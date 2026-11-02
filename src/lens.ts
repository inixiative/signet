import type { LensNarrowing, PathProjection, StoredLens } from '@inixiative/json-rules';
import { z } from 'zod';

/**
 * A grant's lens is a chain of json-rules layers over the integration's base lens for the resource's
 * model (Aron, 2026-11-01: "root `where` filters; otherwise a narrowing of shape (pick/omit)… No
 * lens means the default"). The base lives in Kingdom's catalog, as code, under the id
 * `provider:kind`; a grant row stores only the layers under it, as json-rules `StoredLens` records,
 * the request's first and an approver's after it. Every layer ANDs with the ones above it, so an
 * approver can only narrow. This package carries the layers; Kingdom validates, composes
 * (`composeLens`) and applies them (`projectRows`).
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
 * A base lens as Kingdom's catalog carries it: the json-rules `Lens` itself (its field maps, map name
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

/** The id of an integration's base lens for a resource kind's model, in Kingdom's catalog. */
export const baseLensId = (provider: string, kind: string) => `${provider}:${kind}`;

/**
 * A grant's lens as the refusals read it: its own layers (empty = the base) and json-rules'
 * `projectLens` of the composed chain, which Kingdom computes after validating the layers.
 */
export type GrantLens = { layers: readonly LensLayer[]; projection: PathProjection };

/** Whether the composed lens filters rows anywhere: a `where` on the anchor or along a relation. */
export const projectionFilters = (projection: PathProjection) =>
  Object.values(projection).some((visit) => visit.whereClauses.length > 0);

/** Whether the composed lens shows `field` of its anchor model (the visit keyed by the model alone). */
export const projectionShows = (projection: PathProjection, field: string) =>
  Object.entries(projection).some(
    ([path, visit]) => !path.includes('.') && Object.hasOwn(visit.fields, field),
  );
