import type { ValidationResult } from '@inixiative/json-rules';
import { z } from 'zod';
import { describeWhetherLensFiltersOperationRows, type GrantLens } from './lens';
import { type OperationScope, validateOperationsInScope } from './operations';

/**
 * GitHub repositories (Kingdom `docs/OPERATOR-ACCESS.md` §9). A GitHub integration is one GitHub
 * account; each repository it reaches is a `repository` resource, named `owner/name`. Kingdom admits
 * each call through a Signet and reads the repository with the integration's credential. A grant
 * pins commits twice: its `where` over the call (`objectId`) says which commits may be asked for, and
 * its lens filters the `RepositoryCall` rows (`{ sha }`) at the operations' branches. Reading a
 * commit never reaches its tree, so a pinned grant reaches no tree or blob.
 */
export const repositoryResourceKind = 'repository';

/** A Git object id: an immutable commit, tree or blob SHA-1. */
export const gitObjectIdSchema = z.string().regex(/^[a-f0-9]{40}$/);

/** The operations a `repository` resource carries. */
export const githubOperationSchema = z.enum(['commits.read', 'trees.read', 'blobs.read']);
export type GithubOperation = z.infer<typeof githubOperationSchema>;

export const githubOperationNames: Record<GithubOperation, string> = {
  'commits.read': 'Read an immutable repository commit',
  'trees.read': 'Read an immutable repository tree',
  'blobs.read': 'Read an immutable repository file',
};

/**
 * The input each repository operation takes: the object to read. `access/execute` carries the same
 * field beside `resourceId` and `limit` (`accessInputSchema`).
 */
export const githubInputSchemas = {
  'commits.read': z.strictObject({ objectId: gitObjectIdSchema }),
  'trees.read': z.strictObject({ objectId: gitObjectIdSchema }),
  'blobs.read': z.strictObject({ objectId: gitObjectIdSchema }),
} as const satisfies Record<GithubOperation, z.ZodObject>;

/**
 * Whether a grant of `operation` can carry its lens, read at its own branch, as json-rules
 * validators answer: `{ ok, errors }`.
 */
export const validateRepositoryOperationLens = (
  operation: GithubOperation,
  grant: GrantLens,
): ValidationResult => {
  const errors =
    operation !== 'commits.read' && describeWhetherLensFiltersOperationRows(grant.lens, operation)
      ? [
          {
            path: operation,
            message:
              'A grant pinned to commits reads only those commits; trees and blobs need an unpinned grant',
            code: 'invalid_lens',
          },
        ]
      : [];
  return { ok: errors.length === 0, errors };
};

/** `validateRepositoryOperationLens` over every operation a grant row reaches, `full` meaning all of them. */
export const validateRepositoryGrantLens = (scope: OperationScope, grant: GrantLens) =>
  validateOperationsInScope(scope, githubOperationSchema.options, (operation) =>
    validateRepositoryOperationLens(operation, grant),
  );

/** The row a repository call reads at its operation's branch of the lens: its object, as `sha`. */
export const repositoryCallRow = (input: { objectId: string }) => ({ sha: input.objectId });
