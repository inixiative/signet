import { describe, expect, test } from 'bun:test';
import {
  accessEventsAppendSchema,
  accessEventsStreamName,
  accountResourceKind,
  eventOperationKey,
  type IntegrationEvent,
  integrationEventFieldSchema,
  integrationEventSchema,
  narrowsOperations,
  parseAccessEventsStreamName,
  resolveOperationPicks,
} from '../src/contracts';

const event: IntegrationEvent = {
  eventId: 'delivery-1',
  integrationId: Bun.randomUUIDv7(),
  provider: 'github',
  type: 'issue_comment.created',
  at: '2026-11-01T12:00:00.000Z',
  actor: { login: 'sam', id: '42' },
  scope: 'inixiative/kingdom',
  mentions: ['aron'],
  assignees: [],
  requestedReviewers: [],
  subject: {
    title: 'Fix the relay',
    url: 'https://github.com/inixiative/kingdom/pull/9',
    number: 9,
  },
  excerpt: '@aron can you look?',
  payload: { commentId: 7 },
};
describe('integration events', () => {
  test('an event parses as the normalized envelope', () => {
    expect(integrationEventSchema.parse(event)).toEqual(event);
  });

  test('event kinds are operation leaves under events., picked by prefix like any operation', () => {
    const leaves = [
      'commits.read',
      eventOperationKey('pull_request.opened'),
      eventOperationKey('pull_request.review_requested'),
      eventOperationKey('issue_comment.created'),
    ];
    expect(eventOperationKey('issue_comment.created')).toBe('events.issue_comment.created');
    const pullRequests = resolveOperationPicks(leaves, { picks: ['events.pull_request.*'] });
    expect(pullRequests).toEqual({
      full: false,
      operations: ['events.pull_request.opened', 'events.pull_request.review_requested'],
    });
    const oneKind = resolveOperationPicks(leaves, {
      picks: ['events.pull_request.review_requested'],
    });
    expect(narrowsOperations(oneKind, pullRequests)).toBe(true);
    expect(narrowsOperations(pullRequests, oneKind)).toBe(false);
    expect(narrowsOperations(pullRequests, { full: true })).toBe(true);
    expect(accountResourceKind).toBe('account');
  });

  test('a lens names the row fields only: never eventId, type or payload', () => {
    expect(integrationEventFieldSchema.options).toEqual([
      'integrationId',
      'provider',
      'at',
      'actor',
      'scope',
      'mentions',
      'assignees',
      'requestedReviewers',
      'subject',
      'excerpt',
    ]);
    for (const outside of ['eventId', 'type', 'payload'])
      expect(integrationEventFieldSchema.safeParse(outside).success).toBe(false);
  });

  test('an append carries eventId and type outside the projected event', () => {
    const append = accessEventsAppendSchema.parse({
      eventId: event.eventId,
      type: event.type,
      event: { subject: event.subject },
    });
    expect(append).toEqual({
      eventId: 'delivery-1',
      type: 'issue_comment.created',
      event: { subject: event.subject },
    });
    expect(() => accessEventsAppendSchema.parse({ type: event.type, event: {} })).toThrow();
  });

  test("a channel's stream name round-trips, path fields sorted", () => {
    const stream = { signetId: Bun.randomUUIDv7(), resourceId: Bun.randomUUIDv7() };
    const name = accessEventsStreamName(stream);
    expect(name).toBe(`accessEvents:resourceId:${stream.resourceId}:signetId:${stream.signetId}`);
    expect(parseAccessEventsStreamName(name)).toEqual(stream);
    expect(parseAccessEventsStreamName(`${name}:extra`)).toBeNull();
    expect(parseAccessEventsStreamName('accessThread:signetId:x:threadId:y')).toBeNull();
  });
});
