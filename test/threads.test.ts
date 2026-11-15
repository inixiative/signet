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
  conversationPermissionSchema,
  conversationResourceKind,
  grantResourceSchema,
  installationInquiriesResponseSchema,
  installationSignetsResponseSchema,
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
} from '../src';

const T1 = 'thread_0199f0aa-0000-7000-8000-000000000001';
const uuid = () => Bun.randomUUIDv7();

describe('conversation permissions and entries', () => {
  test('take is a floor action, and member.take is the permission a host admits it by', () => {
    expect(conversationPermissionSchema.safeParse('member.take').success).toBe(true);
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
  };
  const join = {
    resourceKind: conversationResourceKind,
    integrationId: uuid(),
    externalId: T1,
    operations: { picks: ['thread.read', 'thread.prompt', 'member.wake'] },
  };

  test('a join request names a conversation by kind and thread id', () => {
    const proposal = signetProposalSchema.parse({ ...terms, resources: [join] });
    expect(proposal.resources[0]).toMatchObject({
      resourceKind: 'conversation',
      integrationId: join.integrationId,
      externalId: T1,
      operations: join.operations,
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
    expect(signetReviewProposalSchema.safeParse({ ...terms, resources: [join] }).success).toBe(
      false,
    );
    expect(
      signetReviewProposalSchema.safeParse({
        ...terms,
        resources: [
          {
            resourceModel: 'IntegrationResource',
            integrationResourceId: uuid(),
            operations: join.operations,
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
      postId,
      text: 'Watching for X',
    });
    const host = operationInputFromAccess('thread.prompt', input);
    expect(host.success && host.data).toEqual({ postId, text: 'Watching for X' });
    // No input names the thread: the call's resource is the conversation.
    expect(accessInputSchema.safeParse({ resourceId, threadId: T1 }).success).toBe(false);
    expect(operationInputFromAccess('thread.read', input)).toMatchObject({
      success: true,
      data: {},
    });
    expect(
      operationInputFromAccess('thread.prompt', accessInputSchema.parse({ resourceId })).success,
    ).toBe(false);
    // Only the operation's own keys cross; Kingdom refuses the rest earlier (requireOperationInput).
    expect(
      operationInputFromAccess('thread.floor', { ...input, floor: { action: 'request' } }),
    ).toMatchObject({ success: true, data: { floor: { action: 'request' } } });
    expect(
      operationInputFromAccess(
        'thread.floor',
        accessInputSchema.parse({ resourceId, floor: { action: 'release' } }),
      ),
    ).toMatchObject({ success: true, data: { floor: { action: 'release' } } });
    expect(accessInputSchema.safeParse({ resourceId, text: 'x'.repeat(16_001) }).success).toBe(
      false,
    );
    // Kingdom's per-operation allow list derives from the same schemas.
    expect(operationInputKeys('thread.prompt')).toEqual(['postId', 'text', 'inReplyTo', 'aside']);
    expect(operationInputKeys('thread.read')).toEqual(['afterSeq']);
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
      threadId: T1,
      permissions: ['member.wake'],
    };
    const prompt = threadRequestFrameSchema.parse({
      ...base,
      operation: 'thread.prompt',
      input: { postId: uuid(), text: 'hi' },
    });
    expect(prompt.operation === 'thread.prompt' && prompt.input.text).toBe('hi');
    expect(prompt.permissions).toEqual(['member.wake']);
    expect(
      threadRequestFrameSchema.safeParse({ ...prompt, permissions: ['thread.read'] }).success,
    ).toBe(false);
    expect(
      threadRequestFrameSchema.safeParse({
        ...base,
        operation: 'thread.read',
        input: { postId: uuid(), text: 'hi' },
      }).success,
    ).toBe(false);
    for (const frame of [
      prompt,
      { ...base, type: 'thread.subscribe' },
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
        conversationPermissionSchema,
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
