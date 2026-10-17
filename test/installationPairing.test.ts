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
import { requestRegistrationResponseSchema, requestRegistrationSchema } from '../src/contracts';

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
const libraryId = crypto.randomUUID();
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
const registrationRequests: unknown[] = [];
let claimed = false;
const reviewUrl = 'https://kingdom.example/dashboard?reviewSignet=ABCDEF123456';
let server: ReturnType<typeof Bun.serve>;
let url: string;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (req.headers.get('upgrade') === 'websocket') return new Response(null, { status: 426 });
      const action = new URL(req.url).pathname.split('/').at(-1)!;
      calls.push(action);
      if (action === 'requestRegistration') registrationRequests.push(await req.json());
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
            reviewUrl,
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

test("pairs through polling when the socket is refused, showing Kingdom's review link and confirming the owner", async () => {
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
      owner: { ownerModel: 'Organization', organization: 'inixiative' },
      resources: [
        { resourceKind: 'model', operations: ['inference.create'] },
        { resourceId: libraryId, operations: ['sessions.write'] },
      ],
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
  expect(reviews).toEqual(['ABCDEF123456', reviewUrl]);
  expect(requestRegistrationSchema.parse(registrationRequests[0]).terms).toMatchObject({
    owner: { ownerModel: 'Organization', organization: 'inixiative' },
    resources: [
      { resourceKind: 'model', operations: ['inference.create'], lens: {} },
      { resourceId: libraryId, operations: ['sessions.write'], lens: {} },
    ],
  });
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

test('gives up when the review code expires, even if Kingdom still reports it pending', async () => {
  const stuck = Bun.serve({
    port: 0,
    fetch(req) {
      if (req.headers.get('upgrade') === 'websocket') return new Response(null, { status: 426 });
      const action = new URL(req.url).pathname.split('/').at(-1)!;
      const data = (value: unknown) => Response.json({ data: value });
      const expiresAt = new Date(Date.now() + 100).toISOString();
      if (action === 'nonce') return data({ nonce: nonce() });
      if (action === 'registerInstallation') return data({ installationId: crypto.randomUUID() });
      if (action === 'requestRegistration')
        return data({ reviewCode: 'ABCDEF123456', expiresAt, reviewUrl });
      if (action === 'installationInquiries')
        return data({
          pending: {
            reviewCode: 'ABCDEF123456',
            expiresAt: new Date(Date.now() + 600000).toISOString(),
          },
          declinedAt: null,
          inquiries: [],
        });
      return new Response(null, { status: 404 });
    },
  });
  const root = await mkdtemp(join(tmpdir(), 'signet-expired-'));
  const start = Date.now();
  try {
    await expect(
      pairInstallation({
        url: `http://localhost:${stuck.port}`,
        root,
        kind: 'archive',
        name: 'Laptop Archive',
        terms: {
          name: 'Laptop Archive',
          lifecycle: 'ongoing',
          resources: [],
          expiresAt: null,
          maxRequests: null,
          maxConcurrent: 4,
        },
        onReview: () => {},
        expiryGraceMs: 50,
        socketOptions: { pollMs: 20, retryBaseMs: 1000 },
      }),
    ).rejects.toThrow('review code expired');
  } finally {
    stuck.stop(true);
  }
  expect(Date.now() - start).toBeLessThan(3000);
});

const terms = {
  name: 'Studio Foundry',
  lifecycle: 'ongoing' as const,
  resources: [],
  expiresAt: null,
  maxRequests: null,
  maxConcurrent: 1,
};
const sentInquiry = (id: string, status: string, expiresAt: string | null) => ({
  id,
  type: 'registerIntegration',
  status,
  createdAt: new Date().toISOString(),
  expiresAt,
  owner: status === 'approved' ? owner : null,
  ownerName: status === 'approved' ? 'Aron' : null,
  integrationId: status === 'approved' ? integrationId : null,
  signetId: status === 'approved' ? signetId : null,
  deliverBefore: null,
});

/** A Kingdom whose review code lives `codeMs`; `inquiries(n)` answers the nth inquiry read. */
const stubKingdom = (codeMs: number, inquiries: (read: number) => Response | object) => {
  let reads = 0;
  const kingdom = Bun.serve({
    port: 0,
    fetch(req) {
      if (req.headers.get('upgrade') === 'websocket') return new Response(null, { status: 426 });
      const action = new URL(req.url).pathname.split('/').at(-1)!;
      const data = (value: unknown) => Response.json({ data: value });
      if (action === 'nonce') return data({ nonce: nonce() });
      if (action === 'registerInstallation') return data({ installationId: crypto.randomUUID() });
      if (action === 'requestRegistration')
        return data({
          reviewCode: 'ABCDEF123456',
          expiresAt: new Date(Date.now() + codeMs).toISOString(),
          reviewUrl,
        });
      if (action === 'installationInquiries') {
        const answer = inquiries(reads++);
        return answer instanceof Response ? answer : data(answer);
      }
      if (action === 'installationSignets') return data({ signets: [] });
      if (action === 'collectSignet') return data(collected(signetId));
      return new Response(null, { status: 404 });
    },
  });
  return { url: `http://localhost:${kingdom.port}`, stop: () => kingdom.stop(true) };
};

const outcome = (promise: Promise<unknown>, ms: number) =>
  Promise.race([
    promise.then(
      () => 'resolved',
      (error: Error) => `rejected: ${error.message}`,
    ),
    Bun.sleep(ms).then(() => 'still waiting'),
  ]);

test('a claimed registration waiting for approval outlives the review code, then collects', async () => {
  const id = crypto.randomUUID();
  const started = Date.now();
  const kingdom = stubKingdom(100, (read) => ({
    pending: null,
    declinedAt: null,
    inquiries:
      read === 0 ? [] : [sentInquiry(id, Date.now() - started < 600 ? 'sent' : 'approved', null)],
  }));
  const root = await mkdtemp(join(tmpdir(), 'signet-awaiting-'));
  try {
    const paired = await pairInstallation({
      url: kingdom.url,
      root,
      kind: 'foundry',
      name: 'Studio Foundry',
      terms,
      onReview: () => {},
      expiryGraceMs: 50,
      socketOptions: { pollMs: 20, retryBaseMs: 1000 },
    });
    expect(paired.signetId).toBe(signetId);
    expect(Date.now() - started).toBeGreaterThan(500);
  } finally {
    kingdom.stop();
  }
});

test('a claimed registration still unapproved when its inquiry expires gives up', async () => {
  const id = crypto.randomUUID();
  const inquiryExpiresAt = new Date(Date.now() + 300).toISOString();
  const kingdom = stubKingdom(100, (read) => ({
    pending: null,
    declinedAt: null,
    inquiries: read === 0 ? [] : [sentInquiry(id, 'sent', inquiryExpiresAt)],
  }));
  const root = await mkdtemp(join(tmpdir(), 'signet-unapproved-'));
  const controller = new AbortController();
  try {
    const result = await outcome(
      pairInstallation({
        url: kingdom.url,
        root,
        kind: 'foundry',
        name: 'Studio Foundry',
        terms,
        onReview: () => {},
        expiryGraceMs: 50,
        signal: controller.signal,
        socketOptions: { pollMs: 20, retryBaseMs: 1000 },
      }),
      2000,
    );
    expect(result).toBe('rejected: The registration expired in Kingdom before it was approved');
  } finally {
    controller.abort();
    kingdom.stop();
  }
});

test('a Kingdom unreachable at the deadline is reported as such, not as an expired code', async () => {
  const kingdom = stubKingdom(100, (read) =>
    read === 0
      ? { pending: null, declinedAt: null, inquiries: [] }
      : new Response(null, { status: 503 }),
  );
  const root = await mkdtemp(join(tmpdir(), 'signet-unreachable-'));
  const errors: unknown[] = [];
  try {
    await expect(
      pairInstallation({
        url: kingdom.url,
        root,
        kind: 'foundry',
        name: 'Studio Foundry',
        terms,
        onReview: () => {},
        onError: (error) => void errors.push(error),
        expiryGraceMs: 50,
        socketOptions: { pollMs: 10_000, retryBaseMs: 10 },
      }),
    ).rejects.toThrow('Could not reach Kingdom to confirm the registration');
  } finally {
    kingdom.stop();
  }
  expect(errors.length).toBeGreaterThanOrEqual(3);
});

test('a review code expiring past the timer limit does not fire early, and abort releases the signal', async () => {
  const kingdom = stubKingdom(40 * 86_400_000, () => ({
    pending: { reviewCode: 'ABCDEF123456', expiresAt: new Date(Date.now() + 600000).toISOString() },
    declinedAt: null,
    inquiries: [],
  }));
  const root = await mkdtemp(join(tmpdir(), 'signet-far-'));
  const controller = new AbortController();
  const listeners = { added: 0, removed: 0 };
  const { signal } = controller;
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  signal.addEventListener = ((...args: Parameters<typeof add>) => {
    listeners.added++;
    add(...args);
  }) as typeof signal.addEventListener;
  signal.removeEventListener = ((...args: Parameters<typeof remove>) => {
    listeners.removed++;
    remove(...args);
  }) as typeof signal.removeEventListener;
  const pairing = pairInstallation({
    url: kingdom.url,
    root,
    kind: 'foundry',
    name: 'Studio Foundry',
    terms,
    onReview: () => {},
    signal,
    socketOptions: { pollMs: 20, retryBaseMs: 1000 },
  });
  try {
    expect(await outcome(pairing, 300)).toBe('still waiting');
    controller.abort(Error('done waiting'));
    expect(await outcome(pairing, 300)).toBe('rejected: done waiting');
    expect(listeners).toEqual({ added: 1, removed: 1 });
  } finally {
    kingdom.stop();
  }
});

test('a registration response without reviewUrl is refused', () => {
  expect(
    requestRegistrationResponseSchema.safeParse({
      reviewCode: 'ABCDEF123456',
      expiresAt: new Date().toISOString(),
    }).success,
  ).toBe(false);
});
