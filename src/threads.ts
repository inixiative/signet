import { z } from 'zod';

/**
 * Agent conversations (Kingdom `docs/AGENT-CONVERSATIONS.md`, Foundry `docs/reference/CONVERSATIONS.md`).
 * A member reaches a host Foundry's main thread through a Signet on the Foundry's single `threads`
 * resource. Kingdom admits each call and relays it over the host's Installation socket; the host
 * answers. Nothing here is stored by Kingdom.
 */
export const threadsResourceKind = 'threads';

/**
 * A Foundry id (a thread, an invitation, a held prompt). Thread ids sit inside Kingdom stream names,
 * which are colon-separated, and inside URL paths, so neither `:` nor `/` is allowed. Main threads
 * are `thread_<uuidv7>`.
 */
export const foundryIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const threadIdSchema = foundryIdSchema;

/** `own`: the member's posts and the sends addressed to it. `thread`: the main thread's messages. */
export const threadViewSchema = z.enum(['own', 'thread']);
/** `note`: rides the owner's next turn. `turn`: queued as a turn of its own. */
export const threadDeliverySchema = z.enum(['note', 'turn']);
/** `review`: the host's sends to this member wait for the owner. `auto`: they leave at once. */
export const threadOutboundSchema = z.enum(['review', 'auto']);
/**
 * The member's own floor rights. `mayTake`: it may take the conch without being given it (a senior
 * pairing with a junior). A role changes by revising the Signet, never in a separate table (Aron,
 * 2026-11-01: "You join with a certain thing... and then you can have it changed or granted or
 * ungranted").
 */
export const threadFloorTermsSchema = z.strictObject({ mayTake: z.boolean().default(false) });

/**
 * A member's terms on a `threads` resource: how it takes part, not which threads it reaches (that
 * is the grant's lens, a json-rules filter Kingdom applies at admission). Every term defaults to its
 * narrowest value, so terms that omit one can only be more careful.
 */
export const threadsTermsSchema = z.strictObject({
  view: threadViewSchema.default('own'),
  delivery: threadDeliverySchema.default('note'),
  outbound: threadOutboundSchema.default('review'),
  floor: threadFloorTermsSchema.default({ mayTake: false }),
});
export type ThreadsTerms = z.infer<typeof threadsTermsSchema>;

/** The row a threads grant's `where` is evaluated over at admission: the thread, by `id`. */
export const threadRow = (threadId: string) => ({ id: threadIdSchema.parse(threadId) });

const order = <T extends string>(values: readonly T[]) => {
  const rank = (value: T) => values.indexOf(value);
  return (granted: T, requested: T) => rank(granted) <= rank(requested);
};
const narrowsView = order(threadViewSchema.options);
const narrowsDelivery = order(threadDeliverySchema.options);
const narrowsOutbound = order(threadOutboundSchema.options);

/**
 * Approving a request may only narrow (`own` < `thread`, `note` < `turn`, `review` < `auto`, and
 * `floor.mayTake` only where it was asked for). Terms don't compose like lens layers, so approval
 * checks them here.
 */
export const narrowsThreadsTerms = (granted: ThreadsTerms, requested: ThreadsTerms): boolean =>
  narrowsView(granted.view, requested.view) &&
  narrowsDelivery(granted.delivery, requested.delivery) &&
  narrowsOutbound(granted.outbound, requested.outbound) &&
  (!granted.floor.mayTake || requested.floor.mayTake);

/** The operations a `threads` resource carries. `prompt.resolve` is for owner recipients only. */
export const threadOperationSchema = z.enum([
  'thread.read',
  'thread.prompt',
  'thread.floor',
  'prompt.resolve',
]);
export type ThreadOperation = z.infer<typeof threadOperationSchema>;

export const threadOperationNames: Record<ThreadOperation, string> = {
  'thread.read': "Read a conversation's thread through this member's view",
  'thread.prompt': 'Post into a conversation',
  'thread.floor': "Request, release or pass a conversation's floor",
  'prompt.resolve': "Answer the host's held prompts (owner only)",
};

/**
 * A party in a conversation, as Foundry names it (not "participant": that is a Warden contributor).
 * `local` is a member on the host's own machine (its own Codex, a local Herald), joined in-process
 * with no Signet; `signet` is one that reaches the host through Kingdom.
 * Read paths (entries, views) use plain objects, so a host that adds a field never costs an older
 * member its entries; terms and request frames stay strict.
 */
export const conversationMemberSchema = z.object({
  kind: z.enum(['owner', 'local', 'signet']),
  id: z.string().min(1).max(128),
});
export type ConversationMember = z.infer<typeof conversationMemberSchema>;

/** A post or a read is capped at 16,000 characters, like Archive document relays. */
export const threadTextLimit = 16_000;

export const threadFloorActionSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('request') }),
  /** Take the conch without being given it: only under `floor.mayTake`. */
  z.strictObject({ action: z.literal('take') }),
  z.strictObject({ action: z.literal('release') }),
  z.strictObject({ action: z.literal('pass'), to: conversationMemberSchema }),
]);

/**
 * The input each thread operation takes, as the host receives it. `access/execute` carries the same
 * fields beside `resourceId` (`accessInputSchema`); Kingdom allows exactly these keys per operation.
 */
export const threadInputSchemas = {
  'thread.read': z.strictObject({
    threadId: threadIdSchema,
    afterSeq: z.number().int().min(0).optional(),
  }),
  /** `postId` is the member's own id for the post: a retry with a new request id keeps it. */
  'thread.prompt': z.strictObject({
    threadId: threadIdSchema,
    postId: z.uuid(),
    text: z.string().min(1).max(threadTextLimit),
    /** The invitation a `speak-when-spoken-to` reply answers. */
    inReplyTo: foundryIdSchema.optional(),
    /**
     * An aside: person to person, out of the thread's log (entry kind `aside`). Every person in the
     * thread sees it and no agent does, until someone promotes it to a post. A person types it, never
     * an agent; it is not floor-gated and starts no turn.
     */
    aside: z.literal(true).optional(),
  }),
  'thread.floor': z.strictObject({ threadId: threadIdSchema, floor: threadFloorActionSchema }),
  'prompt.resolve': z.strictObject({
    threadId: threadIdSchema,
    promptId: foundryIdSchema,
    /** `approved`, `rejected` or an option id, plus the edited text where the prompt takes input. */
    answer: z.strictObject({
      action: z.string().min(1).max(80),
      input: z.string().max(threadTextLimit).optional(),
    }),
  }),
} as const satisfies Record<ThreadOperation, z.ZodObject>;

/**
 * A commissioned task (Aron, 2026-11-01): a send that asks a member's agent for work. `report`
 * is fixed by the caller's person when the send is released: `post` lets the report enter the
 * thread against this commission, `notify` tells only the caller.
 */
export const threadCommissionSchema = z.strictObject({
  report: z.enum(['post', 'notify']),
  expiresAt: z.iso.datetime(),
});
export type ThreadCommission = z.infer<typeof threadCommissionSchema>;

/**
 * One entry of the main thread's journal as a member sees it: an owner message, a main-agent
 * message, a member's post (`member` = its author), a released send (`member` = the addressee;
 * `commission` when it asks for work), or an aside: person to person, out of the thread's log
 * (`member` = its author, `to` = the one person it is for; never shown to an agent).
 */
export const threadEntrySchema = z.object({
  journalSeq: z.number().int().min(0),
  at: z.iso.datetime(),
  kind: z.enum(['owner', 'agent', 'post', 'send', 'aside']),
  member: conversationMemberSchema.nullable(),
  to: conversationMemberSchema.optional(),
  commission: threadCommissionSchema.optional(),
  text: z.string().max(threadTextLimit),
});
export type ThreadEntry = z.infer<typeof threadEntrySchema>;

/** A member's view, taken at `journalSeq`: the answer to `thread.read` and to `thread.subscribe`. */
export const threadViewResultSchema = z.object({
  journalSeq: z.number().int().min(0),
  entries: z.array(threadEntrySchema).max(1000),
  /** The view was cut at the character cap; read again after the last entry's `journalSeq`. */
  truncated: z.boolean(),
});
export type ThreadViewResult = z.infer<typeof threadViewResultSchema>;

/**
 * A view read per entry (`thread.read` results, stream snapshots): an entry this package can't read
 * is dropped and counted, never costing the whole view. Null when the view itself is unreadable.
 */
export const parseThreadView = (value: unknown) => {
  const record = z
    .object({ entries: z.array(z.unknown()).max(1000) })
    .loose()
    .safeParse(value);
  const view = threadViewResultSchema.omit({ entries: true }).safeParse(value);
  if (!record.success || !view.success) return null;
  const entries = record.data.entries.flatMap((entry) => {
    const parsed = threadEntrySchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
  return { ...view.data, entries, dropped: record.data.entries.length - entries.length };
};

export const floorModeSchema = z.enum(['talk', 'speak-when-spoken-to', 'conch']);

/** What the host answers per operation (and to `thread.subscribe`). */
export const threadResultSchemas = {
  'thread.read': threadViewResultSchema,
  /** `duplicate`: the same `(signetId, postId)` was already admitted; `journalSeq` is the original's. */
  'thread.prompt': z.strictObject({
    accepted: z.literal(true),
    journalSeq: z.number().int().min(0),
    duplicate: z.boolean(),
  }),
  'thread.floor': z.strictObject({
    mode: floorModeSchema,
    holder: conversationMemberSchema.nullable(),
    expiresAt: z.iso.datetime().nullable(),
  }),
  'prompt.resolve': z.strictObject({ resolved: z.literal(true) }),
  'thread.subscribe': threadViewResultSchema,
} as const satisfies Record<ThreadOperation | 'thread.subscribe', z.ZodType>;
export type ThreadResult<O extends keyof typeof threadResultSchemas> = z.infer<
  (typeof threadResultSchemas)[O]
>;

/**
 * Why the host refused. The first five are the design's refusals, which Kingdom records as
 * `AccessExecution.status = 'denied'` with this `errorCode` (§5.4). `invalid_request` is a frame the
 * host could not read for any other reason, and `failed` an error inside the host; Kingdom records
 * both as `failed`.
 */
export const threadRefusalSchema = z.enum([
  'unknown_thread',
  'thread_closed',
  'floor_denied',
  'not_invited',
  'conversation_paused',
  'invalid_request',
  'failed',
]);
export type ThreadRefusal = z.infer<typeof threadRefusalSchema>;
export const threadDeniedRefusals = [
  'unknown_thread',
  'thread_closed',
  'floor_denied',
  'not_invited',
  'conversation_paused',
] as const satisfies readonly ThreadRefusal[];

/** The member a frame acts for: its Signet and the name Kingdom shows for its recipient. */
export const threadMemberSchema = z.strictObject({
  signetId: z.uuid(),
  displayName: z.string().min(1).max(200),
});

const relayed = {
  /** The `AccessExecution` id: one per admitted call, and the id the answer carries back. */
  requestId: z.uuid(),
  signetId: z.uuid(),
  /** The Signet revision Kingdom admitted the call under; the terms are that revision's. */
  acceptedRevision: z.number().int().min(1),
  member: threadMemberSchema,
  /** The member's terms, as Kingdom admitted the call under them. */
  terms: threadsTermsSchema,
};
const requestFrame = <O extends ThreadOperation>(operation: O) =>
  z.strictObject({
    type: z.literal('thread.request'),
    ...relayed,
    operation: z.literal(operation),
    input: threadInputSchemas[operation],
  });

/**
 * Kingdom → host over the Installation socket: one admitted call. The host trusts it (Kingdom's
 * admission is the membership check) and answers with `thread.response` within 15 s.
 */
export const threadRequestFrameSchema = z.discriminatedUnion('operation', [
  requestFrame('thread.read'),
  requestFrame('thread.prompt'),
  requestFrame('thread.floor'),
  requestFrame('prompt.resolve'),
]);
export type ThreadRequestFrame = z.infer<typeof threadRequestFrameSchema>;

/**
 * Kingdom → host: open a member's live view, atomically. The answer (`thread.response` with
 * `requestId`) is the view and the `journalSeq` it was taken at, and the subscription starts at that
 * same point. `requestId` is also the subscription's id for appends, leases and unsubscribe.
 */
export const threadSubscribeFrameSchema = z.strictObject({
  type: z.literal('thread.subscribe'),
  ...relayed,
  threadId: threadIdSchema,
});
export type ThreadSubscribeFrame = z.infer<typeof threadSubscribeFrameSchema>;

/** Kingdom → host: the member's stream closed (leave, revocation, any revision, …). */
export const threadUnsubscribeFrameSchema = z.strictObject({
  type: z.literal('thread.unsubscribe'),
  subscriptionId: z.uuid(),
});

/**
 * Kingdom → host, on every 45 s re-authorize sweep: the subscriptions it still holds. The host drops
 * any subscription not re-asserted within `threadSubscriptionLeaseMs`, and all of them when its
 * socket reconnects, so a dead Kingdom node leaves nothing pushing.
 */
export const threadLeaseFrameSchema = z.strictObject({
  type: z.literal('thread.lease'),
  subscriptionIds: z.array(z.uuid()).max(10_000),
});
/**
 * Two sweeps from the last re-assertion: a subscription survives one late sweep and is dropped by the
 * next missed one, so at most 45 s after a missed re-assertion (Foundry test 27).
 */
export const threadSubscriptionLeaseMs = 90_000;

/** Every frame Kingdom sends a host for conversations. */
export const threadHostFrameSchema = z.discriminatedUnion('type', [
  threadRequestFrameSchema,
  threadSubscribeFrameSchema,
  threadUnsubscribeFrameSchema,
  threadLeaseFrameSchema,
]);

const refusedOutcome = z.strictObject({
  ok: z.literal(false),
  refusal: threadRefusalSchema,
  message: z.string().max(500).optional(),
});
const responseFrame = <R extends z.ZodType>(result: R) =>
  z.strictObject({
    action: z.literal('thread.response'),
    requestId: z.uuid(),
    outcome: z.discriminatedUnion('ok', [
      z.strictObject({ ok: z.literal(true), result }),
      refusedOutcome,
    ]),
  });

/** Host → Kingdom: the answer to a `thread.request` or `thread.subscribe`, read by what was asked. */
export const threadResponseFrameSchema = <O extends keyof typeof threadResultSchemas>(
  operation: O,
) => responseFrame(threadResultSchemas[operation]);
/** The response envelope before Kingdom knows which request it answers. */
export const threadResponseEnvelopeSchema = responseFrame(z.unknown());
export type ThreadOutcome<O extends keyof typeof threadResultSchemas> =
  | { ok: true; result: ThreadResult<O> }
  | { ok: false; refusal: ThreadRefusal; message?: string };
export type ThreadResponseFrame<O extends keyof typeof threadResultSchemas> = {
  action: 'thread.response';
  requestId: string;
  outcome: ThreadOutcome<O>;
};

/** A host's answer: the operation's result. */
export const threadResult = <R>(result: R) => ({ ok: true as const, result });
/** A host's refusal. */
export const threadRefused = (refusal: ThreadRefusal, message?: string) => ({
  ok: false as const,
  refusal,
  ...(message ? { message: message.slice(0, 500) } : {}),
});

/**
 * Host → Kingdom: an entry for one subscription, already filtered to that member's view. `seq` counts
 * this subscription's appends densely from 1 (the snapshot is 0): a filtered view skips journal
 * entries, so `journalSeq` jumps on purpose and can't detect loss. Kingdom drops an append whose
 * `journalSeq` is at or below the snapshot's, and sends the member `resync` when `seq` jumps. An
 * entry the host can't send still spends its `seq`, so the member resyncs instead of missing it.
 */
export const threadAppendFrameSchema = z.strictObject({
  action: z.literal('thread.append'),
  subscriptionId: z.uuid(),
  signetId: z.uuid(),
  threadId: threadIdSchema,
  seq: z.number().int().min(1),
  journalSeq: z.number().int().min(0),
  entry: threadEntrySchema,
});
export type ThreadAppendFrame = z.infer<typeof threadAppendFrameSchema>;

/**
 * A member's live view of one thread is a Kingdom data stream (design §5.6.1): open, snapshot,
 * append, close, a per-stream `seq`, `resync` on a gap, no replay. Its family is the operationId of
 * Kingdom's snapshot route `GET /api/v1/access/threads/{signetId}/{threadId}`, and a stream's name is
 * that route's channel key: the family, then each path field and value, fields sorted.
 */
export const accessThreadStreamFamily = 'accessThread';
export const accessThreadStreamName = (stream: { signetId: string; threadId: string }) =>
  `${accessThreadStreamFamily}:signetId:${z.uuid().parse(stream.signetId)}:threadId:${threadIdSchema.parse(stream.threadId)}`;
export const parseAccessThreadStreamName = (name: string) => {
  const [family, signetField, signetId, threadField, threadId, ...rest] = name.split(':');
  if (
    family !== accessThreadStreamFamily ||
    signetField !== 'signetId' ||
    threadField !== 'threadId'
  )
    return null;
  const parsed = z
    .object({ signetId: z.uuid(), threadId: threadIdSchema })
    .safeParse({ signetId, threadId });
  return parsed.success && rest.length === 0 ? parsed.data : null;
};
/** The snapshot is the route's body: Kingdom's `{ data }` envelope around the member's view. */
export const accessThreadSnapshotSchema = z.object({ data: threadViewResultSchema });
/** A `log` stream's one op: each append's payload is one `ThreadEntry`. */
export const accessThreadAppendType = 'append';

/** Why Kingdom closed a member's stream (sent on `closed` and `openRejected`). */
export const accessThreadCloseReasonSchema = z.enum([
  /** The member closed it. */
  'left',
  'revoked',
  /** Any revision closes the stream; the member reopens under the new revision. */
  'revised',
  'enrollmentRevoked',
  'expired',
  'hostOffline',
  /** The 45 s re-authorize sweep no longer admits the stream. */
  'unauthorized',
  /** No `renewPresentation` arrived before the socket's access token expired. */
  'presentationExpired',
]);
export type AccessThreadCloseReason = z.infer<typeof accessThreadCloseReasonSchema>;
