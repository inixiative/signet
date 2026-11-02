import { describe, expect, test } from 'bun:test';
import {
  accessInputSchema,
  declaredOperationSchema,
  githubInputSchemas,
  githubOperationNames,
  githubOperationSchema,
  operationInputFromAccess,
  operationInputKeys,
} from '../src';

const a = 'a'.repeat(40);
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
