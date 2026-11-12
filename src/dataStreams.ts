import { z } from 'zod';
import { type AccessThreadCloseReason, accessThreadCloseReasonSchema } from './threads';

/** Why a stream ended; `rejected` when Kingdom refused the open without a reason, null when it gave none. */
export type DataStreamCloseReason = AccessThreadCloseReason | 'rejected' | null;

/** A jump in a stream's `seq`: the last one seen, and the one that arrived after it. */
export type DataStreamGap = { after: number; seq: number };

/**
 * What tells one family of Kingdom data streams from another; the rest (opening, Kingdom's control
 * frames, retry, re-presenting) is the same for all of them.
 */
export type DataStreamFamily<Key extends object, Snapshot, Append> = {
  name: (key: Key) => string;
  /** Whether a stream name belongs to this family. */
  owns: (stream: string) => boolean;
  /**
   * Read a snapshot's payload. Null when it can't be read at all: the stream is then left, never
   * reopened. `problem` reports what was left out of a snapshot that is kept.
   */
  snapshot: (payload: unknown) => { snapshot: Snapshot; problem?: string } | null;
  /** Read one append; null when it can't be read (reported, and the stream goes on). */
  append: (type: string, payload: unknown) => Append | null;
  /**
   * What the snapshot holds decides what a `seq` means.
   * - `resync`: the snapshot is the state up to its `seq`. An append at or below the last `seq` is
   *   already in it and is skipped, and a jump re-opens for a fresh snapshot, which holds whatever
   *   was missed.
   * - `deliver`: the snapshot holds nothing, so nothing is ever already in it and nothing can be
   *   read again. Every append is delivered, and a jump is reported (`onGap`) beside the append
   *   that showed it.
   */
  gap: 'resync' | 'deliver';
};

export type DataStreamHandlers<Key extends object, Snapshot, Append> = {
  onSnapshot: (key: Key, snapshot: Snapshot) => void | Promise<void>;
  onAppend: (key: Key, append: Append, seq: number) => void | Promise<void>;
  /** Only a `deliver` family reports gaps; a `resync` family reopens instead. */
  onGap?: (key: Key, gap: DataStreamGap) => void;
  onClosed?: (key: Key, reason: DataStreamCloseReason) => void;
  onError?: (error: unknown) => void;
};

export type DataStreamOptions = {
  retryBaseMs?: number;
  /** An open Kingdom never answers is sent again after this long (a relay waits up to 15 s). */
  openTimeoutMs?: number;
  /** Kingdom closed a stream because the socket's presentation lapsed: re-present, then reopen. */
  onPresentationExpired?: () => void;
};

const reasonSchema = accessThreadCloseReasonSchema.optional().catch(undefined);
const controlFrameSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('opened'), stream: z.string() }),
  z.object({ type: z.literal('openRejected'), stream: z.string(), reason: reasonSchema }),
  z.object({ type: z.literal('closed'), stream: z.string(), reason: reasonSchema }),
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

type StreamState<Key> = {
  key: Key;
  lastSeq: number | null;
  attempts: number;
  /** An open is on the wire; a resync or retry meanwhile waits for its answer, not a second open. */
  pending: boolean;
  /** Something asked for a fresh snapshot while an open was pending: open again once it answers. */
  again: boolean;
};

/** Kingdom closed the stream, but the holder may come back: under a new lens, or once re-presented. */
const reopenAfter = new Set<AccessThreadCloseReason>(['revised', 'presentationExpired']);
/** Kingdom closed the stream until the host returns: reopen with backoff. */
const retryAfter = new Set<AccessThreadCloseReason>(['hostOffline']);

/**
 * One family of a holder's streams on one Kingdom socket, as Kingdom's data-stream primitive and
 * its web client run them (Kingdom `docs/claude/WEBSOCKETS.md`, `packages/ui/src/lib/ws/
 * createApiWebsocket.ts`, which isn't published): one open in flight per stream, a snapshot
 * carrying `seq`, then appends. What a repeated or jumped `seq` means is the family's (`gap`). No
 * replay. Frames are handled one at a time, so an append never overtakes the snapshot before it.
 * The socket that owns it sends and re-authenticates.
 */
export class DataStreams<Key extends object, Snapshot, Append> {
  private readonly streams = new Map<string, StreamState<Key>>();
  /** Closes this holder sent and Kingdom hasn't acknowledged yet, per stream (answered in order). */
  private readonly leaving = new Map<string, number>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private queue: Promise<void> = Promise.resolve();
  private ready = false;

  constructor(
    private readonly family: DataStreamFamily<Key, Snapshot, Append>,
    private readonly send: (frame: Record<string, unknown>) => void,
    private readonly handlers: DataStreamHandlers<Key, Snapshot, Append>,
    private readonly options: DataStreamOptions = {},
  ) {}

  /** The streams this holder holds open, or is opening. */
  held(): Key[] {
    return [...this.streams.values()].map((state) => ({ ...state.key }));
  }

  /** Open a stream now, or once the socket is authenticated. */
  open(key: Key) {
    const stream = this.family.name(key);
    if (this.streams.has(stream)) return;
    this.streams.set(stream, {
      key: { ...key },
      lastSeq: null,
      attempts: 0,
      pending: false,
      again: false,
    });
    this.sendOpen(stream);
  }

  /** Leave a stream: Kingdom closes it. */
  leave(key: Key) {
    const stream = this.family.name(key);
    if (!this.streams.delete(stream)) return;
    this.clearTimer(stream);
    if (!this.ready) return;
    this.leaving.set(stream, (this.leaving.get(stream) ?? 0) + 1);
    this.send({ action: 'close', stream });
  }

  /** The socket (re)authenticated: open every held stream for a fresh snapshot. */
  up() {
    this.ready = true;
    for (const stream of this.streams.keys()) this.sendOpen(stream);
  }

  /** The socket dropped: everything held is stale until the next snapshot. */
  down() {
    this.ready = false;
    this.leaving.clear();
    for (const stream of [...this.timers.keys()]) this.clearTimer(stream);
    for (const state of this.streams.values()) {
      state.lastSeq = null;
      state.pending = false;
      state.again = false;
    }
  }

  /** Handle a frame if it belongs to a stream of this family; true when it did. */
  receive(frame: Record<string, unknown>): boolean {
    if (typeof frame.stream !== 'string' || !this.family.owns(frame.stream)) return false;
    this.queue = this.queue
      .then(() => this.handle(frame))
      .catch(this.handlers.onError ?? (() => {}));
    return true;
  }

  private async handle(frame: Record<string, unknown>) {
    if (frame.category === 'data') {
      const data = dataFrameSchema.safeParse(frame);
      if (!data.success) return this.handlers.onError?.(data.error);
      return this.data(data.data);
    }
    const control = controlFrameSchema.safeParse(frame);
    if (!control.success) return this.handlers.onError?.(control.error);
    this.control(control.data);
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
        this.answered(frame.stream, state);
        if (frame.retryable) return this.retry(frame.stream, state);
        return this.end(frame.stream, 'rejected');
      case 'openRejected':
        if (state) this.answered(frame.stream, state);
        return this.closedBy(frame.stream, frame.reason ?? 'rejected');
      case 'closed':
        // Our own close is only acknowledged (no reason, or `left`); a close with any other reason,
        // or one we didn't ask for, is Kingdom ending the stream.
        if ((frame.reason ?? 'left') === 'left' && this.acknowledge(frame.stream)) return;
        return this.closedBy(frame.stream, frame.reason ?? null);
    }
  }

  private closedBy(stream: string, reason: DataStreamCloseReason) {
    const state = this.streams.get(stream);
    if (!state) return;
    if (reason === 'presentationExpired') {
      // The socket re-presents; `up()` then reopens everything held.
      state.lastSeq = null;
      this.options.onPresentationExpired?.();
      return;
    }
    if (reason && reasonIn(reopenAfter, reason)) return this.reopen(stream);
    if (reason && reasonIn(retryAfter, reason)) return this.retry(stream, state);
    this.end(stream, reason);
  }

  private async data(frame: z.infer<typeof dataFrameSchema>) {
    const state = this.streams.get(frame.stream);
    if (!state) return;
    if (frame.action === 'snapshot') {
      this.answered(frame.stream, state);
      const read = this.family.snapshot(frame.payload);
      if (!read) return this.abandon(state, Error(`${frame.stream}: unreadable snapshot`));
      if (read.problem) this.handlers.onError?.(Error(`${frame.stream}: ${read.problem}`));
      state.lastSeq = frame.seq;
      await this.handlers.onSnapshot(state.key, read.snapshot);
      if (state.again) {
        state.again = false;
        this.reopen(frame.stream);
      }
      return;
    }
    if (this.family.gap === 'resync') {
      if (state.lastSeq === null || frame.seq <= state.lastSeq) return;
      if (frame.seq > state.lastSeq + 1) return this.reopen(frame.stream);
      state.lastSeq = frame.seq;
    } else if (state.lastSeq !== null && frame.seq > state.lastSeq) {
      if (frame.seq > state.lastSeq + 1)
        this.handlers.onGap?.(state.key, { after: state.lastSeq, seq: frame.seq });
      state.lastSeq = frame.seq;
    }
    const append = this.family.append(frame.type, frame.payload);
    if (append === null)
      return this.handlers.onError?.(Error(`${frame.stream}: unreadable ${frame.type} append`));
    await this.handlers.onAppend(state.key, append, frame.seq);
  }

  private sendOpen(stream: string) {
    const state = this.streams.get(stream);
    if (!state || !this.ready) return;
    if (state.pending) {
      state.again = true;
      return;
    }
    state.pending = true;
    state.lastSeq = null;
    this.send({ action: 'open', stream });
    this.setTimer(stream, this.options.openTimeoutMs ?? 30_000, () => {
      state.pending = false;
      this.reopen(stream);
    });
  }

  private answered(stream: string, state: StreamState<Key>) {
    state.pending = false;
    this.clearTimer(stream);
  }

  private acknowledge(stream: string) {
    const pending = this.leaving.get(stream) ?? 0;
    if (pending === 0) return false;
    if (pending === 1) this.leaving.delete(stream);
    else this.leaving.set(stream, pending - 1);
    return true;
  }

  // Until the next snapshot, a `resync` family's appends on the wire are already in it.
  private reopen(stream: string) {
    const state = this.streams.get(stream);
    if (!state) return;
    state.lastSeq = null;
    this.sendOpen(stream);
  }

  private retry(stream: string, state: StreamState<Key>) {
    const delay = Math.min((this.options.retryBaseMs ?? 1_000) * 2 ** state.attempts++, 30_000);
    this.setTimer(stream, delay, () => this.reopen(stream));
  }

  private setTimer(stream: string, delay: number, fire: () => void) {
    this.clearTimer(stream);
    this.timers.set(
      stream,
      setTimeout(() => {
        this.timers.delete(stream);
        fire();
      }, delay),
    );
  }

  private clearTimer(stream: string) {
    const timer = this.timers.get(stream);
    if (timer) clearTimeout(timer);
    this.timers.delete(stream);
  }

  // Re-opening an unreadable snapshot would read (and meter) the same thing again: leave instead.
  private abandon(state: StreamState<Key>, error: unknown) {
    this.handlers.onError?.(error);
    this.leave(state.key);
    this.handlers.onClosed?.(state.key, null);
  }

  private end(stream: string, reason: DataStreamCloseReason) {
    const state = this.streams.get(stream);
    if (!state) return;
    this.streams.delete(stream);
    this.clearTimer(stream);
    this.handlers.onClosed?.(state.key, reason);
  }
}

const reasonIn = (
  set: Set<AccessThreadCloseReason>,
  reason: AccessThreadCloseReason | 'rejected',
) => reason !== 'rejected' && set.has(reason);
