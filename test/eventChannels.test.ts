import { describe, expect, test } from 'bun:test';
import {
  accessEventsStreamName,
  type EventChannelMap,
  eventChannelMapSchema,
  installationSignetSchema,
  parseInstallationSignets,
  parseInstallationSnapshot,
  parseSignetDescription,
  signetDescriptionSchema,
} from '../src';

const uuid = () => Bun.randomUUIDv7();
const comments = 'events.issue_comment.created';
const mentions = 'events.notifications.mention';

// The shapes Kingdom's `readEventChannelMaps` builds (`eventChannelMapSchema` there).
const channelMap = (signetId: string) => {
  const repositoryId = uuid();
  const accountId = uuid();
  const repositories: EventChannelMap[number] = {
    integration: { id: uuid(), provider: 'githubOrganization', name: 'GitHub · inixiative' },
    channels: [
      {
        resourceId: repositoryId,
        kind: 'repository',
        name: 'inixiative/kingdom',
        events: [comments],
        stream: accessEventsStreamName({ resourceId: repositoryId, signetId }),
      },
    ],
  };
  const account: EventChannelMap[number] = {
    integration: { id: uuid(), provider: null, name: 'GitHub · aron' },
    channels: [
      {
        resourceId: accountId,
        kind: 'account',
        name: 'Account',
        events: [mentions],
        stream: accessEventsStreamName({ resourceId: accountId, signetId }),
      },
    ],
  };
  return { repositories, account, eventChannels: [repositories, account] };
};
const described = (signetId: string, extra: Record<string, unknown> = {}) => ({
  signetId,
  name: 'Events channels',
  expiresAt: null,
  lifecycle: 'ongoing',
  taskId: null,
  currentRevision: 1,
  remainingRequests: null,
  holder: null,
  operations: [],
  ...extra,
});
const held = (signetId: string, extra: Record<string, unknown> = {}) => ({
  signetId,
  name: 'Studio Foundry',
  enrollmentId: null,
  owner: { ownerModel: 'User', userId: uuid(), organizationId: null, spaceId: null },
  resources: [],
  ...extra,
});
const snapshot = (signets: unknown[]) => ({
  type: 'installation.snapshot',
  pending: null,
  declinedAt: null,
  inquiries: [],
  hostedSignetRequests: [],
  signets,
  hostedSignets: [],
});

describe('eventChannels on a Signet (Kingdom docs/INTEGRATION-EVENTS.md)', () => {
  test('the schemas carry eventChannels, a null provider included', () => {
    const signetId = uuid();
    const { eventChannels } = channelMap(signetId);
    expect(eventChannelMapSchema.parse(eventChannels)).toEqual(eventChannels);
    expect(
      signetDescriptionSchema.parse(described(signetId, { eventChannels })).eventChannels,
    ).toEqual(eventChannels);
    expect(installationSignetSchema.parse(held(signetId, { eventChannels })).eventChannels).toEqual(
      eventChannels,
    );
  });

  test('describe keeps eventChannels', () => {
    const signetId = uuid();
    const { eventChannels } = channelMap(signetId);
    const description = parseSignetDescription(described(signetId, { eventChannels }));
    expect(description.eventChannels).toEqual(eventChannels);
    expect(description.dropped).toEqual([]);
  });

  test('describe drops a channel or an integration it cannot read, and keeps the rest', () => {
    const signetId = uuid();
    const { repositories, account } = channelMap(signetId);
    const unreadable = { resourceId: 'not-a-uuid', kind: 'repository', name: 'x', events: [] };
    const description = parseSignetDescription(
      described(signetId, {
        eventChannels: [
          { ...repositories, channels: [unreadable, ...repositories.channels] },
          { integration: { name: 'No id' }, channels: [] },
          account,
        ],
      }),
    );
    expect(description.eventChannels).toEqual([repositories, account]);
    expect(description.dropped.map(({ list, index, id }) => ({ list, index, id }))).toEqual([
      { list: 'eventChannels', index: 1, id: null },
      {
        list: `eventChannels.${repositories.integration.id}.channels`,
        index: 0,
        id: 'not-a-uuid',
      },
    ]);
    expect(description.signetId).toBe(signetId);
  });

  test('describe from a Kingdom before integration events has no eventChannels and reports nothing', () => {
    const description = parseSignetDescription(described(uuid()));
    expect(description).not.toHaveProperty('eventChannels');
    expect(description.dropped).toEqual([]);
  });

  test('eventChannels that is not a list reads as empty and is reported', () => {
    const description = parseSignetDescription(described(uuid(), { eventChannels: 'soon' }));
    expect(description.eventChannels).toEqual([]);
    expect(description.dropped).toMatchObject([{ list: 'eventChannels', index: -1 }]);
  });

  test("the Installation snapshot keeps each held Signet's eventChannels", () => {
    const signetId = uuid();
    const { eventChannels } = channelMap(signetId);
    const parsed = parseInstallationSnapshot(snapshot([held(signetId, { eventChannels })]));
    expect(parsed.signets[0]?.eventChannels).toEqual(eventChannels);
    expect(parsed.dropped).toEqual([]);
    expect(
      parseInstallationSignets({ signets: [held(signetId, { eventChannels })], hostedSignets: [] })
        .signets[0]?.eventChannels,
    ).toEqual(eventChannels);
  });

  test('a channel the snapshot reader cannot read is dropped and reported; its Signet is kept', () => {
    const signetId = uuid();
    const other = held(uuid());
    const { repositories, account } = channelMap(signetId);
    const parsed = parseInstallationSnapshot(
      snapshot([
        held(signetId, {
          eventChannels: [
            { ...repositories, channels: [...repositories.channels, { kind: 'repository' }] },
            'unreadable',
            account,
          ],
        }),
        other,
      ]),
    );
    expect(parsed.signets.map((signet) => signet.signetId)).toEqual([signetId, other.signetId]);
    expect(parsed.signets[0]?.eventChannels).toEqual([repositories, account]);
    expect(parsed.signets[1]).not.toHaveProperty('eventChannels');
    expect(parsed.dropped.map(({ list, index }) => ({ list, index }))).toEqual([
      { list: `signets.${signetId}.eventChannels`, index: 1 },
      {
        list: `signets.${signetId}.eventChannels.${repositories.integration.id}.channels`,
        index: 1,
      },
    ]);
  });
});
