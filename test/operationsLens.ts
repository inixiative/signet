import type { FieldMapEntry, Lens } from '@inixiative/json-rules';
import { operationsLens as generatedLens } from '../src';

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
