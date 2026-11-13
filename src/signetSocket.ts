import { z } from 'zod';
import type { SignetClient } from './client';
import { kingdomUrl } from './client';
import { signetPresentedFrameSchema } from './contracts';
import type { DataStreamOptions } from './dataStreams';
import { type EventStreamHandlers, EventStreams } from './eventStreams';
import { type ThreadStreamHandlers, ThreadStreams } from './threadStreams';

export type SignetSocketOptions = Omit<ThreadStreamHandlers, 'onSnapshot' | 'onEntry'> &
  /** Thread views; a holder that only listens to event channels leaves them out. */
  Partial<Pick<ThreadStreamHandlers, 'onSnapshot' | 'onEntry'>> & {
    /** The Signet this socket presents; it renews the access token the presentation rides on. */
    client: SignetClient;
    /**
     * Hold this Signet's event channels (`eventChannels` on `describe`). Errors go to its own
     * `onError`, or to this socket's when it has none.
     */
    eventStreams?: EventStreamHandlers;
    /** Kingdom accepted (or renewed) the presentation; it holds until `expiresAt`. */
    onPresented?: (presentation: z.infer<typeof signetPresentedFrameSchema>) => void;
    /** The connection was lost; the socket reconnects, presents again and reopens what it held. */
    onDisconnected?: () => void;
    pingMs?: number;
    retryBaseMs?: number;
    retryMaxMs?: number;
    /** A Kingdom that never answers the presentation is treated as down. */
    authTimeoutMs?: number;
    /** Stream opens sent per window, for each kind of stream (`DataStreamOptions`). */
    openBurst?: number;
    openWindowMs?: number;
    /** Renew this long before the access token expires (it lives five minutes). */
    renewBeforeMs?: number;
    WebSocket?: typeof WebSocket;
  };

const frameSchema = z.object({ type: z.string() }).loose();
/** WebSocket.OPEN, read from the spec rather than whichever WebSocket class was passed. */
const OPEN = 1;

/**
 * Kingdom's live line to a Signet presenter: an outside agent holding a member's Signet on a host
 * Foundry's threads (design §5.6.1). It authenticates as that Signet's presentation
 * (`authenticateSignet`: the access token and a single-use proof bound to the Signet socket), renews
 * the presentation before the token expires (`renewPresentation`), and holds the member's
 * `accessThread` streams: entering a thread is opening its stream, and Kingdom closes it on leave,
 * revocation, any revision, expiry or the host going offline. Posts are not sent here; each is its
 * own `access/execute thread.prompt` through the `SignetClient`. It holds the Signet's event
 * channels the same way (`accessEvents` streams, `eventStreams`), live only.
 */
export class SignetSocket {
  private socket: WebSocket | null = null;
  private stopped = false;
  private attempts = 0;
  private authenticated = false;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private authTimer: ReturnType<typeof setTimeout> | null = null;
  private renewTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly streams: ThreadStreams;
  private readonly events: EventStreams | null;

  constructor(private readonly options: SignetSocketOptions) {
    const streamOptions: DataStreamOptions = {
      retryBaseMs: options.retryBaseMs,
      openBurst: options.openBurst,
      openWindowMs: options.openWindowMs,
      // Kingdom closed streams because the presentation lapsed: re-present on a new connection.
      onPresentationExpired: () => this.socket?.close(),
    };
    const send = (frame: Record<string, unknown>) => this.send(frame);
    this.streams = new ThreadStreams(
      send,
      {
        ...options,
        onSnapshot: (stream, view) => options.onSnapshot?.(stream, view),
        onEntry: (stream, entry) => options.onEntry?.(stream, entry),
      },
      streamOptions,
    );
    const events = options.eventStreams;
    this.events = events
      ? new EventStreams(
          send,
          { ...events, onError: (error) => (events.onError ?? options.onError)?.(error) },
          streamOptions,
        )
      : null;
  }

  get connected() {
    return this.authenticated;
  }

  start() {
    if (this.socket || this.retryTimer) return;
    this.stopped = false;
    this.connect();
  }

  /** Enter a thread this Signet's lens selects: a snapshot of the member's view, then appends. */
  open(threadId: string) {
    if (!this.options.onSnapshot || !this.options.onEntry)
      throw Error('Pass onSnapshot and onEntry to hold thread views');
    this.streams.open({ signetId: this.options.client.signetId, threadId });
  }

  /** Leave a thread: Kingdom closes the stream. */
  leave(threadId: string) {
    this.streams.leave({ signetId: this.options.client.signetId, threadId });
  }

  /** The threads this socket holds open, or is opening. */
  threads() {
    return this.streams.held().map((stream) => stream.threadId);
  }

  /**
   * Listen on one of this Signet's event channels, by its resource (needs `eventStreams`): events
   * from the moment Kingdom opens it, none from before.
   */
  openEventChannel(resourceId: string) {
    if (!this.events) throw Error('Pass eventStreams to hold event channels');
    this.events.open({ signetId: this.options.client.signetId, resourceId });
  }

  /** Stop listening on a channel: Kingdom closes the stream. */
  leaveEventChannel(resourceId: string) {
    this.events?.leave({ signetId: this.options.client.signetId, resourceId });
  }

  /** The resources whose event channels this socket holds open, or is opening. */
  heldEventChannels() {
    return this.events?.held().map((channel) => channel.resourceId) ?? [];
  }

  close() {
    this.stopped = true;
    this.clearTimers();
    this.socket?.close(1000, 'closed');
    this.socket = null;
    this.authenticated = false;
    this.streams.down();
    this.events?.down();
  }

  private connect() {
    this.retryTimer = null;
    if (this.stopped) return;
    const Socket = this.options.WebSocket ?? WebSocket;
    const socket = new Socket(kingdomUrl(this.options.client.url).replace(/^http/, 'ws'));
    this.socket = socket;
    socket.onmessage = (event) => void this.receive(socket, String(event.data));
    socket.onclose = () => this.disconnected(socket);
    socket.onerror = () => socket.close();
  }

  private async receive(socket: WebSocket, raw: string) {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return;
    }
    if (socket !== this.socket || typeof json !== 'object' || json === null) return;
    if (this.streams.receive(json as Record<string, unknown>)) return;
    if (this.events?.receive(json as Record<string, unknown>)) return;
    const parsed = frameSchema.safeParse(json);
    if (!parsed.success) return;
    const frame = parsed.data;
    try {
      switch (frame.type) {
        case 'connected': {
          this.authTimer = setTimeout(() => socket.close(), this.options.authTimeoutMs ?? 10_000);
          const { accessToken, proof } = await this.options.client.socketPresentation();
          this.sendOn(socket, { action: 'authenticateSignet', accessToken, proof });
          return;
        }
        case 'signet': {
          const presented = signetPresentedFrameSchema.parse(frame);
          if (presented.signetId !== this.options.client.signetId) {
            this.options.onError?.(Error('Kingdom presented another Signet on this socket'));
            socket.close();
            return;
          }
          if (this.authTimer) clearTimeout(this.authTimer);
          this.authTimer = null;
          this.scheduleRenewal(socket, presented.expiresAt);
          this.options.onPresented?.(presented);
          if (this.authenticated) return;
          this.authenticated = true;
          this.attempts = 0;
          this.pingTimer ??= setInterval(
            () => this.send({ action: 'ping' }),
            this.options.pingMs ?? 20_000,
          );
          this.streams.up();
          this.events?.up();
          return;
        }
        case 'signetRejected':
          this.options.onError?.(Error('Kingdom refused this Signet presentation'));
          socket.close();
          return;
        case 'reconnect':
          socket.close();
          return;
      }
    } catch (error) {
      this.options.onError?.(error);
      if (frame.type === 'connected') socket.close();
    }
  }

  // The presentation is bounded by the access token; Kingdom closes every stream if none follows.
  private scheduleRenewal(socket: WebSocket, expiresAt: string) {
    if (this.renewTimer) clearTimeout(this.renewTimer);
    const delay = Math.max(
      0,
      Date.parse(expiresAt) - Date.now() - (this.options.renewBeforeMs ?? 60_000),
    );
    this.renewTimer = setTimeout(() => void this.renew(socket, expiresAt), delay);
  }

  private async renew(socket: WebSocket, expiresAt: string) {
    this.renewTimer = null;
    if (socket !== this.socket) return;
    try {
      const { accessToken, proof } = await this.options.client.socketPresentation({ renew: true });
      this.sendOn(socket, { action: 'renewPresentation', accessToken, proof });
      // Kingdom answers with `signet` (which reschedules); silence means the presentation is lost.
      this.authTimer = setTimeout(() => socket.close(), this.options.authTimeoutMs ?? 10_000);
    } catch (error) {
      this.options.onError?.(error);
      if (socket !== this.socket) return;
      // Try again while the old presentation still holds; past it, reconnect and present afresh.
      if (Date.parse(expiresAt) > Date.now())
        this.renewTimer = setTimeout(
          () => void this.renew(socket, expiresAt),
          this.options.retryBaseMs ?? 1_000,
        );
      else socket.close();
    }
  }

  private send(frame: Record<string, unknown>) {
    if (this.socket) this.sendOn(this.socket, frame);
  }

  private sendOn(socket: WebSocket, frame: Record<string, unknown>) {
    if (socket === this.socket && socket.readyState === OPEN) socket.send(JSON.stringify(frame));
  }

  private disconnected(socket: WebSocket) {
    if (socket !== this.socket) return;
    this.socket = null;
    this.authenticated = false;
    this.clearTimers();
    this.streams.down();
    this.events?.down();
    if (this.stopped) return;
    this.options.onDisconnected?.();
    const base = this.options.retryBaseMs ?? 1_000;
    const delay = Math.min(base * 2 ** this.attempts++, this.options.retryMaxMs ?? 30_000);
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }

  private clearTimers() {
    for (const timer of [this.authTimer, this.renewTimer, this.retryTimer])
      if (timer) clearTimeout(timer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.authTimer = null;
    this.renewTimer = null;
    this.retryTimer = null;
    this.pingTimer = null;
  }
}
