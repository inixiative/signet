import {
  assertValidNarrowing,
  type Condition,
  createLens,
  type FieldMapEntry,
  type Lens,
  type LensNarrowing,
  type ModelNarrowing,
  type PathProjection,
  type ProjectedVisit,
  projectLens,
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
 * repository call, an integration event). Relations are off until a narrowing turns them on, so a
 * narrowing turns on the branches it keeps and narrows the row shapes with `mapDefaults` (every
 * branch of a row model) or one branch through `root.relations`. A row stores only its own
 * narrowing; along a re-delegation chain the reader composes each row's narrowing over the one above
 * it, the upstream first. A chain with no narrowing reads every branch. This package carries the
 * narrowing and the shape of the tree, generates the base (`operationsLens`), composes a chain over
 * it (`composeGrantLens`) and reads rows through the result (`rowsThroughLens`); Kingdom and a host
 * both go through these.
 */

/** A narrowing as a row stores it: json-rules' narrowing without its parent. */
export type LensBody = Omit<LensNarrowing, 'parent'>;

/**
 * A narrowing's envelope only: what is inside `root` and `mapDefaults` is json-rules', unchecked
 * here. `composeGrantLens` validates it before it is read.
 */
export const lensNarrowingSchema = z.strictObject({
  root: z.record(z.string(), z.unknown()).optional(),
  mapDefaults: z.record(z.string(), z.unknown()).optional(),
});

/** The most narrowings a chain composes. */
export const grantLensChainLimit = 20;

/**
 * A grant row's lens as the refusals read it: json-rules' `projectLens` of its chain composed over
 * the base, and whether any narrowing on the chain narrows at all (`false` reads every branch).
 */
export type GrantLens = { projection: PathProjection; narrowed: boolean };

const branchOf = (operation: string) => operation.split('.');

/** One operation's rows as the record its operations lens reads: `{ documents: { read: rows } }`. */
export const operationRecord = (operation: string, rows: readonly Record<string, unknown>[]) =>
  branchOf(operation).reduceRight<unknown>(
    (inner, segment) => ({ [segment]: inner }),
    [...rows],
  ) as Record<string, unknown>;

/** The rows at one operation's branch of a record (`operationRecord`'s, after projection). */
export const operationRows = (record: unknown, operation: string): Record<string, unknown>[] => {
  const reached = branchOf(operation).reduce<unknown>(
    (node, segment) =>
      node && typeof node === 'object' ? (node as Record<string, unknown>)[segment] : undefined,
    record,
  );
  return Array.isArray(reached) ? (reached as Record<string, unknown>[]) : [];
};

/** A narrowing of one operation's rows, placed at its branch of the operations lens's root. */
export const narrowingAtOperation = (
  operation: string,
  narrowing: ModelNarrowing,
): ModelNarrowing =>
  branchOf(operation).reduceRight<ModelNarrowing>(
    (inner, segment) => ({ relations: { [segment]: inner } }),
    narrowing,
  );

/**
 * Every operation's branch turned on, as a narrowing's `root`: each operation a leaf holding
 * `leafNarrowing(operation)`, nothing narrowed by default. A row condition goes here, at the leaf.
 * An operation that reads no rows (`leafNarrowing` gives undefined) has no leaf to turn on; the
 * branches above it are kept.
 */
export const everyBranch = (
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

/** The field map every operations lens is generated under. */
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
 * A resource kind's operations lens, generated from its catalog: `model` is the anchor, each dotted
 * segment of an operation a relation to a branch model (`model_segment_…`), and each operation a
 * list of the rows it reads (`rowModel(operation)`, its fields from `rowModels`). An operation that
 * reads no rows is a Boolean field. Kingdom generates the bases with this; a test or a host that
 * needs one builds it the same way. Throws on a catalog the tree can't hold apart: an operation
 * that is also a prefix of another, or two branches or a row model sharing one model name.
 */
export const operationsLens = ({
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
    models[row] = { fields: rowModels[row] ?? {} };
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
export const rowModelNarrowing = (
  operations: readonly string[],
  row: string,
  narrowing: ModelNarrowing,
): LensBody => ({
  root: everyBranch(operations),
  mapDefaults: { [operationsMapName]: { models: { [row]: narrowing } } },
});

/** A base's operations, read back from its map: each path from the anchor, and whether it reads rows. */
const baseOperations = (
  base: Lens,
  model = base.model,
  path: readonly string[] = [],
): { operation: string; rows: boolean }[] => {
  if (path.length > 20) throw new GrantLensError('The base lens is not a tree of operations');
  return Object.entries(base.maps[base.mapName]?.models[model]?.fields ?? {}).flatMap(
    ([name, field]) =>
      field.kind === 'object' && !field.isList
        ? baseOperations(base, field.type, [...path, name])
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

/** A chain composed over the base: the lens to read rows through, and the `GrantLens` of it. */
export type ComposedGrantLens = GrantLens & { lens: Lens | LensNarrowing };

const isEmptyBody = (body: LensBody) =>
  Object.keys(body.root ?? {}).length === 0 && Object.keys(body.mapDefaults ?? {}).length === 0;

/**
 * A grant row's lens chain, the upstream row's narrowing first and this row's last, composed over
 * the kind's operations lens. An empty or absent narrowing adds nothing; a chain with none reads
 * every branch. json-rules validates each narrowing against the ones above it, so a later one can
 * only narrow. One check is added here, which json-rules has no way to know: no `where` sits above
 * an operation's branch. Such a `where` is over the whole list of rows, not each row, so it would
 * show every row once one matched; rows are filtered at the operation's own branch
 * (`narrowingAtOperation(operation, { where })`). Throws `GrantLensError`.
 */
export const composeGrantLens = (base: Lens, chain: readonly unknown[] = []): ComposedGrantLens => {
  if (chain.length > grantLensChainLimit)
    throw new GrantLensError(`A lens chain composes at most ${grantLensChainLimit} narrowings`);
  const bodies: LensBody[] = [];
  for (const entry of chain) {
    const parsed = lensNarrowingSchema.safeParse(entry ?? {});
    if (!parsed.success) throw new GrantLensError('A lens narrowing does not parse');
    const body = parsed.data as LensBody;
    if (!isEmptyBody(body)) bodies.push(body);
  }
  const operations = baseOperations(base);
  const reads = new Set(operations.filter(({ rows }) => rows).map(({ operation }) => operation));
  if (bodies.length === 0) {
    const lens = {
      parent: base,
      root: everyBranch(
        operations.map(({ operation }) => operation),
        (operation) => (reads.has(operation) ? {} : undefined),
      ),
    };
    return { lens, projection: projectLens(lens), narrowed: false };
  }
  let lens: Lens | LensNarrowing = base;
  try {
    for (const body of bodies) {
      const narrowing: LensNarrowing = { parent: lens, ...body };
      assertValidNarrowing(narrowing);
      lens = narrowing;
    }
  } catch (error) {
    throw new GrantLensError(error instanceof Error ? error.message : 'The lens does not compose');
  }
  const projection = projectLens(lens);
  const gated = [...reads].find((operation) =>
    visitsAbove(projection, operation).some((visit) => visit && visit.whereClauses.length > 0),
  );
  if (gated)
    throw new GrantLensError(
      `A lens filters rows with a where at the operation's own branch, never above it (${gated})`,
    );
  return { lens, projection, narrowed: true };
};

/** One operation's rows as the lens shows them: those it filters out are gone, the rest trimmed. */
export const rowsThroughLens = (
  lens: Lens | LensNarrowing,
  operation: string,
  rows: readonly Record<string, unknown>[],
): Record<string, unknown>[] => {
  const [projected] = projectRows(lens, [operationRecord(operation, rows)]);
  return operationRows(projected, operation);
};

/**
 * One call's filter over an operation's rows, as a rule over the operations lens, for json-rules
 * `validateRuleInLens` (may the call filter on these fields?). Never a lens `where`: there it would
 * pass every row as soon as one matched. A lens filters rows with a `where` at the operation's own
 * branch, `narrowingAtOperation(operation, { where })`.
 */
export const conditionAtOperation = (operation: string, condition: Condition): Condition =>
  ({ field: operation, arrayOperator: 'any', condition }) as Condition;

/** The visit at one operation's branch, or null when the composed lens leaves the branch off. */
export const projectionVisit = (
  projection: PathProjection,
  operation: string,
): ProjectedVisit | null => {
  const anchor = Object.keys(projection).find((path) => !path.includes('.'));
  return (anchor && projection[`${anchor}.${operation}`]) || null;
};

/** The visits above an operation's branch, the anchor first; undefined where the lens has none. */
const visitsAbove = (projection: PathProjection, operation: string) => {
  const anchor = Object.keys(projection).find((path) => !path.includes('.'));
  if (!anchor) return [undefined];
  return branchOf(operation).map(
    (_, index, segments) => projection[[anchor, ...segments.slice(0, index)].join('.')],
  );
};

/**
 * Whether the lens holds back any of an operation's rows: the branch off, or a `where` on any visit
 * from the anchor down to the operation's branch.
 */
export const projectionFilters = (projection: PathProjection, operation: string) =>
  [...visitsAbove(projection, operation), projectionVisit(projection, operation)].some(
    (visit) => !visit || visit.whereClauses.length > 0,
  );

/** Whether the lens shows `field` of the rows at an operation's branch. */
export const projectionShows = (projection: PathProjection, operation: string, field: string) => {
  const visit = projectionVisit(projection, operation);
  return Boolean(visit && Object.hasOwn(visit.fields, field));
};
