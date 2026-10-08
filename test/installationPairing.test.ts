import { afterAll, beforeAll, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import {
  holdInstallationSignets,
  InstallationSocket,
  installationDirectory,
  pairInstallation,
  readPrivateJson,
  signetCredentialFile,
} from '../src';

const nonce = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
const owner = {
  ownerModel: 'User' as const,
  userId: crypto.randomUUID(),
  organizationId: null,
  spaceId: null,
};
const inquiryId = crypto.randomUUID();
const signetId = crypto.randomUUID();
const integrationId = crypto.randomUUID();
const laterSignetId = crypto.randomUUID();
const collected = (id: string) => ({
  enrollmentId: crypto.randomUUID(),
  lifecycle: 'ongoing',
  taskId: null,
  accessToken: `kingdom_${'a'.repeat(43)}`,
  expiresAt: new Date(Date.now() + 300000).toISOString(),
  renewalExpiresAt: new Date(Date.now() + 86400000).toISOString(),
  idleExpiresAt: new Date(Date.now() + 86400000).toISOString(),
  tokenType: 'DPoP',
  renewalCredential: `signet_renew_${'r'.repeat(43)}`,
  signetId: id,
  integrationId,
  owner,
});
const calls: string[] = [];
let claimed = false;
let server: ReturnType<typeof Bun.serve>;
let url: string;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      if (req.headers.get('upgrade') === 'websocket') return new Response(null, { status: 426 });
      const action = new URL(req.url).pathname.split('/').at(-1)!;
      calls.push(action);
      const data = (value: unknown) => Response.json({ data: value });
      switch (action) {
        case 'nonce':
          return data({ nonce: nonce() });
        case 'registerInstallation':
          return data({ installationId: crypto.randomUUID() });
        case 'requestRegistration':
          setTimeout(() => {
            claimed = true;
          }, 50);
          return data({
            reviewCode: 'ABCDEF123456',
            expiresAt: new Date(Date.now() + 600000).toISOString(),
          });
        case 'installationInquiries':
          return data({
            pending: claimed
              ? null
              : {
                  reviewCode: 'ABCDEF123456',
                  expiresAt: new Date(Date.now() + 600000).toISOString(),
                },
            declinedAt: null,
            inquiries: claimed
              ? [
                  {
                    id: inquiryId,
                    type: 'registerIntegration',
                    status: 'approved',
                    createdAt: new Date().toISOString(),
                    expiresAt: null,
                    owner,
                    ownerName: 'Aron',
                    integrationId,
                    signetId,
                    deliverBefore: new Date(Date.now() + 600000).toISOString(),
                  },
                ]
              : [],
          });
        case 'installationSignets':
          return data({ signets: [] });
        case 'collectSignet':
          return data(collected(signetId));
        case 'enrollInstallationSignet':
          return data(collected(laterSignetId));
        default:
          return new Response(null, { status: 404 });
      }
    },
  });
  url = `http://localhost:${server.port}`;
});

afterAll(() => server.stop(true));

test('pairs through polling when the socket is refused, confirming the owner before collecting', async () => {
  const root = await mkdtemp(join(tmpdir(), 'signet-pair-'));
  const reviews: string[] = [];
  const confirmed: (string | null)[] = [];
  const paired = await pairInstallation({
    url,
    root,
    kind: 'foundry',
    name: 'Studio Foundry',
    terms: {
      name: 'Studio Foundry',
      lifecycle: 'ongoing',
      resources: [],
      expiresAt: null,
      maxRequests: null,
      maxConcurrent: 2,
    },
    onReview: ({ reviewCode, review }) => void reviews.push(reviewCode, review),
    confirmOwner: async ({ ownerName }) => {
      confirmed.push(ownerName);
      return true;
    },
    socketOptions: { pollMs: 20, retryBaseMs: 1000 },
  });
  expect(reviews).toEqual(['ABCDEF123456', `${url}/dashboard?reviewSignet=ABCDEF123456`]);
  expect(confirmed).toEqual(['Aron']);
  expect(paired.signetId).toBe(signetId);
  expect(paired.owner).toEqual(owner);
  expect(existsSync(paired.credentialFile)).toBe(true);
  expect(existsSync(paired.keyFile)).toBe(true);

  const stray = signetCredentialFile(paired.directory, crypto.randomUUID());
  await writeFile(stray, '{}');
  const enrolls = () => calls.filter((call) => call === 'enrollInstallationSignet').length;
  const later = { signetId: laterSignetId, integrationId, name: 'Later grant', owner };
  const held = await holdInstallationSignets(url, paired.keyFile, paired.directory, [
    { ...later, enrollmentId: null },
  ]);
  expect(held.map((signet) => signet.signetId)).toEqual([laterSignetId]);
  expect(enrolls()).toBe(1);
  expect(existsSync(stray)).toBe(true);
  const current = z
    .object({ enrollmentId: z.uuid() })
    .parse(await readPrivateJson(signetCredentialFile(paired.directory, laterSignetId)));
  await holdInstallationSignets(url, paired.keyFile, paired.directory, [
    { ...later, enrollmentId: current.enrollmentId },
  ]);
  expect(enrolls()).toBe(1);
  await holdInstallationSignets(url, paired.keyFile, paired.directory, [
    { ...later, enrollmentId: crypto.randomUUID() },
  ]);
  expect(enrolls()).toBe(2);
  expect((await readdir(paired.directory)).sort()).toEqual(
    [
      'installation-key.json',
      `signet-${signetId}.json`,
      `signet-${laterSignetId}.json`,
      stray.split('/').at(-1)!,
    ].sort(),
  );
});

test('refuses to collect when the owner is not confirmed', async () => {
  claimed = false;
  const root = await mkdtemp(join(tmpdir(), 'signet-pair-'));
  await expect(
    pairInstallation({
      url,
      root,
      kind: 'archive',
      name: 'Laptop Archive',
      sourceId: crypto.randomUUID(),
      terms: {
        name: 'Laptop Archive',
        lifecycle: 'ongoing',
        resources: [],
        expiresAt: null,
        maxRequests: null,
        maxConcurrent: 4,
      },
      onReview: () => {},
      confirmOwner: async () => false,
      socketOptions: { pollMs: 20, retryBaseMs: 1000 },
    }),
  ).rejects.toThrow('owner was not confirmed');
});

test('treats a Kingdom that never answers the socket proof as down and polls instead', async () => {
  const silent = Bun.serve({
    port: 0,
    fetch(req, srv) {
      if (req.headers.get('upgrade') === 'websocket')
        return srv.upgrade(req) ? undefined : new Response(null, { status: 426 });
      const action = new URL(req.url).pathname.split('/').at(-1)!;
      if (action === 'nonce') return Response.json({ data: { nonce: nonce() } });
      if (action === 'installationInquiries')
        return Response.json({ data: { pending: null, declinedAt: null, inquiries: [] } });
      return Response.json({ data: { signets: [] } });
    },
    websocket: {
      open(ws) {
        ws.send(JSON.stringify({ type: 'connected', connectionId: crypto.randomUUID() }));
      },
      message() {},
    },
  });
  const root = await mkdtemp(join(tmpdir(), 'signet-silent-'));
  const { keyFile } = await installationDirectory(root, `http://localhost:${silent.port}`);
  const snapshots: unknown[] = [];
  const socket = new InstallationSocket({
    url: `http://localhost:${silent.port}`,
    keyFile,
    authTimeoutMs: 50,
    retryBaseMs: 10_000,
    onSnapshot: (snapshot) => void snapshots.push(snapshot),
  });
  socket.start();
  const start = Date.now();
  while (!snapshots.length && Date.now() - start < 3000) await Bun.sleep(10);
  socket.close();
  silent.stop(true);
  expect(snapshots).toHaveLength(1);
});
