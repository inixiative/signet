import { type Condition, type ValidationResult, walkLensPath } from '@inixiative/json-rules';
import { z } from 'zod';
import {
  conditionOverOperationRows,
  describeWhetherLensFiltersOperationRows,
  type GrantLens,
  type LensBody,
  narrowOperationBranch,
} from './lens';
import { type OperationScope, validateOperationsInScope } from './operations';

/**
 * Archive libraries (Kingdom `docs/kingdom.md`, Archive `docs/KINGDOM.md`). A hosted Archive is an
 * integration with one `archiveLibrary` resource. Kingdom admits each call through a Signet and runs
 * it against that Archive with the integration's credential. The Archive server never sees the lens
 * (a json-rules narrowing of the library's operations lens, each operation a list of
 * `ArchiveDocument` rows), so Kingdom applies it at the operation's branch.
 */
export const archiveLibraryResourceKind = 'archiveLibrary';

/** An Archive session id: `archiveKey(snapshot)`, the digest of its source and session. */
export const archiveDocumentIdSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const archiveFieldSchema = z.enum([
  'id',
  'title',
  'content',
  'tags',
  'projectId',
  'createdAt',
]);
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

const fieldsSchema = z.array(archiveFieldSchema).min(1).max(archiveFieldSchema.options.length);

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
 * Whether a grant of `operation` can carry its lens, as json-rules validators answer: `{ ok, errors }`.
 * A chain with no lens reads every branch. Each check reads the visit at the operation's own branch.
 */
export const validateArchiveOperationLens = (
  operation: ArchiveOperation,
  grant: GrantLens,
): ValidationResult => {
  const message = !grant.narrowed
    ? null
    : isArchiveSourceOperation(operation)
      ? 'Writing or deleting sessions takes no lens'
      : operation === 'documents.search' &&
          (describeWhetherLensFiltersOperationRows(grant.lens, operation) ||
            walkLensPath(grant.lens, `${operation}.content`).outcome !== 'resolved')
        ? 'Search needs a lens that shows content and is not limited to chosen documents'
        : null;
  const errors = message ? [{ path: operation, message, code: 'invalid_lens' }] : [];
  return { ok: errors.length === 0, errors };
};

type ArchiveInput<O extends ArchiveOperation> = z.infer<(typeof archiveInputSchemas)[O]>;

/**
 * What one call filters on, as a json-rules condition over the documents at the operation's branch,
 * or undefined when it filters on nothing. Kingdom gates it with `validateRuleInLens` against the
 * grant's composed lens: a filter on a field the lens hides there (`projectId`, a `tag`) would say
 * which documents carry a value the holder can't see, and is refused with the lens's own code.
 */
export const conditionOverArchiveCallFilters = <O extends ArchiveOperation>(
  operation: O,
  input: ArchiveInput<O>,
): Condition | undefined => {
  const rules: Condition[] = [
    ...('projectId' in input && input.projectId !== undefined
      ? [{ field: 'projectId', operator: 'equals' as const, value: input.projectId }]
      : []),
    ...('tag' in input && input.tag !== undefined
      ? [{ field: 'tags', operator: 'contains' as const, value: input.tag }]
      : []),
  ];
  if (rules.length === 0) return undefined;
  return conditionOverOperationRows(operation, rules.length === 1 ? rules[0]! : { all: rules });
};

/**
 * The fields one call asks for, as a narrowing that picks them at the operation's branch, or
 * undefined when it asks for none. Kingdom validates it under the grant's composed lens
 * (`validateNarrowing`): a field the lens hides there is refused.
 */
export const narrowToArchiveCallFields = <O extends ArchiveOperation>(
  operation: O,
  input: ArchiveInput<O>,
): LensBody | undefined =>
  'fields' in input && input.fields?.length
    ? { root: narrowOperationBranch(operation, { picks: [...input.fields] }) }
    : undefined;

/** `validateArchiveOperationLens` over every operation a grant row reaches, `full` meaning all of them. */
export const validateArchiveGrantLens = (scope: OperationScope, grant: GrantLens) =>
  validateOperationsInScope(scope, archiveOperationSchema.options, (operation) =>
    validateArchiveOperationLens(operation, grant),
  );
