This file starts at 0.17.0. Earlier releases are described in their pull requests: 0.15.0 (threads
terms `posts`, `act` and `agent`, #33) and 0.16.0 (a hosted request carries its requester's
audience, #35).

## 0.21.0 — a lens filters what an operation returns; it never turns an operation off

Aron, 2026-11-17: "The lens is for outgoing stuff, right? For filtering data and truncating data
that you're getting back. That's what the lens is for. Everything else is an operation or a
where." Breaking for what a lens means:

- `composeGrantLensChain` starts every chain from the every-branch narrowing, so a lens that names
  only some operations' branches leaves the others on, unfiltered by it. `{}` now adds nothing (on
  0.20 it turned every branch off).
- A lens that would leave an operation's branch off (by omitting it) throws `GrantLensError`
  ("A lens filters what an operation returns; it cannot leave an operation off").
- Which operations a grant holds is its actions alone; a host that trimmed a row's actions to what
  its lens left on should stop.

## 0.20.0 — entitlement changes are add and remove; the lens surface uses json-rules' verbs

### A change to a Signet's entitlements is `{ add, remove }`, asked and answered

Aron, 2026-11-16: "The payload should just take the same shape, just add and remove. Both the
request and the response." Breaking, no old shape kept:

- **`signetEntitlementRequestSchema`** is `{ signetId, add, remove, reason? }`. `add` takes what
  `resources` took (a resource by id, or by kind as a registration asks); `remove` names held rows
  by their own id. At least one of the two is named. `resources` is gone:
  `requestSignetEntitlement(url, keyFile, { signetId, resources })` becomes `{ signetId, add }`.
- **`signetEntitlementChangesSchema`** (new) is the reviewer's copy and the record of what was
  granted: `{ add, remove }`, with every added resource resolved to an id.
- **A held grant row carries its own `id`** (`signetGrantSchema`, so every `resources` list on
  `installationSignetSchema`, `hostedSignetSchema` and a description): the id a `remove` names. It
  is required, so a 0.20 client reads only a Kingdom that sends it.
- `recipientAudienceSchema`'s `owner` is whoever may manage the hosting integration, a person or an
  integration (Aron, 2026-11-16: "the foundry is the owner, and then everything else is the owner
  action there has"); the doc comment no longer says "never an Integration".

### The lens surface uses json-rules' verbs

Aron, 2026-11-16, on a review of 0.19's four new verbs ("turn on", "nest", "test", "refuse"):
"Okay, agreed. Change that." Why: the naming rule (`docs/rules/naming-and-vocabulary.md`) uses the
library below's verb whenever the operation is that verb. Only "nest" is new; json-rules turns a
relation on by narrowing it, a fact read off a lens is a description, and whether a grant can carry
its lens is a validation. No old name is kept:

| 0.19 | 0.20 | Verb |
| --- | --- | --- |
| `turnOnEveryOperationBranch(operations, leafNarrowing?)` | `narrowEveryOperationBranch(operations, leafNarrowing?)`, same result | narrow |
| `lensFiltersOperationRows(lens, operation)` | `describeWhetherLensFiltersOperationRows(lens, operation)`, same boolean | describe |
| `refuseArchiveOperationLens(operation, grant): string \| null` | `validateArchiveOperationLens(operation, grant): ValidationResult` | validate |
| `refuseArchiveGrantLens(scope, grant): string \| null` | `validateArchiveGrantLens(scope, grant): ValidationResult` | validate |
| `refuseRepositoryOperationLens(operation, grant): string \| null` | `validateRepositoryOperationLens(operation, grant): ValidationResult` | validate |
| `refuseRepositoryGrantLens(scope, grant): string \| null` | `validateRepositoryGrantLens(scope, grant): ValidationResult` | validate |
| `scopeRefusal(scope, catalog, refusal)` | `validateOperationsInScope(scope, catalog, validateOperation)` | validate |

- **The validators return json-rules' `ValidationResult`**, `{ ok, errors: { path, message, code }[] }`,
  not a reason or null: json-rules' validators all return that shape, so a `validate` name that
  returned a string would mislead. Each error's `path` is the operation and its `code` is
  `invalid_lens` (as `GrantLensError`). A grant row's validation now lists every operation it
  fails, not only the first: `if (refusal)` becomes `if (!result.ok)`, and a message is
  `result.errors[0].message` (or every one joined).

## 0.19.0 — a grant row's lens is one narrowing; no base lenses on the wire

Aron, 2026-11-14 and 2026-11-15: the lens column is a narrowing, the same as template's; delegation
never copies the lens; "Drop the base lenses. It's just a lens." Why: layer ids and parents only
chained a request's layer under the base and an approver's under it. Since an approval is a whole
copy and a Signet never holds what was asked, a row holds one narrowing, and a re-delegated row's
lens is its own narrowing composed under the rows above it at read time.

### Breaking

- **A grant row's `lens` is one narrowing** (`lensNarrowingSchema`: `{ root?, mapDefaults? }`,
  strict) on the stored row (`grantResourceSchema`), the holder's view (`signetGrantSchema`) and
  `describe` (`signetDescriptionResourceSchema`), the same shape an ask already carried. A list of
  layers, `id`, `parents` or any other key does not parse; a holder drops that resource and reports
  it. `storedLensLayerSchema`, `storedLensLayersSchema`, `StoredLensLayer`, `ComposedGrantLens` and
  `baseLensId` are gone.
- **`hostedSignetSchema.baseLenses` and `storedBaseLensSchema` are gone.** A host that needs a
  kind's base creates it with `createOperationsLens`. The hosted Signet schema strips unknown keys,
  so a Kingdom that still sends `baseLenses` has it dropped; a 0.18 client drops every hosted Signet
  without it.
- **`composeGrantLensChain(base, chain)`** takes the kind's operations lens and a row's chain of
  lenses, the upstream row's first, and returns a `GrantLens`. Only an absent lens (null or
  undefined) adds nothing; every lens that is present composes exactly as json-rules composes it,
  whatever it holds, so `{}`, `{ root: {} }` and `{ root: { relations: {} } }` all turn every branch
  off, as on 0.18. A chain where every lens is absent reads every branch (`narrowed: false`). Each
  lens is validated against the ones above it with json-rules `assertValidNarrowing`, the step
  `composeLens` runs per layer. A chain over `grantLensChainLimit` (20) is refused.
  `GrantLensError.code` is `invalid_lens`.
- **`GrantLens` is `{ lens, narrowed }`**: the composed json-rules lens, and whether any lens on the
  chain is present. It no longer carries a projection or layers; the refusals read `grant.lens`
  through json-rules (`lensVisit`, `walkLensPath`).
- **`projectionVisit` and `projectionShows` are gone**: they were json-rules `lensVisit(lens,
  operation)` and `walkLensPath(lens, `${operation}.${field}`).outcome === 'resolved'`, read off a
  projection by guessing the anchor. Call those on `grant.lens`.
- **The lens surface is renamed so each name says its action** (`docs/VERBS.md`, enforced by
  `test/verbs.test.ts`). No old name is kept:

  | 0.18 | 0.19 |
  | --- | --- |
  | `operationsLens({ model, operations, rowModel, rowModels })` | `createOperationsLens(…)`, same arguments |
  | `everyBranch(operations, leafNarrowing?)` | `turnOnEveryOperationBranch(operations, leafNarrowing?)` |
  | `rowModelLayer(operations, row, narrowing)` | `narrowRowModelOnEveryBranch(operations, row, narrowing)` |
  | `narrowingAtOperation(operation, narrowing)` | `narrowOperationBranch(operation, narrowing)` |
  | `composeGrantLens(baseId, base, storedLayers)` | `composeGrantLensChain(base, chain): GrantLens` |
  | `rowsThroughLens(lens, operation, rows)` | `projectOperationRows(lens, operation, rows)` |
  | `operationRecord(operation, rows)` | `nestRowsAtOperation(operation, rows)` |
  | `operationRows(record, operation)` | `readRowsAtOperation(record, operation)` (own properties only) |
  | `conditionAtOperation(operation, condition)` | `conditionOverOperationRows(operation, condition)` |
  | `projectionFilters(projection, operation)` | `lensFiltersOperationRows(lens, operation)` |
  | `projectionVisit(projection, operation)` | json-rules `lensVisit(lens, operation)` |
  | `projectionShows(projection, operation, field)` | json-rules `walkLensPath(lens, `${operation}.${field}`).outcome === 'resolved'` |
  | `archiveLensRefusal(operation, lens)` | `refuseArchiveOperationLens(operation, grant)` |
  | `archiveGrantRefusal(scope, lens)` | `refuseArchiveGrantLens(scope, grant)` |
  | `repositoryLensRefusal(operation, lens)` | `refuseRepositoryOperationLens(operation, grant)` |
  | `repositoryGrantRefusal(scope, lens)` | `refuseRepositoryGrantLens(scope, grant)` |
  | `archiveCallCondition(operation, input)` | `conditionOverArchiveCallFilters(operation, input)` |
  | `archiveCallNarrowing(operation, input)` | `narrowToArchiveCallFields(operation, input)` |
  | `lensLayerSchema` | `lensNarrowingSchema` |
  | `LensLayer` | `LensBody` |

## 0.18.0 — a conversation is an integration resource; grant terms are gone

Aron, 2026-11-14: "they should be operations in a conversation… tread conversations as a integration
resource". Why: six of the seven `threads` terms gave a member more power over the host, so they were
permissions kept outside the permission engine, and approving or passing one on needed a hand-written
narrowing (`narrowsThreadsTerms`, Kingdom's `termsNarrow`).

### Breaking

- **One `conversation` resource per shared thread** (`conversationResourceKind`), its `externalId` the
  thread's id. `threadsResourceKind` is gone. No call's input carries `threadId` (it left
  `threadInputSchemas` and `accessInputSchema`): the call's resource is the conversation. Every
  `thread.request` and `thread.subscribe` frame carries the `threadId` Kingdom read from the resource.
- **Grant terms are gone**: `threadsTermsSchema`, `threadViewSchema`, `threadDeliverySchema`,
  `threadOutboundSchema`, `threadFloorTermsSchema`, `threadPostsSchema`, `threadActSchema`,
  `narrowsThreadsTerms`, `meetThreadsTerms`, `grantTermsSchema`, `grantTermsFitKind`, `threadsTerms`,
  and `terms` on grant rows, asks, descriptions and frames.
- **Conversation permissions** (`conversationPermissionSchema`, `conversationPermissionNames`):
  `member.log`, `member.wake`, `member.take`, `member.agent`, `agent.instruct`, `agent.read`,
  `agent.act`. Catalog entries a grant picks and nothing calls, on their own branches, so `thread.*`
  picks the calls alone. Frames carry `permissions` where they carried `terms`.
  `conversationActLevel` reads the act level from them. From the old terms: `view: thread` is
  `member.log`, `delivery: turn` is `member.wake`, `floor.mayTake` is `member.take`,
  `posts: instructions` is `agent.instruct`, `act: read` is `agent.read`, `act: full` is `agent.act`,
  `agent: true` is `member.agent`. `outbound` is the host's own setting
  (`conversationOutboundSchema`), not on the grant.
- **A join request by kind may carry `externalId`** (`requestedResourceKindSchema`); a `conversation`
  ask must, as a thread id.
- **A holder reads a conversation's `externalId`** (its thread id) on its grant rows
  (`signetGrantSchema`) and in `describe` (`signetDescriptionResourceSchema`). The field is optional:
  Kingdom sends it only where the holder acts by it and keeps other provider ids to itself.
- **A hosted Signet's `recipient` carries `audience`** (`recipientAudienceSchema`: `owner`, `inOrg` or
  `outside`). `owner` is how a host knows its owner's own client; holding `prompt.resolve` is not.
- **A hosted request carries `resourceHandles`**: the thread id of each conversation it names, by
  resource id.
- **A grant row may name a scope** (`resourceModel: 'Integration'`: `integrationId`, `kind`, optional
  `projectId`, then `full` / `operations` / `lens` / `where` as on a resource row), asked for in
  `signetResourceSchema` with `resourceKind`. Every reader of grant rows now meets three arms: a
  row is not always one resource.

## 0.17.0 — grant lenses narrow the operations lens; a where goes in, a lens comes out; events carry Kingdom's id

Consumers move to `^0.17.0`: none of this is in 0.15.0 or 0.16.0.

### Breaking

- **A grant's lens layers narrow the resource kind's generated operations lens** (R-SIG-18). The
  base Kingdom generates under `baseLensId(provider, kind)` is a tree with one branch per
  operation, each listing the rows it reads; a layer turns on the branches it keeps and narrows the
  rows there. Layers written against the old row-rooted bases (a `Thread` or `Commit` root) no
  longer compose: Kingdom rewrites stored ones, and a holder writes new layers on the operations
  tree (`everyBranch`, `narrowingAtOperation`, `rowModelLayer`).
- **A lens `where` above an operation's branch is refused.** A `where` on the root, or on a branch
  that holds several operations, is over the whole list of rows, so it showed every row as soon as
  one matched. `composeGrantLens` throws `GrantLensError` for it. A row filter goes at the
  operation's own branch: `narrowingAtOperation(operation, { where })`, or a row model's
  `mapDefaults`. `conditionAtOperation` is only a call's filter for json-rules `validateRuleInLens`.
- **`projectionFilters` and `projectionShows` take an `operation`** and read that operation's
  branch: `projectionFilters(projection, operation)`, `projectionShows(projection, operation,
  field)`. A branch left off holds every row back.
- **Every event carries `id`, and holders dedupe on it.** `integrationEventSchema` gains `id`, a
  UUID Kingdom mints once per event after it has dropped the provider's retries; it is the event
  row's identifier, a field a lens can name (`integrationEventFieldSchema` lists it) and can never
  drop. `eventId` stays on the envelope as the provider's delivery id, for Kingdom's retry dedupe
  only.
- **An append is `{ type, event, truncated? }`.** `accessEventsAppendSchema` no longer carries
  `eventId`; `event` always carries `id` (a UUID), and a consumer that must act once dedupes on
  `event.id`, which is the same on every channel the event reaches. An append whose `event` has no `id` does not parse.
- **`integrationEventFieldSchema` lists only the fields a lens can name** on an `IntegrationEvent`
  row: `eventId` and `type` are gone from it. `type` rides outside the projected body
  (`accessEventsAppendSchema`), so a layer naming either never composed.
- **`SignetSocketOptions`: `onSnapshot` and `onEntry` are optional**, for a holder that only
  listens to event channels; `open(threadId)` throws without them.
- **`onReopening` receives a `ReopenedCloseReason`** (`revised`, `presentationExpired`,
  `hostOffline`), not any close reason.
- **`@inixiative/json-rules` is needed at run time** (`validateRule`, `composeLens`, `createLens`,
  `projectLens`, `projectRows`); it stays a peer dependency, now `^3.21.0`.

### New

- **One home for the operations lens.** `operationsLens({ model, operations, rowModel, rowModels })`
  generates a kind's base, `everyBranch(operations, leafNarrowing?)` turns every branch on,
  `rowModelLayer(operations, row, narrowing)` narrows a row model everywhere,
  `composeGrantLens(baseId, base, storedLayers)` composes a row's layers over the base (json-rules
  `composeLens` checks the chain and each layer; `GrantLensError` otherwise), and
  `rowsThroughLens(lens, operation, rows)` reads rows through the result. Also `operationRecord`,
  `operationRows`, `projectionVisit`, `operationsMapName`. `operationsLens` throws on a catalog whose operations it can't hold apart (one under another, or two sharing a model name). Kingdom and Foundry each had their own
  copies of these.
- **`pickCovers(pick, leaf)`**: the one rule for what a pick takes. A pick ending `.*` takes every
  leaf under its prefix; any other pick takes the leaf of exactly that key.
- **`payload` is the provider's whole event**, as it arrived (the webhook body, or the notification
  for a poll), and a lens can keep or drop it like any row field.
- **`truncated` on an append.** Kingdom caps an append's size; an event over the cap arrives
  without `payload`, every other field whole (`id` included), and the append carries
  `truncated: true`.
- **`where` on a resource ask and on a grant view.** An ask (`signetResourceSchema`,
  `requestedResourceSchema`, `registeredResourceSchema`) may carry the incoming condition its calls
  must meet. `grantWhereSchema` accepts only a positive json-rules condition
  (`validateRule(where, { positive: true })`: no negated operator) that is not vacuous at any depth (no `{}`, no empty `all` or `any`, no bare `true` or `false` in one) and at most `grantWhereLimit` (16,000) characters as JSON. A
  grant view (`signetGrantSchema`) shows the row's `where` whole, read with `storedWhereSchema`: any
  size, so a holder never loses its own row over it. Checking it is Kingdom's, at admission; a holder does not gate on it. A lens `where` may use negated operators: only a grant's `where` decides permission.
- **`owner` on a proposal.** `signetProposalSchema` (and `signetRequestSchema`) may name the one
  owner a request asks, as `namedOwnerSchema`: no other keys, the ids its model is keyed by
  (`ownerIdFields`: User a `userId`; Organization an `organizationId`; Space an `organizationId`
  and `spaceId`; OrganizationUser an `organizationId` and `userId`; SpaceUser all three;
  Integration an `integrationId`) and every other id present and null, `integrationId` included.
  `signetOwnerModelSchema` is the five owner models and `Integration`. The owner read back on a collected or held Signet (`ownerRefSchema`) is unchanged: the five.
- **Event channels**, through which a Signet holder listens to its integration's events:
  `eventChannels` on `installationSignetSchema` and `signetDescriptionSchema`
  (`eventChannelMapSchema`, `eventChannelSchema`), read per entry (`parseEventChannelMap`), and
  `eventStreams` on both sockets, wired once (`HolderStreams`).
- **Streams.** Opens are paced (`openBurst`, `openWindowMs`). A stream closed as `revised` is reopened at once, and with backoff when Kingdom refuses that reopen as `revised` too. A `presentationExpired`
  close on an Installation socket reconnects it, as on a Signet socket. At most `maxQueuedFrames`
  (1,000) frames wait on the handlers; appends past that are dropped and reported, and show as a gap or a resync at the next append or once the handlers have caught up (`maxQueuedFrames` on either socket). An event channel reports a `seq` that went back as a gap, not only a jump.
  `reopenedCloseReasons` and `closeIsReopened(reason)` say which closes are reopened after, and a
  refused presentation is reported as a `SignetPresentationRefused` error.
- **Close reasons describe the holder's own Signet.** `revoked`, `revised`, `expired` and
  `enrollmentRevoked` never describe anything else; a change elsewhere closes a stream as
  `unauthorized`, with no further reason.
- **A retired installation key re-pairs.** When Kingdom refuses a key it retired (its
  Installation removed by the unclaimed or orphaned sweep) with `retiredKeyMessage`,
  `pairInstallation` sets the key aside as `installation-key.retired-<ts>.json`, makes a new one
  under the hold lock, and registers once more. Any other refusal still throws.
- A dropped grant row is reported under its `integrationResourceId` (`dropped[].id`).
