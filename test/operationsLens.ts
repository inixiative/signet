import { type FieldMapEntry, type Lens, projectLens } from '@inixiative/json-rules';
import {
  composeGrantLens,
  type GrantLens,
  operationsLens as generatedLens,
  type LensLayer,
} from '../src';

/** An operations lens whose every operation reads `row` rows. */
export const operationsLens = (
  operations: readonly string[],
  row: string,
  rowFields: Record<string, FieldMapEntry>,
): Lens =>
  generatedLens({
    model: 'Operations',
    operations,
    rowModel: () => row,
    rowModels: { [row]: rowFields },
  });

/** A grant row's `GrantLens`: its layers stored as one chain under `base`, composed as Kingdom does. */
export const grantLensOver = (base: Lens, layers: LensLayer[]): GrantLens => ({
  layers,
  projection: projectLens(
    composeGrantLens(
      'base',
      base,
      layers.map((layer, index) => ({
        ...layer,
        id: `layer-${index}`,
        parents: ['base', ...layers.slice(0, index).map((_, earlier) => `layer-${earlier}`)],
      })),
    ),
  ),
});
