import { validateRule } from '@inixiative/json-rules';
import { z } from 'zod';
import { lensLayerSchema, storedLensLayersSchema } from './lens';
import { operationPickSchema, resolvedOperationsSchema } from './operations';
import { conversationResourceKind, threadIdSchema } from './threads';

/**
 * What a Signet revision grants, one row per resource (Aron, 2026-11-01). False polymorphism on
 * `resourceModel`: an `IntegrationResource` row carries its operations (`full`, or the leaves its
 * picks resolved to) and its lens layers; a `Project` row names a Kingdom project
 * the Signet may be used in, and nothing else. Artifacts may join later.
 */
export const grantResourceModelSchema = z.enum(['IntegrationResource', 'Project']);
export type GrantResourceModel = z.infer<typeof grantResourceModelSchema>;

/** The most characters a `where` may take as JSON, the size of a thread's text. */
export const grantWhereLimit = 16_000;

/** Whether a condition holds, at any depth, an `all` or `any` that is empty or lists a bare `true` or `false`. */
const hasVacuousGroup = (condition: unknown): boolean => {
  if (typeof condition === 'boolean') return true;
  if (typeof condition !== 'object' || condition === null) return false;
  const { all, any } = condition as { all?: unknown; any?: unknown };
  return [all, any].some(
    (group) => Array.isArray(group) && (group.length === 0 || group.some(hasVacuousGroup)),
  );
};

/**
 * A where as a party asks for it: a positive json-rules condition over the incoming call (its input
 * fields), what may go in. It only narrows: json-rules `validateRule(where, { positive: true })`
 * refuses a malformed condition and one that could hold on a missing value, and an `all` or `any`
 * that is empty or lists a bare `true` or `false` (it admits everything, or nothing) is refused at
 * any depth. Negated operators are
 * refused here and allowed in a lens, which decides no permission. The size cap is an ask's only: a
 * stored where grows as it is passed on (`storedWhereSchema`). The lens says what comes out.
 */
export const grantWhereSchema = z.record(z.string(), z.unknown()).superRefine((where, context) => {
  if (hasVacuousGroup(where))
    context.addIssue({
      code: 'custom',
      message: 'A where has no empty all or any, and no bare true or false',
    });
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

/**
 * A where as Kingdom stores and shows it: read as it is, whatever its size. Kingdom checked it when
 * it was asked, and a holder must never lose its own grant row over a condition it can't act on.
 */
export const storedWhereSchema = z.record(z.string(), z.unknown());

const integrationResourceShape = {
  resourceModel: z.literal('IntegrationResource'),
  integrationResourceId: z.uuid(),
  /** Everything the resource offers, now and as its catalog grows. */
  full: z.boolean(),
  /** The resolved leaves; absent when `full`. */
  operations: resolvedOperationsSchema.optional(),
  /** The layers under the kind's operations lens; absent reads every branch of it. */
  lens: storedLensLayersSchema.optional(),
  /**
   * What may go in: the condition this row's calls must meet, whole. Kingdom checks it at
   * admission; a holder never gates on it. It names no other Signet and no path.
   */
  where: storedWhereSchema.optional(),
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
 * A grant as a holder reads it: the stored row, plus the resource's `kind`, its `externalId` (the
 * provider's own id for it: a conversation's thread id) and the `integrationId` of the integration
 * the resource is on. A Signet reaches resources on any number of integrations, so each row names
 * its own. Read paths stay loose (a field a newer Kingdom
 * adds is dropped, not fatal).
 */
export const signetGrantSchema = z.discriminatedUnion('resourceModel', [
  z
    .object({
      ...integrationResourceShape,
      kind: z.string().min(1).max(80),
      externalId: z.string().min(1).max(256),
      integrationId: z.uuid(),
    })
    .superRefine(fullOrOperations),
  z.object(projectGrantSchema.shape),
]);
export type SignetGrant = z.infer<typeof signetGrantSchema>;

/**
 * What a party asks for on one resource: `full` or picks, its own lens layer (Kingdom assigns the
 * layer its id and chains it under the base, or under the request when an approver writes it).
 */
const askedOperations = {
  operations: operationPickSchema,
  lens: lensLayerSchema.optional(),
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
 * A resource asked for by kind on an existing integration, when the asker does not know its id.
 * `externalId` names one resource of that kind; without it the ask reaches every resource of the
 * kind on the integration. A conversation is always asked for one at a time: a party asking to join
 * names the Foundry's `integrationId`, the `conversation` kind and the thread's id as `externalId`.
 * Kingdom resolves the ask to resource ids before anyone reviews it.
 */
export const requestedResourceKindSchema = z
  .strictObject({
    ...askedByKind,
    integrationId: z.uuid(),
    externalId: z.string().min(1).max(256).optional(),
  })
  .superRefine((ask, context) => {
    if (ask.resourceKind !== conversationResourceKind) return;
    if (!threadIdSchema.safeParse(ask.externalId).success)
      context.addIssue({
        code: 'custom',
        path: ['externalId'],
        message: 'A conversation is asked for by its thread id',
      });
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
