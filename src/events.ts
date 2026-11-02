import { z } from 'zod';

/**
 * Integration events (Kingdom `docs/INTEGRATION-EVENTS.md`, Aron 2026-11-01). An integration that
 * receives its provider's events (a webhook endpoint, or a poll where the provider has none) has one
 * `events` resource: its feed. A Signet grant of `events.subscribe` on it is a **channel**: a
 * json-rules `where` over the event and an optional `select` of what the holder receives. The holder
 * reads its Signet to see the channels it has, and subscribes to any or all of them; Kingdom matches
 * each arriving event against the integration's channels the same way. Live only: a channel nobody
 * holds open drops the event.
 */
export const eventsResourceKind = 'events';

/** A provider identity an event names: a login or handle, and the provider's id when it gives one. */
export const eventPartySchema = z.strictObject({
  login: z.string().min(1).max(200),
  id: z.string().min(1).max(200).optional(),
});
export type EventParty = z.infer<typeof eventPartySchema>;

/**
 * One provider event, normalized. `eventId` is the provider's delivery id (or the notification id
 * for a poll), so a retried delivery is one event. `type` is `<provider event>.<action>`, e.g.
 * `issue_comment.created`. `payload` holds only the fields Kingdom allows for that type; the rest of
 * a provider body never leaves Kingdom.
 */
export const integrationEventSchema = z.strictObject({
  eventId: z.string().min(1).max(200),
  integrationId: z.uuid(),
  provider: z.string().min(1).max(80),
  type: z.string().min(1).max(120),
  at: z.iso.datetime(),
  actor: eventPartySchema.nullable(),
  /** Where it happened: `owner/name` for a repository, a channel or team id elsewhere. */
  scope: z.string().min(1).max(300).nullable(),
  /** Who it names: mentioned, assigned, asked to review. */
  mentions: z.array(z.string().min(1).max(200)).max(200),
  assignees: z.array(z.string().min(1).max(200)).max(200),
  requestedReviewers: z.array(z.string().min(1).max(200)).max(200),
  /** What it is about, for a holder that shows it: a title, a link, a number. */
  subject: z.strictObject({
    title: z.string().max(1000).optional(),
    url: z.url().max(2000).optional(),
    number: z.number().int().optional(),
  }),
  /** A short excerpt of the text (a comment, a message), when the type has one. */
  excerpt: z.string().max(2000).optional(),
  payload: z.record(z.string(), z.unknown()),
});
export type IntegrationEvent = z.infer<typeof integrationEventSchema>;

/** The envelope fields a channel may `select`. */
export const integrationEventFieldSchema = z.enum([
  'eventId',
  'integrationId',
  'provider',
  'type',
  'at',
  'actor',
  'scope',
  'mentions',
  'assignees',
  'requestedReviewers',
  'subject',
  'excerpt',
  'payload',
]);
export type IntegrationEventField = z.infer<typeof integrationEventFieldSchema>;

/**
 * A channel: `where` is a json-rules condition over the event (Kingdom validates it with
 * json-rules against `integrationEventSchema`'s fields; this package only carries it as JSON), a
 * positive condition, so a grant without one matches every event. `select` is the overlay
 * restricting what the holder receives; `eventId` and `type` are always sent. The `where` may test
 * fields the `select` leaves out. `name` is what the holder sees when it reads its channels.
 */
export const eventsLensSchema = z.strictObject({
  name: z.string().min(1).max(80).optional(),
  where: z.record(z.string(), z.unknown()).optional(),
  select: z.array(integrationEventFieldSchema).min(1).max(20).optional(),
});
export type EventsLens = z.infer<typeof eventsLensSchema>;

/** What a holder receives from a channel: the event, cut to the channel's `select`. */
export const selectedEventSchema = integrationEventSchema
  .partial()
  .required({ eventId: true, type: true });
export type SelectedEvent = z.infer<typeof selectedEventSchema>;

/** The event as a channel's `select` lets it through; `eventId` and `type` always go. */
export const selectEvent = (lens: EventsLens, event: IntegrationEvent): SelectedEvent => {
  if (!lens.select) return event;
  const fields = new Set<IntegrationEventField>([...lens.select, 'eventId', 'type']);
  return Object.fromEntries(
    Object.entries(event).filter(([key]) => fields.has(key as IntegrationEventField)),
  ) as SelectedEvent;
};

/** JSON with object keys sorted at every depth: a condition read back from jsonb reorders them. */
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value !== null && typeof value === 'object'
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
        )
      : value;
const sameJson = (a: unknown, b: unknown) =>
  JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

/**
 * `granted` reaches nothing `requested` doesn't. Conservative and structural, since this package
 * doesn't evaluate json-rules: the granted `where` is the requested one, or `{all: [...]}` holding
 * it (the requested condition plus more); the granted `select` is within the requested one.
 */
export const narrowsEventsLens = (granted: EventsLens, requested: EventsLens) => {
  const whereNarrows =
    requested.where === undefined ||
    sameJson(granted.where, requested.where) ||
    (typeof granted.where === 'object' &&
      granted.where !== null &&
      !Array.isArray(granted.where) &&
      Array.isArray((granted.where as { all?: unknown }).all) &&
      (granted.where as { all: unknown[] }).all.some((part) => sameJson(part, requested.where)));
  const selectNarrows =
    !requested.select ||
    (!!granted.select && granted.select.every((field) => requested.select?.includes(field)));
  return whereNarrows && selectNarrows;
};

/** The operation an `events` resource carries: hold a channel open. It takes no input. */
export const eventsOperationSchema = z.enum(['events.subscribe']);
export type EventsOperation = z.infer<typeof eventsOperationSchema>;
export const eventsOperationNames: Record<EventsOperation, string> = {
  'events.subscribe': "Receive this integration's events as they happen, filtered by the channel",
};
export const eventsInputSchemas = {
  'events.subscribe': z.strictObject({}),
} as const satisfies Record<EventsOperation, z.ZodObject>;

/**
 * A channel's live stream is a Kingdom data stream, like a thread's (`accessThread`): its family is
 * the operationId of Kingdom's snapshot route `GET /api/v1/access/events/{resourceId}/{signetId}`,
 * and its name that route's channel key (path fields sorted). The snapshot is always empty: there is
 * no backlog. Each append's payload is one `SelectedEvent`.
 */
export const accessEventsStreamFamily = 'accessEvents';
export const accessEventsStreamName = (stream: { signetId: string; resourceId: string }) =>
  `${accessEventsStreamFamily}:resourceId:${z.uuid().parse(stream.resourceId)}:signetId:${z.uuid().parse(stream.signetId)}`;
export const parseAccessEventsStreamName = (name: string) => {
  const [family, resourceField, resourceId, signetField, signetId, ...rest] = name.split(':');
  if (
    family !== accessEventsStreamFamily ||
    resourceField !== 'resourceId' ||
    signetField !== 'signetId'
  )
    return null;
  const parsed = z.object({ signetId: z.uuid(), resourceId: z.uuid() }).safeParse({
    signetId,
    resourceId,
  });
  return parsed.success && rest.length === 0 ? parsed.data : null;
};
/** The empty snapshot, in Kingdom's `{ data }` envelope: a channel has no history. */
export const accessEventsSnapshotSchema = z.object({
  data: z.strictObject({ events: z.tuple([]) }),
});
