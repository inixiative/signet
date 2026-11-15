import type { DataStreamOptions } from './dataStreams';
import { type EventStreamHandlers, type EventStreamKey, EventStreams } from './eventStreams';
import { type ThreadStreamHandlers, type ThreadStreamKey, ThreadStreams } from './threadStreams';

export type HolderStreamHandlers = {
  threadStreams?: ThreadStreamHandlers;
  /** Errors go to its own `onError`, or to the socket's when it has none. */
  eventStreams?: EventStreamHandlers;
  onError?: (error: unknown) => void;
};

/**
 * The streams a holder keeps on one Kingdom socket, thread views and event channels alike: both
 * sockets (`SignetSocket`, `InstallationSocket`) hold them through this, and keep only how they
 * name a stream and how they authenticate.
 */
export class HolderStreams {
  private readonly threads: ThreadStreams | null;
  private readonly events: EventStreams | null;

  constructor(
    send: (frame: Record<string, unknown>) => void,
    handlers: HolderStreamHandlers,
    options: DataStreamOptions,
  ) {
    const { threadStreams, eventStreams, onError } = handlers;
    this.threads = threadStreams ? new ThreadStreams(send, threadStreams, options) : null;
    this.events = eventStreams
      ? new EventStreams(
          send,
          { ...eventStreams, onError: (error) => (eventStreams.onError ?? onError)?.(error) },
          options,
        )
      : null;
  }

  /** The socket (re)authenticated: open everything held. */
  up() {
    this.threads?.up();
    this.events?.up();
  }

  /** The socket dropped: everything held is stale until it is back. */
  down() {
    this.threads?.down();
    this.events?.down();
  }

  /** Handle a frame if it belongs to a held kind of stream; true when it did. */
  receive(frame: Record<string, unknown>) {
    return Boolean(this.threads?.receive(frame) || this.events?.receive(frame));
  }

  openThread(stream: ThreadStreamKey) {
    if (!this.threads) throw Error('Pass threadStreams to hold thread views');
    this.threads.open(stream);
  }

  leaveThread(stream: ThreadStreamKey) {
    this.threads?.leave(stream);
  }

  heldThreads(): ThreadStreamKey[] {
    return this.threads?.held() ?? [];
  }

  openEventChannel(channel: EventStreamKey) {
    if (!this.events) throw Error('Pass eventStreams to hold event channels');
    this.events.open(channel);
  }

  leaveEventChannel(channel: EventStreamKey) {
    this.events?.leave(channel);
  }

  heldEventChannels(): EventStreamKey[] {
    return this.events?.held() ?? [];
  }
}
