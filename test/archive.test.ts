import { describe, expect, test } from 'bun:test';
import { createLens, type Lens, type LensNarrowing, projectLens } from '@inixiative/json-rules';
import {
  accessInputSchema,
  archiveFieldSchema,
  archiveInputRefusal,
  archiveInputSchemas,
  archiveOperationNames,
  archiveOperationSchema,
  archiveSourceOperations,
  declaredOperationSchema,
  type GrantLens,
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

describe('Archive calls see only what the lens shows', () => {
  const text = { kind: 'scalar', type: 'String' } as const;
  const base = createLens({
    maps: {
      archive: {
        models: {
          Document: {
            fields: { id: text, title: text, content: text, tags: text, projectId: text },
          },
        },
      },
    },
    mapName: 'archive',
    model: 'Document',
  });
  const lens = (...layers: LensLayer[]): GrantLens => ({
    layers,
    projection: projectLens(
      layers.reduce<Lens | LensNarrowing>((parent, layer) => ({ parent, ...layer }), base),
    ),
  });
  const hidesProject = lens({ root: { omits: ['projectId'] } });
  const hidesTags = lens({ root: { omits: ['tags'] } });

  test('a search may not filter on a field the lens hides: that would say who carries it', () => {
    expect(archiveInputRefusal('documents.search', { projectId: 'zealot' }, hidesProject)).toBe(
      "The lens doesn't show 'projectId'",
    );
    expect(archiveInputRefusal('documents.search', { tag: 'route:userevidence' }, hidesTags)).toBe(
      "The lens doesn't show 'tags'",
    );
    expect(archiveInputRefusal('documents.search', { query: 'x' }, hidesProject)).toBeNull();
    expect(archiveInputRefusal('documents.search', { tag: 'x' }, hidesProject)).toBeNull();
  });

  test('a call may not ask for a field the lens hides', () => {
    expect(archiveInputRefusal('documents.read', { fields: ['title', 'tags'] }, hidesTags)).toBe(
      "The lens doesn't show 'tags'",
    );
    expect(archiveInputRefusal('documents.read', { fields: ['title'] }, hidesTags)).toBeNull();
  });

  test('the base lens shows everything; writes and deletes take no lens', () => {
    expect(
      archiveInputRefusal('documents.search', { projectId: 'x', tag: 'y' }, lens()),
    ).toBeNull();
    expect(archiveInputRefusal('sessions.delete', { documentId: a }, hidesProject)).toBeNull();
  });

  test('projectId is an Archive field a lens can show or hide', () => {
    expect(archiveFieldSchema.options).toContain('projectId');
  });
});
