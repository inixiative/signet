import { describe, expect, it, test } from 'bun:test';
import { type Condition, type ModelNarrowing, projectLens } from '@inixiative/json-rules';
import {
  archiveGrantRefusal,
  archiveLensRefusal,
  archiveOperationSchema,
  composeGrantLens,
  conditionAtOperation,
  conversationActLevel,
  conversationPermissionSchema,
  conversationResourceKind,
  type DroppedEntry,
  declaredOperationSchema,
  everyBranch,
  GrantLensError,
  operationsLens as generateOperationsLens,
  githubOperationSchema,
  grantLensChainLimit,
  grantResourceSchema,
  grantWhereLimit,
  grantWhereSchema,
  type LensBody,
  lensNarrowingSchema,
  narrowingAtOperation,
  narrowsOperations,
  operationRecord,
  operationRows,
  operationsMapName,
  ownerIdFields,
  parseInstallationSignets,
  projectionFilters,
  projectionVisit,
  registeredResourceSchema,
  repositoryCallRow,
  repositoryGrantRefusal,
  repositoryLensRefusal,
  requestedResourceSchema,
  resolveOperationPicks,
  rowModelNarrowing,
  rowsThroughLens,
  signetGrantSchema,
  signetOwnerModelSchema,
  signetProposalSchema,
  signetResourceSchema,
  threadOperationSchema,
  threadRow,
} from '../src';
import { operationsLens } from './operationsLens';

const uuid = () => Bun.randomUUIDv7();
const integrationResourceId = uuid();
const projectId = uuid();

const commitPin = { where: { field: 'sha', operator: 'equals' as const, value: 'a'.repeat(40) } };
/** A narrowing of a GitHub repository's operations lens: a pinned commit. */
const pinned: LensBody = {
  root: { relations: { commits: { relations: { read: {} } } } },
  mapDefaults: { operations: { models: { RepositoryCall: commitPin } } },
};
/** A re-delegated row's narrowing under it: it hides a field, it filters nothing. */
const trimmed: LensBody = {
  mapDefaults: { operations: { models: { RepositoryCall: { omits: ['message'] } } } },
};

describe('the grant resource contract', () => {
  test('an IntegrationResource row: full, or resolved leaves', () => {
    const row = {
      resourceModel: 'IntegrationResource',
      integrationResourceId,
      full: false,
      operations: ['commits.read'],
      lens: pinned,
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

  test('a Project row is the project alone: no full, operations or lens', () => {
    const project = { resourceModel: 'Project', projectId } as const;
    expect(grantResourceSchema.parse(project)).toEqual(project);
    for (const extra of [
      { full: true },
      { full: false },
      { operations: ['commits.read'] },
      { lens: [pinned] },
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

  test("a row's lens is one narrowing: no layers, ids, parents, base or any other key", () => {
    expect(lensNarrowingSchema.parse(pinned)).toEqual(pinned);
    const row = {
      resourceModel: 'IntegrationResource',
      integrationResourceId,
      full: false,
      operations: ['commits.read'],
    } as const;
    for (const lens of [
      { layers: [pinned] },
      [pinned],
      { ...pinned, id: 'request' },
      { ...pinned, parents: ['github:repository'] },
      { ...pinned, parent: {} },
      { ...pinned, model: 'Repository' },
      { ...pinned, terms: {} },
    ]) {
      expect(lensNarrowingSchema.safeParse(lens).success).toBe(false);
      expect(grantResourceSchema.safeParse({ ...row, lens }).success).toBe(false);
    }
  });

  test('round-trips through JSON, as a revision row is stored and read back', () => {
    const row = grantResourceSchema.parse({
      resourceModel: 'IntegrationResource',
      integrationResourceId,
      full: false,
      operations: ['thread.read', 'thread.prompt'],
      lens: pinned,
    });
    expect(grantResourceSchema.parse(JSON.parse(JSON.stringify(row)))).toEqual(row);
  });
});

describe('what a party asks for', () => {
  test('by id: picks or full, with an optional narrowing and where', () => {
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
    // An ask's lens is one narrowing too, never a list of layers.
    expect(
      signetResourceSchema.safeParse({
        resourceModel: 'IntegrationResource',
        integrationResourceId,
        operations: { full: true },
        lens: { layers: [pinned] },
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
      resourceKind: conversationResourceKind,
      externalId: 'thread_a',
      operations: { picks: ['thread.read', 'thread.prompt', 'member.wake'] },
    };
    const integrationId = Bun.randomUUIDv7();
    const asked = requestedResourceSchema.parse({ ...byKind, integrationId });
    expect(asked).toMatchObject({
      resourceKind: 'conversation',
      externalId: 'thread_a',
      integrationId,
      operations: { picks: ['thread.read', 'thread.prompt', 'member.wake'] },
    });
    expect(requestedResourceSchema.safeParse(byKind).success).toBe(false);
    // A conversation is asked for one at a time: no thread id would reach every conversation.
    const { externalId: _thread, ...everyConversation } = byKind;
    expect(requestedResourceSchema.safeParse({ ...everyConversation, integrationId }).success).toBe(
      false,
    );
    expect(
      requestedResourceSchema.safeParse({ ...byKind, integrationId, externalId: 'a:b' }).success,
    ).toBe(false);
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
      externalId: 'inixiative/signet',
      full: true,
    };
    const grant = signetGrantSchema.parse({ ...row, integrationId });
    expect(grant).toMatchObject({
      kind: 'repository',
      externalId: 'inixiative/signet',
      integrationId,
      full: true,
    });
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
        externalId: 'inixiative/signet',
        integrationId: Bun.randomUUIDv7(),
        full: true,
        operations: ['commits.read'],
      }).success,
    ).toBe(false);
  });
});

describe('a row over a scope', () => {
  const integrationId = Bun.randomUUIDv7();
  const scope = {
    resourceModel: 'Integration',
    integrationId,
    kind: 'conversation',
    full: false,
    operations: ['thread.read', 'prompt.resolve', 'member.log'],
  } as const;

  test('names every resource of a kind on an integration, or only a project of them', () => {
    expect(grantResourceSchema.parse(scope)).toEqual(scope as never);
    const inProject = { ...scope, projectId };
    expect(grantResourceSchema.parse(inProject)).toEqual(inProject as never);
    expect(signetGrantSchema.parse(inProject)).toMatchObject({ kind: 'conversation', projectId });
    expect(grantResourceSchema.safeParse({ ...scope, kind: undefined }).success).toBe(false);
    expect(grantResourceSchema.safeParse({ ...scope, integrationResourceId }).success).toBe(false);
    expect(grantResourceSchema.safeParse({ ...scope, full: true }).success).toBe(false);
  });

  test('is asked for with picks, a lens and a where, like one resource', () => {
    const ask = {
      resourceModel: 'Integration',
      integrationId,
      resourceKind: 'conversation',
      operations: { picks: ['thread.*', 'member.log'] },
    };
    expect(signetResourceSchema.parse(ask)).toEqual(ask as never);
    expect(signetResourceSchema.parse({ ...ask, projectId })).toMatchObject({ projectId });
    expect(signetResourceSchema.safeParse({ ...ask, resourceKind: undefined }).success).toBe(false);
    expect(signetResourceSchema.safeParse({ ...ask, externalId: 'thread_a' }).success).toBe(false);
  });
});

describe('conversation permissions', () => {
  const held = (...permissions: string[]) =>
    conversationPermissionSchema.array().parse(permissions);

  test('are catalog entries nothing calls: none is a declared operation', () => {
    for (const permission of conversationPermissionSchema.options)
      expect(declaredOperationSchema.safeParse(permission).success).toBe(false);
    expect(conversationPermissionSchema.safeParse('thread.read').success).toBe(false);
    expect(conversationPermissionSchema.safeParse('agent.write').success).toBe(false);
  });

  test('are picked and narrowed like any operation', () => {
    const leaves = [...threadOperationSchema.options, ...conversationPermissionSchema.options];
    const asked = resolveOperationPicks(leaves, { picks: ['thread.read', 'thread.prompt'] });
    const wider = resolveOperationPicks(leaves, {
      picks: ['thread.read', 'thread.prompt', 'member.take'],
    });
    expect(narrowsOperations(asked, wider)).toBe(true);
    expect(narrowsOperations(wider, asked)).toBe(false);
    expect(resolveOperationPicks(leaves, { picks: ['thread.*'] })).toEqual({
      full: false,
      operations: ['thread.read', 'thread.prompt', 'thread.floor'],
    });
    expect(resolveOperationPicks(leaves, { picks: ['agent.*'] })).toEqual({
      full: false,
      operations: ['agent.instruct', 'agent.read', 'agent.act'],
    });
  });

  test('the act level is the highest held', () => {
    expect(conversationActLevel(held())).toBe('ask');
    expect(conversationActLevel(held('agent.instruct', 'member.wake'))).toBe('ask');
    expect(conversationActLevel(held('agent.read'))).toBe('read');
    expect(conversationActLevel(held('agent.act'))).toBe('full');
    expect(conversationActLevel(held('agent.read', 'agent.act'))).toBe('full');
  });
});

/** A real operations lens per kind, and a grant's `GrantLens` composed over it as Kingdom would. */
const document = { kind: 'scalar', type: 'String' } as const;
const archiveOperations = archiveOperationSchema.options;
const archiveBase = operationsLens(archiveOperations, 'ArchiveDocument', {
  id: document,
  projectId: document,
  title: document,
  content: document,
});
const githubOperations = githubOperationSchema.options;
const repositoryBase = operationsLens(githubOperations, 'RepositoryCall', {
  sha: document,
  message: document,
});

describe("refusals that stay about operations, read at each operation's branch", () => {
  const archive = (...chain: LensBody[]) => composeGrantLens(archiveBase, chain);
  const documents = (narrowing: ModelNarrowing) =>
    rowModelNarrowing(archiveOperations, 'ArchiveDocument', narrowing);
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
    expect(projectionFilters(archive(onlyChosen).projection, 'documents.search')).toBe(true);
    expect(projectionFilters(archive(documents({})).projection, 'documents.search')).toBe(false);
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
    } as LensBody;
    expect(archiveLensRefusal('documents.search', archive(readChosen))).toBeNull();
    const readOnly = { root: narrowingAtOperation('documents.read', {}) } as LensBody;
    expect(archiveLensRefusal('documents.search', archive(readOnly))).not.toBeNull();
    expect(projectionVisit(archive(readOnly).projection, 'documents.search')).toBeNull();
    expect(projectionVisit(archive(readOnly).projection, 'documents.read')?.model).toBe(
      'ArchiveDocument',
    );
  });

  const projects = operationsLens(['documents.read', 'documents.search'], 'ArchiveDocument', {
    id: document,
    projectId: document,
  });
  const inP1 = { field: 'projectId', operator: 'equals', value: 'p1' } as Condition;
  const rows = [
    { id: 'a', projectId: 'p1' },
    { id: 'b', projectId: 'p2' },
  ];
  const read = (body: LensBody, operation: string) => {
    return rowsThroughLens({ parent: projects, ...body }, operation, rows);
  };

  test("a where at an operation's own branch filters its rows and leaves other branches alone", () => {
    const atLeaf = {
      root: everyBranch(['documents.read', 'documents.search'], (operation) =>
        operation === 'documents.read' ? { where: inP1 } : {},
      ),
    } as LensBody;
    expect(read(atLeaf, 'documents.read')).toEqual([{ id: 'a', projectId: 'p1' }]);
    expect(read(atLeaf, 'documents.search')).toEqual(rows);
    const lens = composeGrantLens(projects, [atLeaf]);
    expect(archiveLensRefusal('documents.read', lens)).toBeNull();
  });

  test('a where above a branch would show every row once one matched, so it is refused', () => {
    const aboveBranch = {
      root: {
        ...everyBranch(['documents.read', 'documents.search']),
        where: conditionAtOperation('documents.read', inP1),
      },
    } as LensBody;
    // The leak the refusal is for: p2's document comes back beside p1's.
    expect(read(aboveBranch, 'documents.read')).toEqual(rows);
    const refusal = /never above it/;
    expect(() => composeGrantLens(projects, [aboveBranch])).toThrow(GrantLensError);
    expect(() => composeGrantLens(projects, [aboveBranch])).toThrow(refusal);
    const atDocuments = everyBranch(['documents.read', 'documents.search']);
    (atDocuments.relations?.documents as ModelNarrowing).where = conditionAtOperation(
      'search',
      inP1,
    );
    expect(() => composeGrantLens(projects, [{ root: atDocuments } as LensBody])).toThrow(refusal);
    const pinned = {
      root: {
        ...everyBranch(githubOperations),
        where: conditionAtOperation('commits.read', {
          field: 'sha',
          operator: 'equals',
          value: 'a'.repeat(40),
        }),
      },
    } as LensBody;
    expect(() => repository(pinned)).toThrow(refusal);
  });

  test('a chain composes each narrowing over the one above it; none reads every branch', () => {
    const readOnly = { root: everyBranch(['documents.read']) };
    const search = (chain: unknown[]) =>
      rowsThroughLens(composeGrantLens(projects, chain).lens, 'documents.search', rows);
    expect(composeGrantLens(projects, [readOnly, readOnly]).lens).toHaveProperty('parent');
    expect(search([])).toEqual(rows);
    expect(search([readOnly])).toEqual([]);
    expect(composeGrantLens(projects).narrowed).toBe(false);
    expect(composeGrantLens(projects, [readOnly]).narrowed).toBe(true);
    for (const stored of [
      [{ ...readOnly, id: 'request' }],
      [{ layers: [readOnly] }],
      ['whole'],
      [{ root: { relations: { nowhere: {} } } }],
    ])
      expect(() => composeGrantLens(projects, stored)).toThrow(GrantLensError);
  });

  test('an empty or absent narrowing adds nothing; every branch only when the whole chain is empty', () => {
    const readOnly = { root: everyBranch(['documents.read']) };
    const every = composeGrantLens(projects);
    for (const chain of [[null], [undefined, {}], [{ root: {} }, { mapDefaults: {} }]])
      expect(composeGrantLens(projects, chain)).toEqual(every);
    const alone = composeGrantLens(projects, [readOnly]);
    for (const chain of [
      [{}, readOnly],
      [readOnly, null],
      [undefined, readOnly, {}],
    ])
      expect(composeGrantLens(projects, chain)).toEqual(alone);
  });

  test('two narrowings compose as two stacked layers did on 0.18', () => {
    const chained = composeGrantLens(repositoryBase, [pinned, trimmed]);
    expect(chained.projection).toEqual(
      projectLens({ parent: { parent: repositoryBase, ...pinned }, ...trimmed }),
    );
    const read = projectionVisit(chained.projection, 'commits.read');
    expect(Object.keys(chained.projection)).toEqual([
      'Operations',
      'Operations.commits',
      'Operations.commits.read',
    ]);
    expect(Object.keys(read?.fields ?? {})).toEqual(['sha']);
    expect(read?.whereClauses).toEqual([commitPin.where]);
  });

  test("a later narrowing can't turn on a branch the one above it leaves off", () => {
    const commitsOnly = { root: narrowingAtOperation('commits.read', {}) };
    const trees = { root: narrowingAtOperation('trees.read', {}) };
    expect(composeGrantLens(repositoryBase, [trees]).narrowed).toBe(true);
    expect(() => composeGrantLens(repositoryBase, [commitsOnly, trees])).toThrow(GrantLensError);
  });

  test(`a chain composes at most ${grantLensChainLimit} narrowings`, () => {
    const readOnly = { root: everyBranch(['documents.read']) };
    const chain = (length: number) => Array.from({ length }, () => readOnly);
    expect(composeGrantLens(projects, chain(grantLensChainLimit)).narrowed).toBe(true);
    expect(() => composeGrantLens(projects, chain(grantLensChainLimit + 1))).toThrow(
      GrantLensError,
    );
    expect(() => composeGrantLens(projects, Array(grantLensChainLimit + 1).fill(null))).toThrow(
      GrantLensError,
    );
  });

  test('every branch is turned on once, each leaf with its own narrowing', () => {
    expect(everyBranch(['documents.read', 'documents.search', 'sessions.write'])).toEqual({
      relations: {
        documents: { relations: { read: {}, search: {} } },
        sessions: { relations: { write: {} } },
      },
    });
    expect(everyBranch(['thread.read'], () => ({ picks: ['id'] }))).toEqual({
      relations: { thread: { relations: { read: { picks: ['id'] } } } },
    });
  });

  test('an operations lens has a branch per operation; one that reads no rows has no leaf to turn on', () => {
    const operations = ['documents.read', 'sessions.delete'];
    const rowModel = (operation: string) =>
      operation === 'documents.read' ? 'ArchiveDocument' : undefined;
    const base = generateOperationsLens({
      model: 'ArchiveLibraryOperation',
      operations,
      rowModel,
      rowModels: { ArchiveDocument: { id: document } },
    });
    expect(base.model).toBe('ArchiveLibraryOperation');
    expect(base.maps[operationsMapName]?.models).toEqual({
      ArchiveLibraryOperation: {
        fields: {
          documents: expect.objectContaining({ type: 'ArchiveLibraryOperation_documents' }),
          sessions: expect.objectContaining({ type: 'ArchiveLibraryOperation_sessions' }),
        },
      },
      ArchiveLibraryOperation_documents: {
        fields: { read: expect.objectContaining({ type: 'ArchiveDocument', isList: true }) },
      },
      ArchiveLibraryOperation_sessions: {
        fields: { delete: { kind: 'scalar', type: 'Boolean', isRequired: false } },
      },
      ArchiveDocument: { fields: { id: document } },
    });
    const generate = (catalog: string[], row = 'ArchiveDocument') =>
      generateOperationsLens({
        model: 'Ops',
        operations: catalog,
        rowModel: () => row,
        rowModels: {},
      });
    // A catalog the tree can't hold apart is refused, never merged into operations nobody declared.
    expect(() => generate(['x_y.read', 'x.y.write'])).toThrow();
    expect(() => generate(['documents', 'documents.read'])).toThrow();
    expect(() => generate(['documents.read'], 'Ops_documents')).toThrow();
    const root = everyBranch(operations, (operation) => (rowModel(operation) ? {} : undefined));
    expect(root).toEqual({ relations: { documents: { relations: { read: {} } }, sessions: {} } });
    expect(rowsThroughLens({ parent: base, root }, 'documents.read', [{ id: 'a' }])).toEqual([
      { id: 'a' },
    ]);
    // A row with no narrowing reads exactly that root: every branch the base has.
    expect(composeGrantLens(base).lens).toEqual({ parent: base, root });
    expect(rowModelNarrowing(['documents.read'], 'ArchiveDocument', { picks: ['id'] })).toEqual({
      root: { relations: { documents: { relations: { read: {} } } } },
      mapDefaults: { operations: { models: { ArchiveDocument: { picks: ['id'] } } } },
    });
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

  const repository = (...chain: LensBody[]) => composeGrantLens(repositoryBase, chain);
  const commits = (narrowing: ModelNarrowing) =>
    rowModelNarrowing(githubOperations, 'RepositoryCall', narrowing);
  const pinnedCommit = commits({
    where: { field: 'sha', operator: 'equals', value: 'a'.repeat(40) },
  });

  test('a repository grant pinned to commits reads only commits', () => {
    expect(repositoryLensRefusal('commits.read', repository(pinnedCommit))).toBeNull();
    expect(repositoryLensRefusal('trees.read', repository())).toBeNull();
    expect(
      repositoryLensRefusal('trees.read', repository(commits({ omits: ['message'] }))),
    ).toBeNull();
    expect(repositoryLensRefusal('blobs.read', repository(pinnedCommit))).toBe(
      'A grant pinned to commits reads only those commits; trees and blobs need an unpinned grant',
    );
    expect(
      repositoryGrantRefusal(
        { full: false, operations: ['commits.read'] },
        repository(pinnedCommit),
      ),
    ).toBeNull();
    expect(repositoryGrantRefusal({ full: true }, repository(pinnedCommit))).not.toBeNull();
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

test('the rows a where is evaluated over', () => {
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
      integrationId: null,
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

describe('a where is a bounded, positive json-rules condition', () => {
  const asks = (where: unknown) =>
    signetResourceSchema.safeParse({
      resourceModel: 'IntegrationResource',
      integrationResourceId: Bun.randomUUIDv7(),
      operations: { picks: ['messages.read'] },
      where,
    }).success;

  it('refuses an empty object, junk, a negated rule and an oversized one', () => {
    expect(grantWhereSchema.safeParse({}).success).toBe(false);
    expect(grantWhereSchema.safeParse({ any: 'nope', field: 3 }).success).toBe(false);
    expect(
      grantWhereSchema.safeParse({ field: 'threadId', operator: 'notEquals', value: 'x' }).success,
    ).toBe(false);
    const huge = Object.fromEntries(
      Array.from({ length: 10_000 }, (_, index) => [`k${index}`, 'x'.repeat(100)]),
    );
    expect(grantWhereSchema.safeParse(huge).success).toBe(false);
    const longIn = { field: 'threadId', operator: 'in', value: ['x'.repeat(grantWhereLimit)] };
    expect(grantWhereSchema.safeParse(longIn).success).toBe(false);
    expect(asks({})).toBe(false);
  });

  it('refuses an empty all or any at any depth: one admits everything, the other nothing', () => {
    const rule = { field: 'threadId', operator: 'equals', value: 'main' };
    expect(asks({ all: [] })).toBe(false);
    expect(asks({ any: [] })).toBe(false);
    expect(asks({ all: [rule, { any: [] }] })).toBe(false);
    expect(asks({ any: [{ all: [rule, { all: [] }] }] })).toBe(false);
    expect(asks({ all: [true] })).toBe(false);
    expect(asks({ any: [true, rule] })).toBe(false);
    expect(asks({ all: [rule, { any: [false] }] })).toBe(false);
    expect(asks({ all: [rule, { any: [rule] }] })).toBe(true);
  });

  it('accepts a positive condition, nested ones included', () => {
    expect(asks({ field: 'threadId', operator: 'in', value: ['main'] })).toBe(true);
    expect(
      grantWhereSchema.safeParse({
        all: [
          { field: 'threadId', operator: 'equals', value: 'main' },
          { any: [{ field: 'query', operator: 'startsWith', value: 'release' }] },
        ],
      }).success,
    ).toBe(true);
  });
});

describe("a request's owner names exactly the ids its model needs", () => {
  const id = () => Bun.randomUUIDv7();
  const propose = (owner: unknown) =>
    signetProposalSchema.safeParse({
      name: 'n',
      lifecycle: 'ongoing',
      expiresAt: null,
      maxRequests: null,
      owner,
      resources: [
        {
          resourceModel: 'IntegrationResource',
          integrationResourceId: id(),
          operations: { full: true },
        },
      ],
    }).success;
  const owner = (
    ownerModel: string,
    ids: Partial<Record<'userId' | 'organizationId' | 'spaceId' | 'integrationId', string>>,
  ) => ({
    ownerModel,
    userId: null,
    organizationId: null,
    spaceId: null,
    integrationId: null,
    ...ids,
  });

  it('refuses an owner missing an id it needs, or carrying a key it does not know', () => {
    expect(propose(owner('User', {}))).toBe(false);
    expect(propose({ ...owner('User', { userId: id() }), extra: 1 })).toBe(false);
    expect(propose(owner('Organization', {}))).toBe(false);
    expect(propose(owner('Space', { spaceId: id() }))).toBe(false);
    expect(propose(owner('OrganizationUser', { organizationId: id() }))).toBe(false);
    expect(propose(owner('SpaceUser', { organizationId: id(), spaceId: id() }))).toBe(false);
    expect(propose(owner('User', { userId: id(), organizationId: id() }))).toBe(false);
    expect(propose(owner('Integration', {}))).toBe(false);
    expect(propose(owner('Integration', { integrationId: id(), userId: id() }))).toBe(false);
    expect(propose(owner('User', { userId: id(), integrationId: id() }))).toBe(false);
    expect(propose({ ownerModel: 'User', userId: id(), organizationId: null, spaceId: null })).toBe(
      false,
    );
  });

  it('accepts each owner model with its ids', () => {
    expect(propose(owner('User', { userId: id() }))).toBe(true);
    expect(propose(owner('Organization', { organizationId: id() }))).toBe(true);
    expect(propose(owner('Space', { organizationId: id(), spaceId: id() }))).toBe(true);
    expect(propose(owner('OrganizationUser', { organizationId: id(), userId: id() }))).toBe(true);
    expect(propose(owner('SpaceUser', { organizationId: id(), spaceId: id(), userId: id() }))).toBe(
      true,
    );
    expect(propose(owner('Integration', { integrationId: id() }))).toBe(true);
    expect(Object.keys(ownerIdFields).sort()).toEqual([...signetOwnerModelSchema.options].sort());
  });
});

describe('a grant view shows its incoming where', () => {
  it('a holder reads the where its grant admits calls by', () => {
    const where = { field: 'threadId', operator: 'equals', value: 'thread_a' };
    const view = signetGrantSchema.parse({
      resourceModel: 'IntegrationResource',
      integrationResourceId: Bun.randomUUIDv7(),
      integrationId: Bun.randomUUIDv7(),
      kind: 'conversation',
      externalId: 'thread_a',
      full: true,
      where,
    });
    expect(view.resourceModel === 'IntegrationResource' && view.where).toEqual(where);
  });

  it("a stored where past an ask's cap is read whole: the holder keeps its own row", () => {
    const where = {
      all: Array.from({ length: 400 }, (_, index) => ({
        field: `f${index}`,
        operator: 'equals',
        value: 'x'.repeat(30),
      })),
    };
    expect(JSON.stringify(where).length).toBeGreaterThan(grantWhereLimit);
    expect(grantWhereSchema.safeParse(where).success).toBe(false);
    const row = {
      resourceModel: 'IntegrationResource' as const,
      integrationResourceId: Bun.randomUUIDv7(),
      integrationId: Bun.randomUUIDv7(),
      kind: 'conversation',
      externalId: 'thread_a',
      full: true,
      where,
    };
    const dropped: DroppedEntry[] = [];
    const { signets } = parseInstallationSignets(
      {
        signets: [
          {
            signetId: Bun.randomUUIDv7(),
            name: 'held',
            enrollmentId: null,
            owner: {
              ownerModel: 'User',
              userId: Bun.randomUUIDv7(),
              organizationId: null,
              spaceId: null,
            },
            resources: [row],
          },
        ],
        hostedSignets: [],
      },
      dropped,
    );
    expect(dropped).toEqual([]);
    expect(signets[0]?.resources).toEqual([row]);
  });
});
