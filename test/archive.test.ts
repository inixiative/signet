import { describe, expect, test } from 'bun:test';
import {
  accessInputSchema,
  archiveInputSchemas,
  archiveLensRefusal,
  archiveLensSchema,
  archiveOperationNames,
  archiveOperationSchema,
  archiveSourceOperations,
  declaredOperationSchema,
  githubOperationNames,
  githubOperationSchema,
  narrowsArchiveLens,
  narrowsSignetLens,
  operationInputFromAccess,
  operationInputKeys,
  operationInputSchemas,
  threadOperationNames,
  threadOperationSchema,
} from '../src';

const a = 'a'.repeat(64);
const b = 'b'.repeat(64);
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

describe('the Archive lens', () => {
  test('narrowing keeps to the requested documents and fields', () => {
    expect(narrowsArchiveLens({ documentIds: [a] }, { documentIds: [a, b] })).toBe(true);
    expect(narrowsArchiveLens({ documentIds: [a, b] }, { documentIds: [a] })).toBe(false);
    expect(narrowsArchiveLens({}, { documentIds: [a] })).toBe(false);
    expect(narrowsArchiveLens({ documentIds: [a] }, {})).toBe(true);
    expect(narrowsArchiveLens({ fields: ['title'] }, { fields: ['title', 'content'] })).toBe(true);
    expect(narrowsArchiveLens({ fields: ['content'] }, { fields: ['title'] })).toBe(false);
    expect(narrowsSignetLens({ documentIds: [a] }, { documentIds: [a, b] })).toBe(true);
  });

  test('sessions operations take no lens; search needs content over every document', () => {
    const lens = (value: unknown) => archiveLensSchema.parse(value);
    expect(archiveLensRefusal('sessions.write', lens({}))).toBeNull();
    expect(archiveLensRefusal('sessions.delete', lens({}))).toBeNull();
    expect(archiveLensRefusal('sessions.delete', lens({ documentIds: [a] }))).toBe(
      'Writing or deleting sessions takes no lens',
    );
    expect(archiveLensRefusal('sessions.write', lens({ fields: ['title'] }))).toBe(
      'Writing or deleting sessions takes no lens',
    );
    expect(archiveLensRefusal('documents.search', lens({ documentIds: [a] }))).not.toBeNull();
    expect(archiveLensRefusal('documents.search', lens({ fields: ['title'] }))).not.toBeNull();
    expect(archiveLensRefusal('documents.search', lens({ fields: ['content'] }))).toBeNull();
    expect(
      archiveLensRefusal('documents.read', lens({ documentIds: [a], fields: ['title'] })),
    ).toBe(null);
  });
});
