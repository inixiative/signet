import { z } from 'zod';
import {
  type DataStreamCloseReason,
  type DataStreamFamily,
  type DataStreamOptions,
  DataStreams,
} from './dataStreams';
import {
  accessThreadAppendType,
  accessThreadStreamName,
  parseAccessThreadStreamName,
  parseThreadView,
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
  /** Kingdom ended the stream for good, or refused to open it (`rejected`); it is not reopened. */
  onClosed?: (stream: ThreadStreamKey, reason: DataStreamCloseReason) => void;
  /** A frame that didn't parse, or entries dropped from one (the rest are kept). */
  onError?: (error: unknown) => void;
};

export type ThreadStreamOptions = DataStreamOptions;

const threadStreamFamily: DataStreamFamily<ThreadStreamKey, ThreadViewResult, ThreadEntry> = {
  name: accessThreadStreamName,
  owns: (stream) => parseAccessThreadStreamName(stream) !== null,
  snapshot: (payload) => {
    const view = parseThreadView(z.object({ data: z.unknown() }).safeParse(payload).data?.data);
    if (!view) return null;
    const { dropped, ...snapshot } = view;
    return { snapshot, ...(dropped ? { problem: `dropped ${dropped} entries` } : {}) };
  },
  append: (type, payload) => {
    const entry = threadEntrySchema.safeParse(payload);
    return type === accessThreadAppendType && entry.success ? entry.data : null;
  },
  // The snapshot is the member's view: a jump re-opens for a fresh one, which holds what was missed.
  gap: 'resync',
};

/**
 * A member's `accessThread` streams on one Kingdom socket (`DataStreams`): a snapshot carrying
 * `seq`, then appends; an append at or below the last seq is already in the snapshot, and a gap or
 * `resync` re-opens for a fresh snapshot. No replay.
 */
export class ThreadStreams extends DataStreams<ThreadStreamKey, ThreadViewResult, ThreadEntry> {
  constructor(
    send: (frame: Record<string, unknown>) => void,
    handlers: ThreadStreamHandlers,
    options: ThreadStreamOptions = {},
  ) {
    super(
      threadStreamFamily,
      send,
      {
        onSnapshot: (stream, view) => handlers.onSnapshot(stream, view),
        onAppend: (stream, entry) => handlers.onEntry(stream, entry),
        onClosed: (stream, reason) => handlers.onClosed?.(stream, reason),
        onError: (error) => handlers.onError?.(error),
      },
      options,
    );
  }
}
