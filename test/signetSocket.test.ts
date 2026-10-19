import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerWebSocket } from 'bun';
import {
  accessThreadStreamName,
  authenticateSignetFrameSchema,
  generateSignetKey,
  renewPresentationFrameSchema,
  SignetClient,
  SignetSocket,
  saveCollectedSignet,
  type ThreadEntry,
  type ThreadViewResult,
  verifySignetProof,
  writePrivateJson,
} from '../src';

const uuid = () => crypto.randomUUID();
const T1 = 'thread_0199f0aa-0000-7000-8000-000000000001';
const T2 = 'thread_0199f0aa-0000-7000-8000-000000000002';
const signetId = uuid();
const enrollmentId = uuid();
const nonces = new Set<string>();
const frames: Record<string, unknown>[] = [];
let tokens = 0;
let failRenewal = false;
let presentForMs: number | null = null;
const accessToken = () => `kingdom_${String(tokens).padStart(43, 'a')}`;
const minutes = (count: number) => new Date(Date.now() + count * 60_000).toISOString();
let kingdom: ServerWebSocket<unknown> | null = null;
let server: ReturnType<typeof Bun.serve>;
let url: string;
let client: SignetClient;

const waitFor = async (predicate: () => boolean, timeoutMs = 3000) => {
  for (const start = Date.now(); !predicate(); await Bun.sleep(5))
    if (Date.now() - start > timeoutMs) throw Error('waitFor timed out');
};
const toMember = (frame: Record<string, unknown>) => kingdom?.send(JSON.stringify(frame));
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
const opens = (threadId: string) =>
  frames.filter(
    (frame) =>
      frame.action === 'open' && frame.stream === accessThreadStreamName({ signetId, threadId }),
  ).length;

beforeAll(async () => {
  const directory = await mkdtemp(join(tmpdir(), 'signet-presenter-'));
  const keyFile = join(directory, 'key.json');
  const credentialFile = join(directory, 'signet.json');
  await writePrivateJson(keyFile, generateSignetKey());
  server = Bun.serve({
    port: 0,
    async fetch(req, srv) {
      if (req.headers.get('upgrade') === 'websocket')
        return srv.upgrade(req, { data: null }) ? undefined : new Response(null, { status: 426 });
      const action = new URL(req.url).pathname.split('/').at(-1);
      if (action === 'nonce') {
        const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
        nonces.add(nonce);
        return Response.json({ data: { nonce } });
      }
      if (action === 'renewSignet') {
        if (failRenewal) return Response.json({ error: 'revoked' }, { status: 401 });
        tokens++;
        return Response.json({
          data: {
            enrollmentId,
            lifecycle: 'ongoing',
            taskId: null,
            accessToken: accessToken(),
            expiresAt: minutes(5),
            renewalExpiresAt: minutes(60 * 24),
            idleExpiresAt: minutes(60 * 24),
            tokenType: 'DPoP',
          },
        });
      }
      return new Response(null, { status: 404 });
    },
    websocket: {
      open(ws) {
        kingdom = ws;
        ws.send(JSON.stringify({ type: 'connected', connectionId: uuid() }));
      },
      async message(ws, raw) {
        const frame = JSON.parse(String(raw)) as Record<string, unknown>;
        frames.push(frame);
        if (frame.action !== 'authenticateSignet' && frame.action !== 'renewPresentation') return;
        const presented = (
          frame.action === 'authenticateSignet'
            ? authenticateSignetFrameSchema
            : renewPresentationFrameSchema
        ).parse(frame);
        // The Installation pattern: bound to the fixed socket URL, a single-use nonce, `ath`.
        const proof = await verifySignetProof({
          proof: presented.proof,
          url: `${url}/api/v1/access/signetSocket`,
          method: 'POST',
          now: new Date(),
          token: presented.accessToken,
        });
        if (!nonces.delete(proof.nonce)) {
          ws.send(JSON.stringify({ type: 'signetRejected' }));
          return;
        }
        // A renewed presentation holds longer, so the test sees exactly one renewal.
        const expiresAt =
          presentForMs === null
            ? minutes(frame.action === 'authenticateSignet' ? 5 : 60)
            : new Date(Date.now() + presentForMs).toISOString();
        ws.send(JSON.stringify({ type: 'signet', signetId, enrollmentId, expiresAt }));
      },
      close(ws) {
        if (kingdom === ws) kingdom = null;
      },
    },
  });
  url = `http://localhost:${server.port}`;
  await saveCollectedSignet(credentialFile, url, keyFile, {
    signetId,
    enrollmentId,
    lifecycle: 'ongoing',
    taskId: null,
    accessToken: accessToken(),
    renewalCredential: `signet_renew_${'r'.repeat(43)}`,
    expiresAt: minutes(5),
    renewalExpiresAt: minutes(60 * 24),
    idleExpiresAt: minutes(60 * 24),
    tokenType: 'DPoP',
  });
  client = await SignetClient.fromFile(credentialFile);
});

afterAll(() => server.stop(true));

test('presents its Signet, renews before expiry, and holds thread streams by seq', async () => {
  const snapshots: [string, number][] = [];
  const entries: [string, number][] = [];
  const closed: [string, string | null][] = [];
  const errors: unknown[] = [];
  const socket = new SignetSocket({
    client,
    // Renew almost at once, so the test sees `renewPresentation`.
    renewBeforeMs: 5 * 60_000 - 50,
    retryBaseMs: 20,
    onSnapshot: (stream, received) => void snapshots.push([stream.threadId, received.journalSeq]),
    onEntry: (stream, received) => void entries.push([stream.threadId, received.journalSeq]),
    onClosed: (stream, reason) => void closed.push([stream.threadId, reason]),
    onError: (error) => void errors.push(error),
  });
  socket.open(T1);
  socket.start();
  await waitFor(() => socket.connected);
  expect(frames[0]).toMatchObject({ action: 'authenticateSignet', accessToken: accessToken() });
  await waitFor(() => opens(T1) === 1);

  await waitFor(() => frames.some((frame) => frame.action === 'renewPresentation'));
  const renewal = renewPresentationFrameSchema.parse(
    frames.find((frame) => frame.action === 'renewPresentation'),
  );
  expect(renewal.accessToken).toBe(accessToken());
  expect(tokens).toBe(1);

  const stream = accessThreadStreamName({ signetId, threadId: T1 });
  const data = (action: 'snapshot' | 'append', seq: number, payload: unknown) =>
    toMember({ category: 'data', action, stream, seq, payload, type: 'append' });
  toMember({ type: 'opened', stream });
  data('snapshot', 3, { data: view(10) });
  data('append', 3, entry(10)); // already in the snapshot
  data('append', 4, entry(11));
  data('append', 4, entry(11)); // a duplicate
  await waitFor(() => entries.length === 1);
  expect(snapshots).toEqual([[T1, 10]]);
  expect(entries).toEqual([[T1, 11]]);

  // A gap: re-open for a fresh snapshot, with no replay.
  data('append', 6, entry(13));
  await waitFor(() => opens(T1) === 2);
  data('append', 7, entry(14)); // before the new snapshot: already in it
  data('snapshot', 7, { data: view(14) });
  await waitFor(() => snapshots.length === 2);
  toMember({ type: 'resync', stream });
  await waitFor(() => opens(T1) === 3);
  data('snapshot', 8, { data: { ...view(15), entries: [entry(15), { kind: 'later' }] } });
  await waitFor(() => snapshots.length === 3);
  expect(errors).toHaveLength(1); // the unreadable entry, dropped; the view is kept
  expect(entries).toEqual([[T1, 11]]);

  // Kingdom closes it (a revocation); the member is told why.
  toMember({ type: 'closed', stream, reason: 'revoked' });
  await waitFor(() => closed.length === 1);
  expect(closed).toEqual([[T1, 'revoked']]);
  expect(socket.threads()).toEqual([]);

  // Leaving is acknowledged, not reported as Kingdom closing it.
  socket.open(T2);
  await waitFor(() => opens(T2) === 1);
  socket.leave(T2);
  const second = accessThreadStreamName({ signetId, threadId: T2 });
  await waitFor(() => frames.some((frame) => frame.action === 'close' && frame.stream === second));
  toMember({ type: 'closed', stream: second });
  socket.open(T2);
  await waitFor(() => opens(T2) === 2);
  // The host is offline: the member keeps the thread and retries with backoff.
  toMember({ type: 'openRejected', stream: second, reason: 'hostOffline' });
  await waitFor(() => opens(T2) === 3);
  expect(closed).toHaveLength(1);
  // A revision closes the stream; the member reopens under the new lens.
  toMember({ type: 'opened', stream: second });
  toMember({
    category: 'data',
    action: 'snapshot',
    stream: second,
    seq: 1,
    payload: { data: view(20) },
  });
  await waitFor(() => snapshots.length === 4);
  toMember({ type: 'closed', stream: second, reason: 'revised' });
  await waitFor(() => opens(T2) === 4);
  // While that open is pending, a resync asks for nothing more: one open in flight per stream.
  toMember({ type: 'resync', stream: second });
  await Bun.sleep(30);
  expect(opens(T2)).toBe(4);
  // ...and once it is answered, the asked-for fresh snapshot follows.
  toMember({
    category: 'data',
    action: 'snapshot',
    stream: second,
    seq: 1,
    payload: { data: view(21) },
  });
  await waitFor(() => opens(T2) === 5);
  toMember({
    category: 'data',
    action: 'snapshot',
    stream: second,
    seq: 1,
    payload: { data: { ...view(22), newField: true } },
  });
  await waitFor(() => snapshots.length === 6);
  expect(snapshots.at(-1)).toEqual([T2, 22]); // a field this package doesn't know is ignored
  // A narrowing that leaves this thread out: Kingdom refuses the reopen, and the member is told.
  toMember({ type: 'openRejected', stream: second, reason: 'unauthorized' });
  await waitFor(() => closed.length === 2);
  expect(closed[1]).toEqual([T2, 'unauthorized']);

  // The presentation lapsed: Kingdom closed the stream; the socket re-presents and reopens it.
  socket.open(T2);
  await waitFor(() => opens(T2) === 6);
  const presentations = () =>
    frames.filter((frame) => frame.action === 'authenticateSignet').length;
  toMember({ type: 'closed', stream: second, reason: 'presentationExpired' });
  await waitFor(() => presentations() === 2 && opens(T2) === 7, 5000);
  expect(closed).toHaveLength(2);
  socket.leave(T2);

  // A dropped socket re-presents and re-opens what it holds.
  socket.open(T1);
  const before = opens(T1);
  kingdom?.close();
  await waitFor(() => opens(T1) === before + 1, 5000);
  expect(frames.filter((frame) => frame.action === 'authenticateSignet')).toHaveLength(3);
  socket.close();
});

test('a renewal that keeps failing past expiry reconnects and presents afresh', async () => {
  frames.length = 0;
  failRenewal = true;
  presentForMs = 150;
  const errors: unknown[] = [];
  const socket = new SignetSocket({
    client,
    renewBeforeMs: 100,
    retryBaseMs: 20,
    onSnapshot: () => {},
    onEntry: () => {},
    onError: (error) => void errors.push(error),
  });
  socket.start();
  try {
    await waitFor(
      () => frames.filter((frame) => frame.action === 'authenticateSignet').length >= 2,
      5000,
    );
    expect(frames.some((frame) => frame.action === 'renewPresentation')).toBe(false);
    expect(errors.length).toBeGreaterThan(0);
  } finally {
    socket.close();
    failRenewal = false;
    presentForMs = null;
  }
});
