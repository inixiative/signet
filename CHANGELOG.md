This file starts at 0.17.0. Earlier releases are described in their pull requests: 0.15.0 (threads
terms `posts`, `act` and `agent`, #33) and 0.16.0 (a hosted request carries its requester's
audience, #35).

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
  `event.id`, which is the same on every channel the event reaches. An append with `eventId`, or
  whose `event` has no `id`, does not parse.
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
  `operationRows`, `projectionVisit`, `operationsMapName`. Kingdom and Foundry each had their own
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
  (`validateRule(where, { positive: true })`: no negated operator) that is non-empty at every depth
  (no `{}`, no empty `all` or `any`) and at most `grantWhereLimit` (16,000) characters as JSON. A
  grant view (`signetGrantSchema`) shows the row's `where` whole, read with `storedWhereSchema`: any
  size, so a holder never loses its own row over it. Kingdom admits every call; a holder does not
  gate on it. A lens `where` may use negated operators: only a grant's `where` decides permission.
- **`owner` on a proposal.** `signetProposalSchema` (and `signetRequestSchema`) may name the one
  owner a request asks, as `namedOwnerSchema`: no other keys, the ids its model is keyed by
  (`ownerIdFields`: User a `userId`; Organization an `organizationId`; Space an `organizationId`
  and `spaceId`; OrganizationUser an `organizationId` and `userId`; SpaceUser all three;
  Integration an `integrationId`) and every other id present and null, `integrationId` included.
  `signetOwnerModelSchema` is the five owner models and `Integration`.
- **Event channels**, through which a Signet holder listens to its integration's events:
  `eventChannels` on `installationSignetSchema` and `signetDescriptionSchema`
  (`eventChannelMapSchema`, `eventChannelSchema`), read per entry (`parseEventChannelMap`), and
  `eventStreams` on both sockets, wired once (`HolderStreams`).
- **Streams.** Opens are paced (`openBurst`, `openWindowMs`). A stream Kingdom keeps closing as
  `revised` is reopened at once the first time and with backoff after. A `presentationExpired`
  close on an Installation socket reconnects it, as on a Signet socket. At most `maxQueuedFrames`
  (1,000) frames wait on the handlers; appends past that are dropped and reported, and show as a
  gap or a resync. An event channel reports a `seq` that went back as a gap, not only a jump.
  `reopenedCloseReasons` and `closeIsReopened(reason)` say which closes are reopened after, and a
  refused presentation is reported as a `SignetPresentationRefused` error.
- **Close reasons describe the holder's own Signet.** `revoked`, `revised`, `expired` and
  `enrollmentRevoked` never describe anything else; a change elsewhere closes a stream as
  `unauthorized`, with no further reason.
- A dropped grant row is reported under its `integrationResourceId` (`dropped[].id`).
