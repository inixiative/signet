import { z } from 'zod';
import { lensFilters, lensHidesField, type StoredLensLayer } from './lens';

/**
 * Archive libraries (Kingdom `docs/kingdom.md`, Archive `docs/KINGDOM.md`). A hosted Archive is an
 * integration with one `archiveLibrary` resource. Kingdom admits each call through a Signet and runs
 * it against that Archive with the integration's credential. The Archive server never sees the lens
 * (json-rules layers over the library's base lens), so Kingdom applies it.
 */
export const archiveLibraryResourceKind = 'archiveLibrary';

/** An Archive session id: `archiveKey(snapshot)`, the digest of its source and session. */
export const archiveDocumentIdSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const archiveFieldSchema = z.enum(['id', 'title', 'content', 'tags', 'createdAt']);
export type ArchiveField = z.infer<typeof archiveFieldSchema>;

/** The operations an `archiveLibrary` resource carries. */
export const archiveOperationSchema = z.enum([
  'documents.read',
  'documents.search',
  'sessions.write',
  'sessions.delete',
]);
export type ArchiveOperation = z.infer<typeof archiveOperationSchema>;

export const archiveOperationNames: Record<ArchiveOperation, string> = {
  'documents.read': 'Read permitted archive documents',
  'documents.search': 'Search permitted archive documents',
  'sessions.write': 'Write sessions from a paired local Archive',
  'sessions.delete': 'Delete sessions a paired local Archive wrote',
};

/**
 * Operations a paired local Archive runs on its own sessions: Kingdom binds each one to the
 * Archive's `sourceId`, so a grant of them takes no lens.
 */
export const archiveSourceOperations = [
  'sessions.write',
  'sessions.delete',
] as const satisfies readonly ArchiveOperation[];
export const isArchiveSourceOperation = (operation: ArchiveOperation) =>
  (archiveSourceOperations as readonly ArchiveOperation[]).includes(operation);

const fieldsSchema = z.array(archiveFieldSchema).min(1).max(5);

/**
 * The input each Archive operation takes. `access/execute` carries the same fields beside
 * `resourceId` and `limit` (`accessInputSchema`); Kingdom allows exactly these keys per operation.
 */
export const archiveInputSchemas = {
  /** Without `documentId`, the newest documents the lens reaches, up to `limit`. */
  'documents.read': z.strictObject({
    documentId: archiveDocumentIdSchema.optional(),
    fields: fieldsSchema.optional(),
  }),
  'documents.search': z.strictObject({
    query: z.string().max(1000).optional(),
    budget: z.number().int().min(16).max(32768).optional(),
    fields: fieldsSchema.optional(),
    projectId: z.string().min(1).max(256).optional(),
    tag: z.string().min(1).max(120).optional(),
  }),
  /**
   * An Archive snapshot (`@inixiative/archive`), parsed by Kingdom before it is stored. `restore`
   * brings back a session deleted at the hosted Archive on purpose (a routed part sent back), which
   * its tombstone otherwise refuses.
   */
  'sessions.write': z.strictObject({
    snapshot: z.record(z.string(), z.unknown()),
    previousDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable()
      .optional(),
    restore: z.boolean().optional(),
  }),
  'sessions.delete': z.strictObject({ documentId: archiveDocumentIdSchema }),
} as const satisfies Record<ArchiveOperation, z.ZodObject>;

/**
 * Why a grant of `operation` can't carry these lens layers, or null when it can. Kingdom evaluates
 * the layers; this reads only whether they filter documents or hide `content`.
 */
export const archiveLensRefusal = (
  operation: ArchiveOperation,
  lens: readonly StoredLensLayer[] | undefined,
) => {
  if (!lens?.length) return null;
  if (isArchiveSourceOperation(operation)) return 'Writing or deleting sessions takes no lens';
  if (operation === 'documents.search' && (lensFilters(lens) || lensHidesField(lens, 'content')))
    return 'Search needs a lens that shows content and is not limited to chosen documents';
  return null;
};
