import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerWebSocket } from 'bun';
import {
  accessInputSchema,
  chorusOperationNames,
  chorusOperationSchema,
  chorusResourceKind,
  declaredOperationSchema,
  generateSignetKey,
  InstallationSocket,
  operationInputFromAccess,
  operationResponseFrameSchema,
  type RelayedOperationHandlers,
  relayedOperationRefusal,
  relayedOperationResult,
  relayedOperationSchema,
  relayedOperationTimeoutMs,
  writePrivateJson,
} from '../src';

const uuid = () => Bun.randomUUIDv7();
const P1 = uuid();
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
const sendHost = (frame: Record<string, unknown>) => kingdom?.send(JSON.stringify(frame));
const responseTo = async (requestId: string) => {
  await waitFor(() => received.some((frame) => frame.requestId === requestId));
  const found = received.find((frame) => frame.requestId === requestId);
  if (!found) throw Error(`No response for ${requestId}`);
  return found;
};
const chorusRelayed = (overrides: Record<string, unknown> = {}) => ({
  requestId: uuid(),
  signetId: uuid(),
  acceptedRevision: 1,
  projectId: P1,
  ...overrides,
});

beforeAll(async () => {
  keyFile = join(await mkdtemp(join(tmpdir(), 'signet-chorus-')), 'key.json');
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

afterEach(() => {
  socket?.close();
  socket = null;
  received.length = 0;
});
afterAll(() => server.stop(true));

const connect = async (operations: RelayedOperationHandlers) => {
  socket = new InstallationSocket({
    url,
    keyFile,
    operations,
    onSnapshot: () => {},
  });
  socket.start();
  await waitFor(() => socket?.connected === true && kingdom !== null);
  return socket;
};

test('every chorus operation is declared, relayed, named, and bounded by a timeout', () => {
  expect(chorusResourceKind).toBe('chorus');
  for (const op of chorusOperationSchema.options) {
    expect(declaredOperationSchema.options).toContain(op);
    expect(relayedOperationSchema.options).toContain(op);
    expect(chorusOperationNames[op].length).toBeGreaterThan(0);
    expect(relayedOperationTimeoutMs[op]).toBeGreaterThanOrEqual(15_000);
  }
});

test('accessInputSchema and operationInputFromAccess accept chorus operation payloads', () => {
  const adviseInput = accessInputSchema.parse({
    resourceId: uuid(),
    moment: 'Add a distributed lock around token refresh',
    sourceThreadId: 'thread_0199f0aa-0000-7000-8000-000000000001',
    domains: ['concurrency', 'auth'],
    deadlineMs: 45_000,
  });
  const pickedAdvise = operationInputFromAccess('chorus.advise', adviseInput);
  expect(pickedAdvise.success).toBe(true);
  if (pickedAdvise.success) {
    expect(pickedAdvise.data.moment).toBe('Add a distributed lock around token refresh');
    expect(pickedAdvise.data.domains).toEqual(['concurrency', 'auth']);
  }

  const activityInput = accessInputSchema.parse({
    resourceId: uuid(),
    activity: 'start',
  });
  const pickedActivity = operationInputFromAccess('chorus.projectActivity', activityInput);
  expect(pickedActivity.success).toBe(true);
  if (pickedActivity.success) expect(pickedActivity.data.activity).toBe('start');
});

test('chorus schemas bound domain ids, threadKnowledge size, deadlines, and outcomes', () => {
  const resourceId = uuid();
  expect(accessInputSchema.safeParse({ resourceId, domain: 'concurrency' }).success).toBe(true);
  expect(accessInputSchema.safeParse({ resourceId, domain: '../etc' }).success).toBe(false);
  expect(accessInputSchema.safeParse({ resourceId, domain: '.hidden' }).success).toBe(false);
  expect(accessInputSchema.safeParse({ resourceId, domain: 'a..b' }).success).toBe(false);
  expect(accessInputSchema.safeParse({ resourceId, deadlineMs: 60_000 }).success).toBe(true);
  expect(accessInputSchema.safeParse({ resourceId, deadlineMs: 60_001 }).success).toBe(false);

  const exactMaxDomains: Record<string, string> = {};
  for (let i = 0; i < 200; i++) exactMaxDomains[`domain-${i}`] = 'note';
  expect(
    accessInputSchema.safeParse({ resourceId, threadKnowledge: exactMaxDomains }).success,
  ).toBe(true);

  const tooManyDomains: Record<string, string> = { ...exactMaxDomains, 'domain-200': 'note' };
  expect(accessInputSchema.safeParse({ resourceId, threadKnowledge: tooManyDomains }).success).toBe(
    false,
  );

  const responseSchema = operationResponseFrameSchema('chorus.advise');
  const validFrame = {
    action: 'operation.response',
    requestId: uuid(),
    outcome: {
      ok: true,
      result: {
        rosterRevision: 'rev-1',
        elapsedMs: 10,
        contributions: [
          {
            callId: uuid(),
            domain: 'concurrency',
            outcome: 'no-comment',
            snippets: [],
            layers: [],
            confidence: 0,
          },
        ],
      },
    },
  };
  expect(responseSchema.safeParse(validFrame).success).toBe(true);

  const badOutcome = responseSchema.safeParse({
    ...validFrame,
    outcome: {
      ok: true,
      result: {
        ...validFrame.outcome.result,
        contributions: [{ ...validFrame.outcome.result.contributions[0], outcome: 'typo-outcome' }],
      },
    },
  });
  expect(badOutcome.success).toBe(false);
});

test('chorus.advise and chorus.projectActivity round-trip over InstallationSocket', async () => {
  const seenProjects: string[] = [];
  await connect({
    'chorus.advise': (frame) => {
      seenProjects.push(frame.projectId);
      return relayedOperationResult({
        rosterRevision: 'rev-1',
        elapsedMs: 42,
        contributions: [
          {
            callId: uuid(),
            domain: 'concurrency',
            outcome: 'spoke',
            snippets: ['Look over here: makeLock in packages/db/src/lock/'],
            layers: ['region:concurrency'],
            confidence: 0.92,
          },
        ],
      });
    },
    'chorus.projectActivity': (frame) => {
      if (frame.input.activity === 'stop') return relayedOperationRefusal('chorus_warming');
      return relayedOperationResult({
        projectId: frame.projectId,
        status: 'serving',
        expectedWardens: 32,
        heldWardens: 32,
        wardensDown: [],
        rosterRevision: 'rev-1',
      });
    },
  });

  const adviseFrame = chorusRelayed();
  sendHost({
    type: 'operation.request',
    ...adviseFrame,
    operation: 'chorus.advise',
    input: { moment: 'Need a mutex for refresh' },
  });
  const adviseResponse = operationResponseFrameSchema('chorus.advise').parse(
    await responseTo(adviseFrame.requestId),
  );
  expect(adviseResponse.outcome.ok).toBe(true);
  if (adviseResponse.outcome.ok) {
    expect(adviseResponse.outcome.result.contributions).toHaveLength(1);
    expect(adviseResponse.outcome.result.contributions[0]?.domain).toBe('concurrency');
  }
  expect(seenProjects).toEqual([P1]);

  const statusFrame = chorusRelayed();
  sendHost({
    type: 'operation.request',
    ...statusFrame,
    operation: 'chorus.projectActivity',
    input: { activity: 'status' },
  });
  const statusResponse = operationResponseFrameSchema('chorus.projectActivity').parse(
    await responseTo(statusFrame.requestId),
  );
  expect(statusResponse.outcome).toEqual({
    ok: true,
    result: {
      projectId: P1,
      status: 'serving',
      expectedWardens: 32,
      heldWardens: 32,
      wardensDown: [],
      rosterRevision: 'rev-1',
    },
  });

  const warmingFrame = chorusRelayed();
  sendHost({
    type: 'operation.request',
    ...warmingFrame,
    operation: 'chorus.projectActivity',
    input: { activity: 'stop' },
  });
  const warmingResponse = operationResponseFrameSchema('chorus.projectActivity').parse(
    await responseTo(warmingFrame.requestId),
  );
  expect(warmingResponse.outcome).toEqual({ ok: false, refusal: 'chorus_warming' });
});
