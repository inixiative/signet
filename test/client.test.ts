import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  collectPairing,
  generateClientKey,
  keyThumbprint,
  publicKeyOf,
  requestPairing,
  SignetClient,
  SignetHttpError,
  saveCollectedSignet,
  verifySignetProof,
  writePrivateJson,
} from '../src';

const uuid = () => crypto.randomUUID();
const token = (prefix: string) => `${prefix}${'a'.repeat(43)}`;
const nonce = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');

type Call = { action: string; body: Record<string, unknown>; headers: Headers };
const calls: Call[] = [];
const nonces = new Set<string>();
let approved = false;
let denied = false;
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

const verify = async (request: Request, action: string, accessToken?: string) => {
  const proof = await verifySignetProof({
    proof: request.headers.get('dpop') ?? '',
    url: `${url}/api/v1/access/${action}`,
    method: 'POST',
    now: new Date(),
    token: accessToken,
  });
  if (!nonces.delete(proof.nonce)) throw Error('nonce');
  return proof;
};

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const action = new URL(request.url).pathname.split('/').pop()!;
      const body = (await request.json()) as Record<string, unknown>;
      calls.push({ action, body, headers: request.headers });
      const ok = (data: unknown) => Response.json({ data });
      if (action === 'nonce') {
        const value = nonce();
        nonces.add(value);
        return ok({ nonce: value, expiresAt: new Date().toISOString() });
      }
      try {
        if (action === 'requestSignet') {
          await verify(request, action);
          return ok({
            requestId: uuid(),
            reviewCode: 'ABC123',
            deviceCode: 'd'.repeat(43),
            expiresAt: new Date(Date.now() + 600000).toISOString(),
          });
        }
        if (action === 'collectSignet') {
          await verify(request, action);
          if (denied) return Response.json({ message: 'Approval not available' }, { status: 403 });
          if (!approved)
            return Response.json({ message: 'Approval not available' }, { status: 409 });
          return ok({
            ...credentials(-1),
            renewalCredential: token('signet_renew_'),
            signetId,
            integrationId,
            owner: { ownerModel: 'User', userId: uuid(), organizationId: null, spaceId: null },
          });
        }
        if (action === 'renewSignet') {
          await verify(request, action);
          return ok(credentials(5));
        }
        if (action === 'execute') {
          const accessToken = request.headers.get('authorization')!.slice(5);
          await verify(request, action, accessToken);
          return ok({ executionId: uuid(), result: { echoed: body.operation } });
        }
      } catch {
        return Response.json({ message: 'Invalid proof' }, { status: 401 });
      }
      return new Response('missing', { status: 404 });
    },
  });
  url = `http://127.0.0.1:${server.port}`;
});
afterAll(() => server.stop(true));

describe('proofs', () => {
  test('a proof verifies against its own key and binds the access token', async () => {
    const key = generateClientKey();
    const { createSignetProof } = await import('../src/proof');
    const proof = await createSignetProof({
      privateKey: key,
      publicKey: publicKeyOf(key),
      nonce: nonce(),
      url: 'https://kingdom.test/api/v1/access/execute',
      method: 'POST',
      token: 'kingdom_x',
    });
    const verified = await verifySignetProof({
      proof,
      url: 'https://kingdom.test/api/v1/access/execute',
      method: 'POST',
      now: new Date(),
      token: 'kingdom_x',
      keyThumbprint: await keyThumbprint(publicKeyOf(key)),
    });
    expect(verified.publicKey).toEqual(publicKeyOf(key));
    await expect(
      verifySignetProof({
        proof,
        url: 'https://kingdom.test/api/v1/access/execute',
        method: 'POST',
        now: new Date(),
        token: 'kingdom_y',
      }),
    ).rejects.toThrow();
  });
});

describe('pairing and presentation', () => {
  test('pairs, waits for approval, then renews and executes with DPoP', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'signet-'));
    const keyFile = join(directory, 'key.json');
    await writePrivateJson(keyFile, generateClientKey());
    const pending = await requestPairing(url, keyFile, {
      provider: 'archive',
      name: 'Laptop Archive',
      resources: [],
      expiresAt: null,
      maxRequests: null,
      maxConcurrent: 4,
    });
    expect(calls.at(-1)?.body).toMatchObject({ provider: 'archive', lifecycle: 'ongoing' });
    expect(await collectPairing(url, keyFile, pending.deviceCode)).toBeNull();
    approved = true;
    const collected = await collectPairing(url, keyFile, pending.deviceCode);
    expect(collected?.integrationId).toBe(integrationId);
    const credentialFile = join(directory, 'signet.json');
    await saveCollectedSignet(credentialFile, url, keyFile, collected!);

    const client = new SignetClient(credentialFile, { url, signetId });
    const result = await client.execute({
      integrationId: uuid(),
      operation: 'sessions.write',
      input: { resourceId: uuid(), limit: 20 },
    });
    expect(result.result).toEqual({ echoed: 'sessions.write' });
    expect(calls.filter((call) => call.action === 'renewSignet')).toHaveLength(1);
    const execute = calls.findLast((call) => call.action === 'execute')!;
    expect(execute.headers.get('authorization')).toStartWith('DPoP kingdom_');
    expect(execute.body.signetId).toBe(signetId);
  });

  test('a denied pairing throws with the status and Kingdom message', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'signet-'));
    const keyFile = join(directory, 'key.json');
    await writePrivateJson(keyFile, generateClientKey());
    denied = true;
    const error = await collectPairing(url, keyFile, 'd'.repeat(43)).catch(
      (caught: unknown) => caught,
    );
    denied = false;
    expect(error).toBeInstanceOf(SignetHttpError);
    expect((error as SignetHttpError).status).toBe(403);
    expect((error as SignetHttpError).message).toContain('Approval not available');
  });
});
