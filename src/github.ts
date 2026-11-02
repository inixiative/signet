import { z } from 'zod';
import { lensFilters, type StoredLensLayer } from './lens';

/**
 * GitHub repositories (Kingdom `docs/OPERATOR-ACCESS.md` §9). A GitHub integration is one GitHub
 * account; each repository it reaches is a `repository` resource, named `owner/name`. Kingdom admits
 * each call through a Signet and reads the repository with the integration's credential, so the
 * lens is applied by Kingdom. A grant pins commits with a `where` over the call's `{ sha }`; reading a
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

/** Why a grant of `operation` can't carry these lens layers, or null when it can. */
export const repositoryLensRefusal = (
  operation: GithubOperation,
  lens: readonly StoredLensLayer[] | undefined,
) =>
  lens && lensFilters(lens) && operation !== 'commits.read'
    ? 'A grant pinned to commits reads only those commits; trees and blobs need an unpinned grant'
    : null;
