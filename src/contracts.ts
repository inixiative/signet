import { z } from 'zod';
import {
  foundryIdSchema,
  narrowsThreadsLens,
  type ThreadOperation,
  threadFloorActionSchema,
  threadIdSchema,
  threadInputSchemas,
  threadsLensSchema,
  threadsResourceKind,
  threadTextLimit,
} from './threads';

export * from './threads';

const token43 = /^[A-Za-z0-9_-]{43}$/;

export const accessTokenPattern = /^kingdom_[A-Za-z0-9_-]{43}$/;
export const renewalCredentialPattern = /^signet_renew_[A-Za-z0-9_-]{43}$/;
export const nonceSchema = z.string().regex(token43);

export const archiveDocumentIdSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const archiveFieldSchema = z.enum(['id', 'title', 'content', 'tags', 'createdAt']);
export type ArchiveField = z.infer<typeof archiveFieldSchema>;

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

/** The resource kind of a hosted Archive library: one per Archive integration. */
export const archiveLibraryResourceKind = 'archiveLibrary';
/** Which documents and fields of an `archiveLibrary` a grant reaches; `{}` reaches all of them. */
export const archiveLensSchema = z.strictObject({
  documentIds: z.array(archiveDocumentIdSchema).max(1000).optional(),
  fields: z.array(archiveFieldSchema).max(6).optional(),
});
export type ArchiveLens = z.infer<typeof archiveLensSchema>;
/** Every other resource kind takes no lens. */
export const emptyLensSchema = z.strictObject({});

/**
 * A grant's lens. `signetResourceSchema` names a resource by id with no `kind`, so the contract can
 * only hold a union of the strict shapes; which shape a grant may carry depends on its resource's
 * kind, and Kingdom checks that with `resourceLensSchema` against the kind it stores (review R9).
 * `{}` parses as the empty Archive lens: "no lens", valid for every kind but `threads`.
 */
export const signetLensSchema = z.union([archiveLensSchema, threadsLensSchema]);
export type SignetLens = z.infer<typeof signetLensSchema>;

/** The lens shape a resource of `kind` takes. */
export const resourceLensSchema = (kind: string) =>
  kind === archiveLibraryResourceKind
    ? archiveLensSchema
    : kind === threadsResourceKind
      ? threadsLensSchema
      : emptyLensSchema;

const subset = <T>(granted: T[] | undefined, requested: T[] | undefined) =>
  !requested || (granted !== undefined && granted.every((item) => requested.includes(item)));

/**
 * `granted` reaches nothing `requested` doesn't, for lenses of the same resource. Approving someone
 * else's request may only narrow; an owner revising their own grant may widen (review U3). A lens of
 * another shape than the request's is refused.
 */
export const narrowsSignetLens = (granted: SignetLens, requested: SignetLens): boolean => {
  if ('threads' in granted || 'threads' in requested)
    return 'threads' in granted && 'threads' in requested && narrowsThreadsLens(granted, requested);
  return (
    subset(granted.documentIds, requested.documentIds) && subset(granted.fields, requested.fields)
  );
};

export const signetResourceSchema = z.strictObject({
  resourceId: z.uuid(),
  operations: z.array(z.string().min(1).max(80)).min(1).max(100),
  lens: signetLensSchema.default({}),
});
export const signetRecipientSchema = z.discriminatedUnion('recipientModel', [
  z.strictObject({ recipientModel: z.literal('User'), userId: z.uuid() }),
  z.strictObject({ recipientModel: z.literal('Integration'), integrationId: z.uuid() }),
]);
export const signetLifecycleSchema = z.enum(['request', 'task', 'ongoing']);
export type SignetRecipient = z.infer<typeof signetRecipientSchema>;
export type SignetResource = z.infer<typeof signetResourceSchema>;

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
  integrationId: z.uuid(),
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
  maxConcurrent: z.number().int().min(1).max(20),
};
/** A local Foundry, Archive or Oracle known to Kingdom by its key. */
export const installationKindSchema = z.enum(['foundry', 'archive', 'oracle']);
export type InstallationKind = z.infer<typeof installationKindSchema>;
/**
 * A resource asked for by kind, and optionally name, when the asker does not know its id: an
 * Installation registering, or a party asking to join a Foundry's `threads` (one per Foundry, so the
 * integration id names it). Kingdom resolves it to the resource's id before anyone reviews it.
 */
export const requestedResourceKindSchema = z.strictObject({
  resourceKind: z.string().min(1).max(80),
  resourceName: z.string().trim().min(1).max(120).optional(),
  operations: z.array(z.string().min(1).max(80)).min(1).max(100),
  lens: signetLensSchema.default({}),
});
export const requestedResourceSchema = z.union([signetResourceSchema, requestedResourceKindSchema]);
/** What a party asks for on an integration: resources by id or by kind (review R8). */
export const signetProposalSchema = z.strictObject({
  ...signetTerms,
  integrationId: z.uuid(),
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
  resources: z.array(requestedResourceSchema).max(100),
});
/** A person asks for a Signet on an integration, to be presented with `publicKey`. */
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
export type RequestedResource = z.input<typeof requestedResourceSchema>;
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
 * A pending `signetRequest` whose target is one of the Installation's integrations: a party asking
 * to join a Foundry's threads. The owner reviews it in Kingdom at `reviewUrl`.
 */
export const hostedSignetRequestSchema = z.object({
  id: z.uuid(),
  status: inquiryStatusSchema,
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime().nullable(),
  /** The Installation's integration the request targets. */
  integrationId: z.uuid(),
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

/** One resource a Signet reaches, with its stored kind, so its lens can be checked against it. */
export const signetGrantSchema = z.object({
  resourceId: z.uuid(),
  kind: z.string().min(1).max(80),
  operations: z.array(z.string().min(1).max(80)),
  lens: signetLensSchema,
});
export type SignetGrant = z.infer<typeof signetGrantSchema>;
/** Whether a grant's lens is the shape its resource's kind takes. */
export const grantLensFitsKind = (grant: Pick<SignetGrant, 'kind' | 'lens'>) =>
  resourceLensSchema(grant.kind).safeParse(grant.lens).success;

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
  integrationId: z.uuid(),
  name: z.string(),
  /** The enrollment that is current for this installation's key, if any. */
  enrollmentId: z.uuid().nullable(),
  owner: ownerRefSchema,
  /** What the Signet reaches, so a holder knows, for example, which threads it may open. */
  resources: z.array(signetGrantSchema),
});
/**
 * A Signet issued on one of the Installation's integrations: a member of a Foundry's conversations.
 * For display and for cancelling a member's queued work once it is gone, never as an admission
 * gate: Kingdom admits every call.
 */
export const hostedSignetSchema = z.object({
  signetId: z.uuid(),
  /** The Installation's integration the Signet is issued on. */
  integrationId: z.uuid(),
  name: z.string(),
  /** The current revision; the host compares it with the `acceptedRevision` frames carry. */
  revision: z.number().int().min(1),
  lifecycle: signetLifecycleSchema,
  expiresAt: z.iso.datetime().nullable(),
  maxRequests: z.number().int().nullable(),
  maxConcurrent: z.number().int(),
  recipient: z.object({
    recipientModel: signetRecipientModelSchema,
    id: z.uuid(),
    displayName: z.string(),
  }),
  resources: z.array(signetGrantSchema),
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

export const signetDescriptionResourceSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  kind: z.string(),
  integrationId: z.uuid(),
  lens: signetLensSchema,
});
export const signetDescriptionSchema = z.object({
  signetId: z.uuid(),
  integrationId: z.uuid(),
  provider: z.string().nullable(),
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
  threadId: threadIdSchema.optional(),
  postId: z.uuid().optional(),
  text: z.string().min(1).max(threadTextLimit).optional(),
  inReplyTo: foundryIdSchema.optional(),
  afterSeq: z.number().int().min(0).optional(),
  floor: threadFloorActionSchema.optional(),
  promptId: foundryIdSchema.optional(),
  answer: threadInputSchemas['prompt.resolve'].shape.answer.optional(),
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
 * The host-side input of a thread operation, taken from an `access/execute` input: exactly the keys
 * that operation takes (no `resourceId`, no `limit`). Kingdom builds `thread.request` frames with it.
 */
export const threadInputFromAccess = <O extends ThreadOperation>(
  operation: O,
  input: AccessRequest['input'],
) => {
  const schema = threadInputSchemas[operation];
  const picked = Object.fromEntries(
    Object.keys(schema.shape).flatMap((key) =>
      key in input ? [[key, input[key as keyof typeof input]]] : [],
    ),
  );
  return schema.safeParse(picked) as z.ZodSafeParseResult<z.infer<(typeof threadInputSchemas)[O]>>;
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
const lensMismatch = (resources: readonly Pick<SignetGrant, 'kind' | 'lens'>[]) =>
  resources.find((grant) => !grantLensFitsKind(grant));

/**
 * Parse each entry on its own and drop the ones that don't parse. A Kingdom ahead of this package
 * (a selector form it doesn't know, a new field shape) then costs only those entries: never the
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

const kindCheck = (entry: { resources: readonly Pick<SignetGrant, 'kind' | 'lens'>[] }) => {
  const grant = lensMismatch(entry.resources);
  return grant ? `a ${grant.kind} resource carries a lens of another shape` : null;
};

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

/** `installationSignets`, per entry: a Signet whose lens doesn't fit its resource's kind is dropped. */
export function parseInstallationSignets(value: unknown, dropped: DroppedEntry[] = []) {
  const record = z.object({}).loose().parse(value);
  return {
    signets: parseEntries('signets', record.signets, installationSignetSchema, dropped, kindCheck),
    hostedSignets: parseEntries(
      'hostedSignets',
      record.hostedSignets,
      hostedSignetSchema,
      dropped,
      kindCheck,
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

/** `access/describe`, per entry: a resource whose lens doesn't parse, or doesn't fit its kind, is dropped. */
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
      (resource) => (grantLensFitsKind(resource) ? null : 'lens does not fit the resource kind'),
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
