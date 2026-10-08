import { z } from 'zod';

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

export const signetLensSchema = z.strictObject({
  documentIds: z.array(archiveDocumentIdSchema).max(1000).optional(),
  fields: z.array(archiveFieldSchema).max(6).optional(),
});
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
export type SignetLens = z.infer<typeof signetLensSchema>;
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
export const signetProposalSchema = z.strictObject({
  ...signetTerms,
  integrationId: z.uuid(),
  resources: z.array(signetResourceSchema).min(1).max(100),
});
export const signetReviewProposalSchema = z.strictObject({
  ...signetTerms,
  resources: z.array(signetResourceSchema).max(100),
});
/** What an Installation asks for when it asks to be registered as an owner's integration. */
export const registrationTermsSchema = z.strictObject({
  ...signetTerms,
  lifecycle: z.literal('ongoing'),
  resources: z.array(signetResourceSchema).max(100),
});
/** A person asks for a Signet on an integration, to be presented with `publicKey`. */
export const signetRequestSchema = z.strictObject({
  ...signetTerms,
  integrationId: z.uuid(),
  resources: z.array(signetResourceSchema).min(1).max(100),
  publicKey: publicClientKeySchema,
});
export const signetRequestResponseSchema = z.object({
  requestId: z.uuid(),
  reviewCode: z.string(),
  expiresAt: z.iso.datetime(),
});
export type SignetProposal = z.infer<typeof signetProposalSchema>;
export type RegistrationTerms = z.infer<typeof registrationTermsSchema>;
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
export const requestRegistrationSchema = z.strictObject({ terms: registrationTermsSchema });
export const requestRegistrationResponseSchema = z.object({
  reviewCode: z.string(),
  expiresAt: z.iso.datetime(),
});
export const installationInquirySchema = z.object({
  id: z.uuid(),
  type: z.string(),
  status: z.enum(['draft', 'sent', 'changesRequested', 'approved', 'denied', 'canceled']),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime().nullable(),
  owner: ownerRefSchema.nullable(),
  ownerName: z.string().nullable(),
  integrationId: z.uuid().nullable(),
  signetId: z.uuid().nullable(),
  deliverBefore: z.iso.datetime().nullable(),
});
export const installationInquiriesResponseSchema = z.object({
  pending: z.object({ reviewCode: z.string(), expiresAt: z.iso.datetime() }).nullable(),
  declinedAt: z.iso.datetime().nullable(),
  inquiries: z.array(installationInquirySchema),
});
export const inquiryReferenceSchema = z.strictObject({ inquiryId: z.uuid() });
export const installationSignetsResponseSchema = z.object({
  signets: z.array(
    z.object({
      signetId: z.uuid(),
      integrationId: z.uuid(),
      name: z.string(),
      owner: ownerRefSchema,
    }),
  ),
});
export const enrollInstallationSignetSchema = z.strictObject({ signetId: z.uuid() });
export const rotateInstallationKeySchema = z.strictObject({
  publicKey: publicClientKeySchema,
  proof: z.string().max(8192),
});
export type InstallationInquiry = z.infer<typeof installationInquirySchema>;

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
      resources: z.array(
        z.object({ id: z.uuid(), name: z.string(), kind: z.string(), integrationId: z.uuid() }),
      ),
    }),
  ),
});
export type SignetDescription = z.infer<typeof signetDescriptionSchema>;

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
/** What Kingdom pushes over the Installation socket, and what a poll of both reads assembles. */
export const installationSnapshotSchema = installationInquiriesResponseSchema.extend(
  installationSignetsResponseSchema.shape,
);
/** The path a socket proof is bound to (POST), though the socket itself opens at the API origin. */
export const installationSocketAction = 'installationSocket';
/** An installation hands Kingdom the credential Kingdom uses to reach it (a Foundry's tunnel token). */
export const setInstallationCredentialSchema = z.strictObject({
  integrationId: z.uuid(),
  token: z.string().min(16).max(4096),
});
export const setInstallationCredentialResponseSchema = z.object({ credentialId: z.uuid() });
