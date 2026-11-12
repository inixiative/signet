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
  type EventStreamKey,
  generateSignetKey,
  InstallationSocket,
  type ThreadEntry,
  writePrivateJson,
} from '../src';

const uuid = () => Bun.randomUUIDv7();
const T1 = 'thread_0199f0aa-0000-7000-8000-000000000001';
const seeded = 1_762_000_000_000_000;
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
const settle = () => Bun.sleep(40);
const toHolder = (frame: Record<string, unknown>) => kingdom?.send(JSON.stringify(frame));
const sent = (action: string, stream: string) =>
  received.filter((frame) => frame.action === action && frame.stream === stream).length;
const append = (eventId: string, event: Record<string, unknown> = {}) =>
  ({ eventId, type: 'pull_request.review_requested', event }) satisfies AccessEventsAppend;
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
const appended = (stream: string, seq: number, payload: unknown) =>
  toHolder({ category: 'data', action: 'append', stream, seq, type: 'append', payload });
const entry = (journalSeq: number): ThreadEntry => ({
  journalSeq,
  at: new Date().toISOString(),
  kind: 'post',
  member: { kind: 'signet', id: uuid() },
  text: `entry ${journalSeq}`,
});

beforeAll(async () => {
  keyFile = join(await mkdtemp(join(tmpdir(), 'signet-installation-events-')), 'key.json');
  await writePrivateJson(keyFile, generateSignetKey());
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
      if (action === 'installationInquiries')
        return Response.json({
          data: { pending: null, declinedAt: null, inquiries: [], hostedSignetRequests: [] },
        });
      return Response.json({ data: { signets: [], hostedSignets: [] } });
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

afterEach(async () => {
  socket?.close();
  socket = null;
  await waitFor(() => kingdom === null);
  received.length = 0;
});
afterAll(() => server.stop(true));

test('an Installation holds the channels of Signets it holds, keyed by Signet and resource', async () => {
  const events: [EventStreamKey, AccessEventsAppend, number][] = [];
  const gaps: [EventStreamKey, EventStreamGap][] = [];
  const closed: [EventStreamKey, string | null][] = [];
  const first = { signetId: uuid(), resourceId: uuid() };
  const second = { signetId: uuid(), resourceId: first.resourceId };
  socket = new InstallationSocket({
    url,
    keyFile,
    retryBaseMs: 20,
    onSnapshot: () => {},
    eventStreams: {
      onEvent: (held, event, seq) => void events.push([held, event, seq]),
      onGap: (held, gap) => void gaps.push([held, gap]),
      onClosed: (held, reason) => void closed.push([held, reason]),
    },
  });
  // Held before the socket is up: opened once it has proved its key.
  socket.openEventChannel(first);
  socket.openEventChannel(second);
  socket.start();
  await waitFor(() => sent('open', accessEventsStreamName(second)) === 1);
  expect(received.filter((frame) => frame.action === 'open')).toEqual([
    {
      action: 'open',
      stream: `accessEvents:resourceId:${first.resourceId}:signetId:${first.signetId}`,
    },
    {
      action: 'open',
      stream: `accessEvents:resourceId:${second.resourceId}:signetId:${second.signetId}`,
    },
  ]);
  expect(received.some((frame) => frame.action === 'authenticateSignet')).toBe(false);
  expect(socket.heldEventChannels()).toEqual([first, second]);

  // Two Signets on one resource: Kingdom appends the event to both channels, each cut by its own
  // Signet's lens. Both arrive; `eventId` is what a consumer dedupes on.
  opened(accessEventsStreamName(first), seeded);
  opened(accessEventsStreamName(second), seeded + 40);
  appended(accessEventsStreamName(first), seeded + 1, append('delivery-1', { mentions: ['aron'] }));
  appended(accessEventsStreamName(second), seeded + 41, append('delivery-1'));
  await waitFor(() => events.length === 2);
  expect(events).toEqual([
    [first, append('delivery-1', { mentions: ['aron'] }), seeded + 1],
    [second, append('delivery-1'), seeded + 41],
  ]);
  expect(gaps).toEqual([]);

  // A jump on one channel is that channel's gap only.
  appended(accessEventsStreamName(second), seeded + 50, append('delivery-2'));
  await waitFor(() => events.length === 3);
  expect(gaps).toEqual([[second, { after: seeded + 41, seq: seeded + 50 }]]);

  socket.leaveEventChannel(first);
  await waitFor(() => sent('close', accessEventsStreamName(first)) === 1);
  toHolder({ type: 'closed', stream: accessEventsStreamName(first) });
  toHolder({ type: 'closed', stream: accessEventsStreamName(second), reason: 'enrollmentRevoked' });
  await waitFor(() => closed.length === 1);
  expect(closed).toEqual([[second, 'enrollmentRevoked']]);
  expect(socket.heldEventChannels()).toEqual([]);
  await settle();
  expect(sent('open', accessEventsStreamName(second))).toBe(1);
});

test('an Installation reopens its channels after its socket drops, beside its thread views', async () => {
  const events: string[] = [];
  const views: number[] = [];
  const entries: number[] = [];
  const held = { signetId: uuid(), resourceId: uuid() };
  const member = { signetId: uuid(), threadId: T1 };
  socket = new InstallationSocket({
    url,
    keyFile,
    retryBaseMs: 20,
    pollMs: 60_000,
    onSnapshot: () => {},
    threadStreams: {
      onSnapshot: (_stream, view) => void views.push(view.journalSeq),
      onEntry: (_stream, received) => void entries.push(received.journalSeq),
    },
    eventStreams: { onEvent: (_held, event) => void events.push(event.eventId) },
  });
  socket.openThread(member);
  socket.openEventChannel(held);
  socket.start();
  const channel = accessEventsStreamName(held);
  const thread = accessThreadStreamName(member);
  await waitFor(() => sent('open', channel) === 1 && sent('open', thread) === 1);
  toHolder({
    category: 'data',
    action: 'snapshot',
    stream: thread,
    seq: 1,
    payload: { data: { journalSeq: 4, entries: [entry(4)], truncated: false } },
  });
  opened(channel, seeded);
  appended(channel, seeded + 1, append('before-the-drop'));
  await waitFor(() => views.length === 1 && events.length === 1);

  // The thread view resyncs on a jump; the channel beside it delivers.
  toHolder({
    category: 'data',
    action: 'append',
    stream: thread,
    seq: 3,
    type: 'append',
    payload: entry(6),
  });
  appended(channel, seeded + 3, append('jumped'));
  await waitFor(() => sent('open', thread) === 2 && events.length === 2);
  expect(entries).toEqual([]);
  expect(sent('open', channel)).toBe(1);

  kingdom?.close();
  await waitFor(() => sent('open', channel) === 2 && sent('open', thread) === 3, 5000);
  opened(channel, seeded + 9);
  appended(channel, seeded + 10, append('after-the-drop'));
  await waitFor(() => events.length === 3);
  expect(events).toEqual(['before-the-drop', 'jumped', 'after-the-drop']);
});

test('an Installation socket given no eventStreams refuses to open a channel', () => {
  socket = new InstallationSocket({ url, keyFile, onSnapshot: () => {} });
  const held = { signetId: uuid(), resourceId: uuid() };
  expect(() => socket?.openEventChannel(held)).toThrow('Pass eventStreams to hold event channels');
  expect(socket.heldEventChannels()).toEqual([]);
  socket.leaveEventChannel(held);
});
