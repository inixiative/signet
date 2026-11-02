# Operation selection: pick and omit over the operation tree

Coordinating doc for inixiative-bf (signet grant core, Kingdom grant table) and inixiative-ec (Archive, the first requester). Status: **draft, for Aron's yes**. Nothing in code changes until the decision points below are settled.

## Why

Aron, 2026-11-02, on signet 0.12.0's `{ full: true } | { picks: [...] }`:

> It's not just full or true. It should just be a pick or omit, right? … The reason I like a lens for this is because you can do a combination of picks and omits, and it's a nested object. … The problem is: do you omit a whole branch, some parts of a branch, or just a couple leaves? Figure out some TDD around that that doesn't just blow up.

His earlier ruling on lenses applies the same way: "omits picks and relations all compose.. only choosing picks is a major error."

`full` is "omit nothing": signet already defines it as "everything the resource offers, now and as its catalog grows". Pick-only can't say "everything except X". Today that needs either a list of every other leaf, which goes stale when the catalog grows, or `full`.

## What exists, and what this reuses

| Concern | Existing primitive | Use |
|---|---|---|
| Operation catalog and tree | `signet/src/operations.ts`: dotted leaf keys, `operationTree` (a key can be both a leaf and a branch) | unchanged: the tree a selection walks |
| Group pick | `key.*` in `resolveOperationPicks` | replaced by naming a branch (below) |
| Pick/omit semantics and layering | json-rules lens: `picks` and `omits` at each node, relations narrowed per hop, layers intersect picks and union omits, a later layer only narrows, naming what an ancestor hid is an error (`json-rules/docs/LENS.md` §2, §5; codes `not_in_lens`, `not_visible`, `conflicting_selection`) | **the same rules**, applied to the operation tree: lens field = operation leaf, lens relation = operation branch |
| Narrowing check | `narrowsOperations`, `permitsOperation`, `scopeRefusal` | kept; they take the resolved scope |

No new machinery: a selection is the lens's pick/omit narrowing, without `where`, over a tree whose nodes are operation segments.

## The shape (proposed)

```ts
/** One node's narrowing. Every name is a direct child of this node: a leaf or a branch. */
type OperationSelection = {
  picks?: string[];  // keep only these children (default: all, including ones added later)
  omits?: string[];  // drop these children (a whole branch, or a leaf)
  branches?: Record<string, OperationSelection>; // narrow a kept child branch ("parts of a branch")
};
```

The three cases Aron named:

| Want | Selection |
|---|---|
| Everything (today's `full`) | `{}` |
| Omit a whole branch | `{ omits: ['events'] }` |
| Omit some of a branch | `{ branches: { events: { omits: ['pull_request'] } } }` |
| Omit a couple of leaves | `{ branches: { sessions: { omits: ['delete'] } } }` |
| Pick a whole branch | `{ picks: ['sessions'] }` |
| Pick a couple of leaves | `{ picks: ['sessions'], branches: { sessions: { picks: ['write', 'delete'] } } }` |
| Mixed | `{ omits: ['commits'], branches: { events: { picks: ['pull_request'], branches: { pull_request: { omits: ['opened'] } } } } }` |

Rules, one place each:

1. **At a node:** start from its children (all of them, or `picks`), remove `omits`, then narrow each remaining branch by `branches[name]`. A branch kept with no entry in `branches` is whole.
2. **Growth:** a node with no `picks` takes children the catalog adds later; a node with `picks` is fixed to those children, but each picked branch still grows inside unless it is narrowed itself. So `{}` grows everywhere (today's `full`), and `{ picks: ['sessions'] }` takes a future `sessions.restore`.
3. **Layers** (requester's ask, then each approver; the integration's baseline caps all): picks intersect, omits union, `branches` compose per child. A layer can only narrow, never re-add.
4. **Validation**, with the lens's codes:
   - `not_in_catalog`: a name that isn't a child of this node.
   - `not_visible`: a layer names something an earlier layer removed.
   - `conflicting_selection`: the same name in both `picks` and `omits`, or in `branches` while omitted.
   - `wrong_kind`: `branches` names a leaf.
   - `empty_selection`: the selection reaches no leaf (a typo never saves an empty grant, as `OperationPickError` does today).
5. **Resolution:** `resolveOperationSelection(catalog, layers) → { operations: string[] }`, in catalog order. It is recomputed whenever the catalog changes, so growth is real. A stored grant keeps its layers, not only the leaves they resolved to.

## Decision points for Aron

1. **Nested object (above) or dotted paths in flat lists?** The alternative is `{ picks?: string[], omits?: string[] }` with relative dotted names (`omits: ['sessions.delete', 'events']`). That's shorter for one-off leaves, but it's a second way to write the same thing, and `conflicting_selection` gets harder (`events` vs `events.push`). Recommendation: **nested only**, because it is the lens's shape and has one place per node.
2. **Omit grows.** An omit-based selection widens on its own as the provider adds operations. That's the point, and `full` already does it. Recommendation: keep it, since the baseline caps it live. A grantor who wants it fixed uses `picks`.
3. **A key that is both a leaf and a branch** (`events` as an operation, with `events.push` under it). Recommendation: naming `events` means the leaf and its whole subtree. To keep only the leaf, write `branches: { events: { picks: [] } }`; empty `picks` means "none of the children", and is valid only there.
4. **Store layers, resolve live.** Signet 0.12 resolves picks to leaves once, at save time. Under this design a grant row stores its selection layers and resolves on read, or when the catalog changes. Recommendation: store layers, plus the resolved leaves as a cache refreshed on catalog change, so refusals stay cheap.

## TDD: one table, one resolver

One fixture catalog and one table-driven test file, `tests/operation-selection.test.ts`. Each row is `selection layers → leaves now → leaves after the catalog grows`, or an error code. New cases are rows, not new tests. That keeps it from turning into a pile of bespoke tests.

Fixture catalog (now):

```
sessions.read  sessions.write  sessions.delete
documents.read  documents.search
events.push  events.pull_request.opened  events.pull_request.review_requested
commits.read
```

Grown catalog: adds `sessions.restore`, `events.pull_request.closed`, `issues.read`.

| # | Layers | Now | After growth |
|---|---|---|---|
| 1 | `{}` | all 9 | all 12 |
| 2 | `{ omits: ['events'] }` | 6 (no events) | 8 (+restore, +issues.read) |
| 3 | `{ branches: { events: { omits: ['pull_request'] } } }` | 7 | 9 (+restore, +issues.read; not +closed) |
| 4 | `{ branches: { sessions: { omits: ['delete'] } } }` | 8 | 11 (+restore, +closed, +issues.read) |
| 5 | `{ picks: ['sessions'] }` | read, write, delete | + restore |
| 6 | `{ picks: ['sessions'], branches: { sessions: { picks: ['write', 'delete'] } } }` | write, delete | write, delete (fixed) |
| 7 | mixed (shape table above) | review_requested, sessions.\*, documents.\* | + restore, + closed, + issues.read |
| 8 | layers `{ picks: ['sessions', 'documents'] }` then `{ omits: ['documents'] }` | sessions.\* | + restore |
| 9 | layers `{ omits: ['events'] }` then `{ picks: ['events'] }` | error `not_visible` | |
| 10 | `{ picks: ['sessions'], omits: ['sessions'] }` | error `conflicting_selection` | |
| 11 | `{ omits: ['events'], branches: { events: {} } }` | error `conflicting_selection` | |
| 12 | `{ branches: { commits: { picks: ['read'] } }, picks: ['sesions'] }` | error `not_in_catalog` (`sesions`) | |
| 13 | `{ branches: { sessions: { branches: { read: {} } } } }` | error `wrong_kind` | |
| 14 | `{ picks: ['sessions'], branches: { sessions: { omits: ['read', 'write', 'delete'] } } }` | error `empty_selection` | |
| 15 | baseline `{ omits: ['commits'] }`, ask `{}` | 8 | 11 |
| 16 | Archive's ask: `{ picks: ['sessions'], branches: { sessions: { picks: ['write', 'delete'] } } }` | write, delete | write, delete |

Plus `narrowsOperations` on resolved scopes, which stays as it is: one row per layer pair, checking that each next layer is a narrowing.

## Who does what

- **bf:** owns the shape and its code in signet (`operations.ts`, `grants.ts`), and Kingdom's grant table and catalog-change refresh. Writes the table test first.
- **ec:** updates Archive's pairing ask to case 16 when Kingdom moves. Until then Archive holds on signet ^0.11.1, because 0.12 changes the pairing shape and prod Kingdom is on 0.11. Reviews the table from the requester's side.
- **Aron:** the four decision points.

## Log

- 2026-11-02: drafted by ec from Aron's direction; for bf to edit.
