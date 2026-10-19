import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerWebSocket } from 'bun';
import {
  accessThreadStreamName,
  generateSignetKey,
  InstallationSocket,
  type ThreadEntry,
  type ThreadHost,
  type ThreadSubscription,
  threadAppendFrameSchema,
  threadRefused,
  threadResponseFrameSchema,
  threadResult,
  writePrivateJson,
} from '../src';

const uuid = () => crypto.randomUUID();
const T1 = 'thread_0199f0aa-0000-7000-8000-000000000001';
const received: Record<string, unknown>[] = [];
let kingdom: ServerWebSocket<unknown> | null = null;
let server: ReturnType<typeof Bun.serve>;
let url: string;
let keyFile: string;
let socket: InstallationSocket | null = null;

const waitFor = async (predicate: () => boolean, timeoutMs = 3000) => {
  for (const start = Date.now(); !predicate(); await Bun.sleep(5))
    if (Date.now() - start > timeoutMs) throw Error('waitFor timed out');
};
const sendHost = (frame: Record<string, unknown>) => kingdom?.send(JSON.stringify(frame));
const responseTo = async (requestId: string) => {
  await waitFor(() => received.some((frame) => frame.requestId === requestId));
  return received.find((frame) => frame.requestId === requestId)!;
};
const entry = (journalSeq: number, text = `entry ${journalSeq}`): ThreadEntry => ({
  journalSeq,
  at: new Date().toISOString(),
  kind: 'post',
  member: { kind: 'signet', id: uuid() },
  text,
});
const relayed = (overrides: Record<string, unknown> = {}) => ({
  requestId: uuid(),
  signetId: uuid(),
  acceptedRevision: 1,
  member: { signetId: uuid(), displayName: 'JobCo' },
  lens: { threads: { form: 'ids', ids: [T1] } },
  ...overrides,
});

beforeAll(async () => {
  keyFile = join(await mkdtemp(join(tmpdir(), 'signet-host-')), 'key.json');
  await writePrivateJson(keyFile, generateSignetKey());
  server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      if (req.headers.get('upgrade') === 'websocket')
        return srv.upgrade(req, { data: null }) ? undefined : new Response(null, { status: 426 });
      const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
      return Response.json({ data: { nonce } });
    },
    websocket: {
      open(ws) {
        kingdom = ws;
        ws.send(JSON.stringify({ type: 'connected', connectionId: uuid() }));
      },
      message(ws, raw) {
        const frame = JSON.parse(String(raw)) as Record<string, unknown>;
        if (frame.action === 'authenticateInstallation') {
          ws.send(JSON.stringify({ type: 'installation', installationId: uuid() }));
          return;
        }
        if (frame.action !== 'ping') received.push(frame);
      },
      close(ws) {
        if (kingdom === ws) kingdom = null;
      },
    },
  });
  url = `http://localhost:${server.port}`;
});

afterEach(() => {
  socket?.close();
  socket = null;
  received.length = 0;
});
afterAll(() => server.stop(true));

const host = (overrides: Partial<ThreadHost> = {}): ThreadHost => ({
  'thread.read': () => threadResult({ journalSeq: 3, entries: [entry(3)], truncated: false }),
  'thread.prompt': () => threadResult({ accepted: true, journalSeq: 7, duplicate: false }),
  'thread.floor': () => threadResult({ mode: 'talk', holder: null, expiresAt: null }),
  'prompt.resolve': () => threadResult({ resolved: true }),
  'thread.subscribe': () => threadResult({ journalSeq: 5, entries: [entry(5)], truncated: false }),
  ...overrides,
});
const connect = async (threads?: ThreadHost, leaseMs?: number) => {
  socket = new InstallationSocket({ url, keyFile, threads, leaseMs, onSnapshot: () => {} });
  socket.start();
  await waitFor(() => socket?.connected === true && kingdom !== null);
  return socket;
};

test('thread.request round-trips, typed by its operation', async () => {
  const seen: unknown[] = [];
  await connect(
    host({
      'thread.prompt': (frame) => {
        seen.push(frame.input.text, frame.lens.delivery);
        return threadResult({ accepted: true, journalSeq: 7, duplicate: false });
      },
    }),
  );
  const frame = relayed();
  sendHost({
    type: 'thread.request',
    ...frame,
    operation: 'thread.prompt',
    input: { threadId: T1, postId: uuid(), text: 'Watching for X' },
  });
  const response = threadResponseFrameSchema('thread.prompt').parse(
    await responseTo(frame.requestId),
  );
  expect(response.outcome).toEqual({
    ok: true,
    result: { accepted: true, journalSeq: 7, duplicate: false },
  });
  expect(seen).toEqual(['Watching for X', 'note']);
});

test('refusals: a host refusal, an unknown selector, an unreadable frame, a broken handler', async () => {
  let calls = 0;
  await connect(
    host({
      'thread.prompt': () => {
        calls++;
        return threadRefused('floor_denied');
      },
      'thread.read': () => {
        throw Error('journal unavailable');
      },
      // A result the contract doesn't allow is never sent as-is.
      'thread.floor': () => threadResult({ mode: 'talk', holder: null, expiresAt: 'soon' }),
    }),
  );
  const outcome = async (frame: Record<string, unknown>) => {
    sendHost(frame);
    return (await responseTo(frame.requestId as string)).outcome;
  };
  const prompt = {
    operation: 'thread.prompt',
    input: { threadId: T1, postId: uuid(), text: 'hi' },
  };
  expect(await outcome({ type: 'thread.request', ...relayed(), ...prompt })).toEqual({
    ok: false,
    refusal: 'floor_denied',
  });
  expect(calls).toBe(1);
  expect(
    await outcome({
      type: 'thread.request',
      ...relayed({ lens: { threads: { form: 'tag', tag: 'job-search' } } }),
      ...prompt,
    }),
  ).toMatchObject({ ok: false, refusal: 'unknown_selector' });
  expect(
    await outcome({
      type: 'thread.request',
      ...relayed(),
      operation: 'thread.prompt',
      input: { threadId: T1 },
    }),
  ).toMatchObject({ ok: false, refusal: 'invalid_request' });
  expect(calls).toBe(1);
  expect(
    await outcome({
      type: 'thread.request',
      ...relayed(),
      operation: 'thread.read',
      input: { threadId: T1 },
    }),
  ).toMatchObject({ ok: false, refusal: 'failed' });
  expect(
    await outcome({
      type: 'thread.request',
      ...relayed(),
      operation: 'thread.floor',
      input: { threadId: T1, floor: { action: 'request' } },
    }),
  ).toMatchObject({ ok: false, refusal: 'failed' });
});

test('a host that serves no threads answers failed at once', async () => {
  await connect();
  const frame = relayed();
  sendHost({ type: 'thread.request', ...frame, operation: 'thread.read', input: { threadId: T1 } });
  expect((await responseTo(frame.requestId)).outcome).toMatchObject({
    ok: false,
    refusal: 'failed',
  });
});

test('subscribe is atomic: entries written while the snapshot is taken follow it, none twice', async () => {
  let release: () => void = () => {};
  const subscribed = new Promise<void>((resolve) => {
    release = resolve;
  });
  const live = await connect(
    host({
      'thread.subscribe': async () => {
        await subscribed;
        return threadResult({ journalSeq: 5, entries: [entry(5)], truncated: false });
      },
    }),
  );
  const frame = relayed();
  sendHost({ type: 'thread.subscribe', ...frame, threadId: T1 });
  await waitFor(() => live.threadSubscriptions().length === 1);
  // Written while the host takes the view: 5 is in the snapshot, 6 and 7 come after it.
  expect(live.appendThread(frame.requestId, { journalSeq: 7, entry: entry(7) })).toBe(true);
  expect(live.appendThread(frame.requestId, { journalSeq: 5, entry: entry(5) })).toBe(true);
  expect(live.appendThread(frame.requestId, { journalSeq: 6, entry: entry(6) })).toBe(true);
  expect(received).toEqual([]);
  release();
  await waitFor(() => received.length === 3);
  expect(received[0]).toMatchObject({ action: 'thread.response', requestId: frame.requestId });
  const appends = received.slice(1).map((sent) => threadAppendFrameSchema.parse(sent));
  expect(appends.map((append) => append.journalSeq)).toEqual([6, 7]);
  expect(appends[0]).toMatchObject({
    subscriptionId: frame.requestId,
    signetId: frame.signetId,
    threadId: T1,
  });
  // Already sent: skipped, not re-sent.
  expect(live.appendThread(frame.requestId, { journalSeq: 6, entry: entry(6) })).toBe(true);
  live.appendThread(frame.requestId, { journalSeq: 8, entry: entry(8) });
  await waitFor(() => received.length === 4);
  expect(threadAppendFrameSchema.parse(received[3]).journalSeq).toBe(8);
});

test('a refused subscribe leaves no subscription', async () => {
  const live = await connect(host({ 'thread.subscribe': () => threadRefused('unknown_thread') }));
  const frame = relayed();
  sendHost({ type: 'thread.subscribe', ...frame, threadId: T1 });
  expect((await responseTo(frame.requestId)).outcome).toEqual({
    ok: false,
    refusal: 'unknown_thread',
  });
  expect(live.threadSubscriptions()).toEqual([]);
  expect(live.appendThread(frame.requestId, { journalSeq: 9, entry: entry(9) })).toBe(false);
});

test('unsubscribe, the lease, and a dropped socket each end a subscription', async () => {
  const ended: [ThreadSubscription, string][] = [];
  const live = await connect(
    host({ ended: (subscription, reason) => void ended.push([subscription, reason]) }),
    150,
  );
  const subscribe = async () => {
    const frame = relayed();
    sendHost({ type: 'thread.subscribe', ...frame, threadId: T1 });
    await responseTo(frame.requestId);
    return frame.requestId;
  };
  const unsubscribed = await subscribe();
  sendHost({ type: 'thread.unsubscribe', subscriptionId: unsubscribed });
  await waitFor(() => ended.length === 1);
  expect(ended[0]).toMatchObject([{ subscriptionId: unsubscribed, threadId: T1 }, 'unsubscribed']);
  expect(live.appendThread(unsubscribed, { journalSeq: 9, entry: entry(9) })).toBe(false);

  const leased = await subscribe();
  const lapsed = await subscribe();
  // Kingdom re-asserts only `leased` on its sweeps; `lapsed` runs out.
  for (let sweep = 0; sweep < 6; sweep++) {
    sendHost({ type: 'thread.lease', subscriptionIds: [leased] });
    await Bun.sleep(50);
  }
  expect(
    ended.map(([subscription, reason]) => [subscription.subscriptionId, reason]),
  ).toContainEqual([lapsed, 'lease']);
  expect(live.threadSubscriptions().map((subscription) => subscription.subscriptionId)).toEqual([
    leased,
  ]);

  kingdom?.close();
  await waitFor(() => ended.some(([, reason]) => reason === 'disconnected'));
  expect(live.threadSubscriptions()).toEqual([]);
});

test('an Installation recipient holds a thread view over its own socket, with no authenticateSignet', async () => {
  const views: number[] = [];
  socket = new InstallationSocket({
    url,
    keyFile,
    onSnapshot: () => {},
    threadStreams: {
      onSnapshot: (_stream, view) => void views.push(view.journalSeq),
      onEntry: () => {},
    },
  });
  const signetId = uuid();
  socket.openThread({ signetId, threadId: T1 });
  socket.start();
  const stream = accessThreadStreamName({ signetId, threadId: T1 });
  await waitFor(() => received.some((frame) => frame.action === 'open' && frame.stream === stream));
  expect(received.some((frame) => frame.action === 'authenticateSignet')).toBe(false);
  sendHost({
    category: 'data',
    action: 'snapshot',
    stream,
    seq: 1,
    payload: { data: { journalSeq: 4, entries: [entry(4)], truncated: false } },
  });
  await waitFor(() => views.length === 1);
  expect(views).toEqual([4]);
});
