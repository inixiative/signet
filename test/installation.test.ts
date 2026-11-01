import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  defaultInstallationName,
  heldCredentials,
  heldSignetFile,
  holdPersonSignets,
  installationDirectory,
  installationPaths,
  listedSignets,
  privateDirectory,
  readPrivateJson,
  SignetHolders,
  SignetHttpError,
  signetCredentialFile,
  withdrawRegistration,
  writePrivateJson,
} from '../src';
import { ownerKey, ownerKeySchema } from '../src/contracts';

const uuid = () => crypto.randomUUID();
const nonce = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
const owner = {
  ownerModel: 'Organization' as const,
  userId: null,
  organizationId: uuid(),
  spaceId: null,
};
const listedId = uuid();
const integrationId = uuid();
const apiToken = 'test_user_token';
const credentials = () => ({
  enrollmentId: uuid(),
  lifecycle: 'ongoing',
  taskId: null,
  accessToken: `kingdom_${'a'.repeat(43)}`,
  renewalCredential: `signet_renew_${'r'.repeat(43)}`,
  expiresAt: new Date(Date.now() + 300000).toISOString(),
  renewalExpiresAt: new Date(Date.now() + 86400000).toISOString(),
  idleExpiresAt: new Date(Date.now() + 86400000).toISOString(),
  tokenType: 'DPoP',
});

const calls: { action: string; body: Record<string, unknown>; authorization: string | null }[] = [];
const count = (action: string) => calls.filter((call) => call.action === action).length;
let cancelStatus = 200;
let server: ReturnType<typeof Bun.serve>;
let url: string;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const action = new URL(request.url).pathname.split('/').at(-1) ?? '';
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      calls.push({ action, body, authorization: request.headers.get('authorization') });
      const data = (value: unknown) => Response.json({ data: value });
      switch (action) {
        case 'nonce':
          return data({ nonce: nonce() });
        case 'installationSignets':
          return data({
            signets: [
              {
                signetId: listedId,
                integrationId,
                name: 'Railway',
                enrollmentId: null,
                owner,
                resources: [],
              },
            ],
            hostedSignets: [],
          });
        case 'enrollInstallationSignet':
          return data({ ...credentials(), signetId: body.signetId, integrationId, owner });
        case 'enrollSignet':
          // Slow enough that two unlocked holders would both enroll.
          await Bun.sleep(40);
          return data(credentials());
        case 'installationInquiries':
          return data({
            pending: null,
            declinedAt: null,
            inquiries: ['sent', 'changesRequested', 'approved'].map((status, index) => ({
              id: `00000000-0000-4000-8000-00000000000${index}`,
              type: 'registerIntegration',
              status,
              createdAt: new Date().toISOString(),
              expiresAt: null,
              owner: null,
              ownerName: null,
              integrationId: null,
              signetId: null,
              deliverBefore: null,
            })),
            hostedSignetRequests: [],
          });
        case 'cancelInstallationInquiry':
          return cancelStatus === 200
            ? data({ id: body.inquiryId })
            : Response.json({ message: 'Refused' }, { status: cancelStatus });
        default:
          return new Response(null, { status: 404 });
      }
    },
  });
  url = `http://localhost:${server.port}`;
});
afterAll(() => server.stop(true));

const roots: string[] = [];
afterEach(async () => {
  calls.length = 0;
  cancelStatus = 200;
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const newRoot = async () => {
  const root = await mkdtemp(join(tmpdir(), 'signet-installation-'));
  roots.push(root);
  return root;
};

describe('installation layout', () => {
  test('installationPaths names the per-host directory and key without creating them', async () => {
    const root = await newRoot();
    const paths = installationPaths(root, `${url}/`);
    expect(paths).toEqual({
      directory: join(root, `localhost:${server.port}`),
      keyFile: join(root, `localhost:${server.port}`, 'installation-key.json'),
    });
    expect(existsSync(paths.directory)).toBe(false);
    expect(await installationDirectory(root, url)).toEqual(paths);
    expect(existsSync(paths.keyFile)).toBe(true);
  });

  test('privateDirectory makes a 0700 directory and refuses a link', async () => {
    const root = await newRoot();
    const directory = join(root, 'home');
    await mkdir(directory, { mode: 0o755 });
    await privateDirectory(directory);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    const link = join(root, 'link');
    await symlink(directory, link);
    await expect(privateDirectory(link)).rejects.toThrow(/owned by this user/);
  });

  test('defaultInstallationName takes the product', () => {
    expect(defaultInstallationName('KCP')).toBe(`KCP on ${hostname()}`.slice(0, 120));
    expect(defaultInstallationName('Foundry')).toStartWith('Foundry on ');
  });

  test('heldCredentials reads the Signet files that parse and skips the rest', async () => {
    const root = await newRoot();
    const { directory, keyFile } = await installationDirectory(root, url);
    const signetId = uuid();
    await writePrivateJson(signetCredentialFile(directory, signetId), {
      ...credentials(),
      signetId,
      url,
      keyFile,
    });
    await writePrivateJson(signetCredentialFile(directory, uuid()), { not: 'a credential' });
    await writeFile(join(directory, 'notes.txt'), 'x');
    const held = await heldCredentials(directory);
    expect(held.map((credential) => credential.signetId)).toEqual([signetId]);
    expect(await heldCredentials(join(root, 'missing'))).toEqual([]);
  });

  test('ownerKey and ownerKeySchema agree, with absent ids empty', () => {
    const key = ownerKey(owner);
    expect(key).toBe(`Organization::${owner.organizationId}:`);
    expect(ownerKeySchema.safeParse(key).success).toBe(true);
    expect(ownerKey({ ownerModel: 'User', userId: owner.organizationId })).toBe(
      `User:${owner.organizationId}::`,
    );
    expect(ownerKeySchema.safeParse('Kastle:::').success).toBe(false);
  });
});

describe('installation Signets', () => {
  test('listedSignets reads each Kingdom once; null without a key', async () => {
    const root = await newRoot();
    expect((await listedSignets(root, [url])).get(url)).toBeNull();
    await installationDirectory(root, url);
    const listed = await listedSignets(root, [url, url]);
    expect(listed.get(url)).toEqual(new Set([listedId]));
    expect(count('installationSignets')).toBe(1);
  });

  test('heldSignetFile enrolls a listed Signet once, and refuses one Kingdom does not list', async () => {
    const root = await newRoot();
    const file = await heldSignetFile(root, url, listedId);
    expect(await readPrivateJson(file)).toMatchObject({ signetId: listedId, integrationId });
    expect(await heldSignetFile(root, url, listedId)).toBe(file);
    expect(count('enrollInstallationSignet')).toBe(1);
    await expect(heldSignetFile(root, url, uuid())).rejects.toThrow(/does not list Signet/);
  });

  test('withdrawRegistration cancels only open registrations and throws what Kingdom refuses', async () => {
    const root = await newRoot();
    expect(await withdrawRegistration(root, url)).toEqual([]);
    expect(calls).toEqual([]);
    await installationDirectory(root, url);
    expect(await withdrawRegistration(root, url)).toEqual([
      '00000000-0000-4000-8000-000000000000',
      '00000000-0000-4000-8000-000000000001',
    ]);
    cancelStatus = 403;
    await expect(withdrawRegistration(root, url)).rejects.toBeInstanceOf(SignetHttpError);
  });
});

describe('holdPersonSignets', () => {
  const signet = { signetId: uuid(), expectedRevision: 3, integrationId, owner };

  test('enrolls as the person, records the integration and owner, and never writes the token', async () => {
    const root = await newRoot();
    const { directory, keyFile } = await installationDirectory(root, url);
    const held = await holdPersonSignets(url, keyFile, directory, apiToken, [signet], {
      name: 'KCP test',
    });
    const credentialFile = signetCredentialFile(directory, signet.signetId);
    expect(held).toEqual([
      { signetId: signet.signetId, integrationId, owner, credentialFile, enrolled: true },
    ]);
    const enroll = calls.find((call) => call.action === 'enrollSignet');
    expect(enroll?.authorization).toBe(`Bearer ${apiToken}`);
    expect(enroll?.body).toMatchObject({
      signetId: signet.signetId,
      expectedRevision: 3,
      name: 'KCP test',
    });
    expect(await readPrivateJson(credentialFile)).toMatchObject({ integrationId, owner, url });
    expect(JSON.stringify(await readPrivateJson(credentialFile))).not.toContain(apiToken);

    const again = await holdPersonSignets(url, keyFile, directory, apiToken, [signet], {
      name: 'KCP test',
    });
    expect(again[0]?.enrolled).toBe(false);
    expect(count('enrollSignet')).toBe(1);
    const replaced = await holdPersonSignets(url, keyFile, directory, apiToken, [signet], {
      name: 'KCP test',
      replace: true,
    });
    expect(replaced[0]?.enrolled).toBe(true);
    expect(count('enrollSignet')).toBe(2);
  });

  test('two holders racing on one directory enroll once: the second waits for the lock', async () => {
    const root = await newRoot();
    const { directory, keyFile } = await installationDirectory(root, url);
    const hold = () =>
      holdPersonSignets(url, keyFile, directory, apiToken, [signet], { name: 'race' });
    const [first, second] = await Promise.all([hold(), hold()]);
    expect([first[0]?.enrolled, second[0]?.enrolled].sort()).toEqual([false, true]);
    expect(count('enrollSignet')).toBe(1);
    expect(existsSync(join(directory, '.hold-lock'))).toBe(false);
  });
});

describe('SignetHolders', () => {
  const ref = (signetId: string) => ({ url, signetId, credentialFile: `/held/${signetId}.json` });
  const described = (signetId: string) => ({
    signetId,
    integrationId,
    provider: 'railway',
    name: 'Railway',
    expiresAt: null,
    lifecycle: 'ongoing',
    taskId: null,
    currentRevision: 1,
    remainingRequests: null,
    operations: [],
    holder: null,
  });

  test('reads once per key until stale, and reports a refused Signet as revoked', async () => {
    let reads = 0;
    const revoked = uuid();
    const holders = new SignetHolders({
      describe: async ({ signetId }) => {
        reads++;
        if (signetId === revoked) throw new SignetHttpError(403);
        return described(signetId);
      },
    });
    const id = uuid();
    const view = await holders.get(ref(id));
    expect(view).toMatchObject({ status: 'described', holder: null });
    expect(view.description?.integrationId).toBe(integrationId);
    await holders.get(ref(id));
    expect(reads).toBe(1);
    holders.stale();
    await holders.get(ref(id));
    expect(reads).toBe(2);
    expect((await holders.get(ref(revoked))).status).toBe('revoked');
  });

  test('keyOf lets a caller key by its own id, which forget then takes', async () => {
    let reads = 0;
    const holders = new SignetHolders<ReturnType<typeof ref> & { pairing: string }>({
      keyOf: (signet) => signet.pairing,
      describe: async ({ signetId }) => {
        reads++;
        return described(signetId);
      },
    });
    const id = uuid();
    await holders.get({ ...ref(id), pairing: 'abc' });
    await holders.get({ ...ref(id), pairing: 'abc' });
    expect(reads).toBe(1);
    holders.forget('abc');
    await holders.get({ ...ref(id), pairing: 'abc' });
    expect(reads).toBe(2);
  });

  test('a person-held description without a holder is refused, as Kingdom always sends one', async () => {
    const holders = new SignetHolders({
      describe: async ({ signetId }) => {
        const { holder: _holder, ...rest } = described(signetId);
        return rest;
      },
    });
    expect((await holders.get(ref(uuid()))).status).toBe('unavailable');
  });
});
