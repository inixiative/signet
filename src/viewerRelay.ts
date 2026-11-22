import { z } from 'zod';
import {
  type ViewerKingdomFrame,
  type ViewerRequestFrame,
  type ViewerSocketOpenFrame,
  viewerBodyChunkBytes,
  viewerHostFrameSchema,
  viewerKingdomFrameSchema,
  viewerMaxRequestBodyBytes,
  viewerMaxSocketMessageChars,
  viewerSocketCloseCodeSent,
  viewerSocketCloseReasonBytes,
} from './contracts';

/** The browser's end of the viewer's socket, as the Installation sees it. */
export type ViewerSocketPeer = {
  send(data: string): void;
  close(code?: number, reason?: string): void;
};
/** What the Installation does with the browser's messages on one viewer socket. */
export type ViewerSocketHandlers = {
  message(data: string): void;
  close(code?: number, reason?: string): void;
};
/**
 * How an Installation serves its own web viewer to Kingdom: plain web requests in, plain responses
 * out. It never sees a frame, and needs no knowledge of Kingdom.
 */
export type ViewerHandlers = {
  /** Answers one browser request; the request's URL is the address the browser used. */
  request: (request: Request) => Response | Promise<Response>;
  /** Accepts the viewer's WebSocket and says what to do with its messages; null refuses it. */
  socket?: (
    request: Request,
    peer: ViewerSocketPeer,
  ) => ViewerSocketHandlers | null | Promise<ViewerSocketHandlers | null>;
};

type ViewerLine = {
  /** Sends one frame; false when the Installation socket is not up. */
  send: (frame: ViewerKingdomFrame) => boolean;
  /** Bytes waiting in the Installation socket's send buffer. */
  buffered: () => number;
  onError?: (error: unknown) => void;
};

type ViewerRelayOptions = {
  serving: boolean;
  /** How long a request waits for its next body frame before it is answered 408. Default: 30 s. */
  bodyIdleMs?: number;
};

type PendingRequest = {
  head: ViewerRequestFrame;
  chunks: Uint8Array[];
  bytes: number;
  abort: AbortController;
  /** Set once the whole request has arrived and the viewer is answering it. */
  answering: boolean;
  stalled?: ReturnType<typeof setTimeout>;
};

/** A body frame is not sent while more than this waits in the socket, so other frames keep moving. */
const maxBufferedBytes = 1024 * 1024;
const bufferPollMs = 5;
const bodilessStatuses = new Set([101, 204, 205, 304]);

const base64Of = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const idOf = (value: unknown) => z.uuid().safeParse(value).data;
const closeCodeSent = (code: number | undefined) =>
  code !== undefined && !viewerSocketCloseCodeSent(code) ? 1011 : code;
const closeReasonSent = (reason: string | undefined) => {
  let sent = reason;
  while (sent && Buffer.byteLength(sent) > viewerSocketCloseReasonBytes) sent = sent.slice(0, -1);
  return sent;
};

/**
 * The Installation's side of the viewer frames: turns Kingdom's `viewer.*` frames into web requests
 * for `ViewerHandlers`, and their responses and socket messages back into frames.
 */
export class ViewerRelay {
  private serving: boolean;
  private readonly bodyIdleMs: number;
  private readonly requests = new Map<string, PendingRequest>();
  private readonly sockets = new Map<string, ViewerSocketHandlers | null>();

  constructor(
    private readonly handlers: ViewerHandlers,
    private readonly line: ViewerLine,
    options: ViewerRelayOptions,
  ) {
    this.serving = options.serving;
    this.bodyIdleMs = options.bodyIdleMs ?? 30_000;
  }

  /** Tells Kingdom whether the viewer is served; sent on connect and on every change. */
  announce() {
    this.send({ action: 'viewer.serving', serving: this.serving });
  }

  serve(serving: boolean) {
    if (this.serving === serving) return;
    this.serving = serving;
    if (!serving) this.down();
    this.announce();
  }

  /** The Installation socket dropped, or serving stopped: nothing in flight can be answered. */
  down() {
    const requests = [...this.requests.values()];
    this.requests.clear();
    for (const request of requests) this.end(request);
    const sockets = [...this.sockets.values()];
    this.sockets.clear();
    for (const socket of sockets) this.quietly(() => socket?.close(1001, 'viewer line closed'));
  }

  /** Takes one `viewer.*` frame from Kingdom; one that breaks the contract is answered, never left waiting. */
  receive(raw: Record<string, unknown>) {
    const parsed = viewerHostFrameSchema.safeParse(raw);
    if (!parsed.success) {
      this.line.onError?.(parsed.error);
      const requestId = idOf(raw.requestId);
      const socketId = idOf(raw.socketId);
      if (requestId) {
        this.drop(requestId);
        this.answerEmpty(requestId, 400);
      }
      if (socketId) {
        const socket = this.sockets.get(socketId);
        this.sockets.delete(socketId);
        this.quietly(() => socket?.close(1008, 'invalid frame'));
        this.send({ action: 'viewer.socket.close', socketId, code: 1008, reason: 'invalid frame' });
      }
      return;
    }
    const frame = parsed.data;
    switch (frame.type) {
      case 'viewer.request':
        return this.requestHead(frame);
      case 'viewer.request.body':
        return this.requestBody(frame.requestId, frame.data, frame.last);
      case 'viewer.request.cancel':
        return this.drop(frame.requestId);
      case 'viewer.socket.open':
        return void this.socketOpen(frame);
      case 'viewer.socket.message':
        return this.quietly(() => this.sockets.get(frame.socketId)?.message(frame.data));
      case 'viewer.socket.close': {
        const socket = this.sockets.get(frame.socketId);
        this.sockets.delete(frame.socketId);
        return this.quietly(() => socket?.close(frame.code, frame.reason));
      }
    }
  }

  /** Sends a frame Kingdom can read; one that breaks the contract is reported, not sent. */
  private send(frame: ViewerKingdomFrame) {
    const sent = viewerKingdomFrameSchema.safeParse(frame);
    if (!sent.success) this.line.onError?.(sent.error);
    return sent.success && this.line.send(sent.data);
  }

  private end(pending: PendingRequest) {
    clearTimeout(pending.stalled);
    pending.abort.abort();
  }

  private drop(requestId: string) {
    const pending = this.requests.get(requestId);
    if (!pending) return;
    this.requests.delete(requestId);
    this.end(pending);
  }

  private awaitBody(pending: PendingRequest) {
    clearTimeout(pending.stalled);
    pending.stalled = setTimeout(() => {
      if (this.requests.get(pending.head.requestId) !== pending) return;
      this.drop(pending.head.requestId);
      this.answerEmpty(pending.head.requestId, 408);
    }, this.bodyIdleMs);
  }

  private requestHead(head: ViewerRequestFrame) {
    if (!this.serving) return this.answerEmpty(head.requestId, 403);
    this.drop(head.requestId);
    const pending: PendingRequest = {
      head,
      chunks: [],
      bytes: 0,
      abort: new AbortController(),
      answering: !head.hasBody,
    };
    this.requests.set(head.requestId, pending);
    if (pending.answering) void this.answer(pending);
    else this.awaitBody(pending);
  }

  private requestBody(requestId: string, data: string, last: boolean) {
    const pending = this.requests.get(requestId);
    if (!pending || pending.answering) return;
    const chunk = Buffer.from(data, 'base64');
    pending.bytes += chunk.byteLength;
    if (chunk.byteLength > viewerBodyChunkBytes || pending.bytes > viewerMaxRequestBodyBytes) {
      this.drop(requestId);
      return this.answerEmpty(requestId, 413);
    }
    pending.chunks.push(chunk);
    if (!last) return this.awaitBody(pending);
    clearTimeout(pending.stalled);
    pending.answering = true;
    void this.answer(pending);
  }

  private async answer(pending: PendingRequest) {
    const { head, abort } = pending;
    const current = () => this.requests.get(head.requestId) === pending;
    try {
      const response = await this.handlers.request(
        new Request(new URL(head.path, head.origin).href, {
          method: head.method,
          headers: head.headers,
          body: head.hasBody ? Buffer.concat(pending.chunks) : undefined,
          signal: abort.signal,
        }),
      );
      const body = bodilessStatuses.has(response.status) ? null : response.body;
      if (!current()) return void body?.cancel().catch(() => {});
      const headers = Object.fromEntries(response.headers);
      delete headers['set-cookie'];
      const headed = this.send({
        action: 'viewer.response',
        requestId: head.requestId,
        status: response.status,
        headers,
        hasBody: body !== null,
      });
      if (!headed) {
        void body?.cancel().catch(() => {});
        return void this.answerEmpty(head.requestId, 502);
      }
      if (body) await this.sendBody(head.requestId, body, abort.signal, current);
    } catch (error) {
      if (current()) {
        this.line.onError?.(error);
        this.answerEmpty(head.requestId, 502);
      }
    } finally {
      if (current()) this.requests.delete(head.requestId);
    }
  }

  private async sendBody(
    requestId: string,
    body: ReadableStream<Uint8Array>,
    ended: AbortSignal,
    current: () => boolean,
  ) {
    const reader = body.getReader();
    // why: a stream gone quiet never returns from read(), so a cancel has to end it from outside
    ended.addEventListener('abort', () => void reader.cancel().catch(() => {}), { once: true });
    const frame = (data: Uint8Array, last: boolean, cutShort?: true) =>
      this.send({
        action: 'viewer.response.body',
        requestId,
        data: base64Of(data),
        last,
        ...(cutShort ? { cutShort } : {}),
      });
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (!current()) return;
        if (done) return void frame(new Uint8Array(), true);
        for (let at = 0; at < value.byteLength; at += viewerBodyChunkBytes) {
          while (current() && this.line.buffered() > maxBufferedBytes)
            await new Promise((resolve) => setTimeout(resolve, bufferPollMs));
          if (!current() || !frame(value.subarray(at, at + viewerBodyChunkBytes), false))
            return void reader.cancel().catch(() => {});
        }
      }
    } catch (error) {
      if (!current()) return;
      this.line.onError?.(error);
      frame(new Uint8Array(), true, true);
    }
  }

  private answerEmpty(requestId: string, status: number) {
    this.send({ action: 'viewer.response', requestId, status, headers: {}, hasBody: false });
  }

  private async socketOpen(frame: ViewerSocketOpenFrame) {
    const { socketId } = frame;
    const refuse = (reason: string) =>
      void this.send({ action: 'viewer.socket.close', socketId, code: 1008, reason });
    if (!this.serving || !this.handlers.socket) return refuse('viewer not served');
    // why: held as null while the viewer decides, so a close that arrives meanwhile is seen below
    this.sockets.set(socketId, null);
    const open = () => this.sockets.has(socketId);
    // why: Kingdom must hear `opened` before anything the viewer sends while it is still accepting
    let early: string[] | null = [];
    const peer: ViewerSocketPeer = {
      send: (data) => {
        if (!open()) return;
        if (data.length > viewerMaxSocketMessageChars) return peer.close(1009, 'message too long');
        if (early) return void early.push(data);
        this.send({ action: 'viewer.socket.message', socketId, data });
      },
      close: (code, reason) => {
        if (!this.sockets.delete(socketId)) return;
        this.send({
          action: 'viewer.socket.close',
          socketId,
          code: closeCodeSent(code),
          reason: closeReasonSent(reason),
        });
      },
    };
    let handlers: ViewerSocketHandlers | null = null;
    try {
      handlers = await this.handlers.socket(
        new Request(new URL(frame.path, frame.origin).href, { headers: frame.headers }),
        peer,
      );
    } catch (error) {
      this.line.onError?.(error);
    }
    if (!open()) return this.quietly(() => handlers?.close(1001, 'closed while opening'));
    if (!handlers) {
      this.sockets.delete(socketId);
      return refuse('viewer refused the socket');
    }
    this.sockets.set(socketId, handlers);
    this.send({ action: 'viewer.socket.opened', socketId });
    const waiting = early;
    early = null;
    for (const data of waiting) peer.send(data);
  }

  private quietly(run: () => void) {
    try {
      run();
    } catch (error) {
      this.line.onError?.(error);
    }
  }
}
