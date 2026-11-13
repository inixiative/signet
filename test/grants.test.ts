import { describe, expect, it, test } from 'bun:test';
import type { ModelNarrowing, StoredLens } from '@inixiative/json-rules';
import {
  archiveGrantRefusal,
  archiveLensRefusal,
  archiveOperationSchema,
  baseLensId,
  conditionAtOperation,
  githubOperationSchema,
  grantResourceSchema,
  grantTermsFitKind,
  grantTermsSchema,
  type LensLayer,
  narrowingAtOperation,
  narrowsThreadsTerms,
  operationRecord,
  operationRows,
  projectionVisit,
  registeredResourceSchema,
  repositoryCallRow,
  repositoryGrantRefusal,
  repositoryLensRefusal,
  requestedResourceSchema,
  type StoredLensLayer,
  signetGrantSchema,
  signetProposalSchema,
  signetResourceSchema,
  storedLensLayerSchema,
  threadRow,
  threadsResourceKind,
  threadsTerms,
  threadsTermsSchema,
} from '../src';
import { everyBranch, grantLensOver, operationsLens, rowLayer } from './operationsLens';

const uuid = () => Bun.randomUUIDv7();
const integrationResourceId = uuid();
const projectId = uuid();

const commitPin = { where: { field: 'sha', operator: 'equals' as const, value: 'a'.repeat(40) } };
/** The request layer over a GitHub repository's operations lens: a pinned commit. */
const pinned: StoredLensLayer = {
  id: 'request',
  parents: ['github:repository'],
  root: { relations: { commits: { relations: { read: {} } } } },
  mapDefaults: { operations: { models: { RepositoryCall: commitPin } } },
};
/** The approver's layer under it: it hides a field, it filters nothing. */
const trimmed: StoredLensLayer = {
  id: 'approval',
  parents: ['github:repository', 'request'],
  mapDefaults: { operations: { models: { RepositoryCall: { omits: ['message'] } } } },
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
      where: { field: 'objectId', operator: 'equals', value: 'a'.repeat(40) },
      lens: {
        root: pinned.root,
        mapDefaults: { operations: { models: { RepositoryCall: commitPin } } },
      },
    });
    expect(asked).toMatchObject({
      operations: { picks: ['commits.*'] },
      where: { field: 'objectId' },
    });
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

  test('by kind on a named integration, when the asker does not know the id', () => {
    const byKind = {
      resourceKind: threadsResourceKind,
      operations: { picks: ['thread.read', 'thread.prompt'] },
      terms: { threads: { delivery: 'turn' } },
    };
    const integrationId = Bun.randomUUIDv7();
    const asked = requestedResourceSchema.parse({ ...byKind, integrationId });
    expect(asked).toMatchObject({
      resourceKind: 'threads',
      integrationId,
      operations: { picks: ['thread.read', 'thread.prompt'] },
    });
    expect(requestedResourceSchema.safeParse(byKind).success).toBe(false);
  });

  test('an installation registering asks by kind alone: its integration does not exist yet', () => {
    const byKind = {
      resourceKind: 'archiveLibrary',
      operations: { picks: ['sessions.write'] },
    };
    expect(registeredResourceSchema.parse(byKind)).toMatchObject(byKind);
    expect(
      registeredResourceSchema.safeParse({ ...byKind, integrationId: Bun.randomUUIDv7() }).success,
    ).toBe(false);
  });
});

describe('the grant as a holder reads it', () => {
  test('carries the resource kind and the integration the resource is on', () => {
    const integrationId = Bun.randomUUIDv7();
    const row = {
      resourceModel: 'IntegrationResource',
      integrationResourceId,
      kind: 'repository',
      full: true,
    };
    const grant = signetGrantSchema.parse({ ...row, integrationId });
    expect(grant).toMatchObject({ kind: 'repository', integrationId, full: true });
    expect(signetGrantSchema.safeParse(row).success).toBe(false);
    expect(signetGrantSchema.parse({ resourceModel: 'Project', projectId })).toEqual({
      resourceModel: 'Project',
      projectId,
    });
    expect(
      signetGrantSchema.safeParse({
        resourceModel: 'IntegrationResource',
        integrationResourceId,
        kind: 'repository',
        integrationId: Bun.randomUUIDv7(),
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

/** A real operations lens per kind, and a grant's `GrantLens` composed over it as Kingdom would. */
const document = { kind: 'scalar', type: 'String' } as const;
const archiveOperations = archiveOperationSchema.options;
const archiveBase = operationsLens(archiveOperations, 'ArchiveDocument', {
  id: document,
  title: document,
  content: document,
});
const githubOperations = githubOperationSchema.options;
const repositoryBase = operationsLens(githubOperations, 'RepositoryCall', {
  sha: document,
  message: document,
});

describe("refusals that stay about operations, read at each operation's branch", () => {
  const archive = (...layers: LensLayer[]) => grantLensOver(archiveBase, archiveOperations, layers);
  const documents = (narrowing: ModelNarrowing) =>
    rowLayer(archiveOperations, 'ArchiveDocument', narrowing);
  const onlyChosen = documents({ where: { field: 'id', operator: 'in', value: ['x'] } });

  test('writing or deleting Archive sessions takes no lens', () => {
    expect(archiveLensRefusal('sessions.write', archive())).toBeNull();
    expect(archiveLensRefusal('sessions.write', archive(documents({ omits: ['title'] })))).toBe(
      'Writing or deleting sessions takes no lens',
    );
  });

  test('Archive search needs content over every document', () => {
    expect(archiveLensRefusal('documents.search', archive())).toBeNull();
    expect(
      archiveLensRefusal('documents.search', archive(documents({ picks: ['content', 'title'] }))),
    ).toBeNull();
    expect(archiveLensRefusal('documents.search', archive(onlyChosen))).not.toBeNull();
    expect(
      archiveLensRefusal('documents.search', archive(documents({ picks: ['title'] }))),
    ).not.toBeNull();
    expect(
      archiveLensRefusal('documents.search', archive(documents({ omits: ['content'] }))),
    ).not.toBeNull();
    expect(archiveLensRefusal('documents.read', archive(onlyChosen))).toBeNull();
  });

  test('a narrowing of one branch leaves the others as they are; a branch left off is held back', () => {
    const readChosen = {
      root: {
        ...everyBranch(archiveOperations),
        relations: {
          ...everyBranch(archiveOperations).relations,
          documents: {
            relations: {
              read: { where: { field: 'id', operator: 'in', value: ['x'] } },
              search: {},
            },
          },
        },
      },
    } as LensLayer;
    expect(archiveLensRefusal('documents.search', archive(readChosen))).toBeNull();
    const readOnly = { root: narrowingAtOperation('documents.read', {}) } as LensLayer;
    expect(archiveLensRefusal('documents.search', archive(readOnly))).not.toBeNull();
    expect(projectionVisit(archive(readOnly).projection, 'documents.search')).toBeNull();
    expect(projectionVisit(archive(readOnly).projection, 'documents.read')?.model).toBe(
      'ArchiveDocument',
    );
  });

  test('a grant row is refused over every operation it reaches, full meaning all of them', () => {
    expect(
      archiveGrantRefusal({ full: false, operations: ['documents.read'] }, archive(onlyChosen)),
    ).toBeNull();
    expect(archiveGrantRefusal({ full: true }, archive(onlyChosen))).toBe(
      'Search needs a lens that shows content and is not limited to chosen documents',
    );
    expect(archiveGrantRefusal({ full: true }, archive())).toBeNull();
  });

  const repository = (...layers: LensLayer[]) =>
    grantLensOver(repositoryBase, githubOperations, layers);
  const commits = (narrowing: ModelNarrowing) =>
    rowLayer(githubOperations, 'RepositoryCall', narrowing);
  const pinnedLayer = commits({
    where: { field: 'sha', operator: 'equals', value: 'a'.repeat(40) },
  });

  test('a repository grant pinned to commits reads only commits', () => {
    expect(repositoryLensRefusal('commits.read', repository(pinnedLayer))).toBeNull();
    expect(repositoryLensRefusal('trees.read', repository())).toBeNull();
    expect(
      repositoryLensRefusal('trees.read', repository(commits({ omits: ['message'] }))),
    ).toBeNull();
    expect(repositoryLensRefusal('blobs.read', repository(pinnedLayer))).toBe(
      'A grant pinned to commits reads only those commits; trees and blobs need an unpinned grant',
    );
    expect(
      repositoryGrantRefusal(
        { full: false, operations: ['commits.read'] },
        repository(pinnedLayer),
      ),
    ).toBeNull();
    expect(repositoryGrantRefusal({ full: true }, repository(pinnedLayer))).not.toBeNull();
    expect(repositoryCallRow({ objectId: 'a'.repeat(40) })).toEqual({ sha: 'a'.repeat(40) });
  });
});

test("rows sit at their operation's branch of the record a lens reads", () => {
  const rows = [threadRow('thread_1')];
  expect(operationRecord('thread.read', rows)).toEqual({ thread: { read: rows } });
  expect(operationRows(operationRecord('thread.read', rows), 'thread.read')).toEqual(rows);
  expect(operationRows({ thread: {} }, 'thread.read')).toEqual([]);
  expect(
    conditionAtOperation('documents.read', { field: 'id', operator: 'equals', value: 'x' }),
  ).toEqual({
    field: 'documents.read',
    arrayOperator: 'any',
    condition: { field: 'id', operator: 'equals', value: 'x' },
  });
});

test('the base lens id and the rows a where is evaluated over', () => {
  expect(baseLensId('github', 'repository')).toBe('github:repository');
  expect(threadRow('thread_1')).toEqual({ id: 'thread_1' });
  expect(() => threadRow('a:b')).toThrow();
});

describe('a resource ask carries an incoming where, and a request names its owner', () => {
  it('a where rides beside the lens on a resource ask', () => {
    const ask = signetResourceSchema.parse({
      resourceModel: 'IntegrationResource',
      integrationResourceId: Bun.randomUUIDv7(),
      operations: { picks: ['messages.read'] },
      where: { field: 'query', operator: 'startsWith', value: 'release' },
    });
    expect(ask.resourceModel === 'IntegrationResource' && ask.where).toEqual({
      field: 'query',
      operator: 'startsWith',
      value: 'release',
    });
  });

  it('a request may name the owner it asks', () => {
    const owner = {
      ownerModel: 'User' as const,
      userId: Bun.randomUUIDv7(),
      organizationId: null,
      spaceId: null,
    };
    const proposal = signetProposalSchema.parse({
      name: 'Release notes',
      lifecycle: 'ongoing',
      expiresAt: null,
      maxRequests: null,
      owner,
      resources: [
        {
          resourceModel: 'IntegrationResource',
          integrationResourceId: Bun.randomUUIDv7(),
          operations: { full: true },
        },
      ],
    });
    expect(proposal.owner).toEqual(owner);
  });
});
