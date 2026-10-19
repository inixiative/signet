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

const uuid = () => crypto.randomUUID();
const T1 = 'thread_0199f0aa-0000-7000-8000-000000000001';
const owner = { ownerModel: 'User', userId: uuid(), organizationId: null, spaceId: null };
const threadsGrant = (selector: Record<string, unknown>) => ({
  resourceId: uuid(),
  kind: 'threads',
  operations: ['thread.read', 'thread.prompt'],
  lens: { threads: selector, view: 'own', delivery: 'note', outbound: 'review' },
});
const held = (resources: unknown[] = []) => ({
  signetId: uuid(),
  integrationId: uuid(),
  name: 'Studio Foundry',
  enrollmentId: null,
  owner,
  resources,
});
const hosted = (resources: unknown[]) => ({
  signetId: uuid(),
  integrationId: uuid(),
  name: 'JobCo',
  revision: 2,
  lifecycle: 'ongoing',
  expiresAt: null,
  maxRequests: null,
  maxConcurrent: 1,
  recipient: { recipientModel: 'User', id: uuid(), displayName: 'JobCo agent' },
  resources,
});
const request = (lens: Record<string, unknown>) => ({
  id: uuid(),
  status: 'sent',
  createdAt: new Date().toISOString(),
  expiresAt: null,
  integrationId: uuid(),
  requester: { sourceModel: 'User', id: uuid(), displayName: 'JobCo agent' },
  terms: {
    name: 'JobCo',
    lifecycle: 'ongoing',
    expiresAt: null,
    maxRequests: null,
    maxConcurrent: 1,
    resources: [{ resourceId: uuid(), operations: ['thread.prompt'], lens }],
  },
  reviewUrl: 'https://kingdom.example/dashboard?reviewSignet=ABC',
});

// A Kingdom ahead of this package: one hosted grant on a form it doesn't know yet.
const ownHeld = held();
const member = hosted([threadsGrant({ form: 'ids', ids: [T1] })]);
const standing = hosted([threadsGrant({ form: 'tag', tag: 'job-search' })]);
const misfit = held([{ ...threadsGrant({ form: 'ids', ids: [T1] }), kind: 'archiveLibrary' }]);
const ahead = {
  type: 'installation.snapshot',
  pending: null,
  declinedAt: null,
  inquiries: [],
  hostedSignetRequests: [
    request({ threads: { form: 'ids', ids: [T1] } }),
    request({ threads: { form: 'withMember' } }),
  ],
  signets: [ownHeld, misfit],
  hostedSignets: [member, standing],
};

describe('per-entry snapshot parsing (review U1)', () => {
  test('one unknown selector form drops only its entry', () => {
    const snapshot = parseInstallationSnapshot(ahead);
    expect(snapshot.signets.map((signet) => signet.signetId)).toEqual([ownHeld.signetId]);
    expect(snapshot.hostedSignets.map((signet) => signet.signetId)).toEqual([member.signetId]);
    expect(snapshot.hostedSignets[0]?.resources[0]?.lens).toMatchObject({
      threads: { form: 'ids', ids: [T1] },
    });
    expect(snapshot.hostedSignetRequests).toHaveLength(1);
    expect(snapshot.dropped.map(({ list, index, id }) => ({ list, index, id }))).toEqual([
      { list: 'hostedSignetRequests', index: 1, id: ahead.hostedSignetRequests[1]!.id },
      { list: 'signets', index: 1, id: misfit.signetId },
      { list: 'hostedSignets', index: 1, id: standing.signetId },
    ]);
    expect(snapshot.dropped[1]?.reason).toContain('another shape');
  });

  test('a missing list reads as empty and is reported, never failing the rest', () => {
    const { hostedSignets: _gone, ...older } = ahead;
    const snapshot = parseInstallationSnapshot(older);
    expect(snapshot.signets).toHaveLength(1);
    expect(snapshot.hostedSignets).toEqual([]);
    expect(
      snapshot.dropped.some((drop) => drop.list === 'hostedSignets' && drop.index === -1),
    ).toBe(true);
  });

  test('describe drops a resource whose lens it cannot read, and keeps the rest', () => {
    const resource = (lens: unknown, kind = 'threads') => ({
      id: uuid(),
      name: 'Threads',
      kind,
      integrationId: uuid(),
      lens,
    });
    const description = parseSignetDescription({
      signetId: uuid(),
      integrationId: uuid(),
      provider: 'foundry',
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
            resource({ threads: { form: 'ids', ids: [T1] } }),
            resource({ threads: { form: 'tag', tag: 'x' } }),
            resource({}, 'threads'),
          ],
        },
      ],
    });
    expect(description.operations[0]?.resources).toHaveLength(1);
    expect(description.dropped).toHaveLength(2);
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
    expect(snapshots[0]?.signets.map((signet) => signet.signetId)).toEqual([ownHeld.signetId]);
    expect(snapshots[0]?.hostedSignets.map((signet) => signet.signetId)).toEqual([member.signetId]);
    expect(snapshots[0]?.dropped).toHaveLength(3);
  });
});
