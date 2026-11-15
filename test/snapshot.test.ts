import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerWebSocket } from 'bun';
import {
  generateSignetKey,
  type InstallationSnapshot,
  InstallationSocket,
  parseInstallationSnapshot,
  parseSignetDescription,
  writePrivateJson,
} from '../src';

const uuid = () => Bun.randomUUIDv7();
const T1 = 'thread_0199f0aa-0000-7000-8000-000000000001';
const owner = { ownerModel: 'User', userId: uuid(), organizationId: null, spaceId: null };
const conversationGrant = (extra: Record<string, unknown> = {}) => ({
  resourceModel: 'IntegrationResource',
  integrationResourceId: uuid(),
  kind: 'conversation',
  externalId: T1,
  integrationId: uuid(),
  full: false,
  operations: ['thread.read', 'thread.prompt', 'member.wake'],
  ...extra,
});
const held = (resources: unknown[] = []) => ({
  signetId: uuid(),
  name: 'Studio Foundry',
  enrollmentId: null,
  owner,
  resources,
});
const hosted = (resources: unknown[], extra: Record<string, unknown> = {}) => ({
  signetId: uuid(),
  name: 'JobCo',
  revision: 2,
  lifecycle: 'ongoing',
  expiresAt: null,
  maxRequests: null,
  recipient: {
    recipientModel: 'User',
    id: uuid(),
    displayName: 'JobCo agent',
    audience: 'outside',
  },
  resources,
  ...extra,
});
const request = (extra: Record<string, unknown> = {}) => ({
  id: uuid(),
  status: 'sent',
  createdAt: new Date().toISOString(),
  expiresAt: null,
  requester: { sourceModel: 'User', id: uuid(), displayName: 'JobCo agent', audience: 'outside' },
  terms: {
    name: 'JobCo',
    lifecycle: 'ongoing',
    expiresAt: null,
    maxRequests: null,
    resources: [
      {
        resourceModel: 'IntegrationResource',
        integrationResourceId: uuid(),
        operations: { picks: ['thread.prompt'] },
        ...extra,
      },
    ],
  },
  resourceHandles: {},
  reviewUrl: 'https://kingdom.example/dashboard?reviewSignet=ABC',
});

// A Kingdom ahead of this package: one hosted grant in a shape it doesn't know yet.
const ownHeld = held();
const member = hosted([conversationGrant()]);
const standing = hosted([conversationGrant({ operations: 'everything' })]);
const misfit = held([conversationGrant({ lens: 'whole' })]);
const ahead = {
  type: 'installation.snapshot',
  pending: null,
  declinedAt: null,
  inquiries: [],
  hostedSignetRequests: [request(), request({ speakAs: 'host' })],
  signets: [ownHeld, misfit],
  hostedSignets: [member, standing],
};

describe('per-entry snapshot parsing (review U1)', () => {
  test('one unreadable resource drops only itself; every Signet is kept', () => {
    const snapshot = parseInstallationSnapshot(ahead);
    const ids = (list: { signetId: string }[]) => list.map((signet) => signet.signetId);
    expect(ids(snapshot.signets)).toEqual([ownHeld.signetId, misfit.signetId]);
    expect(snapshot.signets[1]?.resources).toEqual([]);
    // A member whose grant this package can't read is still a member: never mistaken for revoked.
    expect(ids(snapshot.hostedSignets)).toEqual([member.signetId, standing.signetId]);
    expect(snapshot.hostedSignets[0]?.resources[0]).toMatchObject({
      kind: 'conversation',
      operations: ['thread.read', 'thread.prompt', 'member.wake'],
    });
    expect(snapshot.hostedSignets[0]?.recipient.audience).toBe('outside');
    expect(snapshot.hostedSignets[1]?.resources).toEqual([]);
    expect(snapshot.hostedSignetRequests).toHaveLength(1);
    expect(snapshot.hostedSignetRequests[0]?.requester.audience).toBe('outside');
    expect(snapshot.dropped.map(({ list, index }) => ({ list, index }))).toEqual([
      { list: 'hostedSignetRequests', index: 1 },
      { list: `signets.${misfit.signetId}.resources`, index: 0 },
      { list: `hostedSignets.${standing.signetId}.resources`, index: 0 },
    ]);
  });

  test("a grant row's lens is one narrowing; a list of layers drops only that resource", () => {
    const lens = { root: { relations: { thread: { relations: { read: {} } } } } };
    const layered = [{ id: 'request', parents: ['foundry:conversation'], ...lens }];
    const signet = hosted([conversationGrant({ lens }), conversationGrant({ lens: layered })]);
    const snapshot = parseInstallationSnapshot({ ...ahead, hostedSignets: [signet] });
    expect(
      snapshot.hostedSignets[0]?.resources.map((row) => ('lens' in row ? row.lens : null)),
    ).toEqual([lens]);
    expect(snapshot.dropped).toContainEqual(
      expect.objectContaining({ list: `hostedSignets.${signet.signetId}.resources`, index: 1 }),
    );
  });

  test('a hosted Signet carries no base lenses: a Kingdom that still sends them has the key dropped', () => {
    const older = hosted([conversationGrant()], { baseLenses: { 'foundry:conversation': {} } });
    const snapshot = parseInstallationSnapshot({ ...ahead, hostedSignets: [older] });
    expect(snapshot.hostedSignets).toHaveLength(1);
    expect(snapshot.hostedSignets[0]).not.toHaveProperty('baseLenses');
    expect(snapshot.hostedSignets[0]?.resources).toHaveLength(1);
  });

  test('a missing list reads as empty and is reported, never failing the rest', () => {
    const { hostedSignets: _gone, ...older } = ahead;
    const snapshot = parseInstallationSnapshot(older);
    expect(snapshot.signets).toHaveLength(2);
    expect(snapshot.hostedSignets).toEqual([]);
    expect(
      snapshot.dropped.some((drop) => drop.list === 'hostedSignets' && drop.index === -1),
    ).toBe(true);
  });

  test('a Signet listed without resources (a Kingdom before 0.5.0) is kept', () => {
    const { resources: _none, ...bare } = ownHeld;
    const snapshot = parseInstallationSnapshot({ ...ahead, signets: [bare] });
    expect(snapshot.signets.map((signet) => signet.signetId)).toEqual([ownHeld.signetId]);
    expect(snapshot.signets[0]?.resources).toEqual([]);
  });

  test('describe drops a resource whose lens it cannot read, and keeps the rest', () => {
    const resource = (extra: Record<string, unknown> = {}, kind = 'conversation') => ({
      id: uuid(),
      name: 'Design review',
      kind,
      externalId: T1,
      integrationId: uuid(),
      provider: 'foundry',
      ...extra,
    });
    const description = parseSignetDescription({
      signetId: uuid(),
      name: 'JobCo',
      expiresAt: null,
      lifecycle: 'ongoing',
      taskId: null,
      currentRevision: 1,
      remainingRequests: null,
      holder: null,
      operations: [
        {
          key: 'thread.prompt',
          name: 'Post',
          resources: [
            resource(),
            resource({ lens: { mapDefaults: {} } }),
            resource({ lens: { threads: { form: 'ids', ids: [T1] } } }),
            resource({ lens: 'whole' }, 'archiveLibrary'),
            resource({ lens: [{ id: 'request', parents: ['foundry:conversation'] }] }),
          ],
        },
      ],
    });
    expect(description.operations[0]?.resources).toHaveLength(2);
    expect(description.dropped).toHaveLength(3);
  });

  test('describe reads a Signet whose resources sit on two integrations', () => {
    const foundry = uuid();
    const archive = uuid();
    const description = parseSignetDescription({
      signetId: uuid(),
      name: 'Research agent',
      expiresAt: null,
      lifecycle: 'ongoing',
      taskId: null,
      currentRevision: 1,
      remainingRequests: null,
      holder: null,
      operations: [
        {
          key: 'thread.read',
          name: 'Read',
          resources: [
            {
              id: uuid(),
              name: 'Threads',
              kind: 'conversation',
              externalId: T1,
              integrationId: foundry,
              provider: 'foundry',
            },
          ],
        },
        {
          key: 'documents.read',
          name: 'Read documents',
          resources: [
            {
              id: uuid(),
              name: 'Library',
              kind: 'archiveLibrary',
              externalId: 'library',
              integrationId: archive,
              provider: 'archive',
            },
          ],
        },
      ],
    });
    expect(description).not.toHaveProperty('integrationId');
    expect(description).not.toHaveProperty('provider');
    expect(
      description.operations.flatMap((operation) =>
        operation.resources.map(({ integrationId, provider }) => ({ integrationId, provider })),
      ),
    ).toEqual([
      { integrationId: foundry, provider: 'foundry' },
      { integrationId: archive, provider: 'archive' },
    ]);
  });
});

describe('an older client meets a snapshot ahead of it (design test 23)', () => {
  const sockets = new Set<ServerWebSocket<unknown>>();
  let server: ReturnType<typeof Bun.serve>;
  let url: string;
  let keyFile: string;

  beforeAll(async () => {
    keyFile = join(await mkdtemp(join(tmpdir(), 'signet-snapshot-')), 'key.json');
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
          sockets.add(ws);
          ws.send(JSON.stringify({ type: 'connected', connectionId: uuid() }));
        },
        message(ws) {
          ws.send(JSON.stringify({ type: 'installation', installationId: uuid() }));
          ws.send(JSON.stringify(ahead));
        },
        close(ws) {
          sockets.delete(ws);
        },
      },
    });
    url = `http://localhost:${server.port}`;
  });

  afterAll(() => server.stop(true));

  test('keeps its own held Signets and every other grant', async () => {
    const snapshots: InstallationSnapshot[] = [];
    const errors: unknown[] = [];
    const socket = new InstallationSocket({
      url,
      keyFile,
      onSnapshot: (snapshot) => void snapshots.push(snapshot),
      onError: (error) => void errors.push(error),
    });
    socket.start();
    for (const start = Date.now(); !snapshots.length; await Bun.sleep(5))
      if (Date.now() - start > 3000) throw Error('no snapshot');
    socket.close();
    expect(errors).toEqual([]);
    expect(snapshots[0]?.signets.map((signet) => signet.signetId)).toEqual([
      ownHeld.signetId,
      misfit.signetId,
    ]);
    expect(snapshots[0]?.hostedSignets.map((signet) => signet.signetId)).toEqual([
      member.signetId,
      standing.signetId,
    ]);
    expect(snapshots[0]?.dropped).toHaveLength(3);
  });
});
