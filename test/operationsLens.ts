import {
  createLens,
  type FieldMapEntry,
  type Lens,
  type LensNarrowing,
  type ModelNarrowing,
  projectLens,
} from '@inixiative/json-rules';
import { type GrantLens, type LensLayer, narrowingAtOperation } from '../src';

const relation = (type: string, isList: boolean): FieldMapEntry => ({
  kind: 'object',
  type,
  isList,
  isRequired: false,
  relationName: type,
  fromFields: [],
  toFields: [],
});

/** An operations lens as Kingdom generates one: each operation a branch listing `row` rows. */
export const operationsLens = (
  operations: readonly string[],
  row: string,
  rowFields: Record<string, FieldMapEntry>,
): Lens => {
  const models: Record<string, { fields: Record<string, FieldMapEntry> }> = {
    [row]: { fields: rowFields },
  };
  const modelAt = (path: readonly string[]) => ['Operations', ...path].join('_');
  for (const operation of operations) {
    const segments = operation.split('.');
    segments.forEach((segment, index) => {
      const at = modelAt(segments.slice(0, index));
      models[at] ??= { fields: {} };
      const last = index === segments.length - 1;
      models[at].fields[segment] = last
        ? relation(row, true)
        : relation(modelAt(segments.slice(0, index + 1)), false);
    });
  }
  return createLens({
    maps: { operations: { models } },
    mapName: 'operations',
    model: 'Operations',
  });
};

/** A root that turns on every operation's branch, the way a Kingdom layer keeps them. */
export const everyBranch = (operations: readonly string[]): ModelNarrowing =>
  operations.reduce<ModelNarrowing>((root, operation) => {
    const placed = narrowingAtOperation(operation, {});
    const merge = (into: ModelNarrowing, from: ModelNarrowing) => {
      for (const [key, value] of Object.entries(from.relations ?? {})) {
        into.relations ??= {};
        into.relations[key] ??= {};
        merge(into.relations[key] as ModelNarrowing, value as ModelNarrowing);
      }
    };
    merge(root, placed);
    return root;
  }, {});

/** A layer that narrows `row` on every branch and keeps them all on. */
export const rowLayer = (
  operations: readonly string[],
  row: string,
  narrowing: ModelNarrowing,
): LensLayer => ({
  root: everyBranch(operations),
  mapDefaults: { operations: { models: { [row]: narrowing } } },
});

/** A grant's lens composed over `base` as Kingdom composes it: no layers reads every branch. */
export const grantLensOver = (
  base: Lens,
  operations: readonly string[],
  layers: LensLayer[],
): GrantLens => ({
  layers,
  projection: projectLens(
    layers.length
      ? layers.reduce<Lens | LensNarrowing>((parent, layer) => ({ parent, ...layer }), base)
      : { parent: base, root: everyBranch(operations) },
  ),
});
