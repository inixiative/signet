import { describe, expect, test } from 'bun:test';
import {
  githubOperationSchema,
  narrowsOperations,
  OperationPickError,
  operationPickSchema,
  operationTree,
  resolveOperationPicks,
} from '../src';

/** A GitHub `repository`'s leaves as the catalog spells them: reads, then nested events. */
const repository = [
  ...githubOperationSchema.options,
  'events.pull_request.opened',
  'events.pull_request.review_requested',
  'events.issue_comment.created',
];

describe('operation picks', () => {
  test('full, or one to a hundred picks of leaves and prefixes', () => {
    expect(operationPickSchema.parse({ full: true })).toEqual({ full: true });
    expect(operationPickSchema.parse({ picks: ['commits.read', 'events.*'] })).toEqual({
      picks: ['commits.read', 'events.*'],
    });
    for (const bad of [
      { full: false },
      { picks: [] },
      { full: true, picks: ['commits.read'] },
      { picks: ['*'] },
      { picks: ['events.*.opened'] },
      { picks: ['commits..read'] },
      { picks: ['.read'] },
      { picks: ['commits.'] },
      { picks: Array.from({ length: 101 }, (_, i) => `op${i}.read`) },
      {},
    ])
      expect(operationPickSchema.safeParse(bad).success).toBe(false);
  });

  test('full stays full: it grows with the catalog, nothing is frozen', () => {
    expect(resolveOperationPicks(repository, { full: true })).toEqual({ full: true });
  });

  test('a leaf resolves to itself', () => {
    expect(resolveOperationPicks(repository, { picks: ['commits.read'] })).toEqual({
      full: false,
      operations: ['commits.read'],
    });
  });

  test('a prefix resolves to every leaf under it, at every depth, frozen and in catalog order', () => {
    expect(resolveOperationPicks(repository, { picks: ['commits.*'] })).toEqual({
      full: false,
      operations: ['commits.read'],
    });
    expect(resolveOperationPicks(repository, { picks: ['events.pull_request.*'] })).toEqual({
      full: false,
      operations: ['events.pull_request.opened', 'events.pull_request.review_requested'],
    });
    expect(resolveOperationPicks(repository, { picks: ['events.*'] })).toEqual({
      full: false,
      operations: [
        'events.pull_request.opened',
        'events.pull_request.review_requested',
        'events.issue_comment.created',
      ],
    });
  });

  test('overlapping picks resolve once each', () => {
    expect(
      resolveOperationPicks(repository, {
        picks: ['events.pull_request.opened', 'events.pull_request.*', 'blobs.read'],
      }),
    ).toEqual({
      full: false,
      operations: [
        'blobs.read',
        'events.pull_request.opened',
        'events.pull_request.review_requested',
      ],
    });
  });

  test('a pick the catalog does not have is a typed error naming it', () => {
    for (const pick of [
      'commits.write',
      'events',
      'events.pull_request',
      'commits.read.*',
      'issues.*',
      'event.*',
    ]) {
      let caught: unknown;
      try {
        resolveOperationPicks(repository, { picks: ['commits.read', pick] });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(OperationPickError);
      expect((caught as OperationPickError).code).toBe('unknown_operation_pick');
      expect((caught as OperationPickError).pick).toBe(pick);
    }
  });

  test('a key that is both a leaf and a prefix: the bare key picks the leaf, `.*` what is under it', () => {
    const leaves = ['events.message', 'events.message.im', 'events.message.app_mention'];
    expect(resolveOperationPicks(leaves, { picks: ['events.message'] })).toEqual({
      full: false,
      operations: ['events.message'],
    });
    expect(resolveOperationPicks(leaves, { picks: ['events.message.*'] })).toEqual({
      full: false,
      operations: ['events.message.im', 'events.message.app_mention'],
    });
    expect(resolveOperationPicks(leaves, { picks: ['events.*'] })).toEqual({
      full: false,
      operations: leaves,
    });
  });
});

describe('the operation tree', () => {
  test('is derived from the dotted keys, with every node pickable', () => {
    const tree = operationTree(repository);
    expect(tree.map((node) => node.key)).toEqual(['commits', 'trees', 'blobs', 'events']);
    const events = tree[3];
    expect(events).toMatchObject({
      key: 'events',
      segment: 'events',
      leaf: false,
      pick: 'events.*',
    });
    expect(events?.children.map((node) => node.key)).toEqual([
      'events.pull_request',
      'events.issue_comment',
    ]);
    expect(events?.children[0]?.children).toEqual([
      {
        key: 'events.pull_request.opened',
        segment: 'opened',
        leaf: true,
        pick: 'events.pull_request.opened',
        children: [],
      },
      {
        key: 'events.pull_request.review_requested',
        segment: 'review_requested',
        leaf: true,
        pick: 'events.pull_request.review_requested',
        children: [],
      },
    ]);
    // Every node's pick resolves, so a UI can offer any of them.
    const visit = (nodes: ReturnType<typeof operationTree>): void => {
      for (const node of nodes) {
        expect(() => resolveOperationPicks(repository, { picks: [node.pick] })).not.toThrow();
        visit(node.children);
      }
    };
    visit(tree);
  });

  test('a key that is also a prefix is a leaf with children', () => {
    const [events] = operationTree(['events.message', 'events.message.im']);
    expect(events?.children[0]).toMatchObject({
      key: 'events.message',
      leaf: true,
      pick: 'events.message',
      children: [{ key: 'events.message.im', leaf: true }],
    });
  });
});

describe('narrowing operations: the inner reaches nothing the outer does not', () => {
  const grant = (picks: string[]) => resolveOperationPicks(repository, { picks });
  const full = { full: true } as const;

  test('a grant of commits.* allows commits.read and refuses trees.read', () => {
    expect(narrowsOperations(grant(['commits.read']), grant(['commits.*']))).toBe(true);
    expect(narrowsOperations(grant(['trees.read']), grant(['commits.*']))).toBe(false);
    expect(narrowsOperations(grant(['commits.read', 'trees.read']), grant(['commits.*']))).toBe(
      false,
    );
  });

  test('a full request under a grant that is not full is not a narrowing, even of every leaf', () => {
    expect(narrowsOperations(full, grant(['commits.*']))).toBe(false);
    expect(narrowsOperations(full, { full: false, operations: [...repository] })).toBe(false);
  });

  test('a full grant contains everything, full included', () => {
    expect(narrowsOperations(full, full)).toBe(true);
    expect(narrowsOperations(grant(['events.*']), full)).toBe(true);
    expect(narrowsOperations({ full: false, operations: ['added.later'] }, full)).toBe(true);
  });

  test('equal leaf sets narrow each other', () => {
    expect(narrowsOperations(grant(['events.*']), grant(['events.*']))).toBe(true);
  });
});
