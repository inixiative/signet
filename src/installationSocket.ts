import { z } from 'zod';
import { installationInquiries, installationSignets, kingdomUrl, signetProof } from './client';
import {
  type InstallationSnapshot,
  installationSocketAction,
  type OperationRequestFrame,
  operationRequestFrameSchema,
  operationResponseFrameSchema,
  parseInstallationSnapshot,
  type RelayedOperation,
  type RelayedOperationCommonRefusal,
  type RelayedOperationOutcome,
  relayedOperationRefusal,
  relayedOperationSchema,
} from './contracts';
import type { EventStreamHandlers, EventStreamKey } from './eventStreams';
import { HolderStreams } from './holderStreams';
import type { ThreadStreamHandlers, ThreadStreamKey } from './threadStreams';
import {
  type ConversationPermission,
  type ThreadAppendFrame,
  type ThreadEntry,
  type ThreadOperationContext,
  threadAppendFrameSchema,
  threadLeaseFrameSchema,
  threadSubscriptionLeaseMs,
  threadUnsubscribeFrameSchema,
} from './threads';
import { type ViewerHandlers, ViewerRelay } from './viewerRelay';

/** A member's live view this host is pushing, from the moment its snapshot was taken. */
export type ThreadSubscription = {
  subscriptionId: string;
  signetId: string;
  threadId: string;
  acceptedRevision: number;
  member: ThreadOperationContext['member'];
  permissions: ConversationPermission[];
};
/** `overflow`: too many entries arrived while the snapshot was taken; the subscribe is refused and retried. */
export type ThreadSubscriptionEnd = 'unsubscribed' | 'lease' | 'disconnected' | 'overflow';

/**
 * The host's handler for one relayed operation, typed by what Kingdom relays and what it reads back.
 * It answers within `relayedOperationTimeoutMs[operation]`, with `relayedOperationResult(...)` or
 * `relayedOperationRefusal(code)`. A handler that throws, or answers with something the contract
 * doesn't allow, is answered `failed`.
 */
export type RelayedOperationHandler<O extends RelayedOperation> = (
  frame: OperationRequestFrame<O>,
) => RelayedOperationOutcome<O> | Promise<RelayedOperationOutcome<O>>;

/**
 * The relayed operations this Installation serves, one handler each; an operation with none is
 * answered `failed`. `thread.subscribe` answers with the member's view and the `journalSeq` it was
 * taken at: the subscription is registered before it runs, and appends pushed meanwhile are held and
 * sent after the answer, minus those at or below `journalSeq`, so snapshot and subscription start at
 * the same point (review V3).
 */
export type RelayedOperationHandlers = Partial<{
  [O in RelayedOperation]: RelayedOperationHandler<O>;
}>;

export type InstallationSocketOptions = {
  url: string;
  keyFile: string;
  onSnapshot: (snapshot: InstallationSnapshot) => void | Promise<void>;
  /** Kingdom revoked this installation; the socket has stopped for good. */
  onRevoked?: () => void;
  /** The connection was lost; the socket reconnects and reopens what it held. */
  onDisconnected?: () => void;
  onError?: (error: unknown) => void;
  /** Reported on every ping so Kingdom can show how busy this installation is. */
  sessionCount?: () => number;
  /** The relayed operations this installation serves (a Foundry's conversations: the host side). */
  operations?: RelayedOperationHandlers;
  /** This installation's own web viewer, served to whoever Kingdom lets open it. */
  viewer?: ViewerHandlers;
  /** Whether the viewer is served from the start; `serveViewer` changes it. Default: true. */
  viewerServing?: boolean;
  /** A thread subscription ended: Kingdom unsubscribed, its lease lapsed, or this socket dropped. */
  onThreadSubscriptionEnded?: (
    subscription: ThreadSubscription,
    reason: ThreadSubscriptionEnd,
  ) => void;
  /** Hold live views of threads on other Foundries through Signets this installation holds. */
  threadStreams?: ThreadStreamHandlers;
  /** Hold event channels of the Signets this installation holds (their `eventChannels`). */
  eventStreams?: EventStreamHandlers;
  pingMs?: number;
  pollMs?: number;
  retryBaseMs?: number;
  /** Stream opens sent per window, for each kind of stream (`DataStreamOptions`). */
  openBurst?: number;
  openWindowMs?: number;
  /** The most frames that may wait on the handlers, for each kind of stream (`DataStreamOptions`). */
  maxQueuedFrames?: number;
  retryMaxMs?: number;
  /** A Kingdom that never answers the proof (one without Installation sockets) is treated as down. */
  authTimeoutMs?: number;
  /** How long a subscription lives without Kingdom re-asserting it. */
  leaseMs?: number;
  WebSocket?: typeof WebSocket;
};

const frameSchema = z.object({ type: z.string() }).loose();

type HeldSubscription = ThreadSubscription & {
  leaseUntil: number;
  /** The last `journalSeq` covered (the snapshot's, then each append's); null while it is taken. */
  sentSeq: number | null;
  /** The last append's dense `seq` (0 = the snapshot). */
  seq: number;
  held: ThreadEntry[];
};
/** Entries held while one snapshot is taken; past this the subscription ends (Kingdom resyncs). */
const maxHeldEntries = 1_000;
/** WebSocket.OPEN, read from the spec rather than whichever WebSocket class was passed. */
const OPEN = 1;

/**
 * Kingdom's live line to an Installation. It proves the installation's key, then receives a
 * snapshot of its inquiries and Signets on connect and again whenever one changes. While the
 * socket is down it polls the same reads, so nothing waits on the socket coming back. A Foundry
 * also answers its members' calls over it (`operations`) and holds its own memberships (`threadStreams`).
 * The event channels of the Signets it holds are held here too (`eventStreams`), live only.
 */
export class InstallationSocket {
  private socket: WebSocket | null = null;
  private stopped = false;
  private attempts = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private leaseTimer: ReturnType<typeof setInterval> | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private authTimer: ReturnType<typeof setTimeout> | null = null;
  private authenticated = false;
  private polling = false;
  private pollGeneration = 0;
  private readonly subscriptions = new Map<string, HeldSubscription>();
  private readonly streams: HolderStreams;
  private readonly viewer: ViewerRelay | null;

  constructor(private readonly options: InstallationSocketOptions) {
    this.streams = new HolderStreams((frame) => this.send(frame), options, {
      retryBaseMs: options.retryBaseMs,
      openBurst: options.openBurst,
      openWindowMs: options.openWindowMs,
      maxQueuedFrames: options.maxQueuedFrames,
      // Reconnecting authenticates afresh, and `up()` then reopens everything held.
      onPresentationExpired: () => this.socket?.close(),
    });
    this.viewer = options.viewer
      ? new ViewerRelay(
          options.viewer,
          {
            send: (frame) => this.send(frame),
            buffered: () => this.socket?.bufferedAmount ?? 0,
            onError: options.onError,
          },
          { serving: options.viewerServing ?? true },
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

  /** Tell Kingdom this installation is restarting (presence shows it as such), then close. */
  restarting() {
    this.send({ action: 'restarting' });
    this.close();
  }

  /** Start or stop answering Kingdom's viewer frames (the owner's switch, changed on the machine). */
  serveViewer(serving: boolean) {
    this.viewer?.serve(serving);
  }

  close() {
    this.stopped = true;
    this.clearTimers();
    this.socket?.close(1000, 'closed');
    this.socket = null;
    this.authenticated = false;
    this.endSubscriptions('disconnected');
    this.streams.down();
    this.viewer?.down();
  }

  /** The members' views this host is pushing now. */
  threadSubscriptions(): ThreadSubscription[] {
    return [...this.subscriptions.values()].map(
      ({ leaseUntil: _lease, sentSeq: _sent, seq: _seq, held: _held, ...subscription }) =>
        subscription,
    );
  }

  /**
   * Push one journal entry to one subscription, already filtered to that member's view. Entries at
   * or below what was covered are skipped; while the snapshot is being taken they are held. An
   * entry that breaks the contract still spends its `seq`, so Kingdom sees the gap and the member
   * resyncs rather than silently missing it. False when the subscription is gone.
   */
  appendThread(subscriptionId: string, entry: ThreadEntry) {
    const subscription = this.subscriptions.get(subscriptionId);
    if (!subscription) return false;
    if (subscription.sentSeq === null) {
      if (subscription.held.length >= maxHeldEntries) {
        this.endSubscription(subscriptionId, 'overflow');
        return false;
      }
      subscription.held.push(entry);
      return true;
    }
    if (entry.journalSeq <= subscription.sentSeq) return true;
    subscription.sentSeq = entry.journalSeq;
    subscription.seq += 1;
    const frame = threadAppendFrameSchema.safeParse({
      action: 'thread.append',
      subscriptionId,
      signetId: subscription.signetId,
      threadId: subscription.threadId,
      seq: subscription.seq,
      journalSeq: entry.journalSeq,
      entry,
    } satisfies ThreadAppendFrame);
    if (!frame.success) {
      this.options.onError?.(frame.error);
      return true;
    }
    this.send(frame.data);
    return true;
  }

  /** Open a live view of a thread through a Signet this installation holds (needs `threadStreams`). */
  openThread(stream: ThreadStreamKey) {
    this.streams.openThread(stream);
  }

  leaveThread(stream: ThreadStreamKey) {
    this.streams.leaveThread(stream);
  }

  /**
   * Listen on an event channel of a Signet this installation holds (needs `eventStreams`): events
   * from the moment Kingdom opens it, none from before.
   */
  openEventChannel(channel: EventStreamKey) {
    this.streams.openEventChannel(channel);
  }

  leaveEventChannel(channel: EventStreamKey) {
    this.streams.leaveEventChannel(channel);
  }

  /** The event channels this socket holds open, or is opening. */
  heldEventChannels(): EventStreamKey[] {
    return this.streams.heldEventChannels();
  }

  private connect() {
    this.retryTimer = null;
    if (this.stopped) return;
    const Socket = this.options.WebSocket ?? WebSocket;
    const socket = new Socket(kingdomUrl(this.options.url).replace(/^http/, 'ws'));
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
    const parsed = frameSchema.safeParse(json);
    if (!parsed.success) return;
    const frame = parsed.data;
    try {
      switch (frame.type) {
        case 'connected':
          this.authTimer = setTimeout(() => socket.close(), this.options.authTimeoutMs ?? 10_000);
          this.sendOn(socket, {
            action: 'authenticateInstallation',
            proof: await signetProof(
              this.options.url,
              installationSocketAction,
              this.options.keyFile,
            ),
          });
          return;
        case 'installation':
          if (this.authTimer) clearTimeout(this.authTimer);
          this.authTimer = null;
          this.authenticated = true;
          this.attempts = 0;
          this.stopPolling();
          this.pingTimer ??= setInterval(
            () => this.send({ action: 'ping', sessionCount: this.options.sessionCount?.() }),
            this.options.pingMs ?? 20_000,
          );
          this.leaseTimer ??= setInterval(
            () => this.expireLeases(),
            Math.min(this.leaseMs() / 3, 5_000),
          );
          this.viewer?.announce();
          this.streams.up();
          return;
        case 'installation.snapshot':
          await this.options.onSnapshot(parseInstallationSnapshot(frame));
          return;
        case 'installationRejected':
          socket.close();
          return;
        case 'installationRevoked':
          this.close();
          this.options.onRevoked?.();
          return;
        case 'reconnect':
          socket.close();
          return;
        case 'operation.request':
          // Only an authenticated Installation socket carries relayed calls and conversation frames.
          if (this.authenticated) await this.operationRequest(socket, frame);
          return;
        case 'thread.unsubscribe':
        case 'thread.lease':
          if (this.authenticated) this.threadFrame(frame);
          return;
        case 'viewer.request':
        case 'viewer.request.body':
        case 'viewer.request.cancel':
        case 'viewer.socket.open':
        case 'viewer.socket.message':
        case 'viewer.socket.close':
          if (this.authenticated) this.viewer?.receive(frame);
          return;
      }
    } catch (error) {
      this.options.onError?.(error);
      if (frame.type === 'connected') socket.close();
    }
  }

  private threadFrame(frame: Record<string, unknown>) {
    switch (frame.type) {
      case 'thread.unsubscribe': {
        const { subscriptionId } = threadUnsubscribeFrameSchema.parse(frame);
        this.endSubscription(subscriptionId, 'unsubscribed');
        return;
      }
      case 'thread.lease': {
        const { subscriptionIds } = threadLeaseFrameSchema.parse(frame);
        const leaseUntil = Date.now() + this.leaseMs();
        for (const id of subscriptionIds) {
          const subscription = this.subscriptions.get(id);
          if (subscription) subscription.leaseUntil = leaseUntil;
        }
        return;
      }
    }
  }

  private async operationRequest(socket: WebSocket, raw: Record<string, unknown>) {
    const requestId = z.uuid().safeParse(raw.requestId);
    if (!requestId.success) return this.options.onError?.(requestId.error);
    const operation = relayedOperationSchema.safeParse(raw.operation);
    if (!operation.success) {
      this.options.onError?.(operation.error);
      return this.refuse(socket, requestId.data, 'invalid_request');
    }
    if (operation.data === 'thread.subscribe')
      return this.threadSubscribe(socket, requestId.data, raw);
    return this.serve(socket, requestId.data, operation.data, raw);
  }

  private async serve<O extends Exclude<RelayedOperation, 'thread.subscribe'>>(
    socket: WebSocket,
    requestId: string,
    operation: O,
    raw: Record<string, unknown>,
  ) {
    const frame = operationRequestFrameSchema(operation).safeParse(raw);
    if (!frame.success) {
      this.options.onError?.(frame.error);
      return this.refuse(socket, requestId, 'invalid_request');
    }
    const handler: RelayedOperationHandler<O> | undefined = this.options.operations?.[operation];
    if (!handler)
      return this.refuse(socket, requestId, 'failed', `This host serves no ${operation}`);
    try {
      this.respond(socket, requestId, operation, await handler(frame.data));
    } catch (error) {
      this.options.onError?.(error);
      this.refuse(socket, requestId, 'failed');
    }
  }

  private async threadSubscribe(
    socket: WebSocket,
    requestId: string,
    raw: Record<string, unknown>,
  ) {
    const parsed = operationRequestFrameSchema('thread.subscribe').safeParse(raw);
    if (!parsed.success) {
      this.options.onError?.(parsed.error);
      return this.refuse(socket, requestId, 'invalid_request');
    }
    const handler = this.options.operations?.['thread.subscribe'];
    if (!handler)
      return this.refuse(socket, requestId, 'failed', 'This host serves no thread.subscribe');
    const frame = parsed.data;
    const subscription: HeldSubscription = {
      subscriptionId: frame.requestId,
      signetId: frame.signetId,
      threadId: frame.threadId,
      acceptedRevision: frame.acceptedRevision,
      member: frame.member,
      permissions: frame.permissions,
      leaseUntil: Date.now() + this.leaseMs(),
      sentSeq: null,
      seq: 0,
      held: [],
    };
    // Registered before the snapshot is taken, so nothing written meanwhile is lost (review V3).
    this.subscriptions.set(subscription.subscriptionId, subscription);
    let outcome: RelayedOperationOutcome<'thread.subscribe'>;
    try {
      outcome = await handler(frame);
    } catch (error) {
      this.options.onError?.(error);
      outcome = relayedOperationRefusal('failed');
    }
    // Ended while the view was taken (overflow, unsubscribe, lease): a view no subscription will
    // follow would freeze the member, so refuse and let Kingdom's open fail and be retried.
    if (this.subscriptions.get(subscription.subscriptionId) !== subscription) {
      this.refuse(
        socket,
        frame.requestId,
        'failed',
        'The subscription ended while its view was taken',
      );
      return;
    }
    const answered = this.respond(socket, frame.requestId, 'thread.subscribe', outcome);
    if (!answered || !outcome.ok) {
      this.subscriptions.delete(subscription.subscriptionId);
      return;
    }
    subscription.sentSeq = outcome.result.journalSeq;
    const held = subscription.held.sort((a, b) => a.journalSeq - b.journalSeq);
    subscription.held = [];
    for (const entry of held) this.appendThread(subscription.subscriptionId, entry);
  }

  /** Answers a request; false (after answering `failed`) when the handler's outcome breaks the contract. */
  private respond<O extends RelayedOperation>(
    socket: WebSocket,
    requestId: string,
    operation: O,
    outcome: RelayedOperationOutcome<O>,
  ) {
    const frame = operationResponseFrameSchema(operation).safeParse({
      action: 'operation.response',
      requestId,
      outcome,
    });
    if (!frame.success) {
      this.options.onError?.(frame.error);
      this.refuse(socket, requestId, 'failed');
      return false;
    }
    this.sendOn(socket, frame.data);
    return true;
  }

  private refuse(
    socket: WebSocket,
    requestId: string,
    refusal: RelayedOperationCommonRefusal,
    message?: string,
  ) {
    this.sendOn(socket, {
      action: 'operation.response',
      requestId,
      outcome: relayedOperationRefusal(refusal, message),
    });
  }

  private leaseMs() {
    return this.options.leaseMs ?? threadSubscriptionLeaseMs;
  }

  private expireLeases() {
    const now = Date.now();
    for (const subscription of [...this.subscriptions.values()])
      if (subscription.leaseUntil <= now)
        this.endSubscription(subscription.subscriptionId, 'lease');
  }

  private endSubscription(subscriptionId: string, reason: ThreadSubscriptionEnd) {
    const subscription = this.subscriptions.get(subscriptionId);
    if (!subscription) return;
    this.subscriptions.delete(subscriptionId);
    const { leaseUntil: _lease, sentSeq: _sent, seq: _seq, held: _held, ...ended } = subscription;
    this.options.onThreadSubscriptionEnded?.(ended, reason);
  }

  private endSubscriptions(reason: ThreadSubscriptionEnd) {
    for (const id of [...this.subscriptions.keys()]) this.endSubscription(id, reason);
  }

  private send(frame: Record<string, unknown>) {
    return this.socket ? this.sendOn(this.socket, frame) : false;
  }

  private sendOn(socket: WebSocket, frame: Record<string, unknown>) {
    if (socket !== this.socket || socket.readyState !== OPEN) return false;
    socket.send(JSON.stringify(frame));
    return true;
  }

  private disconnected(socket: WebSocket) {
    if (socket !== this.socket) return;
    this.socket = null;
    this.authenticated = false;
    if (this.authTimer) clearTimeout(this.authTimer);
    this.authTimer = null;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    if (this.leaseTimer) clearInterval(this.leaseTimer);
    this.leaseTimer = null;
    // Kingdom re-subscribes members after a reconnect; nothing pushes into a dead line meanwhile.
    this.endSubscriptions('disconnected');
    this.streams.down();
    this.viewer?.down();
    if (this.stopped) return;
    this.options.onDisconnected?.();
    if (!this.polling) void this.poll();
    const base = this.options.retryBaseMs ?? 1_000;
    const delay = Math.min(base * 2 ** this.attempts++, this.options.retryMaxMs ?? 30_000);
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }

  private async poll(generation = ++this.pollGeneration) {
    if (this.stopped || this.authenticated || generation !== this.pollGeneration) return;
    this.polling = true;
    try {
      const [inquiries, signets] = await Promise.all([
        installationInquiries(this.options.url, this.options.keyFile),
        installationSignets(this.options.url, this.options.keyFile),
      ]);
      if (!this.authenticated)
        await this.options.onSnapshot({
          ...inquiries,
          ...signets,
          dropped: [...inquiries.dropped, ...signets.dropped],
        });
    } catch (error) {
      this.options.onError?.(error);
    }
    if (this.stopped || this.authenticated || generation !== this.pollGeneration) return;
    this.pollTimer = setTimeout(() => void this.poll(generation), this.options.pollMs ?? 60_000);
  }

  private stopPolling() {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    this.polling = false;
    this.pollGeneration++;
  }

  private clearTimers() {
    this.stopPolling();
    if (this.authTimer) clearTimeout(this.authTimer);
    this.authTimer = null;
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.leaseTimer) clearInterval(this.leaseTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.pingTimer = null;
    this.leaseTimer = null;
    this.retryTimer = null;
  }
}
