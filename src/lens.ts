import {
  type Condition,
  composeLens,
  createLens,
  type FieldMapEntry,
  type Lens,
  type LensNarrowing,
  type ModelNarrowing,
  type PathProjection,
  type ProjectedVisit,
  projectLens,
  projectRows,
  type StoredLens,
} from '@inixiative/json-rules';
import { z } from 'zod';

/**
 * A grant row's lens is its own json-rules layers over the resource kind's operations lens (Aron,
 * 2026-11-13, R-SIG-18: "every top-level operate has a lens over its operations with every
 * sub-operation, generated from the operations catalog, the same shape as a Prisma map, nesting
 * included. Grant lenses narrow it."). Kingdom generates the base from its catalog under the id
 * `provider:kind`: its anchor is the kind's operations, each dotted segment of an operation a
 * relation, and each operation a list of the rows it reads (an Archive document, a thread, a
 * repository call, an integration event). Relations are off until a layer turns them on, so a layer
 * turns on the branches it keeps and narrows the row shapes with `mapDefaults` (every branch of a
 * row model) or one branch through `root.relations`. A grant with no layers reads every branch. A
 * grant row stores only its layers, as json-rules `StoredLens` records, the request's first and an
 * approver's after it. Every layer ANDs with the ones before it, so an approver can only narrow. The
 * layers are this row's alone: what a holder reaches in the end is Kingdom's to work out and is not
 * readable from them. This package carries the layers and the shape of the tree, generates the base
 * (`operationsLens`), composes a row's layers over it (`composeGrantLens`) and reads rows through
 * the result (`rowsThroughLens`); Kingdom and a host both go through these.
 */

/** One layer as a party writes it: a json-rules narrowing without its parent. */
export type LensLayer = Omit<LensNarrowing, 'parent'>;
/** One stored layer: its id and the ids it composes under, the base first. Never a base itself. */
export type StoredLensLayer = Pick<StoredLens, 'id' | 'parents'> & LensLayer;

const narrowingPart = {
  root: z.record(z.string(), z.unknown()).optional(),
  mapDefaults: z.record(z.string(), z.unknown()).optional(),
};
const layerId = z.string().min(1).max(200);

/**
 * A layer's envelope only: what is inside `root` and `mapDefaults` is json-rules', unchecked here.
 * `composeGrantLens` validates it (json-rules `composeLens`) before it is read as a `LensLayer`.
 */
export const lensLayerSchema = z.strictObject(narrowingPart);
export const storedLensLayerSchema = z.strictObject({
  id: layerId,
  parents: z.array(layerId).min(1).max(20),
  ...narrowingPart,
});
export const storedLensLayersSchema = z.array(storedLensLayerSchema).max(20);

/**
 * An operations lens as Kingdom generates it: the json-rules `Lens` itself (its field maps, map name
 * and model) with an `id` and no parents. Only the envelope is checked here; a holder composes it
 * under a grant row's layers with `composeGrantLens`, which validates what is inside.
 */
export const storedBaseLensSchema = z.looseObject({
  id: layerId,
  parents: z.array(layerId).max(0),
  mapName: z.string().min(1),
  model: z.string().min(1),
  maps: z.record(z.string(), z.unknown()),
});

/** The id of a resource kind's operations lens, generated from Kingdom's catalog. */
export const baseLensId = (provider: string, kind: string) => `${provider}:${kind}`;

/**
 * A grant row's lens as the refusals read it: its own layers (empty = every branch of the base) and
 * json-rules' `projectLens` of those layers composed over the base, which Kingdom computes after
 * validating them. It describes this row only, never everything its holder reaches.
 */
export type GrantLens = { layers: readonly LensLayer[]; projection: PathProjection };

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
 * Every operation's branch turned on, as a layer's `root`: each operation a leaf holding
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
 * needs one builds it the same way.
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
  const modelAt = (path: readonly string[]) => [model, ...path].join('_');
  const fieldsAt = (path: readonly string[]) => {
    models[modelAt(path)] ??= { fields: {} };
    return (models[modelAt(path)] as { fields: Record<string, FieldMapEntry> }).fields;
  };
  for (const operation of operations) {
    const segments = branchOf(operation);
    segments.forEach((segment, index) => {
      const fields = fieldsAt(segments.slice(0, index));
      if (index < segments.length - 1) {
        fields[segment] = relationTo(modelAt(segments.slice(0, index + 1)), false);
        return;
      }
      const row = rowModel(operation);
      fields[segment] = row
        ? relationTo(row, true)
        : { kind: 'scalar', type: 'Boolean', isRequired: false };
      if (row) models[row] = { fields: rowModels[row] ?? {} };
    });
  }
  return createLens({
    maps: { [operationsMapName]: { models } },
    mapName: operationsMapName,
    model,
  });
};

/**
 * A layer that narrows `row` wherever it is read and keeps every branch of `operations` on: the
 * shape of a grant pinned to chosen rows.
 */
export const rowModelLayer = (
  operations: readonly string[],
  row: string,
  narrowing: ModelNarrowing,
): LensLayer => ({
  root: everyBranch(operations),
  mapDefaults: { [operationsMapName]: { models: { [row]: narrowing } } },
});

/** A base's operations, read back from its map: each path from the anchor, and whether it reads rows. */
const baseOperations = (
  base: Lens,
  model = base.model,
  path: readonly string[] = [],
): { operation: string; rows: boolean }[] =>
  Object.entries(base.maps[base.mapName]?.models[model]?.fields ?? {}).flatMap(([name, field]) =>
    field.kind === 'object' && !field.isList
      ? baseOperations(base, field.type, [...path, name])
      : [{ operation: [...path, name].join('.'), rows: field.kind === 'object' }],
  );

/**
 * A grant row's stored layers don't parse, aren't one chain under the base, don't compose, or put a
 * `where` above an operation's branch.
 */
export class GrantLensError extends Error {
  readonly code = 'invalid_layers';
  constructor(message: string) {
    super(message);
    this.name = 'GrantLensError';
  }
}

/**
 * A grant row's stored layers composed over the kind's operations lens (`baseId` its id, `base` the
 * lens itself or its stored record): no layers reads every branch. json-rules `composeLens` checks
 * the chain's order and every layer against the ones before it. Two checks are added here, which
 * json-rules has no way to know: no stored layer sits outside the last one's chain, and no `where`
 * sits above an operation's branch. Such a `where` is over the whole list of rows, not each row, so
 * it would show every row once one matched; rows are filtered at the operation's own branch
 * (`narrowingAtOperation(operation, { where })`). Throws `GrantLensError`. The result describes this
 * row's own layers, for Kingdom to apply and for a host to show.
 */
export const composeGrantLens = (
  baseId: string,
  base: Lens,
  stored: unknown,
): Lens | LensNarrowing => {
  const parsed = storedLensLayersSchema.safeParse(stored ?? []);
  if (!parsed.success) throw new GrantLensError('The lens layers do not parse');
  const layers = parsed.data as StoredLens[];
  const last = layers.at(-1);
  const operations = baseOperations(base);
  const reads = new Set(operations.filter(({ rows }) => rows).map(({ operation }) => operation));
  if (!last) {
    const every = operations.map(({ operation }) => operation);
    return {
      parent: base,
      root: everyBranch(every, (operation) => (reads.has(operation) ? {} : undefined)),
    };
  }
  if (last.parents.length !== layers.length)
    throw new GrantLensError(`The lens layers are not one chain under ${baseId}`);
  const records: Record<string, StoredLens> = { [baseId]: { ...base, id: baseId, parents: [] } };
  for (const layer of layers) records[layer.id] = layer;
  let composed: Lens | LensNarrowing;
  try {
    composed = composeLens(last.id, records);
  } catch (error) {
    throw new GrantLensError(
      error instanceof Error ? error.message : 'The lens layers do not compose',
    );
  }
  const projection = projectLens(composed);
  const gated = [...reads].find((operation) =>
    visitsAbove(projection, operation).some((visit) => visit && visit.whereClauses.length > 0),
  );
  if (gated)
    throw new GrantLensError(
      `A lens filters rows with a where at the operation's own branch, never above it (${gated})`,
    );
  return composed;
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
