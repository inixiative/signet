import { z } from 'zod';
import {
  archiveDocumentIdSchema,
  archiveFieldSchema,
  archiveInputSchemas,
  archiveOperationSchema,
} from './archive';
import {
  chorusContextLimit,
  chorusDeniedRefusals,
  chorusDomainCountLimit,
  chorusDomainIdSchema,
  chorusEarlierMessagesSchema,
  chorusInputSchemas,
  chorusMaxDeadlineMs,
  chorusMomentLimit,
  chorusOperationContextSchema,
  chorusOperationSchema,
  chorusOperationTimeoutMs,
  chorusProjectActivityActionSchema,
  chorusRefusalSchema,
  chorusResultSchemas,
  chorusThreadKnowledgeSchema,
  chorusToolObservationSchema,
} from './chorus';
import { type EventChannelMap, eventChannelMapSchema, eventChannelSchema } from './events';
import { githubInputSchemas, githubOperationSchema, gitObjectIdSchema } from './github';
import {
  registeredResourceSchema,
  requestedResourceSchema,
  signetGrantSchema,
  signetResourceSchema,
} from './grants';
import { lensNarrowingSchema } from './lens';
import {
  foundryIdSchema,
  threadDeniedRefusals,
  threadFloorActionSchema,
  threadInputSchemas,
  threadOperationContextSchema,
  threadOperationSchema,
  threadRefusalSchema,
  threadResultSchemas,
  threadTextLimit,
} from './threads';

export * from './archive';
export * from './chorus';
export * from './events';
export * from './github';
export * from './grants';
export * from './lens';
export * from './operations';
export * from './threads';

const token43 = /^[A-Za-z0-9_-]{43}$/;

export const accessTokenPattern = /^kingdom_[A-Za-z0-9_-]{43}$/;
export const renewalCredentialPattern = /^signet_renew_[A-Za-z0-9_-]{43}$/;
export const nonceSchema = z.string().regex(token43);

export const ownerModelSchema = z.enum([
  'User',
  'OrganizationUser',
  'Organization',
  'Space',
  'SpaceUser',
]);
export const ownerRefSchema = z.object({
  ownerModel: ownerModelSchema,
  userId: z.uuid().nullable(),
  organizationId: z.uuid().nullable(),
  spaceId: z.uuid().nullable(),
});
export type OwnerRef = z.infer<typeof ownerRefSchema>;
export type OwnerModel = z.infer<typeof ownerModelSchema>;

/** What a Signet may be owned by: an owner, or an Integration in its own right. */
export const signetOwnerModelSchema = z.enum([...ownerModelSchema.options, 'Integration']);
export type SignetOwnerModel = z.infer<typeof signetOwnerModelSchema>;

const everyOwnerIdField = ['userId', 'organizationId', 'spaceId', 'integrationId'] as const;
type OwnerIdField = (typeof everyOwnerIdField)[number];
/** The ids each Signet owner model is keyed by; every other id is null. */
export const ownerIdFields = {
  User: ['userId'],
  Organization: ['organizationId'],
  Space: ['organizationId', 'spaceId'],
  OrganizationUser: ['organizationId', 'userId'],
  SpaceUser: ['organizationId', 'spaceId', 'userId'],
  Integration: ['integrationId'],
} as const satisfies Record<SignetOwnerModel, readonly OwnerIdField[]>;

/**
 * A Signet owner a party names: no other keys, the ids its model is keyed by, and every other id
 * present and null.
 */
export const namedOwnerSchema = z
  .strictObject({
    ...ownerRefSchema.shape,
    ownerModel: signetOwnerModelSchema,
    integrationId: z.uuid().nullable(),
  })
  .superRefine((owner, context) => {
    const needed: readonly OwnerIdField[] = ownerIdFields[owner.ownerModel];
    for (const field of everyOwnerIdField) {
      if (needed.includes(field) && owner[field] === null)
        context.addIssue({
          code: 'custom',
          path: [field],
          message: `A ${owner.ownerModel} owner names its ${field}`,
        });
      if (!needed.includes(field) && owner[field] !== null)
        context.addIssue({
          code: 'custom',
          path: [field],
          message: `A ${owner.ownerModel} owner has no ${field}`,
        });
    }
  });

/** Kingdom's canonical owner key: `ownerModel:userId:organizationId:spaceId`, absent ids empty. */
export const ownerKey = (
  owner: Pick<OwnerRef, 'ownerModel'> & {
    [K in 'userId' | 'organizationId' | 'spaceId']?: string | null;
  },
) =>
  [owner.ownerModel, owner.userId ?? '', owner.organizationId ?? '', owner.spaceId ?? ''].join(':');

const uuidOrEmpty =
  '(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})?';
/** An `ownerKey` string. */
export const ownerKeySchema = z
  .string()
  .regex(new RegExp(`^(?:${ownerModelSchema.options.join('|')})(?::${uuidOrEmpty}){3}$`));

export const publicClientKeySchema = z.strictObject({
  kty: z.literal('EC'),
  crv: z.literal('P-256'),
  x: z.string().regex(token43),
  y: z.string().regex(token43),
});
export const signetKeySchema = publicClientKeySchema.extend({
  d: z.string().regex(token43),
});
export type PublicClientKey = z.infer<typeof publicClientKeySchema>;
export type SignetKey = z.infer<typeof signetKeySchema>;

export const signetRecipientSchema = z.discriminatedUnion('recipientModel', [
  z.strictObject({ recipientModel: z.literal('User'), userId: z.uuid() }),
  z.strictObject({ recipientModel: z.literal('Integration'), integrationId: z.uuid() }),
]);
export const signetLifecycleSchema = z.enum(['request', 'task', 'ongoing']);
export type SignetRecipient = z.infer<typeof signetRecipientSchema>;

export const signetEnrollmentSchema = z.strictObject({
  signetId: z.uuid(),
  expectedRevision: z.number().int().min(1),
  name: z.string().trim().min(1).max(120),
  publicKey: publicClientKeySchema,
});
export const signetRenewSchema = z.strictObject({
  renewalCredential: z.string().regex(renewalCredentialPattern),
});
export const signetCredentialsSchema = z.object({
  enrollmentId: z.uuid(),
  lifecycle: signetLifecycleSchema,
  taskId: z.uuid().nullable(),
  accessToken: z.string().regex(accessTokenPattern),
  renewalCredential: z.string().regex(renewalCredentialPattern).optional(),
  expiresAt: z.iso.datetime(),
  renewalExpiresAt: z.iso.datetime(),
  idleExpiresAt: z.iso.datetime(),
  tokenType: z.literal('DPoP'),
});
export const collectedSignetSchema = signetCredentialsSchema.extend({
  renewalCredential: z.string().regex(renewalCredentialPattern),
  signetId: z.uuid(),
  owner: ownerRefSchema,
});
export type SignetCredentials = z.infer<typeof signetCredentialsSchema>;
export type CollectedSignet = z.infer<typeof collectedSignetSchema>;

const signetTerms = {
  name: z.string().trim().min(1).max(120),
  lifecycle: signetLifecycleSchema,
  taskId: z.uuid().optional(),
  expiresAt: z.iso.datetime().nullable(),
  maxRequests: z.number().int().min(1).max(100000).nullable(),
};
/** A local Foundry, Archive or Oracle known to Kingdom by its key. */
export const installationKindSchema = z.enum(['foundry', 'archive', 'oracle', 'chorus']);
export type InstallationKind = z.infer<typeof installationKindSchema>;
/**
 * What a party asks for: resources by id, or by kind on the integration each names (review R8). A
 * Signet has no integration of its own; its resources may sit on several. A request names the one
 * owner it asks, with exactly the ids its model is keyed by. A person may be asked for a Signet over
 * resources across the tenants they reach; any other owner, over its own. With no owner named,
 * Kingdom asks the one owner every resource shares.
 */
export const signetProposalSchema = z.strictObject({
  ...signetTerms,
  owner: namedOwnerSchema.optional(),
  resources: z.array(requestedResourceSchema).min(1).max(100),
});
/** The terms as reviewed and issued: every resource named by id. */
export const signetReviewProposalSchema = z.strictObject({
  ...signetTerms,
  resources: z.array(signetResourceSchema).max(100),
});
/** The terms a person approves when registering an Installation as an owner's integration. */
export const registrationTermsSchema = z.strictObject({
  ...signetTerms,
  lifecycle: z.literal('ongoing'),
  resources: z.array(signetResourceSchema).max(100),
});
/** The owner an Installation asks to belong to; `organization` is the organization's id or slug. */
export const requestedOwnerSchema = z.strictObject({
  ownerModel: ownerModelSchema,
  organization: z.string().trim().min(1).max(120).optional(),
  spaceId: z.uuid().optional(),
});
/** What an Installation asks for: the owner it expects and the resources and operations it needs. */
export const registrationRequestSchema = z.strictObject({
  ...signetTerms,
  lifecycle: z.literal('ongoing'),
  owner: requestedOwnerSchema.optional(),
  resources: z.array(registeredResourceSchema).max(100),
});
/** A person asks for a Signet, to be presented with `publicKey`. */
export const signetRequestSchema = signetProposalSchema.extend({
  publicKey: publicClientKeySchema,
});
export const signetRequestResponseSchema = z.object({
  requestId: z.uuid(),
  reviewCode: z.string(),
  expiresAt: z.iso.datetime(),
});
export type SignetProposal = z.infer<typeof signetProposalSchema>;
export type RegistrationTerms = z.infer<typeof registrationTermsSchema>;
export type RequestedOwner = z.infer<typeof requestedOwnerSchema>;
export type RegistrationRequest = z.input<typeof registrationRequestSchema>;
export type SignetRequest = z.infer<typeof signetRequestSchema>;
export type SignetRequestResponse = z.infer<typeof signetRequestResponseSchema>;

/** A local Archive names its sourceId; Kingdom binds every write through its Signets to it. */
export const registerInstallationSchema = z
  .strictObject({
    kind: installationKindSchema,
    name: z.string().trim().min(1).max(120),
    sourceId: z.uuid().optional(),
    publicKey: publicClientKeySchema,
  })
  .refine((value) => value.kind !== 'archive' || Boolean(value.sourceId), {
    message: 'A local Archive registers with its sourceId',
  });
/**
 * Kingdom's refusal when a key it retired (its Installation removed, or the key rotated away)
 * registers again. The client answers it with a new key.
 */
export const retiredKeyMessage = 'This key was retired; use a new key';
export const registerInstallationResponseSchema = z.object({ installationId: z.uuid() });
export const requestRegistrationSchema = z.strictObject({ terms: registrationRequestSchema });
/** A link into Kingdom's web app that callers open, so http(s) only. */
const kingdomLinkSchema = z.url({ protocol: /^https?$/ });
export const requestRegistrationResponseSchema = z.object({
  reviewCode: z.string(),
  expiresAt: z.iso.datetime(),
  /** Where a person reviews the registration in Kingdom's web app. */
  reviewUrl: kingdomLinkSchema,
});
const inquiryStatusSchema = z.enum([
  'draft',
  'sent',
  'changesRequested',
  'approved',
  'denied',
  'canceled',
]);
export const installationInquirySchema = z.object({
  id: z.uuid(),
  type: z.string(),
  status: inquiryStatusSchema,
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime().nullable(),
  owner: ownerRefSchema.nullable(),
  ownerName: z.string().nullable(),
  integrationId: z.uuid().nullable(),
  /** The Signet the inquiry minted, or for a `changeEntitlements` ask the Signet it changes. */
  signetId: z.uuid().nullable(),
  deliverBefore: z.iso.datetime().nullable(),
  /** Where a person reviews it in Kingdom's web app, while it awaits review. */
  reviewUrl: kingdomLinkSchema.nullable().optional(),
});
/**
 * An Installation asks to change what a Signet it holds carries, as Kingdom's one
 * `changeEntitlements` inquiry addressed to that Signet: resources to add, by id or by kind as a
 * registration asks (Kingdom resolves them to entitlements before it stores the ask), and held rows
 * to remove by their own id (`signetGrantSchema`'s `id`). Whoever can manage the Signet answers with
 * a whole copy, narrower or wider than asked, applied as a new revision of the same Signet. One ask
 * is open per Signet: to ask for something else, cancel the open one (`cancelInstallationInquiry`).
 */
export const entitlementChangeRequestSchema = z
  .strictObject({
    signetId: z.uuid(),
    add: z.array(registeredResourceSchema).max(100).default([]),
    remove: z.array(z.uuid()).max(100).default([]),
  })
  .superRefine((changes, context) => {
    if (!changes.add.length && !changes.remove.length)
      context.addIssue({ code: 'custom', path: ['add'], message: 'Name a row to add or remove' });
  });
export const entitlementChangeResponseSchema = z.object({
  inquiryId: z.uuid(),
  status: inquiryStatusSchema,
  expiresAt: z.iso.datetime().nullable(),
  reviewUrl: kingdomLinkSchema,
});
export type EntitlementChangeRequest = z.input<typeof entitlementChangeRequestSchema>;
export type EntitlementChangeResponse = z.infer<typeof entitlementChangeResponseSchema>;
/**
 * Who a requester is to the integration's owner (Aron, 2026-11-14: "just in-org and outside-org,
 * but something naive"): `inOrg` when they share an organization with the owner, else `outside`.
 * Kingdom decides it, since only Kingdom knows memberships; a host picks what a member starts with by it.
 */
export const requestAudienceSchema = z.enum(['inOrg', 'outside']);
export type RequestAudience = z.infer<typeof requestAudienceSchema>;
/**
 * Who a Signet's recipient is to the integration's owner. `owner`: the recipient, a person or an
 * integration, may manage the hosting integration, so on a Foundry it is the owner's own client, not
 * a member from outside. Kingdom decides it by its permission check; holding `prompt.resolve` says nothing about who someone is, since recipients
 * are never restricted. A Signet hosted on integrations of several owners reads as the least of them.
 */
export const recipientAudienceSchema = z.enum(['owner', ...requestAudienceSchema.options]);
export type RecipientAudience = z.infer<typeof recipientAudienceSchema>;

/**
 * A pending `signetRequest` that asks for a resource on one of the Installation's integrations: a
 * party asking to join one of a Foundry's conversations. The owner reviews it in Kingdom at `reviewUrl`.
 */
export const hostedSignetRequestSchema = z.object({
  id: z.uuid(),
  status: inquiryStatusSchema,
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime().nullable(),
  requester: z.object({
    sourceModel: z.string(),
    id: z.uuid(),
    displayName: z.string(),
    audience: requestAudienceSchema,
  }),
  terms: signetReviewProposalSchema,
  /**
   * For each resource the request names whose provider id the host acts by (a conversation: its
   * thread id), that id by resource id, so the host can say which thread is being asked for.
   */
  resourceHandles: z.record(z.uuid(), z.string()),
  reviewUrl: kingdomLinkSchema,
});
export type HostedSignetRequest = z.infer<typeof hostedSignetRequestSchema>;
export const installationInquiriesResponseSchema = z.object({
  pending: z.object({ reviewCode: z.string(), expiresAt: z.iso.datetime() }).nullable(),
  declinedAt: z.iso.datetime().nullable(),
  inquiries: z.array(installationInquirySchema),
  hostedSignetRequests: z.array(hostedSignetRequestSchema),
});
export const inquiryReferenceSchema = z.strictObject({ inquiryId: z.uuid() });

const grantsSchema = z.array(signetGrantSchema);

/** Who a Signet is issued to. Recipients run broad (2026-10-18); Kingdom widens issuing in K0. */
export const signetRecipientModelSchema = z.enum([
  'User',
  'OrganizationUser',
  'Organization',
  'Space',
  'SpaceUser',
  'Integration',
]);
export const installationSignetSchema = z.object({
  signetId: z.uuid(),
  name: z.string(),
  /** The enrollment that is current for this installation's key, if any. */
  enrollmentId: z.uuid().nullable(),
  owner: ownerRefSchema,
  /**
   * What the Signet reaches, each row on its own integration, so a holder knows, for example,
   * which conversations it may open.
   */
  resources: grantsSchema,
  /** The event channels it holds; absent from a Kingdom that predates integration events. */
  eventChannels: eventChannelMapSchema.optional(),
});
/**
 * A Signet that reaches a resource on one of the Installation's integrations: a member of a
 * Foundry's conversations. `resources` lists only the rows on the Installation's integrations, each
 * naming which. For display and for cancelling a member's queued work once it is gone, never as an
 * admission gate: Kingdom admits every call.
 */
export const hostedSignetSchema = z.object({
  signetId: z.uuid(),
  name: z.string(),
  /** The current revision; the host compares it with the `acceptedRevision` frames carry. */
  revision: z.number().int().min(1),
  lifecycle: signetLifecycleSchema,
  expiresAt: z.iso.datetime().nullable(),
  maxRequests: z.number().int().nullable(),
  recipient: z.object({
    recipientModel: signetRecipientModelSchema,
    id: z.uuid(),
    displayName: z.string(),
    /**
     * Who the recipient is to the integration's owner: the host's member settings start from it, and
     * `owner` is the owner's own client (`recipientAudienceSchema`). Otherwise `inOrg` when the
     * recipient, or the owner of a recipient Integration, shares an organization with the owner.
     */
    audience: recipientAudienceSchema,
  }),
  resources: grantsSchema,
});
export type InstallationSignet = z.infer<typeof installationSignetSchema>;
export type HostedSignet = z.infer<typeof hostedSignetSchema>;
export const installationSignetsResponseSchema = z.object({
  signets: z.array(installationSignetSchema),
  hostedSignets: z.array(hostedSignetSchema),
});
export const enrollInstallationSignetSchema = z.strictObject({ signetId: z.uuid() });
export const rotateInstallationKeySchema = z.strictObject({
  publicKey: publicClientKeySchema,
  proof: z.string().max(8192),
});
export type InstallationInquiry = z.infer<typeof installationInquirySchema>;

/** One resource a described Signet reaches, and the integration it is on. */
export const signetDescriptionResourceSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  kind: z.string(),
  /** The provider's own id, sent only where the holder acts by it: a conversation's thread id. */
  externalId: z.string().optional(),
  integrationId: z.uuid(),
  /** The integration's provider family (`github`, `anthropic`…): the description has no host. */
  provider: z.string(),
  lens: lensNarrowingSchema.optional(),
});
export const signetDescriptionSchema = z.object({
  signetId: z.uuid(),
  name: z.string(),
  expiresAt: z.iso.datetime().nullable(),
  lifecycle: signetLifecycleSchema,
  taskId: z.uuid().nullable(),
  currentRevision: z.number().int(),
  remainingRequests: z.number().nullable(),
  operations: z.array(
    z.object({
      key: z.string(),
      name: z.string(),
      resources: z.array(signetDescriptionResourceSchema),
    }),
  ),
  /** The event channels it holds; absent from a Kingdom that predates integration events. */
  eventChannels: eventChannelMapSchema.optional(),
});
export type SignetDescription = z.infer<typeof signetDescriptionSchema>;

const holderPersonSchema = z.object({
  id: z.uuid(),
  name: z.string().nullable(),
  email: z.string(),
});
/**
 * `access/describe`'s `holder` for an Integration-held Signet (an Installation such as a Foundry):
 * the integration, its owner, who issued the Signet, and where to manage it in Kingdom.
 */
export const signetHolderSchema = z.object({
  integration: z.object({ id: z.uuid(), name: z.string(), provider: z.string().nullable() }),
  owner: z.object({
    ownerModel: ownerModelSchema,
    name: z.string().nullable(),
    organization: z.object({ id: z.uuid(), name: z.string(), slug: z.string() }).nullable(),
    space: z.object({ id: z.uuid(), name: z.string() }).nullable(),
    user: holderPersonSchema.nullable(),
  }),
  issuedBy: holderPersonSchema.nullable(),
  webUrl: kingdomLinkSchema,
  manageUrl: kingdomLinkSchema,
});
export type SignetHolder = z.infer<typeof signetHolderSchema>;

/** Operation-specific fields; Kingdom validates each against the operation it names. */
export const accessInputSchema = z.strictObject({
  resourceId: z.uuid(),
  documentId: archiveDocumentIdSchema.optional(),
  fields: z.array(archiveFieldSchema).min(1).max(5).optional(),
  limit: z.number().int().min(1).max(50).default(20),
  query: z.string().max(1000).optional(),
  projectId: z.string().min(1).max(256).optional(),
  tag: z.string().min(1).max(120).optional(),
  budget: z.number().int().min(16).max(32768).optional(),
  snapshot: z.record(z.string(), z.unknown()).optional(),
  previousDigest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable()
    .optional(),
  restore: z.boolean().optional(),
  postId: z.uuid().optional(),
  text: z.string().min(1).max(threadTextLimit).optional(),
  inReplyTo: foundryIdSchema.optional(),
  aside: threadInputSchemas['thread.prompt'].shape.aside,
  afterSeq: z.number().int().min(0).optional(),
  floor: threadFloorActionSchema.optional(),
  promptId: foundryIdSchema.optional(),
  answer: threadInputSchemas['prompt.resolve'].shape.answer.optional(),
  objectId: gitObjectIdSchema.optional(),
  sourceThreadId: foundryIdSchema.optional(),
  moment: z.string().min(1).max(chorusMomentLimit).optional(),
  threadState: z.string().max(chorusContextLimit).optional(),
  threadKnowledge: chorusThreadKnowledgeSchema.optional(),
  domains: z.array(chorusDomainIdSchema).min(1).max(chorusDomainCountLimit).optional(),
  earlier: chorusEarlierMessagesSchema.optional(),
  deadlineMs: z.number().int().min(1_000).max(chorusMaxDeadlineMs).optional(),
  rosterRevision: z.string().min(1).max(128).optional(),
  observations: z.array(chorusToolObservationSchema).max(chorusDomainCountLimit).optional(),
  workSummary: z.string().min(1).max(chorusMomentLimit).optional(),
  domain: chorusDomainIdSchema.optional(),
  callId: z.uuid().optional(),
  activity: chorusProjectActivityActionSchema.optional(),
});
export const accessRequestSchema = z.strictObject({
  requestId: z.uuid(),
  taskId: z.uuid().optional(),
  runId: z.uuid().optional(),
  integrationId: z.uuid(),
  signetId: z.uuid(),
  operation: z.string().min(1).max(80),
  input: accessInputSchema,
});
export type AccessRequest = z.infer<typeof accessRequestSchema>;
/** What a caller sends: fields with a default (`input.limit`) may be left out. */
export type AccessRequestInput = z.input<typeof accessRequestSchema>;
export const accessResultSchema = z.object({ executionId: z.uuid(), result: z.unknown() });

/**
 * Every operation a contract in this package declares (`threads.ts`, `chorus.ts`, `archive.ts`,
 * `github.ts`), and the input each takes. Kingdom's `access/execute` check, its catalog and its
 * dispatch read these, so a new operation is added here and nowhere else. Operation names are
 * unique across contracts.
 */
export const declaredOperationSchema = z.enum([
  ...threadOperationSchema.options,
  ...chorusOperationSchema.options,
  ...archiveOperationSchema.options,
  ...githubOperationSchema.options,
]);
export type DeclaredOperation = z.infer<typeof declaredOperationSchema>;
export const operationInputSchemas = {
  ...threadInputSchemas,
  ...chorusInputSchemas,
  ...archiveInputSchemas,
  ...githubInputSchemas,
} as const satisfies Record<DeclaredOperation, z.ZodObject>;
export type OperationInput<O extends DeclaredOperation> = z.infer<
  (typeof operationInputSchemas)[O]
>;

/** The `access/execute` input keys a declared operation takes, besides `resourceId` and `limit`. */
export const operationInputKeys = <O extends DeclaredOperation>(operation: O) =>
  Object.keys(operationInputSchemas[operation].shape) as (keyof OperationInput<O>)[];

/**
 * A declared operation's input, taken from an `access/execute` input: exactly the keys that
 * operation takes (no `resourceId`, no `limit`). Kingdom builds `operation.request` frames and
 * Archive calls with it.
 */
export const operationInputFromAccess = <O extends DeclaredOperation>(
  operation: O,
  input: AccessRequest['input'],
) => {
  const schema = operationInputSchemas[operation];
  const picked = Object.fromEntries(
    Object.keys(schema.shape).flatMap((key) =>
      key in input ? [[key, input[key as keyof typeof input]]] : [],
    ),
  );
  return schema.safeParse(picked) as z.ZodSafeParseResult<OperationInput<O>>;
};

/**
 * The operations Kingdom relays to an Installation over its socket (a `delivery: 'installationSocket'`
 * provider's), each with its contract below, keyed by operation as `operationInputSchemas` is. Kingdom
 * admits the call, sends `operation.request`, waits `relayedOperationTimeoutMs` for the host's
 * `operation.response` and reads it by the operation's result and refusals. A relayed operation is
 * added here and nowhere else. `thread.subscribe` is relayed but not declared: it opens a member's
 * live view of a thread and is admitted as `thread.read`.
 */
export const relayedOperationSchema = z.enum([
  ...threadOperationSchema.options,
  'thread.subscribe',
  ...chorusOperationSchema.options,
]);
export type RelayedOperation = z.infer<typeof relayedOperationSchema>;

/** The `input` each relayed operation's request carries: a declared operation's own input. */
export const relayedOperationInputSchemas = {
  ...threadInputSchemas,
  'thread.subscribe': z.strictObject({}),
  ...chorusInputSchemas,
} as const satisfies Record<RelayedOperation, z.ZodObject>;
export type RelayedOperationInput<O extends RelayedOperation> = z.infer<
  (typeof relayedOperationInputSchemas)[O]
>;

/** The fields each relayed operation's request carries beside the common ones, flat on the frame. */
export const relayedOperationContextSchemas = {
  'thread.read': threadOperationContextSchema,
  'thread.prompt': threadOperationContextSchema,
  'thread.floor': threadOperationContextSchema,
  'prompt.resolve': threadOperationContextSchema,
  'thread.subscribe': threadOperationContextSchema,
  'chorus.advise': chorusOperationContextSchema,
  'chorus.guard': chorusOperationContextSchema,
  'chorus.brief': chorusOperationContextSchema,
  'chorus.consumed': chorusOperationContextSchema,
  'chorus.milestone': chorusOperationContextSchema,
  'chorus.handBack': chorusOperationContextSchema,
  'chorus.review': chorusOperationContextSchema,
  'chorus.conventions': chorusOperationContextSchema,
  'chorus.debugReason': chorusOperationContextSchema,
  'chorus.projectActivity': chorusOperationContextSchema,
} as const satisfies Record<RelayedOperation, z.ZodObject>;
export type RelayedOperationContext<O extends RelayedOperation> = z.infer<
  (typeof relayedOperationContextSchemas)[O]
>;

/** What the host answers each relayed operation with. */
export const relayedOperationResultSchemas = {
  ...threadResultSchemas,
  ...chorusResultSchemas,
} as const satisfies Record<RelayedOperation, z.ZodType>;
export type RelayedOperationResult<O extends RelayedOperation> = z.infer<
  (typeof relayedOperationResultSchemas)[O]
>;

/**
 * The refusals every relayed operation has, because the socket answers them itself: a request it
 * could not read (`invalid_request`) and an error inside the host, or no handler (`failed`). Kingdom
 * records both as `failed`.
 */
export const relayedOperationCommonRefusals = ['invalid_request', 'failed'] as const;
export type RelayedOperationCommonRefusal = (typeof relayedOperationCommonRefusals)[number];

/** Why the host may refuse each relayed operation; each includes `relayedOperationCommonRefusals`. */
export const relayedOperationRefusals = {
  'thread.read': threadRefusalSchema,
  'thread.prompt': threadRefusalSchema,
  'thread.floor': threadRefusalSchema,
  'prompt.resolve': threadRefusalSchema,
  'thread.subscribe': threadRefusalSchema,
  'chorus.advise': chorusRefusalSchema,
  'chorus.guard': chorusRefusalSchema,
  'chorus.brief': chorusRefusalSchema,
  'chorus.consumed': chorusRefusalSchema,
  'chorus.milestone': chorusRefusalSchema,
  'chorus.handBack': chorusRefusalSchema,
  'chorus.review': chorusRefusalSchema,
  'chorus.conventions': chorusRefusalSchema,
  'chorus.debugReason': chorusRefusalSchema,
  'chorus.projectActivity': chorusRefusalSchema,
} as const satisfies Record<
  RelayedOperation,
  z.ZodEnum<{ [C in RelayedOperationCommonRefusal]: C } & Record<string, string>>
>;
export type RelayedOperationRefusalCode<O extends RelayedOperation = RelayedOperation> = z.infer<
  (typeof relayedOperationRefusals)[O]
>;

/**
 * The refusals Kingdom records as `AccessExecution.status = 'denied'`, per relayed operation; any
 * other refusal is `failed`.
 */
export const relayedOperationDeniedRefusals = {
  'thread.read': threadDeniedRefusals,
  'thread.prompt': threadDeniedRefusals,
  'thread.floor': threadDeniedRefusals,
  'prompt.resolve': threadDeniedRefusals,
  'thread.subscribe': threadDeniedRefusals,
  'chorus.advise': chorusDeniedRefusals,
  'chorus.guard': chorusDeniedRefusals,
  'chorus.brief': chorusDeniedRefusals,
  'chorus.consumed': chorusDeniedRefusals,
  'chorus.milestone': chorusDeniedRefusals,
  'chorus.handBack': chorusDeniedRefusals,
  'chorus.review': chorusDeniedRefusals,
  'chorus.conventions': chorusDeniedRefusals,
  'chorus.debugReason': chorusDeniedRefusals,
  'chorus.projectActivity': chorusDeniedRefusals,
} as const satisfies { [O in RelayedOperation]: readonly RelayedOperationRefusalCode<O>[] };

/**
 * How long Kingdom waits for each relayed operation's answer, and so the lease its execution row is
 * admitted with. Past it the call is `unknown` (`host_timeout`, 504) and a late answer is dropped;
 * the host has no deadline of its own.
 */
export const relayedOperationTimeoutMs: Record<RelayedOperation, number> = {
  'thread.read': 15_000,
  'thread.prompt': 15_000,
  'thread.floor': 15_000,
  'prompt.resolve': 15_000,
  'thread.subscribe': 15_000,
  ...chorusOperationTimeoutMs,
};

export type OperationRequestFrame<O extends RelayedOperation> = {
  type: 'operation.request';
  /** The `AccessExecution` id: one per admitted call, and the id the answer carries back. */
  requestId: string;
  signetId: string;
  /** The Signet revision Kingdom admitted the call under. */
  acceptedRevision: number;
  operation: O;
  input: RelayedOperationInput<O>;
} & RelayedOperationContext<O>;

/**
 * Kingdom → host over the Installation socket: one admitted call of a relayed operation, keyed by
 * `type` as every Kingdom → host frame is. Flat: the common fields, the operation's context fields,
 * the operation and its input. The host trusts it (Kingdom's admission is the membership check) and
 * answers with `operation.response` carrying the same `requestId`.
 */
export const operationRequestFrameSchema = <O extends RelayedOperation>(
  operation: O,
): z.ZodType<OperationRequestFrame<O>> =>
  z.strictObject({
    type: z.literal('operation.request'),
    requestId: z.uuid(),
    signetId: z.uuid(),
    acceptedRevision: z.number().int().min(1),
    ...relayedOperationContextSchemas[operation].shape,
    operation: z.literal(operation),
    input: relayedOperationInputSchemas[operation],
  }) as unknown as z.ZodType<OperationRequestFrame<O>>;

const operationOutcomeSchema = <R extends z.ZodType, C extends z.ZodType<string>>(
  result: R,
  refusal: C,
) =>
  z.discriminatedUnion('ok', [
    z.strictObject({ ok: z.literal(true), result }),
    z.strictObject({
      ok: z.literal(false),
      refusal,
      message: z.string().max(500).optional(),
    }),
  ]);

export type OperationResponseFrame<O extends RelayedOperation> = {
  action: 'operation.response';
  requestId: string;
  outcome: RelayedOperationOutcome<O>;
};

/**
 * Host → Kingdom: the answer to one `operation.request`, keyed by `action` as every host → Kingdom
 * frame is, read by the operation that was asked.
 */
export const operationResponseFrameSchema = <O extends RelayedOperation>(
  operation: O,
): z.ZodType<OperationResponseFrame<O>> =>
  z.strictObject({
    action: z.literal('operation.response'),
    requestId: z.uuid(),
    outcome: operationOutcomeSchema(
      relayedOperationResultSchemas[operation],
      relayedOperationRefusals[operation],
    ),
  }) as unknown as z.ZodType<OperationResponseFrame<O>>;
/** The response envelope before Kingdom knows which request it answers. */
export const operationResponseEnvelopeSchema = z.strictObject({
  action: z.literal('operation.response'),
  requestId: z.uuid(),
  outcome: operationOutcomeSchema(z.unknown(), z.string().min(1).max(80)),
});
export type OperationResponseEnvelope = z.infer<typeof operationResponseEnvelopeSchema>;
export type RelayedOperationOutcome<O extends RelayedOperation> =
  | { ok: true; result: RelayedOperationResult<O> }
  | { ok: false; refusal: RelayedOperationRefusalCode<O>; message?: string };

/** A host's answer to a relayed operation: its result. */
export const relayedOperationResult = <R>(result: R) => ({ ok: true as const, result });
/** A host's refusal of a relayed operation, its message cut to 500 characters. */
export const relayedOperationRefusal = <C extends string>(refusal: C, message?: string) => ({
  ok: false as const,
  refusal,
  ...(message ? { message: message.slice(0, 500) } : {}),
});

/**
 * Viewer frames: Kingdom forwards a browser's requests for an Installation's own web viewer over the
 * Installation socket, and the Installation answers them. Kingdom has already admitted the browser
 * (whoever may manage the integration); the frames carry HTTP as it is and nothing of Kingdom's.
 * A body travels after its head in `…body` frames of at most `viewerBodyChunkBytes`, the last one
 * marked, so a large or streamed body never holds the socket's other frames behind one message.
 *
 * Headers are one value per name. The host sends its response's headers as they are, less
 * `set-cookie` (the viewer sets no cookie through Kingdom); Kingdom chooses which reach the browser
 * and sets the transfer headers itself (`content-length`, `transfer-encoding`, `connection`).
 * Kingdom holds a browser's socket messages until `viewer.socket.opened`. A host that serves no
 * viewer ignores these frames, so Kingdom sends them only after `viewer.serving` said true.
 */
export const viewerBodyChunkBytes = 192 * 1024;
/** The largest request body Kingdom forwards; past it the browser is answered 413. */
export const viewerMaxRequestBodyBytes = 8 * 1024 * 1024;
/** The longest text message of the viewer's own socket, either way. */
export const viewerMaxSocketMessageChars = 1024 * 1024;

const viewerHeadersSchema = z.record(z.string().min(1).max(200), z.string().max(16_384));
/** A path on the viewer's own address: one leading slash, so it can never name another host. */
const viewerPathSchema = z
  .string()
  .max(8_192)
  .regex(/^\/(?![/\\])/);
const viewerBodyShape = {
  requestId: z.uuid(),
  /** Base64 of at most `viewerBodyChunkBytes` bytes. */
  data: z.string().max(Math.ceil(viewerBodyChunkBytes / 3) * 4),
  last: z.boolean(),
};
/** The close codes an endpoint may send: 1000–1003, 1007–1014 and 3000–4999. */
export const viewerSocketCloseCodeSent = (code: number) =>
  (code >= 1000 && code <= 1003) ||
  (code >= 1007 && code <= 1014) ||
  (code >= 3000 && code <= 4999);
/** A close reason is at most 123 bytes of UTF-8 on the wire. */
export const viewerSocketCloseReasonBytes = 123;
const viewerSocketCloseShape = {
  socketId: z.uuid(),
  code: z.number().int().refine(viewerSocketCloseCodeSent).optional(),
  reason: z
    .string()
    .refine((reason) => Buffer.byteLength(reason) <= viewerSocketCloseReasonBytes)
    .optional(),
};
const viewerSocketMessageShape = {
  socketId: z.uuid(),
  data: z.string().max(viewerMaxSocketMessageChars),
};

/** Kingdom → host: the head of one browser request. `origin` is the address the browser used. */
export const viewerRequestFrameSchema = z
  .strictObject({
    type: z.literal('viewer.request'),
    requestId: z.uuid(),
    origin: z.url(),
    method: z.string().min(1).max(16),
    path: viewerPathSchema,
    headers: viewerHeadersSchema,
    /** Whether `viewer.request.body` frames follow; never on GET or HEAD. */
    hasBody: z.boolean(),
  })
  .refine((frame) => !frame.hasBody || !['GET', 'HEAD'].includes(frame.method.toUpperCase()));
export type ViewerRequestFrame = z.infer<typeof viewerRequestFrameSchema>;
export const viewerRequestBodyFrameSchema = z.strictObject({
  type: z.literal('viewer.request.body'),
  ...viewerBodyShape,
});
/** Kingdom → host: the browser gave up on a request; the host stops answering it. */
export const viewerRequestCancelFrameSchema = z.strictObject({
  type: z.literal('viewer.request.cancel'),
  requestId: z.uuid(),
});
/** Kingdom → host: the browser opened the viewer's own WebSocket. */
export const viewerSocketOpenFrameSchema = z.strictObject({
  type: z.literal('viewer.socket.open'),
  socketId: z.uuid(),
  origin: z.url(),
  path: viewerPathSchema,
  headers: viewerHeadersSchema,
});
export type ViewerSocketOpenFrame = z.infer<typeof viewerSocketOpenFrameSchema>;
export const viewerSocketMessageToHostFrameSchema = z.strictObject({
  type: z.literal('viewer.socket.message'),
  ...viewerSocketMessageShape,
});
export const viewerSocketCloseToHostFrameSchema = z.strictObject({
  type: z.literal('viewer.socket.close'),
  ...viewerSocketCloseShape,
});
/** Every viewer frame Kingdom sends a host. */
export const viewerHostFrameSchema = z.discriminatedUnion('type', [
  viewerRequestFrameSchema,
  viewerRequestBodyFrameSchema,
  viewerRequestCancelFrameSchema,
  viewerSocketOpenFrameSchema,
  viewerSocketMessageToHostFrameSchema,
  viewerSocketCloseToHostFrameSchema,
]);
export type ViewerHostFrame = z.infer<typeof viewerHostFrameSchema>;

/** Host → Kingdom: the head of the answer to one `viewer.request`. */
export const viewerResponseFrameSchema = z.strictObject({
  action: z.literal('viewer.response'),
  requestId: z.uuid(),
  status: z.number().int().min(100).max(599),
  headers: viewerHeadersSchema,
  /** Whether `viewer.response.body` frames follow. */
  hasBody: z.boolean(),
});
export type ViewerResponseFrame = z.infer<typeof viewerResponseFrameSchema>;
export const viewerResponseBodyFrameSchema = z.strictObject({
  action: z.literal('viewer.response.body'),
  ...viewerBodyShape,
  /** On the last frame: the body stopped before its end, so Kingdom breaks the browser's response off. */
  cutShort: z.literal(true).optional(),
});
/** Host → Kingdom: the viewer accepted the socket; messages may flow. A refusal is a close. */
export const viewerSocketOpenedFrameSchema = z.strictObject({
  action: z.literal('viewer.socket.opened'),
  socketId: z.uuid(),
});
export const viewerSocketMessageToKingdomFrameSchema = z.strictObject({
  action: z.literal('viewer.socket.message'),
  ...viewerSocketMessageShape,
});
export const viewerSocketCloseToKingdomFrameSchema = z.strictObject({
  action: z.literal('viewer.socket.close'),
  ...viewerSocketCloseShape,
});
/**
 * Host → Kingdom: whether this Installation answers viewer frames now. Sent on every connect and
 * when the owner changes it on the machine; Kingdom offers to open the viewer only while it is true.
 * False also ends every request and socket in flight: the host answers none of them further.
 */
export const viewerServingFrameSchema = z.strictObject({
  action: z.literal('viewer.serving'),
  serving: z.boolean(),
});
/** Every viewer frame a host sends Kingdom. */
export const viewerKingdomFrameSchema = z.discriminatedUnion('action', [
  viewerResponseFrameSchema,
  viewerResponseBodyFrameSchema,
  viewerSocketOpenedFrameSchema,
  viewerSocketMessageToKingdomFrameSchema,
  viewerSocketCloseToKingdomFrameSchema,
  viewerServingFrameSchema,
]);
export type ViewerKingdomFrame = z.infer<typeof viewerKingdomFrameSchema>;

/** What Kingdom pushes over the Installation socket, and what a poll of both reads assembles. */
export const installationSnapshotSchema = installationInquiriesResponseSchema.extend(
  installationSignetsResponseSchema.shape,
);

/** An entry a reader dropped instead of failing the whole read, and why (review U1). */
export type DroppedEntry = { list: string; index: number; id: string | null; reason: string };
export type InstallationSnapshot = z.infer<typeof installationSnapshotSchema> & {
  dropped: DroppedEntry[];
};

const entryId = (value: unknown) => {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const id = record.signetId ?? record.id ?? record.resourceId ?? record.integrationResourceId;
  return typeof id === 'string' ? id.slice(0, 80) : null;
};
/**
 * Parse each entry on its own and drop the ones that don't parse. A Kingdom ahead of this package
 * (a term it doesn't know, a new field shape) then costs only those entries: never the
 * Installation's other grants or its own held Signets. A missing list reads as empty, reported.
 */
export function parseEntries<T>(
  list: string,
  value: unknown,
  schema: z.ZodType<T>,
  dropped: DroppedEntry[],
  check: (entry: T) => string | null = () => null,
): T[] {
  if (!Array.isArray(value)) {
    dropped.push({ list, index: -1, id: null, reason: 'missing or not a list' });
    return [];
  }
  return value.flatMap((raw, index) => {
    const parsed = schema.safeParse(raw);
    const reason = parsed.success
      ? check(parsed.data)
      : parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    if (reason === null && parsed.success) return [parsed.data];
    dropped.push({ list, index, id: entryId(raw), reason: (reason ?? 'invalid').slice(0, 500) });
    return [];
  });
}

/**
 * Signets read per entry, and their resources per entry inside them: a resource this package can't
 * read is dropped and reported, and the Signet is
 * kept, so the Installation never loses a held Signet (or mistakes a member for revoked) over one
 * resource.
 */
function parseSignetsWithGrants<S extends z.ZodObject<{ resources: typeof grantsSchema }>>(
  list: string,
  value: unknown,
  schema: S,
  dropped: DroppedEntry[],
): z.infer<S>[] {
  const identity = schema.omit({ resources: true }).extend({ resources: z.unknown().optional() });
  return parseEntries(list, value, identity, dropped).map(
    (entry) =>
      ({
        ...entry,
        resources: parseEntries(
          `${list}.${entryId(entry)}.resources`,
          entry.resources,
          signetGrantSchema,
          dropped,
        ),
      }) as z.infer<S>,
  );
}

const eventChannelIntegrationSchema = eventChannelMapSchema.element.extend({
  channels: z.unknown().optional(),
});

/**
 * `eventChannels`, per integration and per channel inside it: one this package can't read is
 * dropped and reported, and the Signet and its other channels are kept.
 */
export function parseEventChannelMap(
  list: string,
  value: unknown,
  dropped: DroppedEntry[],
): EventChannelMap {
  return parseEntries(list, value, eventChannelIntegrationSchema, dropped).map((entry) => ({
    ...entry,
    channels: parseEntries(
      `${list}.${entry.integration.id}.channels`,
      entry.channels,
      eventChannelSchema,
      dropped,
    ),
  }));
}

const heldSignetIdentitySchema = installationSignetSchema.extend({
  eventChannels: z.unknown().optional(),
});

const inquiriesScalars = installationInquiriesResponseSchema.pick({
  pending: true,
  declinedAt: true,
});

/** `installationInquiries`, per entry. */
export function parseInstallationInquiries(value: unknown, dropped: DroppedEntry[] = []) {
  const record = z.object({}).loose().parse(value);
  return {
    ...inquiriesScalars.parse(record),
    inquiries: parseEntries('inquiries', record.inquiries, installationInquirySchema, dropped),
    hostedSignetRequests: parseEntries(
      'hostedSignetRequests',
      record.hostedSignetRequests,
      hostedSignetRequestSchema,
      dropped,
    ),
    dropped,
  };
}

/** `installationSignets`, per Signet, and per resource and event channel inside it. */
export function parseInstallationSignets(value: unknown, dropped: DroppedEntry[] = []) {
  const record = z.object({}).loose().parse(value);
  return {
    signets: parseSignetsWithGrants(
      'signets',
      record.signets,
      heldSignetIdentitySchema,
      dropped,
    ).map(
      ({ eventChannels, ...signet }): InstallationSignet =>
        eventChannels === undefined
          ? signet
          : {
              ...signet,
              eventChannels: parseEventChannelMap(
                `signets.${signet.signetId}.eventChannels`,
                eventChannels,
                dropped,
              ),
            },
    ),
    hostedSignets: parseSignetsWithGrants(
      'hostedSignets',
      record.hostedSignets,
      hostedSignetSchema,
      dropped,
    ),
    dropped,
  };
}

/** The Installation socket's snapshot frame (or a poll of both reads), per entry. */
export function parseInstallationSnapshot(value: unknown): InstallationSnapshot {
  const dropped: DroppedEntry[] = [];
  const { dropped: _inquiries, ...inquiries } = parseInstallationInquiries(value, dropped);
  const { dropped: _signets, ...signets } = parseInstallationSignets(value, dropped);
  return { ...inquiries, ...signets, dropped };
}

export type ParsedSignetDescription = SignetDescription & { dropped: DroppedEntry[] };

/**
 * `access/describe`, per entry: a resource whose lens doesn't parse is dropped, and so is an event channel that doesn't parse.
 */
export function parseSignetDescription(value: unknown): ParsedSignetDescription {
  const dropped: DroppedEntry[] = [];
  const record = z
    .object({ operations: z.array(z.object({}).loose()) })
    .loose()
    .parse(value);
  const operations = record.operations.map((operation, index) => ({
    ...signetDescriptionSchema.shape.operations.element.omit({ resources: true }).parse(operation),
    resources: parseEntries(
      `operations.${index}.resources`,
      operation.resources,
      signetDescriptionResourceSchema,
      dropped,
    ),
  }));
  const eventChannels =
    record.eventChannels === undefined
      ? {}
      : { eventChannels: parseEventChannelMap('eventChannels', record.eventChannels, dropped) };
  return {
    ...signetDescriptionSchema.parse({ ...record, operations, ...eventChannels }),
    dropped,
  };
}

/** The path a socket proof is bound to (POST), though the socket itself opens at the API origin. */
export const installationSocketAction = 'installationSocket';

/**
 * A Signet presenter's socket (design §5.6.1, review Round 4). Like the Installation socket: a DPoP
 * proof bound to `POST /api/v1/access/signetSocket`, on a single-use Kingdom nonce, with `ath` over
 * the access token. The socket then carries one actor, that Signet's presentation, until the token
 * expires; `renewPresentation` (a new token, a new proof) extends it.
 */
export const signetSocketAction = 'signetSocket';
const presentation = {
  accessToken: z.string().regex(accessTokenPattern),
  proof: z.string().max(8192),
};
export const authenticateSignetFrameSchema = z.strictObject({
  action: z.literal('authenticateSignet'),
  ...presentation,
});
export const renewPresentationFrameSchema = z.strictObject({
  action: z.literal('renewPresentation'),
  ...presentation,
});
/** Kingdom's answer to either: the presentation the socket now carries, and until when. */
export const signetPresentedFrameSchema = z.object({
  type: z.literal('signet'),
  signetId: z.uuid(),
  enrollmentId: z.uuid(),
  expiresAt: z.iso.datetime(),
});
export const signetRejectedFrameSchema = z.object({ type: z.literal('signetRejected') });
