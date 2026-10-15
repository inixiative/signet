import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeJwt } from 'jose';
import {
  awaitSignet,
  enrollSignet,
  generateSignetKey,
  readPrivateJson,
  requestSignet,
  SignetClient,
  SignetHttpError,
  saveCollectedSignet,
  signetCredentialSchema,
  signetPublicKey,
  verifySignetProof,
  writePrivateJson,
} from '../src';

const uuid = () => crypto.randomUUID();
const token = (prefix: string) => `${prefix}${'b'.repeat(43)}`;
const nonce = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
const apiToken = 'kingdom_api_token';

type Call = { action: string; body: Record<string, unknown>; headers: Headers; ath?: string };
const calls: Call[] = [];
const nonces = new Set<string>();
const requests = new Map<string, { thumbprint: string; polls: number }>();
let server: ReturnType<typeof Bun.serve>;
let url: string;
const signetId = uuid();
const integrationId = uuid();
const enrollmentId = uuid();
const credentials = (minutes: number) => ({
  enrollmentId,
  lifecycle: 'ongoing',
  taskId: null,
  accessToken: token('kingdom_'),
  expiresAt: new Date(Date.now() + minutes * 60000).toISOString(),
  renewalExpiresAt: new Date(Date.now() + 86400000).toISOString(),
  idleExpiresAt: new Date(Date.now() + 86400000).toISOString(),
  tokenType: 'DPoP',
});

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const action = new URL(request.url).pathname.split('/').pop()!;
      const body = (await request.json()) as Record<string, unknown>;
      const ok = (data: unknown) => Response.json({ data });
      if (action === 'nonce') {
        const value = nonce();
        nonces.add(value);
        return ok({ nonce: value, expiresAt: new Date().toISOString() });
      }
      const authorization = request.headers.get('authorization') ?? '';
      const accessToken = authorization.startsWith('DPoP ') ? authorization.slice(5) : undefined;
      let proof: Awaited<ReturnType<typeof verifySignetProof>>;
      try {
        proof = await verifySignetProof({
          proof: request.headers.get('dpop') ?? '',
          url: `${url}/api/v1/access/${action}`,
          method: 'POST',
          now: new Date(),
          token: accessToken,
        });
        if (!nonces.delete(proof.nonce)) throw Error('nonce');
      } catch {
        return Response.json({ message: 'Invalid proof' }, { status: 401 });
      }
      calls.push({
        action,
        body,
        headers: request.headers,
        ath: decodeJwt(request.headers.get('dpop')!).ath as string | undefined,
      });
      const person = authorization === `Bearer ${apiToken}`;
      const publicKey = body.publicKey as { x?: string; y?: string } | undefined;
      const keyMatches = publicKey?.x === proof.publicKey.x && publicKey?.y === proof.publicKey.y;
      if (action === 'requestSignet') {
        if (!person) return Response.json({ message: 'Unauthorized' }, { status: 401 });
        if (!keyMatches) return Response.json({ message: 'Wrong client key' }, { status: 403 });
        const requestId = uuid();
        requests.set(requestId, { thumbprint: proof.keyThumbprint, polls: 0 });
        return ok({
          requestId,
          reviewCode: 'ABCDEF123456',
          expiresAt: new Date(Date.now() + 600000).toISOString(),
        });
      }
      if (action === 'collectSignet') {
        const pending = requests.get(body.inquiryId as string);
        if (authorization || !pending || pending.thumbprint !== proof.keyThumbprint)
          return Response.json({ message: 'Request unavailable' }, { status: 404 });
        if (pending.polls++ < 2)
          return Response.json({ message: 'Approval not available' }, { status: 409 });
        return ok({
          ...credentials(-1),
          renewalCredential: token('signet_renew_'),
          signetId,
          integrationId,
          owner: { ownerModel: 'User', userId: uuid(), organizationId: null, spaceId: null },
        });
      }
      if (action === 'enrollSignet') {
        if (!person) return Response.json({ message: 'Unauthorized' }, { status: 401 });
        if (!keyMatches || body.expectedRevision !== 2)
          return Response.json(
            { message: 'Enrollment requires the current recipient and accepted revision' },
            { status: 403 },
          );
        return ok({ ...credentials(5), renewalCredential: token('signet_renew_') });
      }
      if (action === 'renewSignet') return ok(credentials(5));
      if (action === 'execute' && accessToken)
        return ok({ executionId: uuid(), result: { echoed: body.operation } });
      return new Response('missing', { status: 404 });
    },
  });
  url = `http://127.0.0.1:${server.port}`;
});
afterAll(() => server.stop(true));

const newKeyFile = async () => {
  const directory = await mkdtemp(join(tmpdir(), 'signet-person-'));
  const keyFile = join(directory, 'key.json');
  await writePrivateJson(keyFile, generateSignetKey());
  return { directory, keyFile };
};

const proposal = {
  name: 'Agent research',
  integrationId,
  resources: [{ resourceId: uuid(), operations: ['documents.read'] }],
  lifecycle: 'ongoing' as const,
  expiresAt: null,
  maxRequests: null,
  maxConcurrent: 1,
};

describe('a person asks for a Signet', () => {
  test('request, wait for approval, collect, then execute with DPoP', async () => {
    const { directory, keyFile } = await newKeyFile();
    const requested = await requestSignet(url, keyFile, apiToken, proposal);
    expect(requested.reviewCode).toBe('ABCDEF123456');
    const call = calls.findLast((item) => item.action === 'requestSignet')!;
    expect(call.headers.get('authorization')).toBe(`Bearer ${apiToken}`);
    expect(call.ath).toBeUndefined();
    expect(call.body.publicKey).toEqual(signetPublicKey(await readPrivateJson(keyFile)));
    expect(call.body.resources).toEqual([{ ...proposal.resources[0], lens: {} }]);

    const collected = await awaitSignet(url, keyFile, requested.requestId, { intervalMs: 5 });
    expect(collected.signetId).toBe(signetId);
    expect(calls.filter((item) => item.action === 'collectSignet')).toHaveLength(3);
    const credentialFile = join(directory, 'signet.json');
    await saveCollectedSignet(credentialFile, url, keyFile, collected);
    const client = await SignetClient.fromFile(credentialFile);
    const result = await client.execute({
      integrationId,
      operation: 'documents.read',
      input: { resourceId: uuid(), limit: 1 },
    });
    expect(result.result).toEqual({ echoed: 'documents.read' });
  });

  test('a malformed proposal is refused before anything is sent', async () => {
    const { keyFile } = await newKeyFile();
    const before = calls.length;
    await expect(
      requestSignet(url, keyFile, apiToken, { ...proposal, resources: [] }),
    ).rejects.toThrow();
    expect(calls.length).toBe(before);
  });

  test('waiting stops when its signal aborts', async () => {
    const { keyFile } = await newKeyFile();
    const { requestId } = await requestSignet(url, keyFile, apiToken, proposal);
    const controller = new AbortController();
    const waiting = awaitSignet(url, keyFile, requestId, {
      intervalMs: 60000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(Error('stopped')), 50);
    await expect(waiting).rejects.toThrow('stopped');
  });
});

describe('a person enrolls a Signet granted to them', () => {
  test('enroll, save next to the key, then present it', async () => {
    const { directory, keyFile } = await newKeyFile();
    const enrolled = await enrollSignet(url, keyFile, apiToken, {
      signetId,
      expectedRevision: 2,
      name: 'Agent laptop',
    });
    expect(enrolled.signetId).toBe(signetId);
    expect(enrolled.renewalCredential).toStartWith('signet_renew_');
    const call = calls.findLast((item) => item.action === 'enrollSignet')!;
    expect(call.headers.get('authorization')).toBe(`Bearer ${apiToken}`);
    expect(call.ath).toBeUndefined();
    expect(call.body).toEqual({
      signetId,
      expectedRevision: 2,
      name: 'Agent laptop',
      publicKey: signetPublicKey(await readPrivateJson(keyFile)),
    });
    const credentialFile = join(directory, 'signet.json');
    const saved = await saveCollectedSignet(credentialFile, url, keyFile, enrolled);
    expect(signetCredentialSchema.parse(await readPrivateJson(credentialFile))).toEqual(saved);
    const client = await SignetClient.fromFile(credentialFile);
    expect(
      (
        await client.execute({
          integrationId,
          operation: 'documents.read',
          input: { resourceId: uuid(), limit: 1 },
        })
      ).result,
    ).toEqual({ echoed: 'documents.read' });
  });

  test('a stale revision keeps Kingdom’s reason', async () => {
    const { keyFile } = await newKeyFile();
    const error = await enrollSignet(url, keyFile, apiToken, {
      signetId,
      expectedRevision: 1,
      name: 'Agent laptop',
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SignetHttpError);
    expect((error as SignetHttpError).status).toBe(403);
    expect((error as SignetHttpError).message).toContain('accepted revision');
  });
});
