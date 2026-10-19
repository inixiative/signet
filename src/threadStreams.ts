import { z } from 'zod';
import { type DroppedEntry, parseEntries } from './contracts';
import {
  type AccessThreadCloseReason,
  accessThreadAppendType,
  accessThreadCloseReasonSchema,
  accessThreadSnapshotSchema,
  accessThreadStreamName,
  parseAccessThreadStreamName,
  type ThreadEntry,
  type ThreadViewResult,
  threadEntrySchema,
} from './threads';

export type ThreadStreamKey = { signetId: string; threadId: string };

/** What a member does with its live views. `reason` is null when Kingdom gave none. */
export type ThreadStreamHandlers = {
  /** A fresh view: on open, and again after every resync. Replace what was held for the thread. */
  onSnapshot: (stream: ThreadStreamKey, view: ThreadViewResult) => void | Promise<void>;
  onEntry: (stream: ThreadStreamKey, entry: ThreadEntry) => void | Promise<void>;
  /** Kingdom closed the stream, or refused to open it (`rejected`); it is not reopened. */
  onClosed?: (stream: ThreadStreamKey, reason: AccessThreadCloseReason | 'rejected' | null) => void;
  /** A frame that didn't parse, or entries dropped from one (the rest are kept). */
  onError?: (error: unknown) => void;
};

const controlFrameSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('opened'), stream: z.string() }),
  z.object({
    type: z.literal('openRejected'),
    stream: z.string(),
    reason: accessThreadCloseReasonSchema.optional().catch(undefined),
  }),
  z.object({
    type: z.literal('closed'),
    stream: z.string(),
    reason: accessThreadCloseReasonSchema.optional().catch(undefined),
  }),
  z.object({ type: z.literal('resync'), stream: z.string() }),
  z.object({
    type: z.literal('error'),
    action: z.string(),
    stream: z.string(),
    retryable: z.boolean(),
  }),
]);
const dataFrameSchema = z.discriminatedUnion('action', [
  z.object({
    category: z.literal('data'),
    action: z.literal('snapshot'),
    stream: z.string(),
    seq: z.number().int(),
    payload: z.unknown(),
  }),
  z.object({
    category: z.literal('data'),
    action: z.literal('append'),
    stream: z.string(),
    seq: z.number().int(),
    type: z.string(),
    payload: z.unknown(),
  }),
]);

type StreamState = { key: ThreadStreamKey; lastSeq: number | null; attempts: number };

/**
 * A member's `accessThread` streams on one Kingdom socket, as Kingdom's data-stream primitive runs
 * them (Kingdom `docs/claude/WEBSOCKETS.md`): one `open` per stream, a snapshot carrying `seq`, then
 * appends; an append at or below the last seq is already in the snapshot, and a gap or `resync`
 * re-opens for a fresh snapshot. No replay. The socket that owns it sends and re-authenticates.
 */
export class ThreadStreams {
  private readonly streams = new Map<string, StreamState>();
  /** Closes this member sent and Kingdom hasn't acknowledged yet, per stream (answered in order). */
  private readonly leaving = new Map<string, number>();
  private readonly retries = new Map<string, ReturnType<typeof setTimeout>>();
  private ready = false;

  constructor(
    private readonly send: (frame: Record<string, unknown>) => void,
    private readonly handlers: ThreadStreamHandlers,
    private readonly retryBaseMs = 1_000,
  ) {}

  /** The streams this member holds open, or is opening. */
  held(): ThreadStreamKey[] {
    return [...this.streams.values()].map((state) => ({ ...state.key }));
  }

  /** Enter a thread: open its stream now, or once the socket is authenticated. */
  open(key: ThreadStreamKey) {
    const stream = accessThreadStreamName(key);
    if (this.streams.has(stream)) return;
    this.streams.set(stream, { key: { ...key }, lastSeq: null, attempts: 0 });
    if (this.ready) this.send({ action: 'open', stream });
  }

  /** Leave a thread: Kingdom closes the stream (and the host's subscription). */
  leave(key: ThreadStreamKey) {
    const stream = accessThreadStreamName(key);
    if (!this.streams.delete(stream)) return;
    this.clearRetry(stream);
    if (!this.ready) return;
    this.leaving.set(stream, (this.leaving.get(stream) ?? 0) + 1);
    this.send({ action: 'close', stream });
  }

  /** The socket (re)authenticated: open every held stream for a fresh snapshot. */
  up() {
    this.ready = true;
    for (const [stream, state] of this.streams) {
      state.lastSeq = null;
      this.send({ action: 'open', stream });
    }
  }

  /** The socket dropped: everything held is stale until the next snapshot. */
  down() {
    this.ready = false;
    this.leaving.clear();
    for (const stream of this.retries.keys()) this.clearRetry(stream);
    for (const state of this.streams.values()) state.lastSeq = null;
  }

  /** Handle a frame if it belongs to an `accessThread` stream; true when it did. */
  async receive(frame: Record<string, unknown>): Promise<boolean> {
    if (typeof frame.stream !== 'string' || !parseAccessThreadStreamName(frame.stream))
      return false;
    if (frame.category === 'data') {
      const data = dataFrameSchema.safeParse(frame);
      if (!data.success) this.handlers.onError?.(data.error);
      else await this.data(data.data);
      return true;
    }
    const control = controlFrameSchema.safeParse(frame);
    if (!control.success) {
      this.handlers.onError?.(control.error);
      return true;
    }
    this.control(control.data);
    return true;
  }

  private control(frame: z.infer<typeof controlFrameSchema>) {
    const state = this.streams.get(frame.stream);
    switch (frame.type) {
      case 'opened':
        if (state) state.attempts = 0;
        return;
      case 'resync':
        return this.reopen(frame.stream);
      case 'error':
        if (!state || frame.action !== 'open') return;
        if (frame.retryable) return this.retry(frame.stream, state);
        return this.end(frame.stream, 'rejected');
      case 'openRejected':
        return this.end(frame.stream, frame.reason ?? 'rejected');
      case 'closed':
        // Our own close is only acknowledged (no reason, or `left`); a close with any other reason,
        // or one we didn't ask for, is Kingdom ending the stream.
        if ((frame.reason ?? 'left') === 'left' && this.acknowledge(frame.stream)) return;
        return this.end(frame.stream, frame.reason ?? null);
    }
  }

  private async data(frame: z.infer<typeof dataFrameSchema>) {
    const state = this.streams.get(frame.stream);
    if (!state) return;
    if (frame.action === 'snapshot') {
      const snapshot = z.object({ data: z.object({}).loose() }).safeParse(frame.payload);
      if (!snapshot.success) return this.abandon(state, snapshot.error);
      const { entries: rawEntries, ...rest } = snapshot.data.data;
      const view = accessThreadSnapshotSchema.shape.data.omit({ entries: true }).safeParse(rest);
      if (!view.success) return this.abandon(state, view.error);
      // Per entry: one entry this member's package can't read never costs it the whole view.
      const dropped: DroppedEntry[] = [];
      const entries = parseEntries('entries', rawEntries, threadEntrySchema, dropped);
      if (dropped.length) this.handlers.onError?.(droppedError(frame.stream, dropped));
      state.lastSeq = frame.seq;
      await this.handlers.onSnapshot(state.key, { ...view.data, entries });
      return;
    }
    if (state.lastSeq === null || frame.seq <= state.lastSeq) return;
    if (frame.seq > state.lastSeq + 1) return this.reopen(frame.stream);
    state.lastSeq = frame.seq;
    const entry = threadEntrySchema.safeParse(frame.payload);
    if (frame.type !== accessThreadAppendType || !entry.success) {
      this.handlers.onError?.(
        droppedError(frame.stream, [
          { list: 'append', index: frame.seq, id: null, reason: `unreadable ${frame.type}` },
        ]),
      );
      return;
    }
    await this.handlers.onEntry(state.key, entry.data);
  }

  private acknowledge(stream: string) {
    const pending = this.leaving.get(stream) ?? 0;
    if (pending === 0) return false;
    if (pending === 1) this.leaving.delete(stream);
    else this.leaving.set(stream, pending - 1);
    return true;
  }

  // Until the next snapshot, appends on the wire are already in it.
  private reopen(stream: string) {
    const state = this.streams.get(stream);
    if (!state) return;
    state.lastSeq = null;
    if (this.ready) this.send({ action: 'open', stream });
  }

  private retry(stream: string, state: StreamState) {
    this.clearRetry(stream);
    const delay = Math.min(this.retryBaseMs * 2 ** state.attempts++, 30_000);
    this.retries.set(
      stream,
      setTimeout(() => {
        this.retries.delete(stream);
        this.reopen(stream);
      }, delay),
    );
  }

  private clearRetry(stream: string) {
    const timer = this.retries.get(stream);
    if (timer) clearTimeout(timer);
    this.retries.delete(stream);
  }

  // Re-opening an unreadable snapshot would read (and meter) the same thing again: leave instead.
  private abandon(state: StreamState, error: unknown) {
    this.handlers.onError?.(error);
    this.leave(state.key);
    this.handlers.onClosed?.(state.key, null);
  }

  private end(stream: string, reason: AccessThreadCloseReason | 'rejected' | null) {
    const state = this.streams.get(stream);
    if (!state) return;
    this.streams.delete(stream);
    this.clearRetry(stream);
    this.handlers.onClosed?.(state.key, reason);
  }
}

const droppedError = (stream: string, dropped: DroppedEntry[]) =>
  Object.assign(Error(`${stream}: dropped ${dropped.length} unreadable entries`), { dropped });
