import { validateRule } from '@inixiative/json-rules';
import { z } from 'zod';
import { lensLayerSchema, storedLensLayersSchema } from './lens';
import { operationPickSchema, resolvedOperationsSchema } from './operations';
import { threadsResourceKind, threadsTermsSchema } from './threads';

/**
 * What a Signet revision grants, one row per resource (Aron, 2026-11-01). False polymorphism on
 * `resourceModel`: an `IntegrationResource` row carries its operations (`full`, or the leaves its
 * picks resolved to), its lens layers and its per-kind terms; a `Project` row names a Kingdom project
 * the Signet may be used in, and nothing else. Artifacts may join later.
 */
export const grantResourceModelSchema = z.enum(['IntegrationResource', 'Project']);
export type GrantResourceModel = z.infer<typeof grantResourceModelSchema>;

/**
 * Per-kind terms that are neither operations nor lens: how a holder takes part. Strict per kind. A
 * request names its resource by id with no kind, so Kingdom checks `grantTermsFitKind` once it has
 * resolved the resource.
 */
export const grantTermsSchema = z.strictObject({ threads: threadsTermsSchema.optional() });
export type GrantTerms = z.infer<typeof grantTermsSchema>;

/** The resource kind each terms key belongs to. */
const termsKinds = { threads: threadsResourceKind } as const satisfies Record<
  keyof GrantTerms,
  string
>;
/** Whether `terms` only carry keys that belong to a resource of `kind`. */
export const grantTermsFitKind = (kind: string, terms: GrantTerms | undefined) =>
  Object.entries(terms ?? {}).every(
    ([key, value]) => value === undefined || termsKinds[key as keyof GrantTerms] === kind,
  );

/** A threads grant's terms, every one it leaves out at its narrowest. */
export const threadsTerms = (terms: z.input<typeof grantTermsSchema> | undefined) =>
  threadsTermsSchema.parse(terms?.threads ?? {});

/** The most characters a `where` may take as JSON, the size of a thread's text. */
export const grantWhereLimit = 16_000;

/**
 * A positive json-rules condition over the incoming call (its input fields): what may go in. It only
 * narrows: json-rules `validateRule(where, { positive: true })` refuses a malformed condition and one
 * that could hold on a missing value. The lens says what comes out.
 */
export const grantWhereSchema = z.record(z.string(), z.unknown()).superRefine((where, context) => {
  if (JSON.stringify(where).length > grantWhereLimit) {
    context.addIssue({
      code: 'custom',
      message: `A where takes at most ${grantWhereLimit} characters as JSON`,
    });
    return;
  }
  for (const issue of validateRule(where, { positive: true }).errors)
    context.addIssue({
      code: 'custom',
      message: `A where is a positive json-rules condition: ${issue.path} ${issue.message}`,
    });
});

const integrationResourceShape = {
  resourceModel: z.literal('IntegrationResource'),
  integrationResourceId: z.uuid(),
  /** Everything the resource offers, now and as its catalog grows. */
  full: z.boolean(),
  /** The resolved leaves; absent when `full`. */
  operations: resolvedOperationsSchema.optional(),
  /** The layers under the kind's operations lens; absent reads every branch of it. */
  lens: storedLensLayersSchema.optional(),
  terms: grantTermsSchema.optional(),
  /** What may go in: the grant's incoming condition, every link above it included. */
  where: grantWhereSchema.optional(),
};
const fullOrOperations = (
  row: { full: boolean; operations?: string[] },
  context: z.RefinementCtx,
) => {
  if (row.full && row.operations !== undefined)
    context.addIssue({
      code: 'custom',
      path: ['operations'],
      message: 'A full grant lists no operations',
    });
  if (!row.full && row.operations === undefined)
    context.addIssue({
      code: 'custom',
      path: ['operations'],
      message: 'A grant that is not full lists its operations',
    });
};

export const integrationResourceGrantSchema = z
  .strictObject(integrationResourceShape)
  .superRefine(fullOrOperations);
export const projectGrantSchema = z.strictObject({
  resourceModel: z.literal('Project'),
  projectId: z.uuid(),
});
/** One stored grant row, as Kingdom writes it on a revision. */
export const grantResourceSchema = z.discriminatedUnion('resourceModel', [
  integrationResourceGrantSchema,
  projectGrantSchema,
]);
export type GrantResource = z.infer<typeof grantResourceSchema>;
export type IntegrationResourceGrant = z.infer<typeof integrationResourceGrantSchema>;
export type ProjectGrant = z.infer<typeof projectGrantSchema>;

/**
 * A grant as a holder reads it: the stored row, plus the resource's `kind` so its terms can be read
 * and the `integrationId` of the integration the resource is on. A Signet reaches resources on any
 * number of integrations, so each row names its own. Read paths stay loose (a field a newer Kingdom
 * adds is dropped, not fatal).
 */
export const signetGrantSchema = z.discriminatedUnion('resourceModel', [
  z
    .object({
      ...integrationResourceShape,
      kind: z.string().min(1).max(80),
      integrationId: z.uuid(),
    })
    .superRefine(fullOrOperations),
  z.object(projectGrantSchema.shape),
]);
export type SignetGrant = z.infer<typeof signetGrantSchema>;

/**
 * What a party asks for on one resource: `full` or picks, its own lens layer (Kingdom assigns the
 * layer its id and chains it under the base, or under the request when an approver writes it), and
 * terms.
 */
const askedOperations = {
  operations: operationPickSchema,
  lens: lensLayerSchema.optional(),
  terms: grantTermsSchema.optional(),
  where: grantWhereSchema.optional(),
};
/** A resource asked for by id. */
export const signetResourceSchema = z.discriminatedUnion('resourceModel', [
  z.strictObject({
    resourceModel: z.literal('IntegrationResource'),
    integrationResourceId: z.uuid(),
    ...askedOperations,
  }),
  projectGrantSchema,
]);
export type SignetResource = z.infer<typeof signetResourceSchema>;

const askedByKind = {
  resourceKind: z.string().min(1).max(80),
  resourceName: z.string().trim().min(1).max(120).optional(),
  ...askedOperations,
};
/**
 * A resource an Installation asks for by kind, and optionally name, while it registers: the
 * integration it will become does not exist yet, so the kind alone names the resource. Kingdom
 * resolves it to the resource's id before anyone reviews it.
 */
export const registeredResourceKindSchema = z.strictObject(askedByKind);
/**
 * A resource asked for by kind on an existing integration, when the asker does not know its id: a
 * party asking to join a Foundry's `threads` (one per Foundry, so the kind and the Foundry's
 * `integrationId` name it). Kingdom resolves it to the resource's id before anyone reviews it.
 */
export const requestedResourceKindSchema = z.strictObject({
  ...askedByKind,
  integrationId: z.uuid(),
});
/** What a registering Installation may ask for: resources by id or by kind. */
export const registeredResourceSchema = z.union([
  signetResourceSchema,
  registeredResourceKindSchema,
]);
/** What a party may ask for: resources by id, or by kind on a named integration. */
export const requestedResourceSchema = z.union([signetResourceSchema, requestedResourceKindSchema]);
export type RegisteredResource = z.input<typeof registeredResourceSchema>;
export type RequestedResource = z.input<typeof requestedResourceSchema>;
