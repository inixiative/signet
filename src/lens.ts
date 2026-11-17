import {
  assertValidNarrowing,
  type Condition,
  createLens,
  type FieldMapEntry,
  type Lens,
  type LensNarrowing,
  lensVisit,
  type ModelNarrowing,
  projectRows,
} from '@inixiative/json-rules';
import { z } from 'zod';

/**
 * A grant row's lens is one json-rules narrowing over the resource kind's operations lens (Aron,
 * 2026-11-13, R-SIG-18: "every top-level operate has a lens over its operations with every
 * sub-operation, generated from the operations catalog, the same shape as a Prisma map, nesting
 * included. Grant lenses narrow it."; 2026-11-15: "It's just a lens."). Kingdom generates the base
 * from its catalog: its anchor is the kind's operations, each dotted segment of an operation a
 * relation, and each operation a list of the rows it reads (an Archive document, a thread, a
 * repository call, an integration event). Every operation's branch is on before the first lens; a
 * lens filters and trims what an operation returns, narrowing the row shapes with `mapDefaults`
 * (every branch of a row model) or one branch through `root.relations`, and never says which
 * operations a grant holds (its actions do). A row stores only its own
 * narrowing; along a re-delegation chain the reader composes each row's narrowing over the one above
 * it, the upstream first. A chain with no narrowing reads every branch. This package carries the
 * narrowing and the shape of the tree, creates the base (`createOperationsLens`), composes a chain
 * over it (`composeGrantLensChain`) and projects rows through the result (`projectOperationRows`);
 * Kingdom and a host both go through these. `docs/VERBS.md` lists each of them.
 */

/** A narrowing as a row stores it: json-rules' narrowing without its parent. */
export type LensBody = Omit<LensNarrowing, 'parent'>;

/**
 * A narrowing's envelope only: what is inside `root` and `mapDefaults` is json-rules', unchecked
 * here. `composeGrantLensChain` validates it before it is read.
 */
export const lensNarrowingSchema = z.strictObject({
  root: z.record(z.string(), z.unknown()).optional(),
  mapDefaults: z.record(z.string(), z.unknown()).optional(),
});

/** The most narrowings a chain composes. */
export const grantLensChainLimit = 20;

/**
 * A grant row's lens chain composed over the base: the json-rules lens to read through, and whether
 * any row on the chain carries a lens at all (`false` reads every branch).
 */
export type GrantLens = { lens: Lens | LensNarrowing; narrowed: boolean };

const branchOf = (operation: string) => operation.split('.');

/** One operation's rows nested at its branch, the record an operations lens reads: `{ documents: { read: rows } }`. */
export const nestRowsAtOperation = (operation: string, rows: readonly Record<string, unknown>[]) =>
  branchOf(operation).reduceRight<unknown>(
    (inner, segment) => ({ [segment]: inner }),
    [...rows],
  ) as Record<string, unknown>;

/** The rows at one operation's branch of a record (`nestRowsAtOperation`'s, after projection). */
export const readRowsAtOperation = (
  record: unknown,
  operation: string,
): Record<string, unknown>[] => {
  const reached = branchOf(operation).reduce<unknown>(
    (node, segment) =>
      node && typeof node === 'object' && Object.hasOwn(node, segment)
        ? (node as Record<string, unknown>)[segment]
        : undefined,
    record,
  );
  return Array.isArray(reached) ? (reached as Record<string, unknown>[]) : [];
};

/** A narrowing of one operation's rows, placed at its branch of the operations lens's root. */
export const narrowOperationBranch = (
  operation: string,
  narrowing: ModelNarrowing,
): ModelNarrowing =>
  branchOf(operation).reduceRight<ModelNarrowing>(
    (inner, segment) => ({ relations: { [segment]: inner } }),
    narrowing,
  );

/**
 * A narrowing of every operation's branch, as a narrowing's `root`: each operation a leaf holding
 * `leafNarrowing(operation)`, nothing narrowed by default. Narrowing a branch is what turns it on
 * (json-rules: a relation is off until the first narrowing turns it on through the relation
 * object), so every branch is on. A row condition goes here, at the leaf.
 * An operation that reads no rows (`leafNarrowing` gives undefined) has no leaf to turn on; the
 * branches above it are kept.
 */
export const narrowEveryOperationBranch = (
  operations: readonly string[],
  leafNarrowing: (operation: string) => ModelNarrowing | undefined = () => ({}),
): ModelNarrowing => {
  const root: ModelNarrowing = {};
  for (const operation of operations) {
    const segments = branchOf(operation);
    let node = root;
    for (const [index, segment] of segments.entries()) {
      const leaf = index === segments.length - 1 ? leafNarrowing(operation) : {};
      if (!leaf) break;
      node.relations ??= {};
      node.relations[segment] ??= leaf;
      node = node.relations[segment] as ModelNarrowing;
    }
  }
  return root;
};

/** The field map every operations lens is created under. */
export const operationsMapName = 'operations';

const relationTo = (type: string, isList: boolean): FieldMapEntry => ({
  kind: 'object',
  type,
  isList,
  isRequired: false,
  relationName: type,
  fromFields: [],
  toFields: [],
});

/**
 * A resource kind's operations lens, created from its catalog: `model` is the anchor, each dotted
 * segment of an operation a relation to a branch model (`model_segment_…`), and each operation a
 * list of the rows it reads (`rowModel(operation)`, its fields from `rowModels`). An operation that
 * reads no rows is a Boolean field. Kingdom creates the bases with this; a test or a host that
 * needs one creates it the same way. Throws on a catalog the tree can't hold apart: an operation
 * that is also a prefix of another, or two branches or a row model sharing one model name.
 */
export const createOperationsLens = ({
  model,
  operations,
  rowModel,
  rowModels,
}: {
  model: string;
  operations: readonly string[];
  rowModel: (operation: string) => string | undefined;
  rowModels: Record<string, Record<string, FieldMapEntry>>;
}): Lens => {
  const models: Record<string, { fields: Record<string, FieldMapEntry> }> = {};
  const branches = new Map<string, string>();
  const modelAt = (path: readonly string[]) => [model, ...path].join('_');
  const fieldsAt = (path: readonly string[]) => {
    const name = modelAt(path);
    if ((branches.get(name) ?? path.join('.')) !== path.join('.'))
      throw Error(`Operations under ${branches.get(name)} and ${path.join('.')} share ${name}`);
    branches.set(name, path.join('.'));
    models[name] ??= { fields: {} };
    return (models[name] as { fields: Record<string, FieldMapEntry> }).fields;
  };
  const leaves = new Set(operations);
  for (const operation of operations) {
    const segments = branchOf(operation);
    segments.forEach((segment, index) => {
      const fields = fieldsAt(segments.slice(0, index));
      if (index < segments.length - 1) {
        if (leaves.has(segments.slice(0, index + 1).join('.')))
          throw Error(`${operation} sits under another operation`);
        fields[segment] = relationTo(modelAt(segments.slice(0, index + 1)), false);
        return;
      }
      const row = rowModel(operation);
      fields[segment] = row
        ? relationTo(row, true)
        : { kind: 'scalar', type: 'Boolean', isRequired: false };
    });
  }
  for (const row of new Set(operations.flatMap((operation) => rowModel(operation) ?? []))) {
    if (branches.has(row)) throw Error(`The row model ${row} shares its name with a branch`);
    models[row] = { fields: Object.hasOwn(rowModels, row) ? (rowModels[row] ?? {}) : {} };
  }
  return createLens({
    maps: { [operationsMapName]: { models } },
    mapName: operationsMapName,
    model,
  });
};

/**
 * A narrowing of `row` wherever it is read that keeps every branch of `operations` on: the shape of
 * a grant pinned to chosen rows. `operations` are ones that read rows; an operation that reads none
 * has no branch to turn on.
 */
export const narrowRowModelOnEveryBranch = (
  operations: readonly string[],
  row: string,
  narrowing: ModelNarrowing,
): LensBody => ({
  root: narrowEveryOperationBranch(operations),
  mapDefaults: { [operationsMapName]: { models: { [row]: narrowing } } },
});

const ownEntry = <T>(record: Record<string, T> | undefined, key: string): T | undefined =>
  record && Object.hasOwn(record, key) ? record[key] : undefined;

/** A base's operations, read back from its map: each path from the anchor, and whether it reads rows. */
const listBaseOperations = (
  base: Lens,
  model = base.model,
  path: readonly string[] = [],
): { operation: string; rows: boolean }[] => {
  if (path.length > 20) throw new GrantLensError('The base lens is not a tree of operations');
  const fields = ownEntry(ownEntry(base.maps, base.mapName)?.models, model)?.fields ?? {};
  return Object.entries(fields).flatMap(([name, field]) =>
    field.kind === 'object' && !field.isList
      ? listBaseOperations(base, field.type, [...path, name])
      : [{ operation: [...path, name].join('.'), rows: field.kind === 'object' }],
  );
};

/**
 * A grant row's lens chain doesn't parse, is longer than `grantLensChainLimit`, doesn't compose, or
 * puts a `where` above an operation's branch.
 */
export class GrantLensError extends Error {
  readonly code = 'invalid_lens';
  constructor(message: string) {
    super(message);
    this.name = 'GrantLensError';
  }
}

/** The relation paths from the anchor down to an operation's branch, the anchor (`''`) first. */
const pathsAboveOperation = (operation: string) =>
  branchOf(operation).map((_, index, segments) => segments.slice(0, index).join('.'));

/**
 * A grant row's lens chain, the upstream row's lens first and this row's last, composed over the
 * kind's operations lens. A lens filters and trims what an operation returns; it never says which
 * operations a grant holds, which are its actions alone (Aron, 2026-11-17: "The lens is for outgoing
 * stuff, right? For filtering data and truncating data that you're getting back. That's what the
 * lens is for. Everything else is an operation or a where."). So every operation's branch is on
 * before the first lens, each lens only narrows rows and fields within a branch (json-rules: a later
 * narrowing never hides a relation it does not omit), and a lens that would leave an operation's
 * branch off is refused. An absent lens (null or undefined) adds nothing. json-rules validates each
 * lens against the ones above it, so a later one can only narrow. One more check is added here: no
 * `where` sits above an operation's branch. Such a `where` is over the whole list of rows, not each
 * row, so it would show every row once one matched; rows are filtered at the operation's own branch
 * (`narrowOperationBranch(operation, { where })`). Throws `GrantLensError`.
 */
export const composeGrantLensChain = (base: Lens, chain: readonly unknown[] = []): GrantLens => {
  if (chain.length > grantLensChainLimit)
    throw new GrantLensError(`A lens chain composes at most ${grantLensChainLimit} narrowings`);
  const bodies: LensBody[] = [];
  for (const entry of chain) {
    if (entry === null || entry === undefined) continue;
    const parsed = lensNarrowingSchema.safeParse(entry);
    if (!parsed.success) throw new GrantLensError('A lens narrowing does not parse');
    bodies.push(parsed.data as LensBody);
  }
  const operations = listBaseOperations(base);
  const reads = new Set(operations.filter(({ rows }) => rows).map(({ operation }) => operation));
  const everyBranch: LensNarrowing = {
    parent: base,
    root: narrowEveryOperationBranch(
      operations.map(({ operation }) => operation),
      (operation) => (reads.has(operation) ? {} : undefined),
    ),
  };
  if (bodies.length === 0) return { lens: everyBranch, narrowed: false };
  let lens: Lens | LensNarrowing = everyBranch;
  try {
    for (const body of bodies) {
      const narrowing: LensNarrowing = { parent: lens, ...body };
      assertValidNarrowing(narrowing);
      lens = narrowing;
    }
  } catch (error) {
    throw new GrantLensError(error instanceof Error ? error.message : 'The lens does not compose');
  }
  const composed = lens;
  const leftOff = [...reads].find((operation) => !lensVisit(composed, operation));
  if (leftOff)
    throw new GrantLensError(
      `A lens filters what an operation returns; it cannot leave an operation off (${leftOff})`,
    );
  const gated = [...reads].find((operation) =>
    pathsAboveOperation(operation).some(
      (path) => (lensVisit(composed, path)?.whereClauses.length ?? 0) > 0,
    ),
  );
  if (gated)
    throw new GrantLensError(
      `A lens filters rows with a where at the operation's own branch, never above it (${gated})`,
    );
  return { lens: composed, narrowed: true };
};

/** One operation's rows projected through a lens (json-rules `projectRows`): those it filters out are gone, the rest trimmed. */
export const projectOperationRows = (
  lens: Lens | LensNarrowing,
  operation: string,
  rows: readonly Record<string, unknown>[],
): Record<string, unknown>[] => {
  const [projected] = projectRows(lens, [nestRowsAtOperation(operation, rows)]);
  return readRowsAtOperation(projected, operation);
};

/**
 * One call's filter over an operation's rows, re-rooted onto the operations record as an `any`
 * array rule, for json-rules `validateRuleInLens` (may the call filter on these fields?). Never a
 * lens `where`: there it would pass every row as soon as one matched. A lens filters rows with a
 * `where` at the operation's own branch, `narrowOperationBranch(operation, { where })`.
 */
export const conditionOverOperationRows = (operation: string, condition: Condition): Condition =>
  ({ field: operation, arrayOperator: 'any', condition }) as Condition;

/**
 * Describe whether the lens holds back any of an operation's rows: the branch off, or a `where` on
 * any visit (json-rules `lensVisit`) from the anchor down to the operation's branch.
 */
export const describeWhetherLensFiltersOperationRows = (
  lens: Lens | LensNarrowing,
  operation: string,
) =>
  [...pathsAboveOperation(operation), operation].some((path) => {
    const visit = lensVisit(lens, path);
    return !visit || visit.whereClauses.length > 0;
  });
