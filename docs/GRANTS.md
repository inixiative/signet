# Grants

What a Signet holds, how operations are picked, and how a lens and a `where` narrow it. Every lens function, its verb and the json-rules verb it wraps are in [VERBS.md](VERBS.md).

## Grant rows

A Signet revision is a list of grant rows (`grantResourceSchema`). Each row is false-polymorphic on `resourceModel`:

| `resourceModel` | Names | Carries |
| --- | --- | --- |
| `IntegrationResource` | one resource | `full` or `operations` (the resolved leaves; absent when `full`), one `lens`, optional `where` |
| `Integration` | a scope: every resource of `kind` on the integration, now and later, or only those in `projectId` | the same `full` / `operations` / `lens` / `where`, applied to each resource it reaches |
| `Project` | a Kingdom Project the Signet may be used in | nothing else: no `full`, operations or lens |

- **`full`** reaches everything the resource offers, now and as its catalog grows, capped live by the integration's baseline. It is a different axis from `Integration.full` and `Token.full`, which let a delegate act with its owner's whole authority.
- **Scope rows are real.** A row may name one conversation, a project's conversations, or a whole integration. Code that reads a grant must not assume a row names one resource; which resources a row reaches is Kingdom's to answer.
- **Two kinds of project.** An `Integration` row's `projectId` narrows which resources that row reaches. A `Project` row says where the Signet may be used. They are unrelated.

## Asking for a grant

| Who asks | Schema | Names resources by |
| --- | --- | --- |
| A party asking for a Signet | `signetResourceSchema` | a resource by id, an `Integration` scope (`integrationId`, `resourceKind`, optional `projectId`), or a `Project` |
| A party asking for a Signet or a change | `requestedResourceSchema` | id, or kind on the integration it names with `integrationId` |
| An Installation registering | `registeredResourceSchema` | id, or kind alone (the integration it will become does not exist yet) |

By kind, `externalId` names one resource of that kind (a conversation's thread id). Without it, the ask reaches every resource of that kind on the integration.

Every resource ask carries operation picks and its own lens narrowing. An ask says `resourceKind`; a stored row says `kind`.

**Naming an owner.** A request may name the one owner it asks (`namedOwnerSchema`): the ids its model is keyed by (`ownerIdFields`), with every other id among `userId`, `organizationId`, `spaceId` and `integrationId` present and null. A Signet's owner is one of the five owner models or an Integration in its own right (`signetOwnerModelSchema`, keyed by `integrationId` alone). The owner a holder reads back on a collected or held Signet (`ownerRefSchema`) is one of the five.

## What a holder reads

`describe` and the installation snapshot read each resource on its own: one this package can't read is dropped and listed in `dropped`, and the Signet is kept. The snapshot's held Signets carry their `resources`.

`signetGrantSchema` is the stored row plus the resource's `kind`, its `integrationId`, and, where the holder acts by it, its `externalId`. A call names that integration: `execute({ integrationId, … })`.

## Operation picks

A provider's catalog is a flat list of dotted leaf keys per resource kind (`commits.read`, `events.pull_request.review_requested`). A party asks with `operationPickSchema`: `{ full: true }` or `{ picks }`.

| Function | Does |
| --- | --- |
| `pickCovers(pick, leaf)` | The one rule for what a pick takes. A pick ending `.*` takes every leaf under its prefix; any other pick takes exactly that leaf. A branch is always written with `.*`. |
| `resolveOperationPicks(leaves, pick)` | Resolves picks to leaves once, when the grant is saved. A pick that reaches nothing throws `OperationPickError` (code `unknown_operation_pick`). A later catalog addition therefore reaches only `full` rows. |
| `operationTree(leaves)` | The nested tree a grant UI offers, each node with the pick that takes it. |
| `narrowsOperations(inner, outer)` | Whether `inner` is within `outer`. A full `outer` contains everything; a full `inner` under a non-full `outer` never narrows it. |
| `permitsOperation(scope, operation)` | Whether a scope allows one operation. |
| `validateOperationsInScope(scope, catalog, validateOperation)` | Runs a per-operation check over every catalog operation a row reaches and joins the errors into one json-rules `ValidationResult`. For a `full` row that is every operation, so re-run it when the catalog grows. |

## Lens: what comes back

A row's lens is one json-rules narrowing (`lensNarrowingSchema`: `{ root?, mapDefaults? }`, nothing else) over the resource kind's **operations lens**.

**The operations lens.** Kingdom creates it from the kind's catalog with `createOperationsLens({ model, operations, rowModel, rowModels })`. Each dotted segment of an operation is a relation, nested like a Prisma map, and each operation is a list of the rows it reads (`ArchiveDocument`, `Thread`, `RepositoryCall`, `IntegrationEvent`). Nothing on the wire carries this base; a host that needs it creates it with `createOperationsLens`.

**Operations are not the lens's job.** Which operations a grant holds is its actions alone. Every operation's branch is on before the first lens, and a lens that would turn one off (by omitting it) is refused. A lens only filters rows and trims fields within a branch:

- on every branch at once, for one row model, with `mapDefaults`: `narrowRowModelOnEveryBranch(operations, row, narrowing)`. A `where` filters rows; picks and omits trim the shape.
- on one branch, through `root.relations`: `narrowOperationBranch(operation, narrowing)`.

**Chains.** A row stores only its own lens. A re-delegated row does not copy the lens above it; the reader composes the chain, upstream first:

```ts
const { lens, narrowed } = composeGrantLensChain(base, chain); // a GrantLens
const visible = projectOperationRows(lens, 'documents.read', rows);
```

- An absent lens (null or undefined), `{}` and `{ root: { relations: {} } }` add nothing. A chain whose lenses are all null or undefined reads every branch with `narrowed: false`; `{}` and the empty-relations form still count as a narrowing (`narrowed: true`).
- json-rules validates each lens against the ones above it, so a later lens can only narrow.
- A chain longer than `grantLensChainLimit` (20) is refused.
- `GrantLensError` is thrown when a lens doesn't parse or the chain doesn't compose.

Kingdom and a host both use `composeGrantLensChain` and `projectOperationRows`.

**Where a lens `where` goes.** A row filter belongs at the operation's own branch. One above it (on the root, or on a branch holding several operations) applies to the whole list, so it would show every row once one matched; `composeGrantLensChain` refuses it. A lens `where` may use negated operators, because it shapes what comes back and decides no permission.

**Reading at a branch.**

| Function | Does |
| --- | --- |
| `nestRowsAtOperation(operation, rows)` | Nests rows at the operation's branch, for `projectRows`. |
| `readRowsAtOperation(record, operation)` | Reads them back. |
| `describeWhetherLensFiltersOperationRows(grant.lens, operation)` | Whether any of the operation's rows is held back. |
| json-rules `lensVisit(grant.lens, operation)` | The visit at the branch. |
| json-rules `walkLensPath(grant.lens, `${operation}.${field}`)` | Whether a field is shown. |
| `repositoryCallRow(input)`, `threadRow(threadId)` | The row a repository call (`{ sha }`) or a conversation's thread (`{ id }`) reads. |
| `conditionOverOperationRows(operation, condition)` | Re-roots a call's own filter as a rule for json-rules `validateRuleInLens`. It is never a lens `where`. |

A `GrantLens` describes one row's chain. What a holder reaches in the end is Kingdom's to work out; nothing here names another Signet, a budget or a path.

## Where: what may be asked

A row's `where` (`grantWhereSchema`) is the incoming side: a positive json-rules condition over the call's input fields (such as `objectId`), which Kingdom checks before the call runs. The lens is the outgoing side.

This package refuses a `where` that is:

- empty or malformed;
- an `all` or `any` that is empty or lists a bare `true` or `false`, at any depth;
- not positive (json-rules `validateRule(where, { positive: true })`): no negated operator, since a `where` decides permission;
- longer than `grantWhereLimit` (16,000) characters as JSON.

`equals null` is json-rules' "no value" form and is accepted: it admits a call that leaves the field out.

A grant view carries the row's `where` whole (`storedWhereSchema`), whatever its size, so a holder never loses its own row over it. Checking it is Kingdom's job at admission; a holder never gates on it.

**Example.** A grant that pins commits sends both sides: `objectId in […]` as its `where`, and the same ids as its lens pin over `RepositoryCall.sha`.
