import { z } from 'zod';

/**
 * GitHub repositories (Kingdom `docs/OPERATOR-ACCESS.md` §9). A GitHub integration is one GitHub
 * account; each repository it reaches is a `repository` resource, named `owner/name`. Kingdom admits
 * each call through a Signet and reads the repository with the integration's credential, so the
 * lens is applied by Kingdom.
 */
export const repositoryResourceKind = 'repository';

/** A Git object id: an immutable commit, tree or blob SHA-1. */
export const gitObjectIdSchema = z.string().regex(/^[a-f0-9]{40}$/);

/**
 * Which commits of a `repository` a grant reaches; `{}` reaches the whole repository. A grant pinned
 * to commits reads only those commits: reading a commit never reaches its tree, so a pinned grant
 * reaches no tree or blob.
 */
export const repositoryLensSchema = z.strictObject({
  commits: z.array(gitObjectIdSchema).min(1).max(1000).optional(),
});
export type RepositoryLens = z.infer<typeof repositoryLensSchema>;

/** `granted` reaches no commit `requested` doesn't. */
export const narrowsRepositoryLens = (granted: RepositoryLens, requested: RepositoryLens) =>
  !requested.commits ||
  (granted.commits?.every((commit) => requested.commits?.includes(commit)) ?? false);

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

/** Why a grant of `operation` can't carry `lens`, or null when it can. */
export const repositoryLensRefusal = (operation: GithubOperation, lens: RepositoryLens) =>
  lens.commits && operation !== 'commits.read'
    ? 'A grant pinned to commits reads only those commits; trees and blobs need an unpinned grant'
    : null;

/** Whether every lens a call is admitted under reaches `objectId` for `operation`. */
export const lensesSelectObject = (
  lenses: RepositoryLens[],
  operation: GithubOperation,
  objectId: string,
) =>
  lenses.every(
    (lens) =>
      !repositoryLensRefusal(operation, lens) && (!lens.commits || lens.commits.includes(objectId)),
  );
