import type { LensNarrowing, ModelNarrowing, StoredLens } from '@inixiative/json-rules';
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

/** The shape is checked here; the narrowing itself is json-rules', checked by Kingdom. */
export const lensLayerSchema = z.strictObject(narrowingPart) as unknown as z.ZodType<
  LensLayer,
  LensLayer
>;
export const storedLensLayerSchema = z.strictObject({
  id: layerId,
  parents: z.array(layerId).min(1).max(20),
  ...narrowingPart,
}) as unknown as z.ZodType<StoredLensLayer, StoredLensLayer>;
export const storedLensLayersSchema = z.array(storedLensLayerSchema).max(20);

/** Every model narrowing a layer spells at its top: `root` and each map default's models. */
const narrowings = (layer: LensLayer): ModelNarrowing[] => [
  ...(layer.root ? [layer.root] : []),
  ...Object.values(layer.mapDefaults ?? {}).flatMap((defaults) =>
    Object.values(defaults.models ?? {}),
  ),
];
const filters = (narrowing: ModelNarrowing): boolean =>
  narrowing.where !== undefined || Object.values(narrowing.relations ?? {}).some(filters);

/** Whether any layer filters rows: a `where` anywhere, on the model or along a relation. */
export const lensFilters = (layers: readonly LensLayer[]) =>
  layers.some((layer) => narrowings(layer).some(filters));

/** Whether any layer hides `field` of the model it narrows, by `picks` leaving it out or `omits`. */
export const lensHidesField = (layers: readonly LensLayer[], field: string) =>
  layers.some((layer) =>
    narrowings(layer).some(
      (narrowing) =>
        (narrowing.picks !== undefined && !narrowing.picks.includes(field)) ||
        narrowing.omits?.includes(field) === true,
    ),
  );
