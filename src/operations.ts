import { z } from 'zod';

/**
 * Operation picks (Aron, 2026-11-01: "any model whole, or whatever group of operations whole, or
 * to any degree of specificity"). A provider's catalog is a flat list of
 * dotted leaf keys per resource kind (`commits.read`, `events.pull_request.review_requested`); the
 * nesting is carried by the dots and derived, never stored. A grant asks for `full` (everything the
 * resource has now and later, capped live by the integration's baseline) or picks at any node: a
 * leaf, or a prefix ending `.*` that takes every leaf under it. Picks resolve to leaves once, when
 * the grant is saved, so a later catalog addition reaches only `full` rows.
 */
const segment = '[A-Za-z0-9_-]+';
export const operationKeySchema = z
  .string()
  .max(80)
  .regex(new RegExp(`^${segment}(?:\\.${segment})*$`));
/** A leaf key, or a prefix ending `.*`. */
export const operationPickKeySchema = z
  .string()
  .max(82)
  .regex(new RegExp(`^${segment}(?:\\.${segment})*(?:\\.\\*)?$`));

export const operationPickSchema = z.union([
  z.strictObject({ full: z.literal(true) }),
  z.strictObject({ picks: z.array(operationPickKeySchema).min(1).max(100) }),
]);
export type OperationPick = z.infer<typeof operationPickSchema>;

/** Resolved leaves, as a grant row stores them. Picks of nested events may run past a hundred. */
export const resolvedOperationsSchema = z
  .array(operationKeySchema)
  .min(1)
  .max(1000)
  .refine((operations) => new Set(operations).size === operations.length, {
    message: 'Each operation is listed once',
  });

/**
 * What a row reaches: `full`, or the leaves its picks resolved to. Not the same axis as
 * `Integration.full` / `Token.full`, which make a delegate act with its owner's whole authority.
 */
export type OperationScope = { full: true } | { full: false; operations: string[] };

export class OperationPickError extends Error {
  readonly code = 'unknown_operation_pick';
  constructor(readonly pick: string) {
    super(`No operation matches the pick '${pick}'`);
    this.name = 'OperationPickError';
  }
}

const prefixOf = (pick: string) => (pick.endsWith('.*') ? pick.slice(0, -1) : null);

/**
 * The leaves `picks` reach among `leaves` (a resource kind's catalog keys), in catalog order. A
 * pick that reaches nothing throws `OperationPickError`, so a typo never saves an empty grant.
 */
export const resolveOperationPicks = (
  leaves: readonly string[],
  pick: OperationPick,
): OperationScope => {
  if ('full' in pick) return { full: true };
  const chosen = new Set<string>();
  for (const key of pick.picks) {
    const prefix = prefixOf(key);
    const reached = prefix
      ? leaves.filter((leaf) => leaf.startsWith(prefix))
      : leaves.filter((leaf) => leaf === key);
    if (reached.length === 0) throw new OperationPickError(key);
    for (const leaf of reached) chosen.add(leaf);
  }
  return { full: false, operations: leaves.filter((leaf) => chosen.has(leaf)) };
};

/**
 * One node of a resource kind's operation tree. `key` is its dotted path, `pick` the pick that
 * takes it (the key for a leaf, `key.*` for a group), and a key that is both a leaf and a prefix is
 * a leaf with children (its own pick then takes only the leaf).
 */
export type OperationNode = {
  key: string;
  segment: string;
  leaf: boolean;
  pick: string;
  /** `key.*`, whenever the node has children (a leaf that is also a prefix included). */
  groupPick?: string;
  children: OperationNode[];
};

/** The tree the dotted keys describe, in catalog order: what a grant UI offers to pick from. */
export const operationTree = (leaves: readonly string[]): OperationNode[] => {
  const roots: OperationNode[] = [];
  for (const leaf of leaves) {
    let level = roots;
    const parts = leaf.split('.');
    parts.forEach((part, depth) => {
      const key = parts.slice(0, depth + 1).join('.');
      let node = level.find((candidate) => candidate.key === key);
      if (!node) {
        node = { key, segment: part, leaf: false, pick: `${key}.*`, children: [] };
        level.push(node);
      }
      if (depth < parts.length - 1) node.groupPick = `${key}.*`;
      if (depth === parts.length - 1) {
        node.leaf = true;
        node.pick = key;
      }
      level = node.children;
    });
  }
  return roots;
};

/**
 * `inner` reaches no operation `outer` doesn't. A full `outer` contains everything; a full `inner`
 * under an `outer` that is not full is never a narrowing, even when `outer` lists every leaf today,
 * because `full` keeps growing with the catalog.
 */
export const narrowsOperations = (inner: OperationScope, outer: OperationScope): boolean => {
  if (outer.full) return true;
  if (inner.full) return false;
  return inner.operations.every((operation) => permitsOperation(outer, operation));
};

/** Whether `scope` reaches `operation`. */
export const permitsOperation = (scope: OperationScope, operation: string) =>
  scope.full || scope.operations.includes(operation);

/**
 * The first refusal among the catalog operations `scope` reaches, or null. A full scope is checked
 * against the whole catalog, so run it again whenever the catalog grows.
 */
export const scopeRefusal = <O extends string>(
  scope: OperationScope,
  catalog: readonly O[],
  refusal: (operation: O) => string | null,
) => {
  for (const operation of catalog) {
    if (!permitsOperation(scope, operation)) continue;
    const reason = refusal(operation);
    if (reason) return reason;
  }
  return null;
};
