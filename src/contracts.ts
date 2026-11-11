import { z } from 'zod';
import {
  archiveDocumentIdSchema,
  archiveFieldSchema,
  archiveInputSchemas,
  archiveOperationSchema,
} from './archive';
import { githubInputSchemas, githubOperationSchema, gitObjectIdSchema } from './github';
import {
  grantTermsFitKind,
  grantTermsSchema,
  registeredResourceSchema,
  requestedResourceSchema,
  type SignetGrant,
  signetGrantSchema,
  signetResourceSchema,
} from './grants';
import { storedBaseLensSchema, storedLensLayersSchema } from './lens';
import {
  foundryIdSchema,
  threadFloorActionSchema,
  threadIdSchema,
  threadInputSchemas,
  threadOperationSchema,
  threadTextLimit,
} from './threads';

export * from './archive';
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
export const installationKindSchema = z.enum(['foundry', 'archive', 'oracle']);
export type InstallationKind = z.infer<typeof installationKindSchema>;
/**
 * What a party asks for: resources by id, or by kind on the integration each names (review R8). A
 * Signet has no integration of its own; its resources may sit on several.
 */
export const signetProposalSchema = z.strictObject({
  ...signetTerms,
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
  signetId: z.uuid().nullable(),
  deliverBefore: z.iso.datetime().nullable(),
});
/**
 * A pending `signetRequest` that asks for a resource on one of the Installation's integrations: a
 * party asking to join a Foundry's threads. The owner reviews it in Kingdom at `reviewUrl`.
 */
export const hostedSignetRequestSchema = z.object({
  id: z.uuid(),
  status: inquiryStatusSchema,
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime().nullable(),
  requester: z.object({ sourceModel: z.string(), id: z.uuid(), displayName: z.string() }),
  terms: signetReviewProposalSchema,
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
   * which threads it may open.
   */
  resources: grantsSchema,
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
  }),
  /** Each base lens the rows' `lens` layers compose under, keyed by `baseLensId(provider, kind)`. */
  baseLenses: z.record(z.string(), storedBaseLensSchema),
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
  integrationId: z.uuid(),
  /** The integration's provider family (`github`, `anthropic`…): the description has no host. */
  provider: z.string(),
  lens: storedLensLayersSchema.optional(),
  terms: grantTermsSchema.optional(),
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
  threadId: threadIdSchema.optional(),
  postId: z.uuid().optional(),
  text: z.string().min(1).max(threadTextLimit).optional(),
  inReplyTo: foundryIdSchema.optional(),
  aside: threadInputSchemas['thread.prompt'].shape.aside,
  afterSeq: z.number().int().min(0).optional(),
  floor: threadFloorActionSchema.optional(),
  promptId: foundryIdSchema.optional(),
  answer: threadInputSchemas['prompt.resolve'].shape.answer.optional(),
  objectId: gitObjectIdSchema.optional(),
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
export const accessResultSchema = z.object({ executionId: z.uuid(), result: z.unknown() });

/**
 * Every operation a contract in this package declares (`threads.ts`, `archive.ts`, `github.ts`), and the input
 * each takes. Kingdom's `access/execute` check, its catalog and its dispatch read these, so a new
 * operation is added here and nowhere else. Operation names are unique across contracts.
 */
export const declaredOperationSchema = z.enum([
  ...threadOperationSchema.options,
  ...archiveOperationSchema.options,
  ...githubOperationSchema.options,
]);
export type DeclaredOperation = z.infer<typeof declaredOperationSchema>;
export const operationInputSchemas = {
  ...threadInputSchemas,
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
 * operation takes (no `resourceId`, no `limit`). Kingdom builds `thread.request` frames and Archive
 * calls with it.
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
  const id = record.signetId ?? record.id;
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

const termsFit = (grant: SignetGrant) =>
  grant.resourceModel === 'Project' || grantTermsFitKind(grant.kind, grant.terms)
    ? null
    : `a ${grant.kind} resource carries terms of another kind`;

/**
 * Signets read per entry, and their resources per entry inside them: a resource this package can't
 * read (a newer term, terms that don't fit its kind) is dropped and reported, and the Signet is
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
          termsFit,
        ),
      }) as z.infer<S>,
  );
}

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

/** `installationSignets`, per Signet and per resource inside it. */
export function parseInstallationSignets(value: unknown, dropped: DroppedEntry[] = []) {
  const record = z.object({}).loose().parse(value);
  return {
    signets: parseSignetsWithGrants('signets', record.signets, installationSignetSchema, dropped),
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

/** `access/describe`, per entry: a resource whose lens or terms don't parse, or don't fit its kind, is dropped. */
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
      (resource) =>
        grantTermsFitKind(resource.kind, resource.terms)
          ? null
          : 'terms do not fit the resource kind',
    ),
  }));
  return { ...signetDescriptionSchema.parse({ ...record, operations }), dropped };
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
/** An installation hands Kingdom the credential Kingdom uses to reach it (a Foundry's tunnel token). */
export const setInstallationCredentialSchema = z.strictObject({
  integrationId: z.uuid(),
  token: z.string().min(16).max(4096),
});
export const setInstallationCredentialResponseSchema = z.object({ credentialId: z.uuid() });
