import type {
  Condition,
  LensNarrowing,
  ModelNarrowing,
  PathProjection,
  ProjectedVisit,
  StoredLens,
} from '@inixiative/json-rules';
import { z } from 'zod';

/**
 * A grant's lens is a chain of json-rules layers over the resource kind's operations lens (Aron,
 * 2026-11-13, R-SIG-18: "every top-level operate has a lens over its operations with every
 * sub-operation, generated from the operations catalog, the same shape as a Prisma map, nesting
 * included. Grant lenses narrow it."). Kingdom generates the base from its catalog under the id
 * `provider:kind`: its anchor is the kind's operations, each dotted segment of an operation a
 * relation, and each operation a list of the rows it reads (an Archive document, a thread, a
 * repository call, an integration event). Relations are off until a layer turns them on, so a layer
 * turns on the branches it keeps and narrows the row shapes with `mapDefaults` (every branch of a
 * row model) or one branch through `root.relations`. A grant with no layers reads every branch. A
 * grant row stores only its layers, as json-rules `StoredLens` records, the request's first and an
 * approver's after it. Every layer ANDs with the ones above it, so an approver can only narrow. This
 * package carries the layers and the shape of the tree; Kingdom validates, composes (`composeLens`)
 * and applies them (`projectRows`).
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
 * Kingdom runs `validateNarrowing` (or `composeLens`) on it before reading it as a `LensLayer`.
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
 * under a grant's layers with json-rules `composeLens`, which validates what is inside.
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
 * A grant's lens as the refusals read it: its own layers (empty = every branch of the base) and
 * json-rules' `projectLens` of the composed chain, which Kingdom computes after validating the
 * layers.
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

/** A condition over one operation's rows, as a rule over the operations lens (any row of it). */
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

/** Whether the lens holds back any of an operation's rows: a `where` at its branch, or the branch off. */
export const projectionFilters = (projection: PathProjection, operation: string) => {
  const visit = projectionVisit(projection, operation);
  return !visit || visit.whereClauses.length > 0;
};

/** Whether the lens shows `field` of the rows at an operation's branch. */
export const projectionShows = (projection: PathProjection, operation: string, field: string) => {
  const visit = projectionVisit(projection, operation);
  return Boolean(visit && Object.hasOwn(visit.fields, field));
};
