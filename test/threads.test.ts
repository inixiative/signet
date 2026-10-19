import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import {
  accessInputSchema,
  accessThreadStreamName,
  archiveLibraryResourceKind,
  narrowsSignetLens,
  narrowsThreadSelector,
  parseAccessThreadStreamName,
  resourceLensSchema,
  type SignetLens,
  selectsThread,
  signetLensSchema,
  signetProposalSchema,
  signetRequestSchema,
  signetResourceSchema,
  signetReviewProposalSchema,
  type ThreadSelector,
  threadHostFrameSchema,
  threadInputFromAccess,
  threadInputKeys,
  threadRequestFrameSchema,
  threadResponseEnvelopeSchema,
  threadResponseFrameSchema,
  threadsLensSchema,
  threadsResourceKind,
  unbuiltThreadSelectorForms,
} from '../src';

const T1 = 'thread_0199f0aa-0000-7000-8000-000000000001';
const T2 = 'thread_0199f0aa-0000-7000-8000-000000000002';
const T3 = 'thread_0199f0aa-0000-7000-8000-000000000003';
const uuid = () => crypto.randomUUID();
const threads = (
  ids: string[],
  terms: Partial<Record<'view' | 'delivery' | 'outbound', string>> = {},
) => signetLensSchema.parse({ threads: { form: 'ids', ids }, ...terms });

describe('the threads lens', () => {
  test('defaults every term but the selector to its narrowest value', () => {
    expect(threadsLensSchema.parse({ threads: { form: 'ids', ids: [T1] } })).toEqual({
      threads: { form: 'ids', ids: [T1] },
      view: 'own',
      delivery: 'note',
      outbound: 'review',
    });
  });

  test('the union holds both strict shapes; {} is the empty archive lens', () => {
    expect(signetLensSchema.parse({})).toEqual({});
    expect(signetLensSchema.parse({ fields: ['title'] })).toEqual({ fields: ['title'] });
    expect(threads([T1, T2])).toMatchObject({ threads: { ids: [T1, T2] }, view: 'own' });
    // A lens mixing the two shapes is neither.
    expect(
      signetLensSchema.safeParse({ fields: ['title'], threads: { form: 'ids', ids: [T1] } })
        .success,
    ).toBe(false);
    expect(
      signetLensSchema.safeParse({ threads: { form: 'ids', ids: [T1] }, extra: 1 }).success,
    ).toBe(false);
  });

  test('named but unbuilt selector forms fail closed, and so does any within', () => {
    expect(unbuiltThreadSelectorForms).toEqual(['withMember', 'tag']);
    for (const selector of [
      { form: 'withMember' },
      { form: 'tag', tag: 'job-search' },
      { form: 'ids', ids: [T1], within: { form: 'tag', tag: 'job-search' } },
      { form: 'ids', ids: [T1], within: { form: 'ids', ids: [T1] } },
      { form: 'everything' },
    ])
      expect(signetLensSchema.safeParse({ threads: selector }).success).toBe(false);
  });

  test('ids are 1..100 Foundry ids with no colon or slash', () => {
    expect(threadsLensSchema.safeParse({ threads: { form: 'ids', ids: [] } }).success).toBe(false);
    const hundred = Array.from({ length: 100 }, (_, i) => `thread_${i}`);
    expect(threadsLensSchema.safeParse({ threads: { form: 'ids', ids: hundred } }).success).toBe(
      true,
    );
    expect(
      threadsLensSchema.safeParse({ threads: { form: 'ids', ids: [...hundred, 'thread_x'] } })
        .success,
    ).toBe(false);
    for (const bad of ['thread:aux', 'a/b', ''])
      expect(threadsLensSchema.safeParse({ threads: { form: 'ids', ids: [bad] } }).success).toBe(
        false,
      );
  });

  test('selectsThread answers ids membership', () => {
    const lens = threadsLensSchema.parse({ threads: { form: 'ids', ids: [T1, T2] } });
    expect(selectsThread(lens.threads, T2)).toBe(true);
    expect(selectsThread(lens.threads, T3)).toBe(false);
  });
});

describe('a lens is checked against its resource kind', () => {
  test('threads take the threads shape, archive libraries the archive shape, others none', () => {
    const fits = (kind: string, lens: unknown) => resourceLensSchema(kind).safeParse(lens).success;
    const lens = { threads: { form: 'ids', ids: [T1] } };
    expect(fits(threadsResourceKind, lens)).toBe(true);
    expect(fits(threadsResourceKind, { fields: ['title'] })).toBe(false);
    // `lens.default({})` can't satisfy a threads grant: its preset must fill the selector (R9).
    expect(
      fits(
        threadsResourceKind,
        signetResourceSchema.parse({ resourceId: uuid(), operations: ['thread.read'] }).lens,
      ),
    ).toBe(false);
    expect(fits(archiveLibraryResourceKind, lens)).toBe(false);
    expect(fits(archiveLibraryResourceKind, { documentIds: ['a'.repeat(64)] })).toBe(true);
    expect(fits('repositoryCommit', {})).toBe(true);
    expect(fits('repositoryCommit', lens)).toBe(false);
    expect(fits('repositoryCommit', { fields: ['title'] })).toBe(false);
  });
});

describe('approving a request only narrows', () => {
  const requested = threads([T1, T2], { view: 'own', delivery: 'turn', outbound: 'review' });

  test('a subset of ids, and any term at or below the request, narrows', () => {
    expect(narrowsSignetLens(requested, requested)).toBe(true);
    expect(narrowsSignetLens(threads([T1], { delivery: 'turn' }), requested)).toBe(true);
    expect(narrowsSignetLens(threads([T2], { delivery: 'note' }), requested)).toBe(true);
  });

  test('widening any field is refused, the selector included', () => {
    expect(narrowsSignetLens(threads([T1, T2, T3], { delivery: 'turn' }), requested)).toBe(false);
    expect(narrowsSignetLens(threads([T3], { delivery: 'turn' }), requested)).toBe(false);
    expect(narrowsSignetLens(threads([T1], { view: 'thread', delivery: 'turn' }), requested)).toBe(
      false,
    );
    expect(
      narrowsSignetLens(threads([T1], { delivery: 'turn', outbound: 'auto' }), requested),
    ).toBe(false);
    const noteOnly = threads([T1]);
    expect(narrowsSignetLens(threads([T1], { delivery: 'turn' }), noteOnly)).toBe(false);
  });

  test('a lens of another shape than the request is refused', () => {
    expect(narrowsSignetLens({}, requested)).toBe(false);
    expect(narrowsSignetLens(requested, {})).toBe(false);
  });

  test('within is never dropped or added', () => {
    // No v1 form can fill `within`; the rule holds for the forms that will.
    const withWithin = { form: 'ids', ids: [T1], within: { form: 'tag', tag: 'x' } };
    const asSelector = (value: unknown) => value as ThreadSelector;
    expect(
      narrowsThreadSelector(asSelector({ form: 'ids', ids: [T1] }), asSelector(withWithin)),
    ).toBe(false);
    expect(
      narrowsThreadSelector(asSelector(withWithin), asSelector({ form: 'ids', ids: [T1] })),
    ).toBe(false);
  });

  test('the archive rules are unchanged', () => {
    const docs = (ids: string[]): SignetLens => ({ documentIds: ids });
    const a = 'a'.repeat(64);
    const b = 'b'.repeat(64);
    expect(narrowsSignetLens(docs([a]), docs([a, b]))).toBe(true);
    expect(narrowsSignetLens(docs([a, b]), docs([a]))).toBe(false);
    expect(narrowsSignetLens({}, docs([a]))).toBe(false);
    expect(narrowsSignetLens(docs([a]), {})).toBe(true);
    expect(narrowsSignetLens({ fields: ['title'] }, { fields: ['title', 'content'] })).toBe(true);
    expect(narrowsSignetLens({ fields: ['content'] }, { fields: ['title'] })).toBe(false);
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
    operations: ['thread.read', 'thread.prompt'],
    lens: { threads: { form: 'ids', ids: [T1] }, delivery: 'turn' },
  };

  test('a join request may name the threads resource by kind', () => {
    const proposal = signetProposalSchema.parse({ ...terms, resources: [join] });
    expect(proposal.resources[0]).toMatchObject({
      resourceKind: 'threads',
      lens: { threads: { form: 'ids', ids: [T1] }, delivery: 'turn', outbound: 'review' },
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
        resources: [{ resourceId: uuid(), operations: join.operations, lens: join.lens }],
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
    const host = threadInputFromAccess('thread.prompt', input);
    expect(host.success && host.data).toEqual({ threadId: T1, postId, text: 'Watching for X' });
    expect(threadInputFromAccess('thread.read', input)).toMatchObject({ data: { threadId: T1 } });
    expect(
      threadInputFromAccess('thread.read', accessInputSchema.parse({ resourceId })).success,
    ).toBe(false);
    // Only the operation's own keys cross; Kingdom refuses the rest earlier (requireOperationInput).
    expect(
      threadInputFromAccess('thread.floor', { ...input, floor: { action: 'request' } }),
    ).toMatchObject({ success: true, data: { threadId: T1, floor: { action: 'request' } } });
    expect(
      threadInputFromAccess(
        'thread.floor',
        accessInputSchema.parse({ resourceId, threadId: T1, floor: { action: 'release' } }),
      ),
    ).toMatchObject({ success: true, data: { threadId: T1, floor: { action: 'release' } } });
    expect(accessInputSchema.safeParse({ resourceId, text: 'x'.repeat(16_001) }).success).toBe(
      false,
    );
    // Kingdom's per-operation allow list derives from the same schemas.
    expect(threadInputKeys('thread.prompt')).toEqual(['threadId', 'postId', 'text', 'inReplyTo']);
    expect(threadInputKeys('thread.read')).toEqual(['threadId', 'afterSeq']);
    for (const operation of [
      'thread.read',
      'thread.prompt',
      'thread.floor',
      'prompt.resolve',
    ] as const)
      for (const key of threadInputKeys(operation))
        expect(Object.keys(accessInputSchema.shape)).toContain(key);
  });

  test('a request frame is typed by its operation', () => {
    const base = {
      type: 'thread.request',
      requestId: uuid(),
      signetId: uuid(),
      acceptedRevision: 2,
      member: { signetId: uuid(), displayName: 'JobCo' },
      lens: { threads: { form: 'ids', ids: [T1] } },
    };
    const prompt = threadRequestFrameSchema.parse({
      ...base,
      operation: 'thread.prompt',
      input: { threadId: T1, postId: uuid(), text: 'hi' },
    });
    expect(prompt.operation === 'thread.prompt' && prompt.input.text).toBe('hi');
    expect(prompt.lens.delivery).toBe('note');
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

  test('every request body and frame stays representable in OpenAPI', () => {
    for (const schema of [
      signetProposalSchema,
      signetRequestSchema,
      accessInputSchema,
      threadHostFrameSchema,
    ])
      expect(() => z.toJSONSchema(schema, { io: 'input', unrepresentable: 'throw' })).not.toThrow();
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
