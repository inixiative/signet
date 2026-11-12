import {
  type DataStreamCloseReason,
  type DataStreamFamily,
  type DataStreamGap,
  type DataStreamOptions,
  DataStreams,
} from './dataStreams';
import {
  type AccessEventsAppend,
  accessEventsAppendSchema,
  accessEventsAppendType,
  accessEventsSnapshotSchema,
  accessEventsStreamName,
  parseAccessEventsStreamName,
} from './events';

/** One event channel: a resource a Signet holds event operations on (`eventChannels`). */
export type EventStreamKey = { signetId: string; resourceId: string };

/** A jump in a channel's `seq`: the last one seen (`after`), and the one that arrived (`seq`). */
export type EventStreamGap = DataStreamGap;

/** What a holder does with its event channels. `reason` is null when Kingdom gave none. */
export type EventStreamHandlers = {
  /**
   * One event, as this channel's Signet projects it, with the stream's `seq`. Every readable append
   * is delivered as it arrives, on each channel it arrives on: the same `eventId` may come more
   * than once (two Signets on one resource, a provider's retry), so dedupe on it where that matters.
   */
  onEvent: (
    channel: EventStreamKey,
    event: AccessEventsAppend,
    seq: number,
  ) => void | Promise<void>;
  /**
   * Kingdom opened the channel: events arrive from now. Again after every reopen (a reconnect, a
   * revision, a re-presentation); what was published in between was not delivered and never will be.
   */
  onOpened?: (channel: EventStreamKey) => void | Promise<void>;
  /**
   * The channel's `seq` jumped, reported just before the event that showed it (which is delivered).
   * Either Kingdom counted afresh after a quiet day and nothing was lost, or the appends in between
   * never arrived; neither can be read again.
   */
  onGap?: (channel: EventStreamKey, gap: EventStreamGap) => void;
  /** Kingdom ended the channel for good, or refused to open it (`rejected`); it is not reopened. */
  onClosed?: (channel: EventStreamKey, reason: DataStreamCloseReason) => void;
  /** A frame or an append that didn't parse; the channel goes on. */
  onError?: (error: unknown) => void;
};

export type EventStreamOptions = DataStreamOptions;

// A Kingdom ahead of this package may add a field: read what is known rather than lose the event.
const appendSchema = accessEventsAppendSchema.strip();

const eventStreamFamily: DataStreamFamily<EventStreamKey, null, AccessEventsAppend> = {
  name: accessEventsStreamName,
  owns: (stream) => parseAccessEventsStreamName(stream) !== null,
  // Kingdom's snapshot is always empty, so one that isn't costs nothing: say so and keep listening.
  snapshot: (payload) => ({
    snapshot: null,
    ...(accessEventsSnapshotSchema.safeParse(payload).success
      ? {}
      : { problem: 'a snapshot that is not empty was ignored' }),
  }),
  append: (type, payload) => {
    const append = appendSchema.safeParse(payload);
    return type === accessEventsAppendType && append.success ? append.data : null;
  },
  // The snapshot holds nothing, so re-opening on a jump would only lose the event that showed it.
  gap: 'deliver',
};

/**
 * A holder's `accessEvents` streams on one Kingdom socket (`DataStreams`), one per channel. Live
 * only: the snapshot is always empty and nothing is replayed, so an event published while the
 * channel wasn't open is gone. Every append that arrives is delivered; a jump in `seq` is reported
 * (`onGap`), never a reason to drop or reopen.
 */
export class EventStreams extends DataStreams<EventStreamKey, null, AccessEventsAppend> {
  constructor(
    send: (frame: Record<string, unknown>) => void,
    handlers: EventStreamHandlers,
    options: EventStreamOptions = {},
  ) {
    super(
      eventStreamFamily,
      send,
      {
        onSnapshot: (channel) => handlers.onOpened?.(channel),
        onAppend: (channel, event, seq) => handlers.onEvent(channel, event, seq),
        onGap: (channel, gap) => handlers.onGap?.(channel, gap),
        onClosed: (channel, reason) => handlers.onClosed?.(channel, reason),
        onError: (error) => handlers.onError?.(error),
      },
      options,
    );
  }
}
