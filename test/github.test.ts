import { describe, expect, test } from 'bun:test';
import {
  accessInputSchema,
  declaredOperationSchema,
  githubInputSchemas,
  githubOperationNames,
  githubOperationSchema,
  grantLensFitsKind,
  lensesSelectObject,
  narrowsRepositoryLens,
  narrowsSignetLens,
  operationInputFromAccess,
  operationInputKeys,
  repositoryLensRefusal,
  repositoryLensSchema,
  repositoryResourceKind,
  resourceLensSchema,
  signetLensSchema,
} from '../src';

const a = 'a'.repeat(40);
const b = 'b'.repeat(40);
const resourceId = crypto.randomUUID();

describe('the GitHub repository contract', () => {
  test('declares three reads on a repository, each named and taking the object id', () => {
    expect(githubOperationSchema.options).toEqual(['commits.read', 'trees.read', 'blobs.read']);
    for (const operation of githubOperationSchema.options) {
      expect(declaredOperationSchema.options).toContain(operation);
      expect(githubOperationNames[operation].length).toBeGreaterThan(0);
      expect(githubInputSchemas[operation]).toBeDefined();
      expect(operationInputKeys(operation)).toEqual(['objectId']);
    }
  });

  test('the object id is required, lowercase and 40 hexadecimal characters', () => {
    expect(
      operationInputFromAccess('blobs.read', accessInputSchema.parse({ resourceId, objectId: a })),
    ).toMatchObject({ success: true, data: { objectId: a } });
    expect(
      operationInputFromAccess('trees.read', accessInputSchema.parse({ resourceId })).success,
    ).toBe(false);
    for (const objectId of ['main', 'A'.repeat(40), 'a'.repeat(64), '../secret'])
      expect(accessInputSchema.safeParse({ resourceId, objectId }).success).toBe(false);
  });
});

describe('the repository lens', () => {
  test('a repository resource takes the repository lens; {} reaches the whole repository', () => {
    expect(resourceLensSchema(repositoryResourceKind)).toBe(repositoryLensSchema);
    expect(grantLensFitsKind({ kind: repositoryResourceKind, lens: {} })).toBe(true);
    expect(
      grantLensFitsKind({
        kind: repositoryResourceKind,
        lens: signetLensSchema.parse({ commits: [a] }),
      }),
    ).toBe(true);
    expect(
      grantLensFitsKind({ kind: 'archiveLibrary', lens: signetLensSchema.parse({ commits: [a] }) }),
    ).toBe(false);
    expect(repositoryLensSchema.safeParse({ commits: [] }).success).toBe(false);
    expect(repositoryLensSchema.safeParse({ commits: ['main'] }).success).toBe(false);
  });

  test('narrowing keeps to the requested commits', () => {
    expect(narrowsRepositoryLens({ commits: [a] }, { commits: [a, b] })).toBe(true);
    expect(narrowsRepositoryLens({ commits: [a, b] }, { commits: [a] })).toBe(false);
    expect(narrowsRepositoryLens({}, { commits: [a] })).toBe(false);
    expect(narrowsRepositoryLens({ commits: [a] }, {})).toBe(true);
    expect(narrowsSignetLens({ commits: [a] }, { commits: [a, b] })).toBe(true);
    expect(narrowsSignetLens({}, { commits: [a] })).toBe(false);
    expect(narrowsSignetLens({ commits: [a] }, {})).toBe(true);
    expect(narrowsSignetLens({ commits: [a] }, { documentIds: ['c'.repeat(64)] })).toBe(false);
  });

  test('a pinned grant reads only its commits, never a tree or blob', () => {
    expect(repositoryLensRefusal('commits.read', { commits: [a] })).toBeNull();
    expect(repositoryLensRefusal('trees.read', {})).toBeNull();
    expect(repositoryLensRefusal('blobs.read', { commits: [a] })).toBe(
      'A grant pinned to commits reads only those commits; trees and blobs need an unpinned grant',
    );
    expect(lensesSelectObject([{ commits: [a] }], 'commits.read', a)).toBe(true);
    expect(lensesSelectObject([{ commits: [a] }], 'commits.read', b)).toBe(false);
    expect(lensesSelectObject([{ commits: [a] }], 'trees.read', a)).toBe(false);
    expect(lensesSelectObject([{}], 'blobs.read', b)).toBe(true);
    expect(lensesSelectObject([{}, { commits: [b] }], 'commits.read', a)).toBe(false);
  });
});
