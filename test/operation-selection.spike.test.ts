// Spike (docs/OPERATION-SELECTION.md, "use the lens itself"): the provider catalog as a json-rules
// lens, the doc's table rows as LensNarrowings over it, checked against validateNarrowing and
// projectLens. Rows where json-rules disagrees with the table are `test.failing`, each one for Aron.
import { describe, expect, test } from 'bun:test';
import {
  createLens,
  type FieldMap,
  type FieldMapEntry,
  type Lens,
  type LensNarrowing,
  type ModelNarrowing,
  projectLens,
  validateNarrowing,
} from '@inixiative/json-rules';

const MAP = 'operations';
const ROOT = '$root';

/** The catalog's operation tree as a field map: a branch is a model, a leaf a column, a child branch a relation. */
const catalogFieldMap = (catalog: readonly string[]): FieldMap => {
  const models: Record<string, Record<string, FieldMapEntry>> = { [ROOT]: {} };
  for (const key of catalog) {
    const segments = key.split('.');
    let model = ROOT;
    segments.forEach((segment, i) => {
      const fields = models[model] as Record<string, FieldMapEntry>;
      const childModel = segments.slice(0, i + 1).join('.');
      if (i === segments.length - 1) {
        if (fields[segment]?.kind === 'object')
          throw new Error(`'${childModel}' is both a leaf and a branch`);
        fields[segment] = { kind: 'scalar', type: 'Boolean' };
        return;
      }
      if (fields[segment]?.kind === 'scalar')
        throw new Error(`'${childModel}' is both a leaf and a branch`);
      fields[segment] = { kind: 'object', type: childModel };
      models[childModel] ??= {};
      model = childModel;
    });
  }
  return {
    models: Object.fromEntries(Object.entries(models).map(([name, fields]) => [name, { fields }])),
  };
};

/** Every relation of the tree, spelled from the root, so the narrowing turns them all on. */
const allRelations = (map: FieldMap, model: string): ModelNarrowing => {
  const relations: Record<string, ModelNarrowing> = {};
  for (const [field, entry] of Object.entries(map.models[model]?.fields ?? {}))
    if (entry.kind === 'object') relations[field] = allRelations(map, entry.type);
  return Object.keys(relations).length ? { relations } : {};
};

const rawCatalogLens = (catalog: readonly string[]): Lens =>
  createLens({ maps: { [MAP]: catalogFieldMap(catalog) }, mapName: MAP, model: ROOT });

/** The spike's one new function: the catalog lens, every relation on (operations start all on). */
const catalogLens = (catalog: readonly string[]): LensNarrowing => {
  const lens = rawCatalogLens(catalog);
  return { parent: lens, root: allRelations(lens.maps[MAP] as FieldMap, ROOT) };
};

/** The operations a narrowing reaches: each shown path's visible columns, as dotted keys. */
const reachedLeaves = (narrowing: Lens | LensNarrowing): string[] =>
  Object.entries(projectLens(narrowing))
    .flatMap(([path, visit]) => {
      const branch = path === ROOT ? '' : path.slice(ROOT.length + 1);
      return Object.entries(visit.fields)
        .filter(([, entry]) => entry.kind === 'scalar')
        .map(([field]) => (branch ? `${branch}.${field}` : field));
    })
    .sort();

/** Chains grant layers (each without its parent) onto a base, then validates every layer. */
const chain = (base: Lens | LensNarrowing, layers: readonly Omit<LensNarrowing, 'parent'>[]) => {
  let narrowing: Lens | LensNarrowing = base;
  const codes: string[] = [];
  for (const layer of layers) {
    narrowing = { ...layer, parent: narrowing };
    const result = validateNarrowing(narrowing);
    if (!result.ok) codes.push(...result.errors.map((e) => e.code));
  }
  return { narrowing, codes };
};

const NOW = [
  'sessions.read',
  'sessions.write',
  'sessions.delete',
  'documents.read',
  'documents.search',
  'events.push',
  'events.pull_request.opened',
  'events.pull_request.review_requested',
  'commits.read',
];
const GROWN = [...NOW, 'sessions.restore', 'events.pull_request.closed', 'issues.read'];
const all = (catalog: readonly string[]) => [...catalog].sort();
const without = (catalog: readonly string[], ...prefixes: string[]) =>
  all(catalog).filter((k) => !prefixes.some((p) => k === p || k.startsWith(`${p}.`)));
const under = (catalog: readonly string[], ...prefixes: string[]) =>
  all(catalog).filter((k) => prefixes.some((p) => k === p || k.startsWith(`${p}.`)));

type Layer = Omit<LensNarrowing, 'parent'>;
type Row = {
  n: string;
  doc: string;
  /** The layers as a lens spells them. `base: 'raw'` stands the layers on the bare lens (relations off). */
  layers: Layer[];
  base?: 'on' | 'raw';
  expected: { now: string[]; grown: string[] } | { code: string };
  /** Set when json-rules disagrees with the doc's table: what it returned. */
  differs?: string;
};

const rows: Row[] = [
  { n: '1', doc: '[{}]', layers: [{}], expected: { now: all(NOW), grown: all(GROWN) } },
  {
    n: '1r',
    doc: '[{}] on the bare lens (relations off)',
    base: 'raw',
    layers: [{}],
    expected: { now: all(NOW), grown: all(GROWN) },
    differs: 'reaches nothing: on the bare lens a relation is off until a layer spells it',
  },
  {
    n: '1s',
    doc: '[{}] on the bare lens, every relation spelled by the layer',
    base: 'raw',
    layers: [
      {
        root: {
          relations: {
            sessions: {},
            documents: {},
            events: { relations: { pull_request: {} } },
            commits: {},
          },
        },
      },
    ],
    expected: { now: all(NOW), grown: all(GROWN) },
    differs: 'now matches; after growth misses issues.read (a new branch is never spelled)',
  },
  {
    n: '2',
    doc: "[{ omits: ['events'] }]",
    layers: [{ root: { omits: ['events'] } }],
    expected: { now: without(NOW, 'events'), grown: without(GROWN, 'events') },
  },
  {
    n: '3',
    doc: "[{ omits: ['events.pull_request'] }]",
    layers: [{ root: { relations: { events: { omits: ['pull_request'] } } } }],
    expected: {
      now: without(NOW, 'events.pull_request'),
      grown: without(GROWN, 'events.pull_request'),
    },
  },
  {
    n: '4',
    doc: "[{ omits: ['sessions.delete'] }]",
    layers: [{ root: { relations: { sessions: { omits: ['delete'] } } } }],
    expected: { now: without(NOW, 'sessions.delete'), grown: without(GROWN, 'sessions.delete') },
  },
  {
    n: '5',
    doc: "[{ picks: ['sessions'] }] (literal: picks a relation)",
    layers: [{ root: { picks: ['sessions'] } }],
    expected: { now: under(NOW, 'sessions'), grown: under(GROWN, 'sessions') },
    differs: "wrong_kind: 'sessions' is a relation: picks names columns",
  },
  {
    n: '5b',
    doc: "[{ picks: ['sessions'] }] (lens form: omit the other relations)",
    layers: [{ root: { omits: ['documents', 'events', 'commits'] } }],
    expected: { now: under(NOW, 'sessions'), grown: under(GROWN, 'sessions') },
    differs: 'now matches; after growth also reaches issues.read (a new branch is not omitted)',
  },
  {
    n: '5c',
    doc: "[{ picks: ['sessions'] }] (lens form on the bare lens: relations off, the layer turns sessions on)",
    base: 'raw',
    layers: [{ root: { relations: { sessions: {} } } }],
    expected: { now: under(NOW, 'sessions'), grown: under(GROWN, 'sessions') },
  },
  {
    n: '6',
    doc: "[{ picks: ['sessions.write', 'sessions.delete'] }] (lens form: omit other relations, pick columns)",
    layers: [
      {
        root: {
          omits: ['documents', 'events', 'commits'],
          relations: { sessions: { picks: ['write', 'delete'] } },
        },
      },
    ],
    expected: {
      now: ['sessions.delete', 'sessions.write'],
      grown: ['sessions.delete', 'sessions.write'],
    },
    differs: 'now matches; after growth also reaches issues.read',
  },
  {
    n: '6c',
    doc: "[{ picks: ['sessions.write', 'sessions.delete'] }] (on the bare lens)",
    base: 'raw',
    layers: [{ root: { relations: { sessions: { picks: ['write', 'delete'] } } } }],
    expected: {
      now: ['sessions.delete', 'sessions.write'],
      grown: ['sessions.delete', 'sessions.write'],
    },
  },
  {
    n: '7',
    doc: "[{ picks: ['sessions', 'documents', 'events.pull_request'], omits: ['events.pull_request.opened'] }]",
    layers: [
      {
        root: {
          omits: ['commits'],
          relations: {
            events: { omits: ['push'], relations: { pull_request: { omits: ['opened'] } } },
          },
        },
      },
    ],
    expected: {
      now: [...under(NOW, 'sessions', 'documents'), 'events.pull_request.review_requested'].sort(),
      grown: [
        ...under(GROWN, 'sessions', 'documents'),
        'events.pull_request.closed',
        'events.pull_request.review_requested',
      ].sort(),
    },
    differs: 'now matches; after growth also reaches issues.read',
  },
  {
    n: '7c',
    doc: 'row 7 on the bare lens',
    base: 'raw',
    layers: [
      {
        root: {
          relations: {
            sessions: {},
            documents: {},
            events: { picks: [], relations: { pull_request: { omits: ['opened'] } } },
          },
        },
      },
    ],
    expected: {
      now: [...under(NOW, 'sessions', 'documents'), 'events.pull_request.review_requested'].sort(),
      grown: [
        ...under(GROWN, 'sessions', 'documents'),
        'events.pull_request.closed',
        'events.pull_request.review_requested',
      ].sort(),
    },
  },
  {
    n: '8',
    doc: "[{ picks: ['sessions', 'documents'] }, { omits: ['documents'] }]",
    layers: [{ root: { omits: ['events', 'commits'] } }, { root: { omits: ['documents'] } }],
    expected: { now: under(NOW, 'sessions'), grown: under(GROWN, 'sessions') },
    differs: 'now matches; after growth also reaches issues.read',
  },
  {
    n: '8c',
    doc: 'row 8 on the bare lens',
    base: 'raw',
    layers: [
      { root: { relations: { sessions: {}, documents: {} } } },
      { root: { omits: ['documents'] } },
    ],
    expected: { now: under(NOW, 'sessions'), grown: under(GROWN, 'sessions') },
  },
  {
    n: '9',
    doc: "[{ omits: ['events'] }, { picks: ['events'] }]",
    layers: [{ root: { omits: ['events'] } }, { root: { relations: { events: {} } } }],
    expected: { code: 'not_visible' },
  },
  {
    n: '10',
    doc: "[{ picks: ['sessions'], omits: ['sessions'] }]",
    base: 'raw',
    layers: [{ root: { omits: ['sessions'], relations: { sessions: {} } } }],
    expected: { code: 'conflicting_selection' },
    differs: 'no error; the omit wins and the layer reaches nothing',
  },
  {
    n: '11',
    doc: "[{ omits: ['events'], picks: ['events.push'] }]",
    layers: [{ root: { omits: ['events'], relations: { events: { picks: ['push'] } } } }],
    expected: { code: 'conflicting_selection' },
    differs: 'no error; the omit wins',
  },
  {
    n: '12',
    doc: "[{ picks: ['sesions'] }]",
    layers: [{ root: { relations: { sesions: {} } } }],
    expected: { code: 'not_in_catalog' },
    differs: "not_in_lens (the lens's name for the doc's not_in_catalog)",
  },
  {
    n: '13',
    doc: "[{ omits: ['commits.read.extra'] }]",
    layers: [{ root: { relations: { commits: { relations: { read: { omits: ['extra'] } } } } } }],
    expected: { code: 'not_in_catalog' },
    differs: "wrong_kind ('read' is a column, not a relation)",
  },
  {
    n: '14',
    doc: "[{ picks: ['sessions'], omits: ['sessions.read', 'sessions.write', 'sessions.delete'] }]",
    base: 'raw',
    layers: [{ root: { relations: { sessions: { omits: ['read', 'write', 'delete'] } } } }],
    expected: { code: 'empty_selection' },
    differs: 'no error; validates and reaches nothing now, then sessions.restore after growth',
  },
  {
    n: '15',
    doc: "baseline [{ omits: ['commits'] }], then ask [{}]",
    layers: [{ root: { omits: ['commits'] } }, {}],
    expected: { now: without(NOW, 'commits'), grown: without(GROWN, 'commits') },
  },
  {
    n: '16',
    doc: "Archive's ask [{ picks: ['sessions.write', 'sessions.delete'] }] (bare lens, as 6c)",
    base: 'raw',
    layers: [{ root: { relations: { sessions: { picks: ['write', 'delete'] } } } }],
    expected: {
      now: ['sessions.delete', 'sessions.write'],
      grown: ['sessions.delete', 'sessions.write'],
    },
  },
];

const run = (row: Row, catalog: readonly string[]) => {
  const base = row.base === 'raw' ? rawCatalogLens(catalog) : catalogLens(catalog);
  return chain(base, row.layers);
};

describe('operation selection as a json-rules lens over the catalog (spike)', () => {
  test('catalogLens turns every operation on', () => {
    const base = catalogLens(NOW);
    expect(validateNarrowing(base)).toEqual({ ok: true, errors: [] } as never);
    expect(reachedLeaves(base)).toEqual(all(NOW));
    expect(reachedLeaves(rawCatalogLens(NOW))).toEqual([]);
  });

  for (const row of rows) {
    const t = row.differs ? test.failing : test;
    t(`row ${row.n}: ${row.doc}`, () => {
      const now = run(row, NOW);
      if ('code' in row.expected) {
        expect(now.codes).toContain(row.expected.code);
        return;
      }
      expect(now.codes).toEqual([]);
      expect(reachedLeaves(now.narrowing)).toEqual(row.expected.now);
      const grown = run(row, GROWN);
      expect(grown.codes).toEqual([]);
      expect(reachedLeaves(grown.narrowing)).toEqual(row.expected.grown);
    });
  }

  test.failing('row 17: a key that is both a leaf and a branch (events, events.push)', () => {
    expect(() => catalogLens(['events', 'events.push'])).not.toThrow();
  });
});

// Prints what json-rules returns for every row (SPIKE_REPORT=1 bun test test/operation-selection.spike.test.ts).
if (process.env.SPIKE_REPORT)
  for (const row of rows)
    for (const [label, catalog] of [
      ['now', NOW],
      ['grown', GROWN],
    ] as const) {
      const { narrowing, codes } = run(row, catalog);
      console.log(
        `${row.n} ${label}: codes=${JSON.stringify(codes)} leaves=${JSON.stringify(codes.length ? [] : reachedLeaves(narrowing))}`,
      );
    }
