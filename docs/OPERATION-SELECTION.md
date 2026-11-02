# Operation selection: pick and omit over the operation tree

Coordinating doc for inixiative-bf (signet grant core, Kingdom grant table) and inixiative-ec (Archive, the first requester). Status: **draft; lens spike done (2026-11-02), differing rows are for Aron (see Log). No `src` code until he rules on them.**

## Why

Aron, 2026-11-02, on signet 0.12.0's `{ full: true } | { picks: [...] }`:

> It's not just full or true. It should just be a pick or omit, right? … The reason I like a lens for this is because you can do a combination of picks and omits … do you omit a whole branch, some parts of a branch, or just a couple leaves? Figure out some TDD around that that doesn't just blow up.

And on the first draft:

> The object should match the map of the operations … Then it needs to have a serialized narrow order, which is why I like lenses … You have a bunch of top-level models. If one's not listed, is that included or not? … We just need a consistent way of describing things so that you can traverse down a thing … Only that path along the branch is given. If you want to remove something, you can omit just that path on the branch as well, with dot path notation. If you pick or omit at any node along the branch, it gets everything [below] that.

His earlier ruling on lenses applies too: "omits picks and relations all compose.. only choosing picks is a major error."

`full` is just "no picks, no omits". Pick-only can't say "everything except X".

## What exists, and what this reuses

| Concern | Existing primitive | Use |
|---|---|---|
| The operations map | the provider catalog: dotted leaf keys, `operationTree` (`signet/src/operations.ts`) | a selection names paths in this map, so its shape is the map's |
| Ordered narrowing layers | json-rules lens: layers in order, picks intersect, omits union, a later layer only narrows, naming what an ancestor hid is an error (`json-rules/docs/LENS.md` §5) | the same composition, layer by layer |
| Refusal checks | `narrowsOperations`, `permitsOperation`, `scopeRefusal` | kept; they take the resolved scope |

## Direction (Aron, 2026-11-02, third round): use the lens itself

> You can pick and omit at any point. It behaves at that point … Kind of like how lenses behave … just copy how lenses do, even though it's very much overkill … for every event and operation, which has its own lens, you'd have a narrowing of the schema, a narrowing of the data you would get back … one is operations narrowings, and one is schema narrowings on the resource grant row … By using lenses again on the narrowing, on that operation, you can talk about a project, and you can put wheres in there. That's just using a lens.

So a resource grant row carries two narrowings, both json-rules lenses:

1. **Operations narrowing.** The provider's catalog becomes a lens schema: each branch of the operation tree is a model, each operation (leaf) a field, each child branch a relation. A grant's operations narrowing is a plain `LensNarrowing` over it. Picks and omits at any node behave as the lens does at that hop; `parents` gives the ordered layers; composition, `validateNarrowing` and its codes, and `projectLens` (the operations a grant reaches) come from json-rules unchanged. The only new code is `catalogLens(catalog)`.
2. **Schema and data narrowing, per operation or event.** Each operation's payload has its own lens: which fields come back (picks/omits) and which rows (`where`, for example scoping to a project's ids through the lens's binds). This extends the data-lens layers the grant row already carries (`signet/src/lens.ts`).

**The mismatch to test first:** lens relations start off and the first narrowing turns them on, whereas operations start all on ("no picks = everything"). Proposed fix: `catalogLens`'s base turns every relation on, so grant layers only narrow.

**Spike, test-first, before any of the shape below is built:** generate the lens from the fixture catalog, express rows 1–17 of the table as `LensNarrowing`s, and check `validateNarrowing` and `projectLens` against the expected leaves (now and after growth) and error codes. Rows that differ show where the lens's rules differ from what Aron described; each one goes to him. If none differ, the design is the lens, and the section below survives only as the description of what the lens does for operations.

## The shape (as first revised; the lens spike decides whether it's needed)

```ts
/** One layer. Every entry is a dot path into the operations map; a path names a node and everything under it. */
type OperationLayer = { picks?: string[]; omits?: string[] };
/** The request's layer first, then each approver's, in order; the integration's baseline caps all of them. */
type OperationSelection = OperationLayer[];
```

The rule is the same at every level, top-level resources included:

1. **No picks:** everything in the map is in, including what the provider adds later.
2. **Picks:** only the picked paths are in, each with everything under it.
3. **Omits:** then remove each omitted path, with everything under it.
4. **Layers:** each layer applies to what the previous one left; it can only narrow.

So the answer to "if one's not listed, is it included?" never depends on depth. A layer without picks includes it; a layer with picks doesn't.

| Want | Layer |
|---|---|
| Everything (today's `full`) | `{}` |
| Omit a whole branch | `{ omits: ['events'] }` |
| Omit part of a branch | `{ omits: ['events.pull_request'] }` |
| Omit a couple of leaves | `{ omits: ['sessions.delete', 'documents.search'] }` |
| Pick a branch | `{ picks: ['sessions'] }` |
| Pick a couple of leaves | `{ picks: ['sessions.write', 'sessions.delete'] }` |
| Pick a branch, minus a leaf | `{ picks: ['events'], omits: ['events.pull_request.opened'] }` |

**Growth follows from the paths.** A picked or unrestricted node takes what the provider adds under it, while a picked leaf is fixed. `{}` grows everywhere, `{ picks: ['sessions'] }` takes a future `sessions.restore`, and `{ picks: ['sessions.write'] }` never grows. An omit-based layer widens as the catalog grows; the baseline caps it live.

**A key that is both a leaf and a branch** (`events` as an operation, with `events.push` under it): naming `events` takes both. To keep only the leaf, omit `events.*`, which is the existing group syntax, here meaning "every child".

**Validation** uses the lens's codes:
- `not_in_catalog`: a path the map doesn't have.
- `not_visible`: a layer names a path an earlier layer removed.
- `conflicting_selection`: in one layer, an omit that equals a pick, or a pick inside an omitted path.
- `empty_selection`: the selection reaches no operation (a typo never saves an empty grant).

## Resolution and caching

`resolveOperationSelection(catalog, layers) → string[]` (leaves, in catalog order) and `permitsSelection(catalog, layers, operation)` are pure functions over the map.

Kingdom's catalogs are code ("catalogs are code/enums"), so resolving is an in-memory walk with nothing to cache. A grant row stores its layers, not the leaves they resolved to, so growth is real.

If a provider's map is ever fetched rather than coded, that fetched map is what gets cached, with a time-to-live. A grant's result is never cached.

A selection is lens-shaped data, so if operations ever become rows, the same paths compile to a query filter the way a lens's narrowing does. Nothing needs that today.

## Open for Aron

1. **Confirm the reading:** layers of `{ picks, omits }` with dot paths, one rule at every depth, a named node covering its subtree.
2. **`events.*` to mean "children only"** for a key that is both a leaf and a branch. That case is rare; GitHub events may have it.

## TDD: one table, one resolver

One fixture catalog, and one table-driven file, `tests/operation-selection.test.ts`. Each row is `layers → leaves now → leaves after the catalog grows`, or an error code. New cases are new rows.

Fixture catalog (now, 9 leaves):

```
sessions.read  sessions.write  sessions.delete
documents.read  documents.search
events.push  events.pull_request.opened  events.pull_request.review_requested
commits.read
```

Grown catalog: adds `sessions.restore`, `events.pull_request.closed`, `issues.read`.

| # | Layers | Now | After growth |
|---|---|---|---|
| 1 | `[{}]` | all 9 | all 12 |
| 2 | `[{ omits: ['events'] }]` | 6 | 8 (+restore, +issues.read) |
| 3 | `[{ omits: ['events.pull_request'] }]` | 7 | 9 (+restore, +issues.read) |
| 4 | `[{ omits: ['sessions.delete'] }]` | 8 | 11 |
| 5 | `[{ picks: ['sessions'] }]` | read, write, delete | + restore |
| 6 | `[{ picks: ['sessions.write', 'sessions.delete'] }]` | write, delete | write, delete (fixed) |
| 7 | `[{ picks: ['sessions', 'documents', 'events.pull_request'], omits: ['events.pull_request.opened'] }]` | sessions.\*, documents.\*, review_requested | + restore, + closed |
| 8 | `[{ picks: ['sessions', 'documents'] }, { omits: ['documents'] }]` | sessions.\* | + restore |
| 9 | `[{ omits: ['events'] }, { picks: ['events'] }]` | error `not_visible` | |
| 10 | `[{ picks: ['sessions'], omits: ['sessions'] }]` | error `conflicting_selection` | |
| 11 | `[{ omits: ['events'], picks: ['events.push'] }]` | error `conflicting_selection` | |
| 12 | `[{ picks: ['sesions'] }]` | error `not_in_catalog` | |
| 13 | `[{ omits: ['commits.read.extra'] }]` | error `not_in_catalog` | |
| 14 | `[{ picks: ['sessions'], omits: ['sessions.read', 'sessions.write', 'sessions.delete'] }]` | error `empty_selection` | |
| 15 | baseline `[{ omits: ['commits'] }]`, then ask `[{}]` | 8 | 11 |
| 16 | Archive's ask: `[{ picks: ['sessions.write', 'sessions.delete'] }]` | write, delete | write, delete |
| 17 | catalog `events`, `events.push`: `[{ omits: ['events.*'] }]` | events | events |

Plus one row per layer pair checking that each next layer is a narrowing, using `narrowsOperations` on the resolved scopes.

## Who does what

- **bf:** owns the shape and its code in signet (`operations.ts`, `grants.ts`), and Kingdom's grant table, which stores layers. Writes the table test first, then the resolver.
- **ec:** updates Archive's pairing ask to row 16 when Kingdom moves. Until then Archive stays on signet ^0.11.1, because 0.12 changes the pairing shape and prod Kingdom is on 0.11. Reviews the table from the requester's side.
- **Aron:** the two open items.

## Log

- 2026-11-02: first draft by ec (nested `branches` form, four decision points).
- 2026-11-02: revised from Aron's answers: dot paths in ordered `{ picks, omits }` layers, one rule at every depth, a named node covers its subtree, store layers and resolve live, cache only a fetched catalog.
- 2026-11-02: lens spike by bf (`test/operation-selection.spike.test.ts`, json-rules 3.16.0, no `src` change, nothing released). Results below.

### Lens spike result

**Setup.** `catalogLens(catalog)` builds one field map: the root is a model (`$root`), each branch path a model, each leaf a `Boolean` column, each child branch an `object` relation. Two bases were tried: **on** (a first narrowing that spells every relation, as proposed above) and **bare** (the raw lens, relations off, so the grant's first layer turns them on). The doc's dot paths are spelled as the lens spells them: a leaf is `relations.<branch>.picks/omits: [leaf]`, a branch omit is `omits: ['<relation>']`, a branch pick is `relations: { <branch>: {} }` (lens `picks` name columns only). Leaves come from `projectLens` (each shown path's visible columns); errors from `validateNarrowing` on every layer. Growth = the same layers over the lens rebuilt from the grown catalog. Counts are now / after growth.

| # | Lens form | Base | Doc expects | json-rules returned | Result |
|---|---|---|---|---|---|
| 1 | `{}` | on | 9 / 12 | 9 / 12 | match |
| 1r | `{}` | bare | 9 / 12 | nothing / nothing | **differs**: on the bare lens a relation is off until spelled |
| 1s | every relation spelled | bare | 9 / 12 | 9 / 11, misses `issues.read` | **differs**: a new branch is never spelled |
| 2 | `root.omits: ['events']` | on | 6 / 8 | 6 / 8 | match |
| 3 | `relations.events.omits: ['pull_request']` | on | 7 / 9 | 7 / 9 | match |
| 4 | `relations.sessions.omits: ['delete']` | on | 8 / 11 | 8 / 11 | match |
| 5 | `root.picks: ['sessions']` (literal) | on | sessions.\* / + restore | `wrong_kind` ('sessions' is a relation: picks names columns) | **differs** |
| 5b | `root.omits` the other branches | on | sessions.\* / + restore | sessions.\* / + restore **+ `issues.read`** | **differs** after growth |
| 5c | `relations: { sessions: {} }` | bare | sessions.\* / + restore | sessions.\* / + restore | match |
| 6 | omit other branches + `relations.sessions.picks: ['write','delete']` | on | write, delete / fixed | write, delete / **+ `issues.read`** | **differs** after growth |
| 6c | `relations.sessions.picks: ['write','delete']` | bare | write, delete / fixed | write, delete / fixed | match |
| 7 | omit `commits`, `events.omits: ['push']`, `pull_request.omits: ['opened']` | on | sessions.\*, documents.\*, review_requested / + restore, + closed | as expected **+ `issues.read`** after growth | **differs** after growth |
| 7c | spell sessions, documents, `events { picks: [], pull_request { omits: ['opened'] } }` | bare | as row 7 | as row 7 | match |
| 8 | layer 1 omits events, commits; layer 2 omits documents | on | sessions.\* / + restore | sessions.\* / + restore **+ `issues.read`** | **differs** after growth |
| 8c | layer 1 spells sessions, documents; layer 2 omits documents | bare | sessions.\* / + restore | sessions.\* / + restore | match |
| 9 | layer 1 omits events; layer 2 `relations: { events: {} }` | on | `not_visible` | `not_visible` | match |
| 10 | `omits: ['sessions']` + `relations: { sessions: {} }` in one layer | bare | `conflicting_selection` | no error; reaches nothing | **differs**: the lens flags only a column omitted beside picks |
| 11 | `omits: ['events']` + `relations.events.picks: ['push']` in one layer | on | `conflicting_selection` | no error; the omit wins | **differs** |
| 12 | `relations: { sesions: {} }` | on | `not_in_catalog` | `not_in_lens` | **differs** in name only |
| 13 | `relations.commits.relations.read.omits: ['extra']` | on | `not_in_catalog` | `wrong_kind` ('read' is a column) | **differs** |
| 14 | `relations.sessions.omits` all three leaves | bare | `empty_selection` | no error; reaches nothing now, `sessions.restore` after growth | **differs**: the lens has no empty check |
| 15 | baseline omits commits, then `{}` | on | 8 / 11 | 8 / 11 | match |
| 16 | Archive's ask, as 6c | bare | write, delete / fixed | write, delete / fixed | match |
| 17 | catalog `events` and `events.push` | either | `events` | not representable: a field map has one field per name, so `events` can't be both a column and a relation | **differs** |

**What the differing rows say, for Aron:**

1. **No one base gives both rules (rows 1–8).** Lens relations are off until the first narrowing spells them; columns are on until picked or omitted. With every relation on in the base, "no picks = everything" holds and grows (1–4, 15), but a branch can only be picked by omitting its siblings, so a branch the provider adds later leaks in (5b, 6, 7, 8 gain `issues.read`). On the bare lens, picks are exact and stay fixed as the catalog grows (5c, 6c, 7c, 8c, 16), but `{}` reaches nothing and "everything" spelled out doesn't grow (1r, 1s). So in the lens, "if one's not listed, is it included?" depends on whether it is a branch or a leaf, not on whether the layer has picks. And only the first narrowing over the bare lens may turn a relation on, so only the first layer (the baseline, or the request when there is none) can pick a branch; later layers narrow by omitting.
2. **Picking a branch is `relations`, not `picks` (row 5).** A dot-path `picks: ['sessions']` has no literal lens form; `picks` naming a relation is `wrong_kind`.
3. **The lens has no `conflicting_selection` for relations (10, 11) and no `empty_selection` (14).** It flags only a column omitted beside picks in one layer; an omit beside a relation turn-on, or a narrowing that reaches nothing, validates.
4. **The codes are the lens's (12, 13).** An unknown name is `not_in_lens`; a path running through a leaf is `wrong_kind`.
5. **A key that is both a leaf and a branch can't be a field map (17).** It needs a catalog rule (no such keys, or the leaf renamed under its branch) before `catalogLens` can build one.

No code was added to cover any of these; each is a question about which rule Aron wants.
