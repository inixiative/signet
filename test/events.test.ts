import { describe, expect, test } from 'bun:test';
import {
  accessEventsStreamName,
  type IntegrationEvent,
  integrationEventSchema,
  parseAccessEventsStreamName,
  selectEvent,
} from '../src/contracts';

const event: IntegrationEvent = {
  eventId: 'delivery-1',
  integrationId: crypto.randomUUID(),
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

  test('the select overlay cuts what the holder receives; eventId and type always go', () => {
    expect(selectEvent({ select: ['subject'] }, event)).toEqual({
      eventId: 'delivery-1',
      type: 'issue_comment.created',
      subject: event.subject,
    });
    expect(selectEvent({}, event)).toEqual(event);
  });

  test("a channel's stream name round-trips, path fields sorted", () => {
    const stream = { signetId: crypto.randomUUID(), resourceId: crypto.randomUUID() };
    const name = accessEventsStreamName(stream);
    expect(name).toBe(`accessEvents:resourceId:${stream.resourceId}:signetId:${stream.signetId}`);
    expect(parseAccessEventsStreamName(name)).toEqual(stream);
    expect(parseAccessEventsStreamName(`${name}:extra`)).toBeNull();
    expect(parseAccessEventsStreamName('accessThread:signetId:x:threadId:y')).toBeNull();
  });
});
