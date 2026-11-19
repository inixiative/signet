import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as api from '../src';
import * as lens from '../src/lens';

// One implementation per lens verb (docs/VERBS.md).

const ROOT = join(import.meta.dir, '..');
const doc = readFileSync(join(ROOT, 'docs/VERBS.md'), 'utf8');

const code = (file: string): string =>
  readFileSync(join(ROOT, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

const SOURCES = readdirSync(join(ROOT, 'src'))
  .filter((name) => name.endsWith('.ts'))
  .map((name) => ({ file: `src/${name}`, code: code(`src/${name}`) }));

const functionsOf = (module: object) =>
  Object.entries(module)
    .filter(([name, value]) => typeof value === 'function' && !/^[A-Z]/.test(name))
    .map(([name]) => name);

// An exported function whose signature takes or returns a lens.
const LENS_SIGNATURE = /\b(GrantLens|LensBody|LensNarrowing|ModelNarrowing|Lens)\b/;
const lensSignatures = SOURCES.flatMap(({ code: source }) =>
  [
    ...source.matchAll(
      /export const (\w+) = (?:async )?(?:<[^=]*?>)?\(([\s\S]*?)\)(?::\s*([^=]+?))?\s*=>/g,
    ),
    ...source.matchAll(
      /export (?:async )?function (\w+)(?:<[^(]*?>)?\(([\s\S]*?)\)(?::\s*([^{]+?))?\s*\{/g,
    ),
  ]
    .filter(([, , params, returns]) => LENS_SIGNATURE.test(`${params} ${returns ?? ''}`))
    .map(([, name]) => name as string),
);

const RULES: { verb: string; pattern: RegExp; owners: string[] }[] = [
  {
    verb: 'split an operation into its branch segments',
    pattern: /operation\.split\('\.'\)/,
    owners: ['src/lens.ts'],
  },
  {
    verb: "build an array rule over an operation's rows",
    pattern: /arrayOperator: 'any'/,
    owners: ['src/lens.ts'],
  },
  { verb: 'project rows through a lens', pattern: /\bprojectRows\(/, owners: ['src/lens.ts'] },
];

describe('one implementation per lens verb', () => {
  for (const { verb, pattern, owners } of RULES)
    test(verb, () => {
      const outside = SOURCES.filter((s) => !owners.includes(s.file) && pattern.test(s.code));
      expect(outside.map((s) => s.file)).toEqual([]);
    });
});

describe('the lens API', () => {
  const documented = [...doc.matchAll(/^\| [^|]+ \| `(\w+)` \|/gm)].map(([, name]) => name);

  test('every function src/lens.ts exports is in the verb catalog', () => {
    expect(functionsOf(lens).filter((name) => !documented.includes(name))).toEqual([]);
  });

  test('every exported function that takes or returns a lens is in the verb catalog', () => {
    expect(lensSignatures.length).toBeGreaterThan(0);
    expect(lensSignatures.filter((name) => !documented.includes(name))).toEqual([]);
  });

  test('every relayed-operation function is in the verb catalog', () => {
    const relay = functionsOf(api).filter((name) =>
      /^(relayedOperation|operation(Request|Response))/.test(name),
    );
    expect(relay.length).toBeGreaterThan(0);
    expect(relay.filter((name) => !documented.includes(name))).toEqual([]);
  });

  test('every name in the catalog is an exported function', () => {
    const exported = functionsOf(api);
    expect(documented.filter((name) => !exported.includes(name))).toEqual([]);
  });
});
