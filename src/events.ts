import { z } from 'zod';

/**
 * Integration events (Kingdom `docs/INTEGRATION-EVENTS.md`, Aron 2026-11-01). An integration that
 * receives its provider's events (a webhook endpoint, or a poll where the provider has none) fans
 * each one out to the Signet grants that reach it: the event kinds are operation leaves under
 * `events.`, picked like any other, and the grant's lens layers filter and trim the event. Live
 * only: a channel nobody holds open drops the event.
 */

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

/**
 * The integration itself as a model: account-level events that belong to no repository, channel or
 * team (a person's mentions, review requests and assignments from GitHub's notifications, a Slack DM)
 * hang off it. Each integration that receives events has one `account` resource.
 */
export const accountResourceKind = 'account';

/**
 * An event kind's operation leaf: `events.<provider event>.<action>`, mirroring the provider's own
 * taxonomy (Aron, 2026-11-01). A grant picks it like any operation, a prefix (`events.pull_request.*`)
 * or everything (`full`).
 */
export const eventOperationKey = (type: IntegrationEvent['type']) => `events.${type}`;

/** The envelope's fields: the `IntegrationEvent` rows at every `events.*` branch of an operations lens. */
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
 * One append on a channel's stream. `eventId` and `type` ride outside the projected body, so the
 * grant's lens trimming can never drop what a holder needs to dedupe and route; `event` is the
 * envelope as the grant's lens layers project it (json-rules `projectRows`).
 */
export const accessEventsAppendSchema = z.strictObject({
  eventId: integrationEventSchema.shape.eventId,
  type: integrationEventSchema.shape.type,
  event: z.record(z.string(), z.unknown()),
});
export type AccessEventsAppend = z.infer<typeof accessEventsAppendSchema>;

/**
 * A channel's live stream is a Kingdom data stream, like a thread's (`accessThread`): its family is
 * the operationId of Kingdom's snapshot route `GET /api/v1/access/events/{resourceId}/{signetId}`,
 * and its name that route's channel key (path fields sorted). The snapshot is always empty: there is
 * no backlog. Each append's payload is one `AccessEventsAppend`.
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
/** A `log` stream's one op: each append's payload is one `AccessEventsAppend`. */
export const accessEventsAppendType = 'append';

/**
 * One channel a Signet holds: a resource its current revision reaches event leaves on. `events` are
 * those leaves (`events.<event>.<action>`) that the integration's baseline still allows, and
 * `stream` is the `accessEvents` stream to open for it (`accessEventsStreamName`).
 */
export const eventChannelSchema = z.object({
  resourceId: z.uuid(),
  kind: z.string(),
  name: z.string(),
  events: z.array(z.string()),
  stream: z.string(),
});
export type EventChannel = z.infer<typeof eventChannelSchema>;

/**
 * `eventChannels` on `access/describe` and on each held Signet of the Installation snapshot: the
 * integrations a Signet can listen on and its channels on each. A holder opens any or all of them.
 */
export const eventChannelMapSchema = z.array(
  z.object({
    integration: z.object({ id: z.uuid(), provider: z.string().nullable(), name: z.string() }),
    channels: z.array(eventChannelSchema),
  }),
);
export type EventChannelMap = z.infer<typeof eventChannelMapSchema>;
