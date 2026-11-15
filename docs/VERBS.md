# Verbs

Every operation signet performs has one verb, one public name per thing it applies to, and one
implementation. The verbs below json-rules' own are json-rules' (`json-rules/docs/VERBS.md`); signet
adds a verb only where json-rules has none for the job. `test/verbs.test.ts` enforces it: every
function `src/lens.ts` exports, and every exported function that takes or returns a lens, a
`GrantLens` or a `LensBody`, must appear here, and every name here must be exported.

This file covers the lens surface. The rest of the package is the next change.

## Lens: public API

| Verb | Name | json-rules verb it wraps | What it does |
| --- | --- | --- | --- |
| create | `createOperationsLens` | create (`createLens`) | Create a resource kind's operations lens from its catalog: one branch per dotted segment of each operation, each operation a list of the rows it reads. |
| turn on | `turnOnEveryOperationBranch` | — (new: builds a narrowing's `root`) | Turn every operation's branch on, as a narrowing's `root`, each leaf holding its own row narrowing. |
| narrow | `narrowOperationBranch` | narrow (a `ModelNarrowing` placed at a relation path) | Place a narrowing of one operation's rows at that operation's branch of the root. |
| narrow | `narrowRowModelOnEveryBranch` | narrow (`mapDefaults`) | Narrow one row model wherever it is read, with every operation's branch turned on. |
| narrow | `narrowToArchiveCallFields` | narrow | Turn the fields one Archive call asks for into a narrowing that picks them at the call's operation. |
| compose | `composeGrantLensChain` | compose (`composeLens`'s inner step, `assertValidNarrowing`) | Compose a grant row's lens chain, upstream first, over the operations lens, returning a `GrantLens`; refuse a `where` above an operation's branch. |
| project | `projectOperationRows` | project (`projectRows`) | Project one operation's rows through a lens: rows it filters out are gone, the rest trimmed. |
| nest | `nestRowsAtOperation` | — (new: the record `projectRows` reads) | Nest one operation's rows at its branch of the record an operations lens reads. |
| read | `readRowsAtOperation` | read (own properties only) | Read the rows at one operation's branch of a projected record. |
| re-root | `conditionOverOperationRows` | re-root (`prefixConditionFields` makes a dotted path the 4.0 gate refuses, so this wraps the condition in an `any` array rule) | Re-root a call's condition over an operation's rows onto the operations record, for `validateRuleInLens`. |
| re-root | `conditionOverArchiveCallFilters` | re-root | Turn what one Archive call filters on into a condition over its operation's rows, or undefined when it filters on nothing. |
| test | `lensFiltersOperationRows` | project (`lensVisit` at each path from the anchor) | Say whether a lens holds back any of an operation's rows: the branch off, or a `where` from the anchor down to it. |
| refuse | `refuseArchiveOperationLens` | walk (`walkLensPath`), project (`lensVisit`) | Return why an Archive grant of one operation can't carry its lens, or null when it can. |
| refuse | `refuseArchiveGrantLens` | — | `refuseArchiveOperationLens` over every operation a grant row reaches. |
| refuse | `refuseRepositoryOperationLens` | project (`lensVisit`) | Return why a repository grant of one operation can't carry its lens, or null when it can. |
| refuse | `refuseRepositoryGrantLens` | — | `refuseRepositoryOperationLens` over every operation a grant row reaches. |

Nouns: `LensBody` is a json-rules narrowing without its `parent` (json-rules names it only as
`Omit<LensNarrowing, 'parent'>`, "a layer's own part"); `lensNarrowingSchema` is its wire envelope;
`GrantLens` is `{ lens, narrowed }`; `grantLensChainLimit` is the most lenses a chain composes;
`operationsMapName` names the field map every operations lens is created under. `GrantLensError`
says a chain doesn't parse, is too long, doesn't compose, or filters above an operation's branch.

Read a visit, or whether a field is shown, with json-rules directly: `lensVisit(grant.lens,
operation)` and `walkLensPath(grant.lens, `${operation}.${field}`).outcome === 'resolved'`.

## Lens: internal verbs and their owners

| Verb | Owner | Rule (`test/verbs.test.ts`) |
| --- | --- | --- |
| split an operation into its branch segments | `src/lens.ts` (`branchOf`) | No `operation.split('.')` elsewhere. |
| build an array rule over an operation's rows | `src/lens.ts` (`conditionOverOperationRows`) | No `arrayOperator: 'any'` elsewhere. |
| project rows through a lens | `src/lens.ts` (`projectOperationRows`) | No `projectRows(` call elsewhere. |
