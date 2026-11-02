import { describe, expect, test } from 'bun:test';
import {
  accessEventsStreamName,
  declaredOperationSchema,
  eventsResourceKind,
  type IntegrationEvent,
  integrationEventSchema,
  narrowsSignetLens,
  operationInputKeys,
  parseAccessEventsStreamName,
  resourceLensSchema,
  selectEvent,
  signetResourceSchema,
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
const mentionsAron = { field: 'mentions', operator: 'contains', value: 'aron' };

describe('integration events: a channel is a grant of events.subscribe on the events resource', () => {
  test('an events grant carries a where and a select, and the events kind takes that lens', () => {
    const lens = { name: 'Mentions of me', where: mentionsAron, select: ['subject', 'actor'] };
    const grant = signetResourceSchema.parse({
      resourceId: crypto.randomUUID(),
      operations: ['events.subscribe'],
      lens,
    });
    expect<unknown>(grant.lens).toEqual(lens);
    expect(resourceLensSchema(eventsResourceKind).safeParse(lens).success).toBe(true);
    expect(resourceLensSchema(eventsResourceKind).safeParse({ select: ['secrets'] }).success).toBe(
      false,
    );
    expect(declaredOperationSchema.parse('events.subscribe')).toBe('events.subscribe');
    expect(operationInputKeys('events.subscribe')).toEqual([]);
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

  test('granting may only narrow: the same where, or all-of it plus more, within the select', () => {
    const requested = { where: mentionsAron, select: ['subject', 'actor'] as const };
    const narrower = {
      where: { all: [mentionsAron, { field: 'scope', operator: 'equals', value: 'x/y' }] },
      select: ['subject'] as const,
    };
    expect(
      narrowsSignetLens(
        { ...narrower, select: [...narrower.select] },
        { ...requested, select: [...requested.select] },
      ),
    ).toBe(true);
    expect(
      narrowsSignetLens(
        { where: { field: 'type', operator: 'equals', value: 'x' } },
        { where: mentionsAron },
      ),
    ).toBe(false);
    expect(
      narrowsSignetLens(
        { where: mentionsAron, select: ['payload'] },
        { where: mentionsAron, select: ['subject'] },
      ),
    ).toBe(false);
    expect(
      narrowsSignetLens({ where: mentionsAron }, { where: mentionsAron, select: ['subject'] }),
    ).toBe(false);
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

test('narrowing compares conditions whatever their key order (jsonb reorders keys)', () => {
  const stored = { value: 'aron', operator: 'contains', field: 'mentions' };
  expect(narrowsSignetLens({ where: stored }, { where: mentionsAron })).toBe(true);
  expect(
    narrowsSignetLens(
      { where: { all: [{ field: 'scope', value: 'x/y', operator: 'equals' }, stored] } },
      { where: mentionsAron },
    ),
  ).toBe(true);
});
