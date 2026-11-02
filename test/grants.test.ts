import { describe, expect, test } from 'bun:test';
import type { StoredLens } from '@inixiative/json-rules';
import {
  archiveLensRefusal,
  grantResourceSchema,
  grantTermsFitKind,
  grantTermsSchema,
  narrowsThreadsTerms,
  repositoryLensRefusal,
  requestedResourceSchema,
  type StoredLensLayer,
  signetGrantSchema,
  signetResourceSchema,
  storedLensLayerSchema,
  threadsResourceKind,
  threadsTerms,
  threadsTermsSchema,
} from '../src';

const uuid = () => crypto.randomUUID();
const integrationResourceId = uuid();
const projectId = uuid();

/** The request layer over a GitHub repository's base lens: a pinned commit. */
const pinned: StoredLensLayer = {
  id: 'request',
  parents: ['github:repository'],
  root: { where: { field: 'sha', operator: 'equals', value: 'a'.repeat(40) } },
};
/** The approver's layer under it: it hides a field, it filters nothing. */
const trimmed: StoredLensLayer = {
  id: 'approval',
  parents: ['github:repository', 'request'],
  root: { omits: ['message'] },
};

describe('the grant resource contract', () => {
  test('an IntegrationResource row: full, or resolved leaves', () => {
    const row = {
      resourceModel: 'IntegrationResource',
      integrationResourceId,
      full: false,
      operations: ['commits.read'],
      lens: [pinned, trimmed],
    };
    expect(grantResourceSchema.parse(row)).toEqual(row as never);
    expect(
      grantResourceSchema.parse({
        resourceModel: 'IntegrationResource',
        integrationResourceId,
        full: true,
      }),
    ).toEqual({ resourceModel: 'IntegrationResource', integrationResourceId, full: true });
  });

  test('a full row carries no operations, and a row that is not full carries some', () => {
    const base = { resourceModel: 'IntegrationResource', integrationResourceId } as const;
    expect(
      grantResourceSchema.safeParse({ ...base, full: true, operations: ['commits.read'] }).success,
    ).toBe(false);
    expect(grantResourceSchema.safeParse({ ...base, full: true, operations: [] }).success).toBe(
      false,
    );
    expect(grantResourceSchema.safeParse({ ...base, full: false }).success).toBe(false);
    expect(grantResourceSchema.safeParse({ ...base, full: false, operations: [] }).success).toBe(
      false,
    );
  });

  test('a Project row is the project alone: no full, operations, lens or terms', () => {
    const project = { resourceModel: 'Project', projectId } as const;
    expect(grantResourceSchema.parse(project)).toEqual(project);
    for (const extra of [
      { full: true },
      { full: false },
      { operations: ['commits.read'] },
      { lens: [pinned] },
      { terms: {} },
      { integrationResourceId },
    ])
      expect(grantResourceSchema.safeParse({ ...project, ...extra }).success).toBe(false);
  });

  test('exactly one id, the one its arm names', () => {
    expect(
      grantResourceSchema.safeParse({ resourceModel: 'IntegrationResource', projectId, full: true })
        .success,
    ).toBe(false);
    expect(
      grantResourceSchema.safeParse({
        resourceModel: 'IntegrationResource',
        integrationResourceId,
        projectId,
        full: true,
      }).success,
    ).toBe(false);
    expect(grantResourceSchema.safeParse({ resourceModel: 'Project' }).success).toBe(false);
    expect(
      grantResourceSchema.safeParse({ resourceModel: 'Tag', integrationResourceId, full: true })
        .success,
    ).toBe(false);
  });

  test('lens layers are json-rules StoredLens records, never a base', () => {
    const asStored: StoredLens[] = [pinned, trimmed];
    expect(asStored).toHaveLength(2);
    expect(storedLensLayerSchema.parse(pinned)).toEqual(pinned);
    expect(storedLensLayerSchema.safeParse({ ...pinned, parents: [] }).success).toBe(false);
    expect(
      storedLensLayerSchema.safeParse({
        id: 'github:repository',
        parents: [],
        maps: {},
        mapName: 'github',
        model: 'Repository',
      }).success,
    ).toBe(false);
    expect(storedLensLayerSchema.safeParse({ ...pinned, parent: {} }).success).toBe(false);
  });

  test('round-trips through JSON, as a revision row is stored and read back', () => {
    const row = grantResourceSchema.parse({
      resourceModel: 'IntegrationResource',
      integrationResourceId,
      full: false,
      operations: ['thread.read', 'thread.prompt'],
      lens: [pinned],
      terms: { threads: { delivery: 'turn' } },
    });
    expect(grantResourceSchema.parse(JSON.parse(JSON.stringify(row)))).toEqual(row);
    expect(row.resourceModel === 'IntegrationResource' && row.terms?.threads).toEqual({
      view: 'own',
      delivery: 'turn',
      outbound: 'review',
      floor: { mayTake: false },
    });
  });
});

describe('what a party asks for', () => {
  test('by id: picks or full, with an optional request layer and terms', () => {
    const asked = signetResourceSchema.parse({
      resourceModel: 'IntegrationResource',
      integrationResourceId,
      operations: { picks: ['commits.*'] },
      lens: { root: { where: { field: 'sha', operator: 'equals', value: 'a'.repeat(40) } } },
    });
    expect(asked).toMatchObject({ operations: { picks: ['commits.*'] } });
    expect(
      signetResourceSchema.parse({
        resourceModel: 'IntegrationResource',
        integrationResourceId,
        operations: { full: true },
      }),
    ).toEqual({
      resourceModel: 'IntegrationResource',
      integrationResourceId,
      operations: { full: true },
    });
    // The asker writes its own layer; ids and parents are Kingdom's to assign.
    expect(
      signetResourceSchema.safeParse({
        resourceModel: 'IntegrationResource',
        integrationResourceId,
        operations: { full: true },
        lens: pinned,
      }).success,
    ).toBe(false);
    // Resolved leaves are what Kingdom stores, not what a party asks with.
    expect(
      signetResourceSchema.safeParse({
        resourceModel: 'IntegrationResource',
        integrationResourceId,
        operations: ['commits.read'],
      }).success,
    ).toBe(false);
  });

  test('a project is asked for by id alone', () => {
    expect(signetResourceSchema.parse({ resourceModel: 'Project', projectId })).toEqual({
      resourceModel: 'Project',
      projectId,
    });
    expect(
      signetResourceSchema.safeParse({
        resourceModel: 'Project',
        projectId,
        operations: { full: true },
      }).success,
    ).toBe(false);
  });

  test('by kind, when the asker does not know the id', () => {
    const asked = requestedResourceSchema.parse({
      resourceKind: threadsResourceKind,
      operations: { picks: ['thread.read', 'thread.prompt'] },
      terms: { threads: { delivery: 'turn' } },
    });
    expect(asked).toMatchObject({
      resourceKind: 'threads',
      operations: { picks: ['thread.read', 'thread.prompt'] },
    });
  });
});

describe('the grant as a holder reads it', () => {
  test('carries the resource kind, and reads a row Kingdom stores', () => {
    const grant = signetGrantSchema.parse({
      resourceModel: 'IntegrationResource',
      integrationResourceId,
      kind: 'repository',
      full: true,
    });
    expect(grant).toMatchObject({ kind: 'repository', full: true });
    expect(signetGrantSchema.parse({ resourceModel: 'Project', projectId })).toEqual({
      resourceModel: 'Project',
      projectId,
    });
    expect(
      signetGrantSchema.safeParse({
        resourceModel: 'IntegrationResource',
        integrationResourceId,
        kind: 'repository',
        full: true,
        operations: ['commits.read'],
      }).success,
    ).toBe(false);
  });
});

describe('threads terms', () => {
  test('default to the narrowest value of every term', () => {
    const narrowest = {
      view: 'own',
      delivery: 'note',
      outbound: 'review',
      floor: { mayTake: false },
    };
    expect(threadsTermsSchema.parse({})).toEqual(narrowest as never);
    expect(threadsTerms(undefined)).toEqual(narrowest as never);
    expect(threadsTerms({})).toEqual(narrowest as never);
    expect(threadsTerms({ threads: { outbound: 'auto' } })).toEqual({
      ...narrowest,
      outbound: 'auto',
    } as never);
  });

  test('are strict: the thread selector is a lens filter now, not a term', () => {
    expect(threadsTermsSchema.safeParse({ threads: { form: 'ids', ids: ['t'] } }).success).toBe(
      false,
    );
    expect(grantTermsSchema.safeParse({ archive: {} }).success).toBe(false);
  });

  test('only a threads resource carries threads terms', () => {
    expect(grantTermsFitKind(threadsResourceKind, { threads: threadsTermsSchema.parse({}) })).toBe(
      true,
    );
    expect(grantTermsFitKind('repository', { threads: threadsTermsSchema.parse({}) })).toBe(false);
    expect(grantTermsFitKind('repository', undefined)).toBe(true);
    expect(grantTermsFitKind('repository', {})).toBe(true);
  });

  test('approving may only narrow each term', () => {
    const terms = (value: object) => threadsTermsSchema.parse(value);
    const asked = terms({ view: 'thread', delivery: 'turn' });
    expect(narrowsThreadsTerms(terms({}), asked)).toBe(true);
    expect(narrowsThreadsTerms(asked, asked)).toBe(true);
    expect(narrowsThreadsTerms(terms({ outbound: 'auto' }), asked)).toBe(false);
    expect(narrowsThreadsTerms(asked, terms({ view: 'thread' }))).toBe(false);
    expect(narrowsThreadsTerms(terms({ floor: { mayTake: true } }), asked)).toBe(false);
    const mayTake = terms({ floor: { mayTake: true } });
    expect(narrowsThreadsTerms(terms({}), mayTake)).toBe(true);
  });
});

describe('refusals that stay about operations', () => {
  const where = { root: { where: { field: 'id', operator: 'in', value: ['x'] } } };
  const layer = (part: object): StoredLensLayer => ({
    id: 'l',
    parents: ['archive:archiveLibrary'],
    ...part,
  });

  test('writing or deleting Archive sessions takes no lens', () => {
    expect(archiveLensRefusal('sessions.write', undefined)).toBeNull();
    expect(archiveLensRefusal('sessions.delete', [])).toBeNull();
    expect(archiveLensRefusal('sessions.write', [layer({ root: { omits: ['title'] } })])).toBe(
      'Writing or deleting sessions takes no lens',
    );
  });

  test('Archive search needs content over every document', () => {
    expect(archiveLensRefusal('documents.search', undefined)).toBeNull();
    expect(
      archiveLensRefusal('documents.search', [layer({ root: { picks: ['content', 'title'] } })]),
    ).toBeNull();
    expect(archiveLensRefusal('documents.search', [layer(where)])).not.toBeNull();
    expect(
      archiveLensRefusal('documents.search', [layer({ root: { picks: ['title'] } })]),
    ).not.toBeNull();
    expect(
      archiveLensRefusal('documents.search', [layer({ root: { omits: ['content'] } })]),
    ).not.toBeNull();
    expect(
      archiveLensRefusal('documents.search', [
        layer({ mapDefaults: { archive: { models: { Document: { where: true } } } } }),
      ]),
    ).not.toBeNull();
    expect(archiveLensRefusal('documents.read', [layer(where)])).toBeNull();
  });

  test('a repository grant pinned to commits reads only commits', () => {
    expect(repositoryLensRefusal('commits.read', [pinned])).toBeNull();
    expect(repositoryLensRefusal('trees.read', undefined)).toBeNull();
    expect(repositoryLensRefusal('trees.read', [trimmed])).toBeNull();
    expect(repositoryLensRefusal('blobs.read', [pinned])).toBe(
      'A grant pinned to commits reads only those commits; trees and blobs need an unpinned grant',
    );
  });
});
