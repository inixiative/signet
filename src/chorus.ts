import { z } from 'zod';
import { foundryIdSchema } from './threads';

/**
 * Chorus routing operations (Aron, 2026-11-18 R-2026-11-18-09 / -20; R-2026-11-19-01 / -03).
 * A Chorus resource represents one project served by a Chorus Installation (`externalId` = the
 * Kingdom Project ID). Kingdom admits each call on a Signet and relays it over the Chorus host's
 * `InstallationSocket` as an `operation.request` (`relayedOperationSchema`). Chorus composes
 * regions itself and never retains prompts or responses beyond the call (except the bounded
 * `chorus.debugReason` window when enabled).
 */
export const chorusResourceKind = 'chorus';

export const chorusDomainIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
  .refine((id) => !id.includes('..'), 'Domain ID must not contain ".."');
export const chorusProjectIdSchema = z.string().min(1).max(128);
export const chorusMomentLimit = 64_000;
export const chorusContextLimit = 32_000;
export const chorusKnowledgeLimit = 16_000;
export const chorusAnswerTextLimit = 20_000;
export const chorusDomainCountLimit = 200;
export const chorusMaxDeadlineMs = 60_000;

export const chorusThreadKnowledgeSchema = z
  .record(chorusDomainIdSchema, z.string().max(chorusKnowledgeLimit))
  .refine(
    (record) => Object.keys(record).length <= chorusDomainCountLimit,
    `At most ${chorusDomainCountLimit} domains allowed`,
  );

/**
 * Every Chorus operation, one per kind of call so each carries its own Signet grant and meter
 * (R-2026-11-18-20). `chorus.conventions` moves `foundry_conventions` into Chorus (R-2026-11-19-03).
 */
export const chorusOperationSchema = z.enum([
  'chorus.advise',
  'chorus.guard',
  'chorus.brief',
  'chorus.consumed',
  'chorus.milestone',
  'chorus.handBack',
  'chorus.review',
  'chorus.conventions',
  'chorus.debugReason',
  'chorus.projectActivity',
]);
export type ChorusOperation = z.infer<typeof chorusOperationSchema>;

export const chorusOperationNames: Record<ChorusOperation, string> = {
  'chorus.advise': 'Ask the project chorus to advise on a user message',
  'chorus.guard': "Ask the project chorus to guard a turn's tool activity",
  'chorus.brief': 'Ask the project chorus to brief a subagent handoff',
  'chorus.consumed': 'Ask the project chorus to advise on a consumed work item',
  'chorus.milestone': 'Ask the project chorus to advise before a milestone call',
  'chorus.handBack': 'Ask the project chorus to advise on a turn hand-back message',
  'chorus.review': 'Ask the project chorus for a post-work review and thread-knowledge updates',
  'chorus.conventions': 'Read domain conventions and instructions from the project chorus',
  'chorus.debugReason': 'Ask why a specific Warden decision answered as it did',
  'chorus.projectActivity': 'Start, touch, stop, or inspect the status of a project chorus host',
};

export const chorusEarlierMessagesSchema = z.strictObject({
  messages: z.array(z.string().min(1).max(chorusMomentLimit)).max(50),
  dropped: z.number().int().min(0),
});
export type ChorusEarlierMessages = z.infer<typeof chorusEarlierMessagesSchema>;

export const chorusToolObservationSchema = z.strictObject({
  callIndex: z.number().int().min(0),
  tool: z.string().min(1).max(120),
  filePath: z.string().max(1024).optional(),
  summary: z.string().min(1).max(4_000),
  detail: z.string().max(16_000).optional(),
});
export type ChorusToolObservation = z.infer<typeof chorusToolObservationSchema>;

export const chorusProjectActivityActionSchema = z.enum(['start', 'touch', 'stop', 'status']);
export type ChorusProjectActivityAction = z.infer<typeof chorusProjectActivityActionSchema>;

const sharedAdviceInput = {
  sourceThreadId: foundryIdSchema.optional(),
  moment: z.string().min(1).max(chorusMomentLimit),
  threadState: z.string().max(chorusContextLimit).optional(),
  threadKnowledge: chorusThreadKnowledgeSchema.optional(),
  domains: z.array(chorusDomainIdSchema).min(1).max(chorusDomainCountLimit).optional(),
  deadlineMs: z.number().int().min(1_000).max(chorusMaxDeadlineMs).optional(),
  rosterRevision: z.string().min(1).max(128).optional(),
};

export const chorusInputSchemas = {
  'chorus.advise': z.strictObject({
    ...sharedAdviceInput,
    earlier: chorusEarlierMessagesSchema.optional(),
  }),
  'chorus.guard': z.strictObject({
    sourceThreadId: foundryIdSchema.optional(),
    observations: z.array(chorusToolObservationSchema).min(1).max(chorusDomainCountLimit),
    threadState: z.string().max(chorusContextLimit).optional(),
    threadKnowledge: chorusThreadKnowledgeSchema.optional(),
    domains: z.array(chorusDomainIdSchema).min(1).max(chorusDomainCountLimit).optional(),
    deadlineMs: z.number().int().min(1_000).max(chorusMaxDeadlineMs).optional(),
    rosterRevision: z.string().min(1).max(128).optional(),
  }),
  'chorus.brief': z.strictObject(sharedAdviceInput),
  'chorus.consumed': z.strictObject(sharedAdviceInput),
  'chorus.milestone': z.strictObject(sharedAdviceInput),
  'chorus.handBack': z.strictObject(sharedAdviceInput),
  'chorus.review': z.strictObject({
    sourceThreadId: foundryIdSchema.optional(),
    workSummary: z.string().min(1).max(chorusMomentLimit),
    observations: z.array(chorusToolObservationSchema).max(chorusDomainCountLimit).optional(),
    threadState: z.string().max(chorusContextLimit).optional(),
    threadKnowledge: chorusThreadKnowledgeSchema.optional(),
    domains: z.array(chorusDomainIdSchema).min(1).max(chorusDomainCountLimit).optional(),
    deadlineMs: z.number().int().min(1_000).max(chorusMaxDeadlineMs).optional(),
    rosterRevision: z.string().min(1).max(128).optional(),
  }),
  'chorus.conventions': z.strictObject({
    domain: chorusDomainIdSchema,
  }),
  'chorus.debugReason': z.strictObject({
    callId: z.uuid(),
  }),
  'chorus.projectActivity': z.strictObject({
    activity: chorusProjectActivityActionSchema,
  }),
} as const satisfies Record<ChorusOperation, z.ZodObject>;

/** Flat context fields Kingdom attaches to every relayed Chorus `operation.request`. */
export const chorusOperationContextSchema = z.strictObject({
  /** The project this Chorus resource serves (its `IntegrationResource.externalId`). */
  projectId: chorusProjectIdSchema,
});
export type ChorusOperationContext = z.infer<typeof chorusOperationContextSchema>;

export const chorusUsageSchema = z.object({
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  cacheReadTokens: z.number().int().min(0),
  cacheWriteTokens: z.number().int().min(0),
  costUsd: z.number().min(0).optional(),
});
export type ChorusUsage = z.infer<typeof chorusUsageSchema>;

export const chorusStageOutcomeSchema = z.enum([
  'yes',
  'no',
  'unsure',
  'timeout',
  'error',
  'not-sent',
]);
export type ChorusStageOutcome = z.infer<typeof chorusStageOutcomeSchema>;

export const chorusStageTraceSchema = z.object({
  stage: z.string().min(1).max(64),
  model: z.string().min(1).max(120).optional(),
  outcome: chorusStageOutcomeSchema,
  elapsedMs: z.number().int().min(0).optional(),
  usage: chorusUsageSchema.optional(),
});
export type ChorusStageTrace = z.infer<typeof chorusStageTraceSchema>;

export const chorusWardenOutcomeSchema = z.enum(['spoke', 'no-comment', 'failed', 'not-sent']);
export type ChorusWardenOutcome = z.infer<typeof chorusWardenOutcomeSchema>;

export const chorusWardenAdviceSchema = z.object({
  callId: z.uuid(),
  domain: chorusDomainIdSchema,
  outcome: chorusWardenOutcomeSchema,
  reason: z.string().max(500).optional(),
  snippets: z.array(z.string().max(chorusAnswerTextLimit)).max(100),
  layers: z.array(z.string().max(256)).max(100),
  confidence: z.number().min(0).max(1),
  catchesUp: z.literal(true).optional(),
  elapsedMs: z.number().int().min(0).optional(),
  stages: z.array(chorusStageTraceSchema).max(10).optional(),
  usage: chorusUsageSchema.optional(),
});
export type ChorusWardenAdvice = z.infer<typeof chorusWardenAdviceSchema>;

export const chorusAdviceResultSchema = z.object({
  rosterRevision: z.string().min(1).max(128),
  contributions: z.array(chorusWardenAdviceSchema).max(500),
  elapsedMs: z.number().int().min(0),
  usage: chorusUsageSchema.optional(),
});
export type ChorusAdviceResult = z.infer<typeof chorusAdviceResultSchema>;

export const chorusGuardFindingSchema = z.object({
  domain: chorusDomainIdSchema,
  severity: z.literal('advisory'),
  description: z.string().min(1).max(chorusAnswerTextLimit),
  location: z.string().max(500).optional(),
});
export type ChorusGuardFinding = z.infer<typeof chorusGuardFindingSchema>;

export const chorusGuardResultSchema = z.object({
  rosterRevision: z.string().min(1).max(128),
  findings: z.array(chorusGuardFindingSchema).max(500),
  checkedDomains: z.array(chorusDomainIdSchema).max(500),
  skippedDomains: z.array(chorusDomainIdSchema).max(500),
  elapsedMs: z.number().int().min(0),
  usage: chorusUsageSchema.optional(),
});
export type ChorusGuardResult = z.infer<typeof chorusGuardResultSchema>;

export const chorusReviewResultSchema = z.object({
  rosterRevision: z.string().min(1).max(128),
  threadKnowledgeUpdates: chorusThreadKnowledgeSchema,
  elapsedMs: z.number().int().min(0),
  usage: chorusUsageSchema.optional(),
});
export type ChorusReviewResult = z.infer<typeof chorusReviewResultSchema>;

export const chorusConventionsResultSchema = z.object({
  domain: chorusDomainIdSchema,
  found: z.boolean(),
  title: z.string().max(256).optional(),
  summary: z.string().max(chorusAnswerTextLimit).optional(),
  rosterRevision: z.string().min(1).max(128),
});
export type ChorusConventionsResult = z.infer<typeof chorusConventionsResultSchema>;

export const chorusDebugReasonResultSchema = z.object({
  callId: z.uuid(),
  domain: chorusDomainIdSchema,
  explanation: z.string().min(1).max(chorusAnswerTextLimit),
  elapsedMs: z.number().int().min(0),
});
export type ChorusDebugReasonResult = z.infer<typeof chorusDebugReasonResultSchema>;

export const chorusProjectHostStatusSchema = z.enum([
  'starting',
  'serving',
  'degraded',
  'failed',
  'closed',
]);
export type ChorusProjectHostStatus = z.infer<typeof chorusProjectHostStatusSchema>;

export const chorusProjectActivityResultSchema = z.object({
  projectId: chorusProjectIdSchema,
  status: chorusProjectHostStatusSchema,
  expectedWardens: z.number().int().min(0),
  heldWardens: z.number().int().min(0),
  wardensDown: z.array(chorusDomainIdSchema).max(500),
  rosterRevision: z.string().max(128).optional(),
  reason: z.string().max(500).optional(),
});
export type ChorusProjectActivityResult = z.infer<typeof chorusProjectActivityResultSchema>;

export const chorusResultSchemas = {
  'chorus.advise': chorusAdviceResultSchema,
  'chorus.guard': chorusGuardResultSchema,
  'chorus.brief': chorusAdviceResultSchema,
  'chorus.consumed': chorusAdviceResultSchema,
  'chorus.milestone': chorusAdviceResultSchema,
  'chorus.handBack': chorusAdviceResultSchema,
  'chorus.review': chorusReviewResultSchema,
  'chorus.conventions': chorusConventionsResultSchema,
  'chorus.debugReason': chorusDebugReasonResultSchema,
  'chorus.projectActivity': chorusProjectActivityResultSchema,
} as const satisfies Record<ChorusOperation, z.ZodType>;

export const chorusRefusalSchema = z.enum([
  'unknown_project',
  'chorus_warming',
  'chorus_unavailable',
  'unknown_call',
  'invalid_request',
  'failed',
]);
export type ChorusRefusal = z.infer<typeof chorusRefusalSchema>;

export const chorusDeniedRefusals = [
  'unknown_project',
  'unknown_call',
] as const satisfies readonly ChorusRefusal[];

export const chorusOperationTimeoutMs: Record<ChorusOperation, number> = {
  'chorus.advise': 60_000,
  'chorus.guard': 60_000,
  'chorus.brief': 60_000,
  'chorus.consumed': 60_000,
  'chorus.milestone': 30_000,
  'chorus.handBack': 60_000,
  'chorus.review': 60_000,
  'chorus.conventions': 15_000,
  'chorus.debugReason': 30_000,
  'chorus.projectActivity': 15_000,
};
