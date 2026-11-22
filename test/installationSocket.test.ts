import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerWebSocket } from 'bun';
import {
  generateSignetKey,
  type InstallationSnapshot,
  InstallationSocket,
  keyThumbprint,
  signetPublicKey,
  verifySignetProof,
  writePrivateJson,
} from '../src';

const nonce = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
const signet = {
  signetId: Bun.randomUUIDv7(),
  name: 'Studio Foundry',
  enrollmentId: null,
  resources: [],
  owner: {
    ownerModel: 'User' as const,
    userId: Bun.randomUUIDv7(),
    organizationId: null,
    spaceId: null,
  },
};
const empty = { pending: null, declinedAt: null, inquiries: [], hostedSignetRequests: [] };
const frames: Record<string, unknown>[] = [];
const sockets = new Set<ServerWebSocket<unknown>>();
const polls: string[] = [];
let server: ReturnType<typeof Bun.serve>;
let url: string;
let keyFile: string;
let thumbprint: string;

const waitFor = async (predicate: () => boolean, timeoutMs = 3000) => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw Error('waitFor timed out');
    await Bun.sleep(5);
  }
};

beforeAll(async () => {
  const key = generateSignetKey();
  keyFile = join(await mkdtemp(join(tmpdir(), 'signet-socket-')), 'key.json');
  await writePrivateJson(keyFile, key);
  thumbprint = await keyThumbprint(signetPublicKey(key));
  server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      if (req.headers.get('upgrade') === 'websocket')
        return srv.upgrade(req, { data: null }) ? undefined : new Response(null, { status: 426 });
      const action = new URL(req.url).pathname.split('/').at(-1)!;
      if (action === 'nonce') return Response.json({ data: { nonce: nonce() } });
      polls.push(action);
      if (action === 'installationInquiries') return Response.json({ data: empty });
      return Response.json({ data: { signets: [], hostedSignets: [] } });
    },
    websocket: {
      open(ws) {
        sockets.add(ws);
        ws.send(JSON.stringify({ type: 'connected', connectionId: Bun.randomUUIDv7() }));
      },
      async message(ws, raw) {
        const frame = JSON.parse(String(raw));
        frames.push(frame);
        if (frame.action !== 'authenticateInstallation') return;
        const proof = await verifySignetProof({
          proof: frame.proof,
          url: `${url}/api/v1/access/installationSocket`,
          method: 'POST',
          now: new Date(),
        });
        expect(proof.keyThumbprint).toBe(thumbprint);
        ws.send(JSON.stringify({ type: 'installation', installationId: Bun.randomUUIDv7() }));
        ws.send(
          JSON.stringify({
            type: 'installation.snapshot',
            ...empty,
            signets: [signet],
            hostedSignets: [],
          }),
        );
      },
      close(ws) {
        sockets.delete(ws);
      },
    },
  });
  url = `http://localhost:${server.port}`;
});

afterAll(() => server.stop(true));

test('proves its key, takes snapshots, polls while down and stops when revoked', async () => {
  const snapshots: InstallationSnapshot[] = [];
  let revoked = false;
  const socket = new InstallationSocket({
    url,
    keyFile,
    viewerUrl: 'https://studio.trycloudflare.com',
    onSnapshot: (snapshot) => void snapshots.push(snapshot),
    onRevoked: () => {
      revoked = true;
    },
    retryBaseMs: 20,
    pollMs: 10_000,
    pingMs: 30,
    sessionCount: () => 2,
  });
  socket.start();
  await waitFor(() => snapshots.length === 1);
  expect(snapshots[0]!.signets).toEqual([signet]);
  await waitFor(() => frames.some((frame) => frame.action === 'advertise'));
  expect(socket.connected).toBe(true);
  await waitFor(() => frames.some((frame) => frame.action === 'ping' && frame.sessionCount === 2));
  socket.start();
  expect(sockets.size).toBe(1);

  for (const ws of sockets) ws.close();
  await waitFor(() => polls.length === 2);
  expect(polls.sort()).toEqual(['installationInquiries', 'installationSignets']);
  await waitFor(() => snapshots.length === 3);
  expect(snapshots[1]!.signets).toEqual([]);
  expect(socket.connected).toBe(true);

  for (const ws of sockets) ws.send(JSON.stringify({ type: 'installationRevoked' }));
  await waitFor(() => revoked);
  await Bun.sleep(60);
  expect(sockets.size).toBe(0);
  expect(socket.connected).toBe(false);
});

test('serves its viewer over the socket: says so on connect, answers a forwarded request, and stops when switched off', async () => {
  frames.length = 0;
  const socket = new InstallationSocket({
    url,
    keyFile,
    onSnapshot: () => {},
    viewer: {
      request: (request) =>
        Response.json({ path: new URL(request.url).pathname, host: new URL(request.url).host }),
    },
    retryBaseMs: 20,
    pollMs: 10_000,
  });
  socket.start();
  await waitFor(() => frames.some((frame) => frame.action === 'viewer.serving'));
  expect(frames.find((frame) => frame.action === 'viewer.serving')).toEqual({
    action: 'viewer.serving',
    serving: true,
  });
  const requestId = Bun.randomUUIDv7();
  for (const ws of sockets)
    ws.send(
      JSON.stringify({
        type: 'viewer.request',
        requestId,
        origin: 'https://studio.foundry.example.test',
        method: 'GET',
        path: '/api/health',
        headers: {},
        hasBody: false,
      }),
    );
  await waitFor(() =>
    frames.some((frame) => frame.action === 'viewer.response.body' && frame.last === true),
  );
  expect(frames.find((frame) => frame.action === 'viewer.response')).toMatchObject({
    requestId,
    status: 200,
    hasBody: true,
  });
  const body = frames
    .filter((frame) => frame.action === 'viewer.response.body')
    .map((frame) => Buffer.from(String(frame.data), 'base64').toString('utf8'))
    .join('');
  expect(JSON.parse(body)).toEqual({ path: '/api/health', host: 'studio.foundry.example.test' });

  socket.serveViewer(false);
  await waitFor(
    () => frames.at(-1)?.action === 'viewer.serving' && frames.at(-1)?.serving === false,
  );
  socket.close();
  await waitFor(() => sockets.size === 0);
});
