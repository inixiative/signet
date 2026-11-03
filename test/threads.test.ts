import { describe, expect, test } from 'bun:test';
import {
  extendZodWithOpenApi,
  OpenAPIRegistry,
  OpenApiGeneratorV31,
} from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import {
  accessInputSchema,
  accessRequestSchema,
  accessThreadSnapshotSchema,
  accessThreadStreamName,
  authenticateSignetFrameSchema,
  grantResourceSchema,
  installationInquiriesResponseSchema,
  installationSignetsResponseSchema,
  narrowsThreadsTerms,
  operationInputFromAccess,
  operationInputKeys,
  operationPickSchema,
  parseAccessThreadStreamName,
  registrationRequestSchema,
  registrationTermsSchema,
  requestedResourceSchema,
  signetDescriptionSchema,
  signetGrantSchema,
  signetProposalSchema,
  signetRequestSchema,
  signetResourceSchema,
  signetReviewProposalSchema,
  threadAppendFrameSchema,
  threadEntrySchema,
  threadFloorActionSchema,
  threadHostFrameSchema,
  threadIdSchema,
  threadRequestFrameSchema,
  threadResponseEnvelopeSchema,
  threadResponseFrameSchema,
  threadsResourceKind,
  threadsTermsSchema,
} from '../src';

const T1 = 'thread_0199f0aa-0000-7000-8000-000000000001';
const uuid = () => Bun.randomUUIDv7();

describe('threads terms and entries', () => {
  test('floor.mayTake narrows only where it was asked for, and take is a floor action', () => {
    const asked = threadsTermsSchema.parse({ floor: { mayTake: true } });
    const without = threadsTermsSchema.parse({});
    expect(narrowsThreadsTerms(without, asked)).toBe(true);
    expect(narrowsThreadsTerms(asked, asked)).toBe(true);
    expect(narrowsThreadsTerms(asked, without)).toBe(false);
    expect(threadFloorActionSchema.safeParse({ action: 'take' }).success).toBe(true);
  });

  test('an entry may be an aside to one person, or a send carrying a commission', () => {
    const at = new Date().toISOString();
    const member = { kind: 'signet' as const, id: uuid() };
    expect(
      threadEntrySchema.safeParse({
        journalSeq: 3,
        at,
        kind: 'aside',
        member,
        to: { kind: 'owner', id: 'owner' },
        text: 'between us',
      }).success,
    ).toBe(true);
    expect(
      threadEntrySchema.safeParse({
        journalSeq: 4,
        at,
        kind: 'send',
        member,
        commission: { report: 'notify', expiresAt: at },
        text: 'look into the retry path and report back',
      }).success,
    ).toBe(true);
    expect(
      threadEntrySchema.safeParse({
        journalSeq: 5,
        at,
        kind: 'send',
        member,
        commission: { report: 'shout', expiresAt: at },
        text: 'x',
      }).success,
    ).toBe(false);
  });

  test('thread ids are Foundry ids with no colon or slash', () => {
    expect(threadIdSchema.safeParse(T1).success).toBe(true);
    for (const bad of ['thread:aux', 'a/b', ''])
      expect(threadIdSchema.safeParse(bad).success).toBe(false);
  });
});

describe('requests by resource kind', () => {
  const terms = {
    name: 'JobCo',
    lifecycle: 'ongoing' as const,
    expiresAt: null,
    maxRequests: null,
    maxConcurrent: 1,
    integrationId: uuid(),
  };
  const join = {
    resourceKind: threadsResourceKind,
    operations: { picks: ['thread.read', 'thread.prompt'] },
    lens: { root: { where: { field: 'id', operator: 'in', value: [T1] } } },
    terms: { threads: { delivery: 'turn' } },
  };

  test('a join request may name the threads resource by kind', () => {
    const proposal = signetProposalSchema.parse({ ...terms, resources: [join] });
    expect(proposal.resources[0]).toMatchObject({
      resourceKind: 'threads',
      lens: join.lens,
      terms: { threads: { view: 'own', delivery: 'turn', outbound: 'review' } },
    });
    const publicKey = {
      kty: 'EC' as const,
      crv: 'P-256' as const,
      x: 'a'.repeat(43),
      y: 'b'.repeat(43),
    };
    expect(signetRequestSchema.parse({ ...terms, resources: [join], publicKey }).publicKey).toEqual(
      publicKey,
    );
    expect(signetRequestSchema.safeParse({ ...terms, resources: [join] }).success).toBe(false);
    expect(
      signetRequestSchema.safeParse({ ...terms, resources: [join], publicKey, extra: 1 }).success,
    ).toBe(false);
  });

  test('the reviewed terms name every resource by id', () => {
    const { integrationId: _integration, ...review } = terms;
    expect(signetReviewProposalSchema.safeParse({ ...review, resources: [join] }).success).toBe(
      false,
    );
    expect(
      signetReviewProposalSchema.safeParse({
        ...review,
        resources: [
          {
            resourceModel: 'IntegrationResource',
            integrationResourceId: uuid(),
            operations: join.operations,
            lens: join.lens,
            terms: join.terms,
          },
        ],
      }).success,
    ).toBe(true);
  });
});

describe('thread operations through access/execute', () => {
  const resourceId = uuid();

  test('the access input carries thread fields, and the host input is exactly the operation’s', () => {
    const postId = uuid();
    const input = accessInputSchema.parse({
      resourceId,
      threadId: T1,
      postId,
      text: 'Watching for X',
    });
    const host = operationInputFromAccess('thread.prompt', input);
    expect(host.success && host.data).toEqual({ threadId: T1, postId, text: 'Watching for X' });
    expect(operationInputFromAccess('thread.read', input)).toMatchObject({
      data: { threadId: T1 },
    });
    expect(
      operationInputFromAccess('thread.read', accessInputSchema.parse({ resourceId })).success,
    ).toBe(false);
    // Only the operation's own keys cross; Kingdom refuses the rest earlier (requireOperationInput).
    expect(
      operationInputFromAccess('thread.floor', { ...input, floor: { action: 'request' } }),
    ).toMatchObject({ success: true, data: { threadId: T1, floor: { action: 'request' } } });
    expect(
      operationInputFromAccess(
        'thread.floor',
        accessInputSchema.parse({ resourceId, threadId: T1, floor: { action: 'release' } }),
      ),
    ).toMatchObject({ success: true, data: { threadId: T1, floor: { action: 'release' } } });
    expect(accessInputSchema.safeParse({ resourceId, text: 'x'.repeat(16_001) }).success).toBe(
      false,
    );
    // Kingdom's per-operation allow list derives from the same schemas.
    expect(operationInputKeys('thread.prompt')).toEqual([
      'threadId',
      'postId',
      'text',
      'inReplyTo',
      'aside',
    ]);
    expect(operationInputKeys('thread.read')).toEqual(['threadId', 'afterSeq']);
    for (const operation of [
      'thread.read',
      'thread.prompt',
      'thread.floor',
      'prompt.resolve',
    ] as const)
      for (const key of operationInputKeys(operation))
        expect(Object.keys(accessInputSchema.shape)).toContain(key);
  });

  test('a request frame is typed by its operation', () => {
    const base = {
      type: 'thread.request',
      requestId: uuid(),
      signetId: uuid(),
      acceptedRevision: 2,
      member: { signetId: uuid(), displayName: 'JobCo' },
      terms: {},
    };
    const prompt = threadRequestFrameSchema.parse({
      ...base,
      operation: 'thread.prompt',
      input: { threadId: T1, postId: uuid(), text: 'hi' },
    });
    expect(prompt.operation === 'thread.prompt' && prompt.input.text).toBe('hi');
    expect(prompt.terms.delivery).toBe('note');
    expect(
      threadRequestFrameSchema.safeParse({
        ...base,
        operation: 'thread.read',
        input: { threadId: T1, postId: uuid(), text: 'hi' },
      }).success,
    ).toBe(false);
    for (const frame of [
      prompt,
      { ...base, type: 'thread.subscribe', threadId: T1 },
      { type: 'thread.unsubscribe', subscriptionId: uuid() },
      { type: 'thread.lease', subscriptionIds: [uuid()] },
    ])
      expect(threadHostFrameSchema.safeParse(frame).success).toBe(true);
  });

  test('a response is read by what was asked', () => {
    const requestId = uuid();
    const accepted = {
      action: 'thread.response',
      requestId,
      outcome: { ok: true, result: { accepted: true, journalSeq: 4, duplicate: false } },
    };
    expect(threadResponseEnvelopeSchema.safeParse(accepted).success).toBe(true);
    expect(threadResponseFrameSchema('thread.prompt').safeParse(accepted).success).toBe(true);
    expect(threadResponseFrameSchema('thread.read').safeParse(accepted).success).toBe(false);
    const refused = {
      action: 'thread.response',
      requestId,
      outcome: { ok: false, refusal: 'floor_denied' },
    };
    expect(threadResponseFrameSchema('thread.read').safeParse(refused).success).toBe(true);
    expect(
      threadResponseFrameSchema('thread.read').safeParse({
        ...refused,
        outcome: { ok: false, refusal: 'nope' },
      }).success,
    ).toBe(false);
  });

  // Kingdom's routes build OpenAPI with @hono/zod-openapi, i.e. @asteasolutions/zod-to-openapi 9.x:
  // test against that generator, not zod's own toJSONSchema (which accepted a z.never() it rejects).
  test('every contract schema stays representable in Kingdom’s OpenAPI generator', () => {
    extendZodWithOpenApi(z);
    const generate = (schemas: Record<string, z.ZodType>) => {
      const registry = new OpenAPIRegistry();
      for (const [name, schema] of Object.entries(schemas))
        registry.registerPath({
          method: 'post',
          path: `/${name}`,
          request: { body: { content: { 'application/json': { schema } } } },
          responses: { 200: { description: name, content: { 'application/json': { schema } } } },
        });
      return new OpenApiGeneratorV31(registry.definitions).generateDocument({
        openapi: '3.1.0',
        info: { title: 'signet', version: '0' },
      });
    };
    expect(() => generate({ never: z.object({ within: z.never().optional() }) })).toThrow();
    expect(() =>
      generate({
        signetProposalSchema,
        signetRequestSchema,
        signetReviewProposalSchema,
        signetResourceSchema,
        requestedResourceSchema,
        grantResourceSchema,
        signetGrantSchema,
        operationPickSchema,
        registrationRequestSchema,
        registrationTermsSchema,
        accessInputSchema,
        accessRequestSchema,
        installationInquiriesResponseSchema,
        installationSignetsResponseSchema,
        signetDescriptionSchema,
        threadsTermsSchema,
        threadHostFrameSchema,
        threadAppendFrameSchema,
        threadResponseEnvelopeSchema,
        authenticateSignetFrameSchema,
        accessThreadSnapshotSchema,
      }),
    ).not.toThrow();
  });
});

describe('the accessThread stream name', () => {
  test('is the snapshot route’s channel key, and inverts', () => {
    const signetId = uuid();
    const name = accessThreadStreamName({ signetId, threadId: T1 });
    expect(name).toBe(`accessThread:signetId:${signetId}:threadId:${T1}`);
    expect(parseAccessThreadStreamName(name)).toEqual({ signetId, threadId: T1 });
    expect(parseAccessThreadStreamName(`${name}:extra:1`)).toBeNull();
    expect(parseAccessThreadStreamName(`organizationReadManyContacts:id:${signetId}`)).toBeNull();
    expect(() => accessThreadStreamName({ signetId, threadId: 'a:b' })).toThrow();
  });
});
