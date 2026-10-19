import { z } from 'zod';
import { installationInquiries, installationSignets, kingdomUrl, signetProof } from './client';
import {
  type InstallationSnapshot,
  installationSocketAction,
  parseInstallationSnapshot,
} from './contracts';
import { type ThreadStreamHandlers, type ThreadStreamKey, ThreadStreams } from './threadStreams';
import {
  type ThreadAppendFrame,
  type ThreadEntry,
  type ThreadOperation,
  type ThreadOutcome,
  type ThreadRefusal,
  type ThreadRequestFrame,
  type ThreadSubscribeFrame,
  type ThreadsLens,
  threadAppendFrameSchema,
  threadLeaseFrameSchema,
  threadRefused,
  threadRequestFrameSchema,
  threadResponseFrameSchema,
  threadSubscribeFrameSchema,
  threadSubscriptionLeaseMs,
  threadUnsubscribeFrameSchema,
} from './threads';

export type ThreadRequestOf<O extends ThreadOperation> = Extract<
  ThreadRequestFrame,
  { operation: O }
>;

/** A member's live view this host is pushing, from the moment its snapshot was taken. */
export type ThreadSubscription = {
  subscriptionId: string;
  signetId: string;
  threadId: string;
  acceptedRevision: number;
  member: ThreadSubscribeFrame['member'];
  lens: ThreadsLens;
};
/** `overflow`: too many entries arrived while the snapshot was taken; the member resyncs. */
export type ThreadSubscriptionEnd = 'unsubscribed' | 'lease' | 'disconnected' | 'overflow';

/**
 * A host Foundry's side of agent conversations: one handler per operation, typed by what Kingdom
 * relays and what it reads back. Each answers within Kingdom's 15 s wait, with `threadResult(...)`
 * or `threadRefused(code)`. A handler that throws, or answers with something the contract doesn't
 * allow, is answered `failed`.
 */
export type ThreadHost = {
  [O in ThreadOperation]: (
    frame: ThreadRequestOf<O>,
  ) => ThreadOutcome<O> | Promise<ThreadOutcome<O>>;
} & {
  /**
   * The member's view and the `journalSeq` it was taken at. The subscription is registered before
   * this runs, and appends pushed meanwhile are held and sent after the answer, minus those at or
   * below `journalSeq`: snapshot and subscription start at the same point (review V3).
   */
  'thread.subscribe': (
    frame: ThreadSubscribeFrame,
  ) => ThreadOutcome<'thread.subscribe'> | Promise<ThreadOutcome<'thread.subscribe'>>;
  /** A subscription ended: Kingdom unsubscribed, its lease lapsed, or this socket dropped. */
  ended?: (subscription: ThreadSubscription, reason: ThreadSubscriptionEnd) => void;
};

export type InstallationSocketOptions = {
  url: string;
  keyFile: string;
  onSnapshot: (snapshot: InstallationSnapshot) => void | Promise<void>;
  /** Kingdom revoked this installation; the socket has stopped for good. */
  onRevoked?: () => void;
  onError?: (error: unknown) => void;
  /** Where Kingdom can reach this installation's viewer (Foundry's tunnel); re-advertised on every connect. */
  viewerUrl?: string | null;
  /** Reported on every ping so Kingdom can show how busy this installation is. */
  sessionCount?: () => number;
  /** Serve conversations on this installation's Foundry integrations (the host side). */
  threads?: ThreadHost;
  /** Hold live views of threads on other Foundries through Signets this installation holds. */
  threadStreams?: ThreadStreamHandlers;
  pingMs?: number;
  pollMs?: number;
  retryBaseMs?: number;
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

/** An unknown selector form (or a `within`, which no v1 form fills) is refused as `unknown_selector`. */
const unknownSelector = (frame: Record<string, unknown>) => {
  const threads = z
    .object({ threads: z.object({ form: z.string(), within: z.unknown().optional() }).loose() })
    .loose()
    .safeParse(frame.lens);
  return (
    threads.success &&
    (threads.data.threads.form !== 'ids' || threads.data.threads.within !== undefined)
  );
};

/**
 * Kingdom's live line to an Installation. It proves the installation's key, then receives a
 * snapshot of its inquiries and Signets on connect and again whenever one changes. While the
 * socket is down it polls the same reads, so nothing waits on the socket coming back. A Foundry
 * also answers its members' calls over it (`threads`) and holds its own memberships (`threadStreams`).
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
  private viewerUrl: string | null;
  private readonly subscriptions = new Map<string, HeldSubscription>();
  private readonly streams: ThreadStreams | null;

  constructor(private readonly options: InstallationSocketOptions) {
    this.viewerUrl = options.viewerUrl ?? null;
    this.streams = options.threadStreams
      ? new ThreadStreams((frame) => this.send(frame), options.threadStreams, {
          retryBaseMs: options.retryBaseMs,
        })
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

  advertise(viewerUrl: string | null) {
    this.viewerUrl = viewerUrl;
    if (this.authenticated) this.send({ action: 'advertise', viewerUrl });
  }

  close() {
    this.stopped = true;
    this.clearTimers();
    this.socket?.close(1000, 'closed');
    this.socket = null;
    this.authenticated = false;
    this.endSubscriptions('disconnected');
    this.streams?.down();
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
    if (!this.streams) throw Error('Pass threadStreams to hold thread views');
    this.streams.open(stream);
  }

  leaveThread(stream: ThreadStreamKey) {
    this.streams?.leave(stream);
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
    if (this.streams?.receive(json as Record<string, unknown>)) return;
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
          if (this.viewerUrl) this.send({ action: 'advertise', viewerUrl: this.viewerUrl });
          this.streams?.up();
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
        case 'advertiseRejected':
          this.options.onError?.(Error(`Kingdom refused viewer URL ${this.viewerUrl}`));
          return;
        case 'thread.request':
        case 'thread.subscribe':
        case 'thread.unsubscribe':
        case 'thread.lease':
          // Only an authenticated Installation socket carries conversation frames.
          if (this.authenticated) await this.threadFrame(socket, frame);
          return;
      }
    } catch (error) {
      this.options.onError?.(error);
      if (frame.type === 'connected') socket.close();
    }
  }

  private async threadFrame(socket: WebSocket, frame: Record<string, unknown>) {
    switch (frame.type) {
      case 'thread.request':
        await this.threadRequest(socket, frame);
        return;
      case 'thread.subscribe':
        await this.threadSubscribe(socket, frame);
        return;
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

  private async threadRequest(socket: WebSocket, raw: Record<string, unknown>) {
    const requestId = z.uuid().safeParse(raw.requestId);
    if (!requestId.success) return this.options.onError?.(requestId.error);
    const frame = threadRequestFrameSchema.safeParse(raw);
    if (!frame.success) {
      this.options.onError?.(frame.error);
      return this.refuse(
        socket,
        requestId.data,
        unknownSelector(raw) ? 'unknown_selector' : 'invalid_request',
      );
    }
    const host = this.options.threads;
    if (!host) return this.refuse(socket, requestId.data, 'failed', 'This host serves no threads');
    try {
      const request = frame.data;
      switch (request.operation) {
        case 'thread.read':
          return this.respond(
            socket,
            request.requestId,
            request.operation,
            await host[request.operation](request),
          );
        case 'thread.prompt':
          return this.respond(
            socket,
            request.requestId,
            request.operation,
            await host[request.operation](request),
          );
        case 'thread.floor':
          return this.respond(
            socket,
            request.requestId,
            request.operation,
            await host[request.operation](request),
          );
        case 'prompt.resolve':
          return this.respond(
            socket,
            request.requestId,
            request.operation,
            await host[request.operation](request),
          );
      }
    } catch (error) {
      this.options.onError?.(error);
      return this.refuse(socket, requestId.data, 'failed');
    }
  }

  private async threadSubscribe(socket: WebSocket, raw: Record<string, unknown>) {
    const requestId = z.uuid().safeParse(raw.requestId);
    if (!requestId.success) return this.options.onError?.(requestId.error);
    const parsed = threadSubscribeFrameSchema.safeParse(raw);
    if (!parsed.success) {
      this.options.onError?.(parsed.error);
      return this.refuse(
        socket,
        requestId.data,
        unknownSelector(raw) ? 'unknown_selector' : 'invalid_request',
      );
    }
    const host = this.options.threads;
    if (!host) return this.refuse(socket, requestId.data, 'failed', 'This host serves no threads');
    const frame = parsed.data;
    const subscription: HeldSubscription = {
      subscriptionId: frame.requestId,
      signetId: frame.signetId,
      threadId: frame.threadId,
      acceptedRevision: frame.acceptedRevision,
      member: frame.member,
      lens: frame.lens,
      leaseUntil: Date.now() + this.leaseMs(),
      sentSeq: null,
      seq: 0,
      held: [],
    };
    // Registered before the snapshot is taken, so nothing written meanwhile is lost (review V3).
    this.subscriptions.set(subscription.subscriptionId, subscription);
    let outcome: ThreadOutcome<'thread.subscribe'>;
    try {
      outcome = await host['thread.subscribe'](frame);
    } catch (error) {
      this.options.onError?.(error);
      outcome = threadRefused('failed');
    }
    const answered = this.respond(socket, frame.requestId, 'thread.subscribe', outcome);
    if (this.subscriptions.get(subscription.subscriptionId) !== subscription) return;
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
  private respond<O extends ThreadOperation | 'thread.subscribe'>(
    socket: WebSocket,
    requestId: string,
    operation: O,
    outcome: ThreadOutcome<O>,
  ) {
    const frame = threadResponseFrameSchema(operation).safeParse({
      action: 'thread.response',
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

  private refuse(socket: WebSocket, requestId: string, refusal: ThreadRefusal, message?: string) {
    this.sendOn(socket, {
      action: 'thread.response',
      requestId,
      outcome: threadRefused(refusal, message),
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
    this.options.threads?.ended?.(ended, reason);
  }

  private endSubscriptions(reason: ThreadSubscriptionEnd) {
    for (const id of [...this.subscriptions.keys()]) this.endSubscription(id, reason);
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
    if (this.authTimer) clearTimeout(this.authTimer);
    this.authTimer = null;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    if (this.leaseTimer) clearInterval(this.leaseTimer);
    this.leaseTimer = null;
    // Kingdom re-subscribes members after a reconnect; nothing pushes into a dead line meanwhile.
    this.endSubscriptions('disconnected');
    this.streams?.down();
    if (this.stopped) return;
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
