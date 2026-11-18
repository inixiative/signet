import type { ModelEntry } from '@inixiative/field-map';
import type { Lens } from '@inixiative/json-rules';
import { createOperationsLens } from '../src';

/** An operations lens whose every operation reads `row` rows. */
export const createTestOperationsLens = (
  operations: readonly string[],
  row: string,
  rowFields: ModelEntry['fields'],
): Lens =>
  createOperationsLens({
    model: 'Operations',
    operations,
    rowModel: () => row,
    rowModels: { [row]: rowFields },
  });
