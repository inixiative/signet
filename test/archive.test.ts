import { describe, expect, test } from 'bun:test';
import {
  createLens,
  type Lens,
  type LensNarrowing,
  validateNarrowing,
  validateRuleInLens,
} from '@inixiative/json-rules';
import {
  accessInputSchema,
  archiveCallCondition,
  archiveCallNarrowing,
  archiveFieldSchema,
  archiveInputSchemas,
  archiveOperationNames,
  archiveOperationSchema,
  archiveSourceOperations,
  declaredOperationSchema,
  githubOperationNames,
  githubOperationSchema,
  type LensLayer,
  operationInputFromAccess,
  operationInputKeys,
  operationInputSchemas,
  threadOperationNames,
  threadOperationSchema,
} from '../src';

const a = 'a'.repeat(64);
const resourceId = crypto.randomUUID();

describe('the Archive operation contract', () => {
  test('declares four operations, each named and with its input', () => {
    expect(archiveOperationSchema.options).toEqual([
      'documents.read',
      'documents.search',
      'sessions.write',
      'sessions.delete',
    ]);
    for (const operation of archiveOperationSchema.options) {
      expect(archiveOperationNames[operation].length).toBeGreaterThan(0);
      expect(archiveInputSchemas[operation]).toBeDefined();
    }
    expect(archiveSourceOperations).toEqual(['sessions.write', 'sessions.delete']);
  });

  test('operation names are unique across contracts, and every declared one is named', () => {
    const threads: readonly string[] = threadOperationSchema.options;
    const github: readonly string[] = githubOperationSchema.options;
    expect(
      archiveOperationSchema.options.filter(
        (operation) => threads.includes(operation) || github.includes(operation),
      ),
    ).toEqual([]);
    expect(threadOperationSchema.options.filter((operation) => github.includes(operation))).toEqual(
      [],
    );
    expect(declaredOperationSchema.options).toHaveLength(
      threadOperationSchema.options.length +
        archiveOperationSchema.options.length +
        githubOperationSchema.options.length,
    );
    const names: Record<string, string> = {
      ...threadOperationNames,
      ...archiveOperationNames,
      ...githubOperationNames,
    };
    for (const operation of declaredOperationSchema.options) {
      expect(names[operation]).toBeDefined();
      expect(operationInputSchemas[operation]).toBeDefined();
    }
  });

  test('every input key an operation takes travels in access/execute', () => {
    for (const operation of declaredOperationSchema.options)
      for (const key of operationInputKeys(operation))
        expect(Object.keys(accessInputSchema.shape)).toContain(key);
    expect(operationInputKeys('documents.read')).toEqual(['documentId', 'fields']);
    expect(operationInputKeys('documents.search')).toEqual([
      'query',
      'budget',
      'fields',
      'projectId',
      'tag',
    ]);
    expect(operationInputKeys('sessions.write')).toEqual(['snapshot', 'previousDigest', 'restore']);
    expect(operationInputKeys('sessions.delete')).toEqual(['documentId']);
  });

  test('the input is exactly the operation’s, and required keys are required', () => {
    const write = operationInputFromAccess(
      'sessions.write',
      accessInputSchema.parse({ resourceId, snapshot: { title: 'x' }, previousDigest: null }),
    );
    expect(write).toMatchObject({
      success: true,
      data: { snapshot: { title: 'x' }, previousDigest: null },
    });
    expect(
      operationInputFromAccess('sessions.write', accessInputSchema.parse({ resourceId })).success,
    ).toBe(false);
    expect(
      operationInputFromAccess(
        'sessions.write',
        accessInputSchema.parse({ resourceId, snapshot: { title: 'x' }, restore: true }),
      ),
    ).toMatchObject({ success: true, data: { snapshot: { title: 'x' }, restore: true } });
    expect(accessInputSchema.safeParse({ resourceId, restore: 'yes' }).success).toBe(false);
    expect(
      operationInputFromAccess(
        'documents.read',
        accessInputSchema.parse({ resourceId, restore: true }),
      ),
    ).toMatchObject({ success: true, data: {} });
    expect(
      operationInputFromAccess('sessions.delete', accessInputSchema.parse({ resourceId })).success,
    ).toBe(false);
    expect(
      operationInputFromAccess(
        'sessions.delete',
        accessInputSchema.parse({ resourceId, documentId: a, query: 'ignored' }),
      ),
    ).toMatchObject({ success: true, data: { documentId: a } });
    expect(
      operationInputFromAccess('documents.read', accessInputSchema.parse({ resourceId })).success,
    ).toBe(true);
  });
});

describe('an Archive call, gated by json-rules against the grant lens', () => {
  const text = { kind: 'scalar', type: 'String' } as const;
  const base = createLens({
    maps: {
      archive: {
        models: {
          Document: {
            fields: {
              id: text,
              title: text,
              content: text,
              tags: { ...text, isList: true },
              projectId: text,
            },
          },
        },
      },
    },
    mapName: 'archive',
    model: 'Document',
  });
  const narrowed = (layer: LensLayer): LensNarrowing => ({ parent: base, ...layer });
  const hidesProject = narrowed({ root: { omits: ['projectId'] } });
  const hidesTags = narrowed({ root: { omits: ['tags'] } });
  const refused = (result: { ok: boolean; errors: { code: string }[] }) =>
    result.ok ? null : result.errors[0]!.code;
  const filters = (operation: 'documents.search', input: object, lens: Lens | LensNarrowing) => {
    const condition = archiveCallCondition(operation, input);
    return condition === undefined ? null : refused(validateRuleInLens(condition, lens));
  };

  test('a search may not filter on a field the lens hides: that would say who carries it', () => {
    expect(filters('documents.search', { projectId: 'zealot' }, hidesProject)).toBe('not_in_lens');
    expect(filters('documents.search', { tag: 'route:userevidence' }, hidesTags)).toBe(
      'not_in_lens',
    );
    expect(filters('documents.search', { tag: 'x' }, hidesProject)).toBeNull();
    expect(filters('documents.search', { projectId: 'x', tag: 'y' }, base)).toBeNull();
    expect(archiveCallCondition('documents.search', { query: 'x' })).toBeUndefined();
  });

  test('a call may not ask for a field the lens hides', () => {
    const asked = archiveCallNarrowing('documents.read', { fields: ['title', 'tags'] })!;
    expect(refused(validateNarrowing({ parent: hidesTags, ...asked }))).toBe('not_visible');
    const ok = archiveCallNarrowing('documents.read', { fields: ['title'] })!;
    expect(validateNarrowing({ parent: hidesTags, ...ok }).ok).toBe(true);
    expect(archiveCallNarrowing('documents.read', {})).toBeUndefined();
  });

  test('projectId is an Archive field a lens can show or hide', () => {
    expect(archiveFieldSchema.options).toContain('projectId');
  });
});
