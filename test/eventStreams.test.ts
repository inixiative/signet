import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerWebSocket } from 'bun';
import {
  type AccessEventsAppend,
  accessEventsStreamName,
  accessThreadStreamName,
  type EventStreamGap,
  type EventStreamHandlers,
  type EventStreamKey,
  generateSignetKey,
  SignetClient,
  SignetSocket,
  saveCollectedSignet,
  type ThreadEntry,
  type ThreadViewResult,
  writePrivateJson,
} from '../src';

const uuid = () => Bun.randomUUIDv7();
const T1 = 'thread_0199f0aa-0000-7000-8000-000000000001';
const R1 = uuid();
const R2 = uuid();
const signetId = uuid();
const enrollmentId = uuid();
// A new counter is seeded from Redis TIME in microseconds (Kingdom `ws/queries/publishStreamAppend.ts`).
const seeded = 1_762_000_000_000_000;
const aDayLater = seeded + 86_400_000_000;
const frames: Record<string, unknown>[] = [];
const minutes = (count: number) => new Date(Date.now() + count * 60_000).toISOString();
let kingdom: ServerWebSocket<unknown> | null = null;
let server: ReturnType<typeof Bun.serve>;
let url: string;
let client: SignetClient;
let socket: SignetSocket | null = null;

const waitFor = async (predicate: () => boolean, timeoutMs = 3000) => {
  for (const start = Date.now(); !predicate(); await Bun.sleep(5))
    if (Date.now() - start > timeoutMs) throw Error('waitFor timed out');
};
const settle = () => Bun.sleep(40);
const toHolder = (frame: Record<string, unknown>) => kingdom?.send(JSON.stringify(frame));
const channel = (resourceId: string) => accessEventsStreamName({ resourceId, signetId });
const thread = (threadId: string) => accessThreadStreamName({ signetId, threadId });
const sent = (action: string, stream: string) =>
  frames.filter((frame) => frame.action === action && frame.stream === stream).length;
const presentations = () => frames.filter((frame) => frame.action === 'authenticateSignet').length;
const append = (
  eventId: string,
  event: Record<string, unknown> = { scope: 'inixiative/kingdom' },
) => ({ eventId, type: 'issue_comment.created', event }) satisfies AccessEventsAppend;
const opened = (stream: string, seq: number) => {
  toHolder({ type: 'opened', stream });
  toHolder({
    category: 'data',
    action: 'snapshot',
    stream,
    seq,
    payload: { data: { events: [] } },
  });
};
const appended = (stream: string, seq: number, payload: unknown, type = 'append') =>
  toHolder({ category: 'data', action: 'append', stream, seq, type, payload });
const entry = (journalSeq: number): ThreadEntry => ({
  journalSeq,
  at: new Date().toISOString(),
  kind: 'send',
  member: { kind: 'signet', id: signetId },
  text: `entry ${journalSeq}`,
});
const view = (journalSeq: number): ThreadViewResult => ({
  journalSeq,
  entries: [entry(journalSeq)],
  truncated: false,
});

type Seen = {
  events: [EventStreamKey, AccessEventsAppend, number][];
  opened: EventStreamKey[];
  gaps: [EventStreamKey, EventStreamGap][];
  closed: [EventStreamKey, string | null][];
  errors: unknown[];
  snapshots: [string, number][];
  entries: [string, number][];
};
const hold = async (overrides: Partial<EventStreamHandlers> = {}) => {
  const seen: Seen = {
    events: [],
    opened: [],
    gaps: [],
    closed: [],
    errors: [],
    snapshots: [],
    entries: [],
  };
  socket = new SignetSocket({
    client,
    retryBaseMs: 20,
    onSnapshot: (stream, received) =>
      void seen.snapshots.push([stream.threadId, received.journalSeq]),
    onEntry: (stream, received) => void seen.entries.push([stream.threadId, received.journalSeq]),
    eventStreams: {
      onEvent: (held, event, seq) => void seen.events.push([held, event, seq]),
      onOpened: (held) => void seen.opened.push(held),
      onGap: (held, gap) => void seen.gaps.push([held, gap]),
      onClosed: (held, reason) => void seen.closed.push([held, reason]),
      onError: (error) => void seen.errors.push(error),
      ...overrides,
    },
  });
  socket.start();
  await waitFor(() => socket?.connected === true && kingdom !== null);
  return { socket, seen };
};

beforeAll(async () => {
  const directory = await mkdtemp(join(tmpdir(), 'signet-events-'));
  const keyFile = join(directory, 'key.json');
  const credentialFile = join(directory, 'signet.json');
  await writePrivateJson(keyFile, generateSignetKey());
  const credential = {
    enrollmentId,
    lifecycle: 'ongoing' as const,
    taskId: null,
    accessToken: `kingdom_${'a'.repeat(43)}`,
    expiresAt: minutes(5),
    renewalExpiresAt: minutes(60 * 24),
    idleExpiresAt: minutes(60 * 24),
    tokenType: 'DPoP' as const,
  };
  server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      if (req.headers.get('upgrade') === 'websocket')
        return srv.upgrade(req, { data: null }) ? undefined : new Response(null, { status: 426 });
      const action = new URL(req.url).pathname.split('/').at(-1);
      if (action === 'nonce') {
        const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
        return Response.json({ data: { nonce } });
      }
      if (action === 'renewSignet') return Response.json({ data: credential });
      return new Response(null, { status: 404 });
    },
    websocket: {
      open(ws) {
        kingdom = ws;
        ws.send(JSON.stringify({ type: 'connected', connectionId: uuid() }));
      },
      message(ws, raw) {
        const frame = JSON.parse(String(raw)) as Record<string, unknown>;
        if (frame.action === 'ping') return;
        frames.push(frame);
        if (frame.action === 'authenticateSignet')
          ws.send(
            JSON.stringify({ type: 'signet', signetId, enrollmentId, expiresAt: minutes(5) }),
          );
      },
      close(ws) {
        if (kingdom === ws) kingdom = null;
      },
    },
  });
  url = `http://localhost:${server.port}`;
  await saveCollectedSignet(credentialFile, url, keyFile, {
    ...credential,
    signetId,
    renewalCredential: `signet_renew_${'r'.repeat(43)}`,
  });
  client = await SignetClient.fromFile(credentialFile);
});

afterEach(async () => {
  socket?.close();
  socket = null;
  await waitFor(() => kingdom === null);
  frames.length = 0;
});
afterAll(() => server.stop(true));

test('opens a channel by resourceId and delivers each append with its seq', async () => {
  const { socket, seen } = await hold();
  socket.openEventChannel(R1);
  await waitFor(() => sent('open', channel(R1)) === 1);
  expect(frames.find((frame) => frame.action === 'open')).toEqual({
    action: 'open',
    stream: `accessEvents:resourceId:${R1}:signetId:${signetId}`,
  });
  expect(socket.heldEventChannels()).toEqual([R1]);

  opened(channel(R1), seeded);
  appended(channel(R1), seeded + 1, append('delivery-1', { mentions: ['aron'] }));
  appended(channel(R1), seeded + 2, { ...append('delivery-2'), later: 'a newer Kingdom' });
  await waitFor(() => seen.events.length === 2);
  expect(seen.opened).toEqual([{ signetId, resourceId: R1 }]);
  expect(seen.events).toEqual([
    [{ signetId, resourceId: R1 }, append('delivery-1', { mentions: ['aron'] }), seeded + 1],
    [{ signetId, resourceId: R1 }, append('delivery-2'), seeded + 2],
  ]);
  expect(seen.gaps).toEqual([]);
  expect(seen.errors).toEqual([]);
});

test('an append after a seq jump is delivered and the gap reported, never reopened for', async () => {
  const { socket, seen } = await hold();
  socket.openEventChannel(R1);
  await waitFor(() => sent('open', channel(R1)) === 1);
  opened(channel(R1), seeded);
  appended(channel(R1), seeded + 1, append('before-the-quiet-day'));
  // The counter expired after 24 quiet hours and was seeded again from the clock.
  appended(channel(R1), aDayLater + 1, append('after-the-quiet-day'));
  appended(channel(R1), aDayLater + 2, append('next'));
  // A few appends that never arrived.
  appended(channel(R1), aDayLater + 5, append('after-a-loss'));
  await waitFor(() => seen.events.length === 4);
  expect(seen.events.map(([, event, seq]) => [event.eventId, seq])).toEqual([
    ['before-the-quiet-day', seeded + 1],
    ['after-the-quiet-day', aDayLater + 1],
    ['next', aDayLater + 2],
    ['after-a-loss', aDayLater + 5],
  ]);
  expect(seen.gaps).toEqual([
    [
      { signetId, resourceId: R1 },
      { after: seeded + 1, seq: aDayLater + 1 },
    ],
    [
      { signetId, resourceId: R1 },
      { after: aDayLater + 2, seq: aDayLater + 5 },
    ],
  ]);
  await settle();
  expect(sent('open', channel(R1))).toBe(1);
  expect(seen.opened).toHaveLength(1);
  expect(seen.errors).toEqual([]);
});

test('the gap is reported before its event, and a holder with no onGap still gets the event', async () => {
  const order: string[] = [];
  const { socket } = await hold({
    onEvent: (_held, event) => void order.push(event.eventId),
    onGap: (_held, gap) => void order.push(`gap after ${gap.after - seeded}`),
  });
  socket.openEventChannel(R1);
  await waitFor(() => sent('open', channel(R1)) === 1);
  opened(channel(R1), seeded);
  appended(channel(R1), seeded + 1, append('first'));
  appended(channel(R1), seeded + 9, append('jumped'));
  await waitFor(() => order.length === 3);
  expect(order).toEqual(['first', 'gap after 1', 'jumped']);
  socket.close();
  await waitFor(() => kingdom === null);
  frames.length = 0;

  const silent = await hold({ onGap: undefined });
  silent.socket.openEventChannel(R1);
  await waitFor(() => sent('open', channel(R1)) === 1);
  opened(channel(R1), seeded);
  appended(channel(R1), seeded + 9, append('jumped'));
  await waitFor(() => silent.seen.events.length === 1);
  expect(silent.seen.errors).toEqual([]);
});

test("an append at or below the snapshot's seq is delivered: an empty snapshot holds nothing", async () => {
  const { socket, seen } = await hold();
  socket.openEventChannel(R1);
  await waitFor(() => sent('open', channel(R1)) === 1);
  // Kingdom subscribes the socket before it reads the seq, and flushes what it held after the
  // snapshot (`ws/dataStreams.ts`): an event published in between carries the snapshot's own seq.
  opened(channel(R1), seeded + 1);
  appended(channel(R1), seeded + 1, append('published-while-opening'));
  appended(channel(R1), seeded + 2, append('next'));
  await waitFor(() => seen.events.length === 2);
  expect(seen.events.map(([, event]) => event.eventId)).toEqual([
    'published-while-opening',
    'next',
  ]);
  expect(seen.gaps).toEqual([]);
});

test('an append it cannot read is reported and the stream goes on', async () => {
  const { socket, seen } = await hold();
  socket.openEventChannel(R1);
  await waitFor(() => sent('open', channel(R1)) === 1);
  opened(channel(R1), seeded);
  appended(channel(R1), seeded + 1, { type: 'issue_comment.created', event: {} });
  appended(channel(R1), seeded + 2, append('another-op'), 'retract');
  toHolder({ category: 'data', action: 'append', stream: channel(R1), payload: append('no-seq') });
  appended(channel(R1), seeded + 3, append('readable'));
  await waitFor(() => seen.events.length === 1);
  expect(seen.events[0]).toEqual([{ signetId, resourceId: R1 }, append('readable'), seeded + 3]);
  expect(seen.errors).toHaveLength(3);
  expect(String(seen.errors[0])).toContain(`${channel(R1)}: unreadable append append`);
  expect(String(seen.errors[1])).toContain(`${channel(R1)}: unreadable retract append`);
  // The unreadable appends still spent their seq: no gap is reported for them.
  expect(seen.gaps).toEqual([]);
  expect(socket.heldEventChannels()).toEqual([R1]);
  expect(sent('open', channel(R1))).toBe(1);
  expect(seen.closed).toEqual([]);
});

test('a handler that throws is reported and the next event still arrives', async () => {
  const delivered: string[] = [];
  const { socket, seen } = await hold({
    onEvent: (_held, event) => {
      if (event.eventId === 'breaks') throw Error('consumer failed');
      delivered.push(event.eventId);
    },
  });
  socket.openEventChannel(R1);
  await waitFor(() => sent('open', channel(R1)) === 1);
  opened(channel(R1), seeded);
  appended(channel(R1), seeded + 1, append('breaks'));
  appended(channel(R1), seeded + 2, append('fine'));
  await waitFor(() => delivered.length === 1);
  expect(delivered).toEqual(['fine']);
  expect(seen.errors.map(String)).toEqual(['Error: consumer failed']);
});

test('a snapshot that is not the empty one is reported and the channel still opens', async () => {
  const { socket, seen } = await hold();
  socket.openEventChannel(R1);
  await waitFor(() => sent('open', channel(R1)) === 1);
  toHolder({
    category: 'data',
    action: 'snapshot',
    stream: channel(R1),
    seq: seeded,
    payload: { data: { events: [append('a-backlog')] } },
  });
  appended(channel(R1), seeded + 1, append('live'));
  await waitFor(() => seen.events.length === 1);
  expect(seen.events.map(([, event]) => event.eventId)).toEqual(['live']);
  expect(seen.opened).toHaveLength(1);
  expect(seen.errors).toHaveLength(1);
  expect(seen.closed).toEqual([]);
});

test('openRejected and a close with a reason reach onClosed, and the channel is not reopened', async () => {
  const { socket, seen } = await hold();
  socket.openEventChannel(R1);
  socket.openEventChannel(R2);
  await waitFor(() => sent('open', channel(R1)) === 1 && sent('open', channel(R2)) === 1);
  // No event leaf on that resource: admission refuses the open.
  toHolder({ type: 'openRejected', stream: channel(R1), reason: 'unauthorized' });
  opened(channel(R2), seeded);
  toHolder({ type: 'closed', stream: channel(R2), reason: 'revoked' });
  await waitFor(() => seen.closed.length === 2);
  expect(seen.closed).toEqual([
    [{ signetId, resourceId: R1 }, 'unauthorized'],
    [{ signetId, resourceId: R2 }, 'revoked'],
  ]);
  expect(socket.heldEventChannels()).toEqual([]);
  // Nothing arrives on a channel Kingdom closed, and a late frame is not delivered.
  appended(channel(R2), seeded + 1, append('late'));
  await settle();
  expect(seen.events).toEqual([]);
  expect(sent('open', channel(R1))).toBe(1);
  expect(sent('open', channel(R2))).toBe(1);

  // Refused with no reason: `rejected`. The reauthorize sweep refuses an open stream the same way.
  socket.openEventChannel(R1);
  await waitFor(() => sent('open', channel(R1)) === 2);
  toHolder({ type: 'openRejected', stream: channel(R1) });
  await waitFor(() => seen.closed.length === 3);
  expect(seen.closed[2]).toEqual([{ signetId, resourceId: R1 }, 'rejected']);
  await settle();
  expect(sent('open', channel(R1))).toBe(2);
});

test('a revision reopens the channel, and a retryable refusal is retried', async () => {
  const { socket, seen } = await hold();
  socket.openEventChannel(R1);
  await waitFor(() => sent('open', channel(R1)) === 1);
  opened(channel(R1), seeded);
  await waitFor(() => seen.opened.length === 1);
  toHolder({ type: 'closed', stream: channel(R1), reason: 'revised' });
  await waitFor(() => sent('open', channel(R1)) === 2);
  toHolder({ type: 'error', action: 'open', stream: channel(R1), retryable: true });
  await waitFor(() => sent('open', channel(R1)) === 3);
  // Whatever Kingdom sends on a held channel is delivered, the snapshot still to come or not.
  appended(channel(R1), seeded + 3, append('before-the-new-snapshot'));
  opened(channel(R1), seeded + 4);
  appended(channel(R1), seeded + 5, append('under-the-new-revision'));
  await waitFor(() => seen.events.length === 2);
  expect(seen.events.map(([, event]) => event.eventId)).toEqual([
    'before-the-new-snapshot',
    'under-the-new-revision',
  ]);
  // Listening again: whatever was published between the two opens was not delivered.
  expect(seen.opened).toHaveLength(2);
  expect(seen.gaps).toEqual([]);
  expect(seen.closed).toEqual([]);
});

test('leaving closes the channel; the acknowledgement is not a close by Kingdom', async () => {
  const { socket, seen } = await hold();
  socket.openEventChannel(R1);
  socket.openEventChannel(R2);
  await waitFor(() => sent('open', channel(R2)) === 1);
  opened(channel(R1), seeded);
  opened(channel(R2), seeded);
  await waitFor(() => seen.opened.length === 2);
  socket.leaveEventChannel(R1);
  await waitFor(() => sent('close', channel(R1)) === 1);
  expect(frames.at(-1)).toEqual({ action: 'close', stream: channel(R1) });
  expect(socket.heldEventChannels()).toEqual([R2]);
  // Already on the wire when the holder left: not delivered.
  appended(channel(R1), seeded + 1, append('after-leaving'));
  toHolder({ type: 'closed', stream: channel(R1) });
  appended(channel(R2), seeded + 1, append('still-held'));
  await waitFor(() => seen.events.length === 1);
  await settle();
  expect(seen.events.map(([held, event]) => [held.resourceId, event.eventId])).toEqual([
    [R2, 'still-held'],
  ]);
  expect(seen.closed).toEqual([]);
});

test('the same eventId is delivered as often as it arrives: once per channel, and again on a repeat', async () => {
  const { socket, seen } = await hold();
  socket.openEventChannel(R1);
  socket.openEventChannel(R2);
  await waitFor(() => sent('open', channel(R2)) === 1);
  opened(channel(R1), seeded);
  opened(channel(R2), seeded);
  appended(channel(R1), seeded + 1, append('delivery-1', { excerpt: 'whole' }));
  appended(channel(R2), seeded + 1, append('delivery-1', {}));
  appended(channel(R1), seeded + 2, append('delivery-1', { excerpt: 'whole' }));
  await waitFor(() => seen.events.length === 3);
  expect(seen.events.map(([held, event, seq]) => [held.resourceId, event, seq])).toEqual([
    [R1, append('delivery-1', { excerpt: 'whole' }), seeded + 1],
    [R2, append('delivery-1', {}), seeded + 1],
    [R1, append('delivery-1', { excerpt: 'whole' }), seeded + 2],
  ]);
  expect(seen.gaps).toEqual([]);
});

test('a dropped connection re-presents and reopens the held channels', async () => {
  const { socket, seen } = await hold();
  socket.openEventChannel(R1);
  socket.openEventChannel(R2);
  await waitFor(() => sent('open', channel(R2)) === 1);
  opened(channel(R1), seeded);
  opened(channel(R2), seeded);
  appended(channel(R1), seeded + 1, append('before-the-drop'));
  await waitFor(() => seen.events.length === 1);
  socket.leaveEventChannel(R2);
  await waitFor(() => sent('close', channel(R2)) === 1);

  kingdom?.close();
  await waitFor(() => sent('open', channel(R1)) === 2, 5000);
  expect(presentations()).toBe(2);
  expect(sent('open', channel(R2))).toBe(1);
  // Three events were published while it was away. None is replayed, and the seq it resumes at is
  // the new snapshot's: the miss shows only as `onOpened` firing again.
  opened(channel(R1), seeded + 4);
  appended(channel(R1), seeded + 5, append('after-the-drop'));
  await waitFor(() => seen.events.length === 2);
  expect(seen.events.map(([, event, seq]) => [event.eventId, seq])).toEqual([
    ['before-the-drop', seeded + 1],
    ['after-the-drop', seeded + 5],
  ]);
  expect(seen.opened.map((held) => held.resourceId)).toEqual([R1, R2, R1]);
  expect(seen.gaps).toEqual([]);
  expect(seen.closed).toEqual([]);
});

test('a socket says when its connection is lost, once for each loss', async () => {
  let disconnected = 0;
  socket = new SignetSocket({
    client,
    retryBaseMs: 20,
    onDisconnected: () => void disconnected++,
    eventStreams: { onEvent: () => {} },
  });
  socket.openEventChannel(R1);
  socket.start();
  await waitFor(() => sent('open', channel(R1)) === 1);
  expect(disconnected).toBe(0);

  kingdom?.close();
  await waitFor(() => sent('open', channel(R1)) === 2, 5000);
  expect(disconnected).toBe(1);

  socket.close();
  await settle();
  expect(disconnected).toBe(1);
});

test('a lapsed presentation re-presents, then reopens the channel', async () => {
  const { socket, seen } = await hold();
  socket.openEventChannel(R1);
  await waitFor(() => sent('open', channel(R1)) === 1);
  opened(channel(R1), seeded);
  await waitFor(() => seen.opened.length === 1);
  expect(presentations()).toBe(1);
  toHolder({ type: 'closed', stream: channel(R1), reason: 'presentationExpired' });
  await waitFor(() => presentations() === 2 && sent('open', channel(R1)) === 2, 5000);
  const order = frames.map((frame) => frame.action);
  expect(order.lastIndexOf('authenticateSignet')).toBeLessThan(order.lastIndexOf('open'));
  expect(seen.closed).toEqual([]);
  expect(socket.heldEventChannels()).toEqual([R1]);
});

test('threads and events share one socket: a thread gap resyncs, an event gap delivers', async () => {
  const { socket, seen } = await hold();
  socket.open(T1);
  socket.openEventChannel(R1);
  await waitFor(() => sent('open', thread(T1)) === 1 && sent('open', channel(R1)) === 1);
  expect(socket.threads()).toEqual([T1]);
  expect(socket.heldEventChannels()).toEqual([R1]);

  const threadData = (action: 'snapshot' | 'append', seq: number, payload: unknown) =>
    toHolder({ category: 'data', action, stream: thread(T1), seq, payload, type: 'append' });
  toHolder({ type: 'opened', stream: thread(T1) });
  threadData('snapshot', 3, { data: view(10) });
  opened(channel(R1), seeded);
  threadData('append', 3, entry(10)); // already in the snapshot
  threadData('append', 4, entry(11));
  appended(channel(R1), seeded + 1, append('delivery-1'));
  await waitFor(() => seen.entries.length === 1 && seen.events.length === 1);
  expect(seen.snapshots).toEqual([[T1, 10]]);
  expect(seen.entries).toEqual([[T1, 11]]);

  // The same jump on both: the thread drops the append and reopens for a fresh snapshot (which
  // holds it); the channel, whose snapshot holds nothing, delivers it.
  threadData('append', 6, entry(13));
  appended(channel(R1), seeded + 3, append('delivery-3'));
  await waitFor(() => sent('open', thread(T1)) === 2 && seen.events.length === 2);
  threadData('append', 7, entry(14)); // before the new snapshot: already in it
  threadData('snapshot', 7, { data: view(14) });
  await waitFor(() => seen.snapshots.length === 2);
  expect(seen.entries).toEqual([[T1, 11]]);
  expect(seen.events.map(([, event]) => event.eventId)).toEqual(['delivery-1', 'delivery-3']);
  expect(seen.gaps).toEqual([
    [
      { signetId, resourceId: R1 },
      { after: seeded + 1, seq: seeded + 3 },
    ],
  ]);
  expect(sent('open', channel(R1))).toBe(1);

  // Closing one family's stream leaves the other's open.
  toHolder({ type: 'closed', stream: channel(R1), reason: 'expired' });
  await waitFor(() => seen.closed.length === 1);
  threadData('append', 8, entry(15));
  await waitFor(() => seen.entries.length === 2);
  expect(socket.threads()).toEqual([T1]);
  expect(socket.heldEventChannels()).toEqual([]);
  expect(seen.errors).toEqual([]);
});

test('a socket given no eventStreams refuses to open a channel', () => {
  socket = new SignetSocket({ client, onSnapshot: () => {}, onEntry: () => {} });
  expect(() => socket?.openEventChannel(R1)).toThrow('Pass eventStreams to hold event channels');
  expect(socket.heldEventChannels()).toEqual([]);
  socket.leaveEventChannel(R1);
});

test('event errors with no handler of their own go to the socket onError', async () => {
  const errors: unknown[] = [];
  const events: string[] = [];
  socket = new SignetSocket({
    client,
    onError: (error) => void errors.push(error),
    eventStreams: { onEvent: (_held, event) => void events.push(event.eventId) },
  });
  expect(() => socket?.open(T1)).toThrow('Pass onSnapshot and onEntry to hold thread views');
  socket.openEventChannel(R1);
  socket.start();
  await waitFor(() => sent('open', channel(R1)) === 1);
  opened(channel(R1), seeded);
  appended(channel(R1), seeded + 1, { event: {} });
  appended(channel(R1), seeded + 2, append('readable'));
  await waitFor(() => events.length === 1);
  expect(errors).toHaveLength(1);
});
