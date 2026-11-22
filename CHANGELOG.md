This file starts at 0.17.0. Earlier releases are described in their pull requests: 0.15.0 (threads
terms `posts`, `act` and `agent`, #33) and 0.16.0 (a hosted request carries its requester's
audience, #35).

## 0.26.0 — an Installation serves its own web viewer over its socket

Aron, 2026-11-22 (R-2026-11-22-03): "We should be building this through Kingdom as first class.
No, no other tools"; "I really would love to just put traffic through Kingdom... I want to be able
to launch this thing from Kingdom and use it on any random machine"; "It's just a wrapper, pretty
blind." A Foundry's viewer was reached through a public tunnel behind one shared token; it will be
shown in a frame on Kingdom, with the browser's traffic forwarded over the socket the Installation
already holds open. Spec: workspace `docs/plans/2026-11-22-open-foundry-through-kingdom.md`.
Additive; nothing existing changes.

- **Viewer frames** (`contracts`), HTTP as it is, nothing of Kingdom's. Kingdom → host (`type`):
  `viewer.request`, `viewer.request.body`, `viewer.request.cancel`, `viewer.socket.open`,
  `viewer.socket.message`, `viewer.socket.close` (`viewerHostFrameSchema`). Host → Kingdom
  (`action`): `viewer.response`, `viewer.response.body`, `viewer.socket.opened`,
  `viewer.socket.message`, `viewer.socket.close`, `viewer.serving` (`viewerKingdomFrameSchema`).
  A body follows its head in frames of at most `viewerBodyChunkBytes` (192 KB), the last marked, so
  a large or streamed body never holds thread frames behind one message. Kingdom forwards request
  bodies up to `viewerMaxRequestBodyBytes` (8 MB); the host answers 413 past it.
- **`InstallationSocket` options `viewer` and `viewerServing`, and `serveViewer(serving)`.**
  `viewer.request(request)` takes a web `Request` whose URL is the address the browser used and
  returns a `Response`; `viewer.socket(request, peer)` accepts the viewer's WebSocket. The host
  never sees a frame (`ViewerRelay`). It tells Kingdom whether it serves the viewer on every
  connect and on every change (`viewer.serving`); while it does not, requests are answered 403 and
  sockets refused. Body frames wait while more than 1 MB sits in the socket's send buffer. A
  dropped socket aborts requests in flight and closes the viewer's sockets.
- **Nothing is left waiting.** A frame that breaks the contract is answered at once (400 for a
  request, a close for a socket); a request whose body stops arriving is answered 408 after 30 s;
  a body that fails part way ends with a last frame marked `cutShort`, so Kingdom breaks the
  browser's response off instead of finishing it; a cancel ends a response stream that has gone
  quiet. What the host sends is checked against the contract first: no `set-cookie`, only close
  codes an endpoint may send (others become 1011), close reasons cut to 123 bytes.
- `viewerUrl` / `advertise` stay until Kingdom and Foundry cut over; the release that follows the
  cutover removes them.

## 0.25.0 — one Installation-socket relay for every operation

Aron, 2026-11-19 (R-2026-11-19-01, "Yes, seems fine."): Kingdom's thread-only relay becomes one
relay any operation can use, so Chorus, which will run on an Installation as a Foundry's
conversations do, reaches its host the same way. Spec: `chorus/docs/GENERAL-RELAY.md` rev 2.
Breaking, hard cut, no behaviour change for conversations:

- **The relay contract is keyed by operation, beside `declaredOperationSchema`.**
  `relayedOperationSchema` (the thread calls and `thread.subscribe`), `relayedOperationInputSchemas`,
  `relayedOperationContextSchemas`, `relayedOperationResultSchemas`, `relayedOperationRefusals`
  (each including `relayedOperationCommonRefusals`: `invalid_request`, `failed`),
  `relayedOperationDeniedRefusals` and `relayedOperationTimeoutMs` (15 s for every thread
  operation, as before). The threads' `threadResultSchemas`, `threadRefusalSchema` and
  `threadDeniedRefusals` are their entries, unchanged. No `provider` on any frame: operation names
  are unique, and providers are Kingdom's. No deadline: the host has none, as before.
- **Frames: `operation.request` (Kingdom → host, keyed by `type`) and `operation.response`
  (host → Kingdom, keyed by `action`)** replace `thread.request`, `thread.subscribe` and
  `thread.response`. The request stays flat: `requestId`, `signetId`, `acceptedRevision`, the
  operation's context fields (threads: `member`, `threadId`, `permissions`,
  `threadOperationContextSchema`), `operation`, `input`. `thread.subscribe` is a relayed request
  on that frame with `input: {}`, admitted by Kingdom as `thread.read`. `thread.append`,
  `thread.unsubscribe`, `thread.lease` and `HolderStreams` are streams and unchanged;
  `threadHostFrameSchema` is now those two Kingdom → host stream frames.
- **Schemas and values:** `operationRequestFrameSchema(operation)`,
  `operationResponseFrameSchema(operation)`, `operationResponseEnvelopeSchema`,
  `relayedOperationResult(result)` and `relayedOperationRefusal(code, message?)` replace
  `threadRequestFrameSchema`, `threadSubscribeFrameSchema`, `threadResponseFrameSchema`,
  `threadResponseEnvelopeSchema`, `threadResult` and `threadRefused`; `OperationRequestFrame<O>`,
  `RelayedOperationOutcome<O>` and `RelayedOperationResult<O>` replace `ThreadRequestOf<O>`,
  `ThreadSubscribeFrame`, `ThreadOutcome<O>` and `ThreadResult<O>`.
- **Host side:** `InstallationSocketOptions.operations` (`RelayedOperationHandlers`, one handler per
  relayed operation) replaces `threads?: ThreadHost`, and `onThreadSubscriptionEnded` replaces its
  `ended`. A missing handler is answered `failed` with "This host serves no `<operation>`". The
  `thread.subscribe` hold-and-replay is unchanged.
- **One behaviour change at the edge:** the response envelope Kingdom reads before it knows the
  request takes any refusal code (it was the threads' enum), so a host outside signet answering a
  code its operation does not declare is now `failed` ("outside the contract", 502) at once, not a
  15 s `host_timeout`. A host built on signet cannot send one: its socket checks every outcome.
- The relay exports are the first non-lens rows in `docs/VERBS.md`.
## 0.24.0 — an ask to change a Signet's entitlements is Kingdom's one `changeEntitlements` inquiry

Aron, 2026-11-18: "we only want one change entitlements system… if you're asking, it should just
be one change entitlements, which is more generic. I think sign entitlement can probably go away."
Breaking, no old name kept (Kingdom drops its `signetEntitlement` inquiry and
`/access/requestSignetEntitlement` in the same change):

- **`requestSignetEntitlement` is `requestEntitlementChange`**, posting to Kingdom's
  `/api/v1/access/requestEntitlementChange`. Kingdom resolves the asked resources to entitlements
  and opens a `changeEntitlements` Inquiry addressed to the Signet; whoever can manage the Signet
  answers (no longer the issuer-or-owner guess).
- **`signetEntitlementRequestSchema` is `entitlementChangeRequestSchema`**: `{ signetId, add,
  remove }`. `reason` is gone; the generic inquiry carries only the change.
- **`signetEntitlementResponseSchema` is `entitlementChangeResponseSchema`** (same fields).
- **`signetEntitlementChangesSchema` is gone.** The approver's copy is Kingdom's own entitlement
  inputs, the body of `POST /signet/:id/entitlements`, not a signet contract.
- One ask is open per Signet: a second is refused (409), where 0.23 replaced the open one. Cancel it
  with `cancelInstallationInquiry`, which now cancels without hiding the inquiry, then ask again.

## 0.23.0 — task settlement is task completion

- **Breaking: the `SignetClient` action `settleTask` is `completeTask`**, posting to Kingdom's
  `/api/v1/access/completeTask` (Kingdom #283; Aron, 2026-11-18: "We should just call it 'complete
  task' then"). It still never renews or retries. Why: "settle" was a metaphor only its author
  read; the call completes a task grant with a receipt. Hard cut, no alias.

## 0.22.0 — json-rules 4.2; the row models are field-map's

- **Requires `@inixiative/json-rules@^4.2.0`** (peer) and depends on `@inixiative/field-map@^0.1.0`.
  Why: json-rules 4.2 takes its schema map from field-map, and the building blocks share one map
  type instead of each declaring the field shape.
- **Breaking: `createOperationsLens`'s `rowModels` is `Record<string, ModelEntry['fields']>`**,
  field-map's fields (`ScalarField`, `EnumField`, `RelationField`, a scalar's `type` one of
  `SCALAR_TYPES`), not json-rules' lens-read `FieldMapEntry`. A row model is a schema model; a
  bridge or a projection's options never belong in one. The operations map is built with
  field-map's own-property readers (`own`, `ownEntry`, `modelOf`), and signet's copy of `ownEntry`
  is gone.
- json-rules 4.0's lens gate (a rule path may not continue past a to-many relation) changes
  nothing here: every lens and filter in the suite already crosses an operation's rows under an
  array rule.

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
