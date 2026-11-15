# @inixiative/signet

> Part of [inixiative](https://www.inixiative.com), technology for cooperation. See [all the projects](https://github.com/inixiative).

Pass-through execution with tracking and audit. A Signet is how anything uses an integration through Kingdom: a revocable pass on the owner's terms. Kingdom decides who may grant and use one with [`@inixiative/permissions`](https://github.com/inixiative/permissions); a grant's lens is [json-rules](https://github.com/inixiative/json-rules). This package presents Kingdom Signets.

A **Signet** is Kingdom's only grant for using integrations. It has an owner and no integration of its own: it names resources, each on its own integration, with their operations, lens and limits, and it can be revoked. Its grantee is a user or an integration, for example a paired Foundry or a machine's local Archive. The grantee presents it with an access token plus a DPoP proof signed by its device key (RFC 9449).

This package is the one implementation of that protocol, shared by Kingdom (which verifies) and Archive, Foundry, Oracle and KCP (which present):

- `contracts`: the wire schemas: keys, grants (operation picks, lens layers), proposals, pairing requests, delivered credentials, `describe` and `execute`, and the conversation frames.
- `proof`: create and verify DPoP proofs (ES256, nonce-bound, access-token-bound).
- `files`: private 0600 JSON files for keys and credentials.
- `client`:
  - an **Installation** (a local Foundry, Archive or Oracle) is an actor known to Kingdom by its key: `registerInstallation`, then `requestRegistration` asks for what it needs (the owner it expects, by organization id or slug, and resources by id or by kind and name, with their operations) and returns a review code a person claims in Kingdom (a `registerIntegration` Inquiry), where the review opens with that owner and those resources selected, then `collectSignet` and `saveCollectedSignet`. `installationInquiries`, `installationSignets`, `cancelInstallationInquiry`, `enrollInstallationSignet` and `rotateInstallationKey` act as the installation. `requestSignetEntitlement` asks for more on a Signet the installation already holds (resources by id or by kind, projects by id, and a reason): Kingdom sends a `signetEntitlement` Inquiry to the person who issued the Signet, and approval adds what they approve, never more than asked, as a new revision of the same Signet; one request is open per Signet, and its `reviewUrl` is also on the installation's inquiries;
  - `pairInstallation` does the whole pairing (register, request, wait on the socket, confirm the owner, collect) and `holdInstallationSignets` keeps one credential file per Signet the installation's integrations hold, enrolling later grants and re-enrolling when Kingdom no longer reports the file's enrollment as current (a rotated key, a revoked or expired enrollment). It never deletes a file: a Signet missing from a snapshot (a paused integration) keeps its file;
  - `InstallationSocket`, Kingdom's live line to an installation: it proves the key, receives a snapshot of the installation's inquiries and Signets on connect and on every change, keeps the installation's integrations marked online, advertises its viewer URL, and polls the same reads while the socket is down;
  - a **person or their agent** acts as themselves with a Kingdom API token plus a proof from its key: `requestSignet` asks for a Signet over the resources it names (a `signetRequest` Inquiry, approved at once when the caller manages every integration it asks on), `awaitSignet` polls `collectSignet` until it is approved, and `enrollSignet` enrolls the key on a Signet an owner granted directly (`owner/grant`). `saveCollectedSignet` writes either result next to the key;
  - `installation`: the layout every installation shares, under one root per product (a Foundry's `kingdom/`, `~/.kcp`): one directory per Kingdom host with its key and one file per Signet (`installationPaths`, `installationDirectory`, `signetCredentialFile`, `heldCredentials`, and `heldSignetCredential` for one file: null when it is missing or an older client wrote it), `privateDirectory`, and `defaultInstallationName(product)`. `listedSignets`, `heldSignetFile` (enrolling again a Signet whose file is missing or unreadable, while Kingdom lists it) and `withdrawRegistration` read and act on it. `holdPersonSignets` enrolls the key on Signets issued to a person, under the same per-directory `withHoldLock` as `holdInstallationSignets`, so a person login and an installation sync never enroll over each other;
  - `SignetHolders`, a cache of each held Signet's `access/describe` (with its `holder`), keyed by credential file or by the caller's own `keyOf`, refreshed after `stale()`;
  - `SignetClient`, which renews its access token and signs each call: `describe`, `execute`, task settlement, and the run actions a Foundry uses for inference (`resolveRun`, `delegateRun`, `renewRun`, `revokeRun`), and for a subscription run `releaseSubscription`, `reportSubscriptionLimits` and `reportCredentialRejected` (the provider rejected the login a release handed out).

```ts
import { holdInstallationSignets, InstallationSocket, pairInstallation, SignetClient } from '@inixiative/signet';

const paired = await pairInstallation({
  url: kingdom, root: dataDir, kind: 'archive', name: 'Laptop Archive', sourceId,
  terms: {
    name: 'Laptop Archive', lifecycle: 'ongoing', expiresAt: null, maxRequests: null,
    owner: { ownerModel: 'Organization', organization: 'inixiative' },
    resources: [{ resourceKind: 'archiveLibrary', operations: { picks: ['sessions.write'] } }],
  },
  onReview: ({ review }) => console.log(`Approve in Kingdom: ${review}`),
  confirmOwner: async ({ ownerName }) => confirm(`Pair with ${ownerName}?`),
});

new InstallationSocket({
  url: kingdom,
  keyFile: paired.keyFile,
  onSnapshot: ({ signets }) => holdInstallationSignets(kingdom, paired.keyFile, paired.directory, signets),
}).start();

const signet = await SignetClient.fromFile(paired.credentialFile);
// paired.integrationId is the integration this installation became, from the approved registration
await signet.execute({ integrationId: paired.integrationId, operation: 'sessions.write', input: { resourceId, snapshot, previousDigest: null } });
```

A person's agent, with an API token minted in Kingdom:

```ts
import { awaitSignet, enrollSignet, generateSignetKey, requestSignet, saveCollectedSignet, SignetClient, writePrivateJson } from '@inixiative/signet';

await writePrivateJson(keyFile, generateSignetKey());
const { requestId, reviewCode } = await requestSignet(kingdom, keyFile, apiToken, {
  name: 'Research agent', lifecycle: 'ongoing', expiresAt: null, maxRequests: null,
  resources: [{ resourceModel: 'IntegrationResource', integrationResourceId, operations: { picks: ['documents.read'] } }],
});
const collected = await awaitSignet(kingdom, keyFile, requestId); // or, for a granted Signet:
// const collected = await enrollSignet(kingdom, keyFile, apiToken, { signetId, expectedRevision, name: 'Research agent' });
await saveCollectedSignet(credentialFile, kingdom, keyFile, collected);
const signet = await SignetClient.fromFile(credentialFile);
await signet.describe();
```

## Grants

A Signet revision grants rows (`grantResourceSchema`), each naming one resource or a scope, false polymorphic on `resourceModel`:

- **`IntegrationResource`**: `full`, or `operations` (the resolved leaves; absent when `full`), and `lens` (json-rules layers). `full` reaches everything the resource offers, now and as its catalog grows, capped live by the integration's baseline. It is a different axis from `Integration.full` / `Token.full`, which let a delegate act with its owner's whole authority.
- **`Integration`**: a scope, not one resource: the same `full` / `operations` / `lens` / `where` on every resource of `kind` on the integration, now and later, or with `projectId` only those in that Kingdom Project. Which scope a row names is what was granted (Aron, 2026-11-14: per-conversation is the usual grant, "but if you want to, you can do project-scoped, the whole Foundry, or the whole integration level"); nothing that reads a grant may assume a row names one resource. What a row reaches is Kingdom's to answer. Its `projectId` narrows which resources the row reaches; that is not the `Project` row below, which says where the Signet may be used. Its `where` is an entitlement condition, positive only, as on a resource row.
- **`Project`**: a Kingdom project the Signet may be used in. Nothing else: no `full`, operations or lens.

**Operation picks.** A provider's catalog is a flat list of dotted leaf keys per resource kind (`commits.read`, `events.pull_request.review_requested`). A party asks with `operationPickSchema`: `{ full: true }` or `{ picks }`, each pick a leaf or a prefix ending `.*` (`commits.*`, `events.pull_request.*`). `pickCovers(pick, leaf)` is the one rule for what a pick takes: a pick ending `.*` takes every leaf under its prefix, and any other pick takes the leaf of exactly that key, so a branch is always written with `.*`. `resolveOperationPicks(leaves, pick)` resolves picks to leaves once, when the grant is saved (a pick that reaches nothing throws `OperationPickError`, code `unknown_operation_pick`), so a later catalog addition reaches only `full` rows. `operationTree(leaves)` derives the nested tree a grant UI offers, every node with the pick that takes it. `narrowsOperations(inner, outer)`: a full `outer` contains everything, and a full `inner` under an `outer` that is not full is never a narrowing. `permitsOperation(scope, operation)` answers one operation; `scopeRefusal(scope, catalog, refusal)` runs a per-operation refusal over every catalog operation a row reaches (all of them when full, so re-run it when the catalog grows).

**Lens.** A grant row's lens is its own json-rules layers over the resource kind's operations lens, which Kingdom generates from its catalog under `provider:kind` (`operationsLens({ model, operations, rowModel, rowModels })`): the anchor is the kind's operations, each dotted segment of an operation a relation (the same shape as a Prisma map, nesting included), and each operation a list of the rows it reads (`ArchiveDocument`, `Thread`, `RepositoryCall`, `IntegrationEvent`). Relations are off until a layer turns them on, so a layer turns on the branches it keeps (`everyBranch(operations, leafNarrowing?)`) and narrows a row shape everywhere with `mapDefaults` (`rowModelLayer(operations, row, narrowing)`: a `where` filters rows; picks and omits trim the shape), or one branch through `root.relations` (`narrowingAtOperation(operation, narrowing)`); a row with no layers reads every branch. A party writes one layer (`lensLayerSchema`, a json-rules narrowing without its parent); Kingdom stores it as a `StoredLens` record (`storedLensLayerSchema`) under the base, an approver's layer under the request's, so every layer ANDs and an approver can only narrow. `composeGrantLens(baseId, base, storedLayers)` composes a row's layers over the base (json-rules `composeLens`, which validates each layer and the order of the chain) and throws `GrantLensError` when they don't parse, aren't one chain, or don't compose; `rowsThroughLens(lens, operation, rows)` reads an operation's rows through the result. Kingdom and a host both use these two. The base's id is `baseLensId(provider, kind)`.

A `where` that filters rows goes at the operation's own branch. One above it (on the root, or on a branch that holds several operations) is over the whole list, so it would show every row as soon as one matched; `composeGrantLens` refuses it. `conditionAtOperation(operation, condition)` writes a call's own filter as a rule for json-rules `validateRuleInLens` and is never a lens `where`. A lens `where` may use negated operators: it shapes what comes back and decides no permission.

Rows are read at an operation's branch: `operationRecord(operation, rows)` nests them for `projectRows` and `operationRows(record, operation)` reads them back. The refusals below read a `GrantLens`: the row's own layers plus `projectLens` of them composed over the base, at each operation's branch (`projectionVisit`, `projectionFilters`, `projectionShows`). A `GrantLens` describes one row. What a holder reaches in the end is Kingdom's to work out, and nothing here names another Signet, a budget or a path. The row an operation reads: `repositoryCallRow(input)` (`{ sha }`) for a repository call, `threadRow(threadId)` (`{ id }`) for a conversation's thread.

**Where.** A resource ask's `where` (`grantWhereSchema`) is the incoming side: a positive json-rules condition over the call (its input fields, such as `objectId`), which Kingdom checks before the call runs. This package refuses an empty or malformed one, an `all` or `any` that is empty or lists a bare `true` or `false` (at any depth), a non-positive one (json-rules `validateRule(where, { positive: true })`: no negated operator, since a `where` decides permission) and one longer than `grantWhereLimit` (16,000) characters as JSON. `equals null` is json-rules' "no value" form and is accepted: it admits a call that leaves the field out. A grant view (`signetGrantSchema`) carries the row's `where` whole, as the condition its calls must meet (`storedWhereSchema`). It is read as it is, whatever its size, so a holder never loses its own row over it; checking it is Kingdom's, at admission, and a holder never gates on it. The lens is the outgoing side. A grant that pins commits sends both: `objectId in […]` as its `where`, and the same ids as its lens pin.

**Owner.** A request may name the one owner it asks (`namedOwnerSchema`): the ids its model is keyed by (`ownerIdFields`) and every other id present and null, among `userId`, `organizationId`, `spaceId` and `integrationId`. A Signet's owner is one of the five owner models or an Integration in its own right (`signetOwnerModelSchema`), which is keyed by `integrationId` alone. The owner a holder reads back (`ownerRefSchema`, on a collected or held Signet) is still one of the five.

What a party asks for (`signetResourceSchema` by id, `requestedResourceSchema` by id or by kind on the integration it names with `integrationId`) carries picks and its own lens layer. By kind, `externalId` names one resource of that kind (a conversation's thread id); without it the ask reaches every resource of the kind on the integration. An Installation registering asks by id or by kind alone (`registeredResourceSchema`): the integration it becomes does not exist yet. What a holder reads (`signetGrantSchema`) is the stored row plus the resource's `kind`, the `integrationId` and, where the holder acts by it, its `externalId` of the integration it is on; a call names that integration (`execute({ integrationId, … })`).

## Declared operations

An integration whose operations Kingdom executes generically declares them here, one module per resource kind: `threads.ts` for a Foundry's `conversation` resources, `archive.ts` for an Archive's `archiveLibrary`, `github.ts` for a GitHub `repository` (reads by object id). Each declares its operation enum, display names and the input each operation takes. `declaredOperationSchema` and `operationInputSchemas` join them (operation names are unique across contracts), `operationInputKeys(operation)` gives the `access/execute` keys an operation takes besides `resourceId` and `limit`, and `operationInputFromAccess(operation, input)` picks and parses exactly those. Kingdom's catalog, its input check and its dispatch read these, so a new operation is added here first.

- **Archive** (`archiveLibrary`): `documents.read`, `documents.search`, `sessions.write`, `sessions.delete`. `archiveSourceOperations` (`sessions.write`, `sessions.delete`) are a paired local Archive acting on its own sessions: Kingdom binds them to its `sourceId`, so their grant takes no lens. `archiveLensRefusal(operation, lens)` says why a grant can't carry its lens (search needs content over every document: no `where` at its branch, `content` shown there), and `archiveGrantRefusal(scope, lens)` checks a whole row.
- **GitHub** (`repository`): `commits.read`, `trees.read`, `blobs.read`. A grant pins commits with a `where` over the call's `objectId` (what may be asked) and a lens pin over the `RepositoryCall` rows' `sha` (what comes out); reading a commit never reaches its tree, so `repositoryLensRefusal(operation, lens)` (and `repositoryGrantRefusal(scope, lens)` for a row) refuses trees and blobs whose branch the lens filters.

## Agent conversations

A conversation wraps a host Foundry's main thread (Kingdom `docs/AGENT-CONVERSATIONS.md`, Foundry `docs/reference/CONVERSATIONS.md`). It is an integration resource of the host Foundry (Aron, 2026-11-14): one `conversation` resource per shared thread (`conversationResourceKind`), its `externalId` the thread's id. A member is a Signet with an entitlement on that resource; Kingdom admits each call and relays it over the host's Installation socket, and stores no post.

- **Calls and permissions.** The resource's catalog has two parts. The calls (`threadOperationSchema`): `thread.read`, `thread.prompt`, `thread.floor`, `prompt.resolve`. And the permissions (`conversationPermissionSchema`), which a grant picks like any operation and nothing calls, as with the `events.*` leaves: `member.log` (read the whole conversation, not only its own posts and the sends to it), `member.wake` (a post wakes the host's agent instead of riding its next turn), `member.take` (take the floor without being given it), `member.agent` (bring its own agent, not only itself as a person; Kingdom cannot tell a person's post from an agent's, so the host counts on it and nothing enforces it), `agent.instruct` (its posts are instructions, not data), `agent.read` and `agent.act` (what the host's agent may do on its word without asking the host). None is a declared operation, so none can be called, and they sit on their own branches (`member.`, `agent.`), so `thread.*` picks the calls alone. `conversationActLevel(permissions)` reads the act level from the highest held: `full` with `agent.act`, `read` with `agent.read`, else `ask`. Approving a request narrows like any operation selection. Kingdom sends the host the permissions the Signet holds on the conversation on every frame (`permissions`, each admitted on its own, as an event leaf is), beside the conversation's `threadId`; no call's input names the thread, because the call's resource is the conversation. What is the host's own choice about a member (whether its sends to them wait for review, `conversationOutboundSchema`; whether an agent speaks or listens) is the host's setting and is not on the grant. A holder reads a conversation resource's `externalId` on its grant rows and in `describe` (Kingdom sends no other kind's provider id): it is the thread id its stream opens by (`socket.open(threadId)`), while its calls name the resource (`resourceId`).
- **Join requests** may name a conversation by kind: `requestSignet` takes `{ resourceKind: 'conversation', integrationId, externalId, operations }`, the Foundry's integration and the thread's id, and Kingdom resolves it before review. A `conversation` ask without a thread id is refused: it would reach every conversation of that Foundry.
- **Per-entry reads.** `installationInquiries`, `installationSignets`, the socket snapshot and `describe` read each entry on its own. An entry this package can't read is dropped and listed in `dropped`, and the rest is kept. Inside a Signet, resources are read one by one: a resource this package can't read is dropped, and the Signet stays, so an installation never loses a held Signet, or mistakes a member for revoked, over one resource. The snapshot carries `hostedSignets` (members of this Foundry's conversations) and `hostedSignetRequests` (join requests aimed at its integrations, each requester marked `inOrg` or `outside` by Kingdom, so the host can start the review from its default for that audience); a hosted Signet's `recipient` carries its `audience` too (`owner`, `inOrg` or `outside`): the host's settings for that member start from it, and `owner` (the recipient is the person who owns the integration; never an Integration recipient, never on an integration an organization or space owns) is the only thing that makes a Signet the owner's own client, since anyone may be granted `prompt.resolve`; a hosted request's `resourceHandles` give the thread id of each conversation it names; held Signets carry their `resources`.
- **Host.** `InstallationSocket` takes `threads`, one handler per operation (`thread.read`, `thread.prompt`, `thread.floor`, `prompt.resolve`, `thread.subscribe`), answering `threadResult(...)` or `threadRefused(code)`. A frame this package can't read is refused `invalid_request` before any handler runs. `thread.subscribe` answers with the member's view and the `journalSeq` it was taken at, and the subscription starts there: `appendThread(subscriptionId, entry)` holds entries pushed meanwhile and never sends one twice. Each append carries a dense per-subscription `seq` (a filtered view skips journal entries, so `journalSeq` can't reveal loss); an entry that can't be sent still spends its `seq`, so Kingdom sees the gap and the member resyncs. A subscription ends on `thread.unsubscribe`, when Kingdom stops re-asserting its lease (`thread.lease`; dropped 90 s after the last one, so one late 45 s sweep is survived), or when the socket drops.
- **Member.** An outside agent holds its live views with `SignetSocket`: it authenticates as its Signet's presentation (`authenticateSignet`, a proof bound to `POST /api/v1/access/signetSocket` with `ath`), renews it before the five-minute token expires (`renewPresentation`), and opens one `accessThread` stream per thread: a snapshot, then appends, with Kingdom's `seq`/`resync` rules. Frames are handled in order, one open is in flight per stream, and Kingdom's close carries the reason: after a revision the stream reopens under the new revision, while the host is offline it retries with backoff, when the presentation lapsed the socket re-presents and reopens, and on revocation or expiry it ends (`onClosed`). Posts are separate `execute` calls (`thread.prompt`), each admitted and metered. A Foundry holding a conversation Signet opens the same streams over its Installation socket (`threadStreams`, `openThread`).

```ts
import { SignetClient, SignetSocket } from '@inixiative/signet';

const signet = await SignetClient.fromFile(credentialFile);
const socket = new SignetSocket({
  client: signet,
  onSnapshot: ({ threadId }, view) => show(threadId, view.entries),
  onEntry: ({ threadId }, entry) => append(threadId, entry),
  onClosed: ({ threadId }, reason) => console.log(`left ${threadId}: ${reason}`),
});
socket.open(threadId);
socket.start();
await signet.execute({
  integrationId,
  operation: 'thread.prompt',
  input: { resourceId, postId: Bun.randomUUIDv7(), text: 'The role you wanted opened' },
});
```

## Integration events

An integration that receives its provider's events (GitHub, Slack, Linear) streams each one to the Signets whose grant picks its kind (Kingdom `docs/INTEGRATION-EVENTS.md`). Event kinds are operation leaves (`events.<event>.<action>`, `eventOperationKey`), picked like any other, and they are streamed, never executed.

- **Channels.** A channel is one resource a Signet holds event operations on. `describe` and each held Signet of the Installation snapshot carry `eventChannels` (`eventChannelMapSchema`): per integration `{ id, provider, name }`, per channel `{ resourceId, kind, name, events, stream }`. They are read per entry: an integration or channel this package can't read is dropped and listed in `dropped`, and the Signet is kept. The field is absent when Kingdom sent none (a Kingdom before integration events), which says nothing about what the Signet holds.
- **Holding a channel.** `SignetSocket` takes `eventStreams` (`EventStreamHandlers`) and holds a channel by its resource: `openEventChannel(resourceId)`, `leaveEventChannel(resourceId)`, `heldEventChannels()`. `InstallationSocket` takes the same for the Signets an installation holds, keyed `{ signetId, resourceId }`. Each channel is one `accessEvents` stream on the socket that carries thread streams, run by the same code (`DataStreams`), wired once for both sockets (`HolderStreams`), so Kingdom's close means the same: after a revision of the holder's Signet the channel reopens under the new revision (at once; with backoff when Kingdom refuses that reopen as `revised` too), when the presentation lapsed the socket authenticates again on a new connection and reopens, a dropped socket reopens what it held, Kingdom's `resync` (its own subscriber reconnected) reopens it, a close it is reopened after is reported first (`onReopening(channel, reason)`), a lost connection is reported once (`onDisconnected` on the socket), an offline host is retried with backoff, and on revocation, expiry or a refused open the channel ends (`onClosed`). `reopenedCloseReasons` lists the closes a stream is reopened after (`revised`, `presentationExpired`, `hostOffline`; `closeIsReopened(reason)`), and `onReopening` reports only those. A close reason is about the holder's own Signet: `revoked`, `revised`, `expired` and `enrollmentRevoked` never describe anything else, and a change elsewhere closes a stream as `unauthorized`, with no further reason, only once nothing admits it. A refused presentation is reported as a `SignetPresentationRefused` error. Opens are paced, ten per two and a half seconds for each kind of stream (`openBurst`, `openWindowMs` on either socket), because Kingdom closes a socket that sends more than 120 frames in ten seconds: a holder of many channels sees them open over a few windows, after every reconnect too. Thread streams are paced the same way. Leaves are not paced, so leaving more than about a hundred streams in one go costs a reconnect.
- **Live only.** A channel's snapshot is always empty and nothing is replayed. `onEvent(channel, { type, event }, seq)` receives each event as that channel's Signet projects it, from the moment Kingdom opens the channel (`onOpened`, again after every reopen). A holder that is offline misses what is published meanwhile, as it does between a close and the reopen, and there is nowhere to read it back from.
- **Gaps.** A thread stream whose `seq` jumps reopens for a fresh snapshot, which holds what it missed. A channel's snapshot holds nothing, so every append that arrives is delivered, whatever its `seq`, and a `seq` that isn't the next one (a jump, or a count that went back) is reported: `onGap(channel, { after, seq })`, just before the event that showed it. A gap means one of two things this package can't tell apart: Kingdom's counter for the stream expired after 24 quiet hours and started again from the clock (nothing was lost), or appends in between never arrived (they are gone). A reconnect reports no gap; it shows as `onOpened`. Frames are handled one at a time, so a handler slower than Kingdom holds back the ones behind it: past `maxQueuedFrames` waiting (1,000 unless set on the socket) appends are dropped, reported once through `onError`, and show as a gap on a channel or a resync on a thread, at the next append or once the handlers have caught up.
- **Duplicates.** Nothing is deduped here: an event is delivered once per channel it arrives on. A holder with two Signets on one resource gets the event on both channels, each cut by its own Signet's lens, so the two bodies can differ. Every event carries `id`, a UUID Kingdom mints once per event, after it has dropped the provider's retried deliveries (which it does for three days, by the provider's delivery id). The `id` is the same on every channel the event reaches and a lens can't drop it, so a consumer that must act once dedupes on `event.id`.
- **What a lens can name.** An event reaches a holder as the `IntegrationEvent` row its Signet's lens projects. A layer at an `events.*` branch names only the row fields, `integrationEventFieldSchema`: `id`, `integrationId`, `provider`, `at`, `actor`, `scope`, `mentions`, `assignees`, `requestedReviewers`, `subject`, `excerpt` and `payload`, the provider's whole event as it arrived (a layer keeps or drops it whole). `id` is the row's identifier: a layer can filter on it and can never leave it out (Kingdom refuses a lens that does). `type` rides outside the projected body on every append, and the provider's delivery id (`eventId`) stays in Kingdom, so a layer that picks or filters on either does not compose.
- **Truncation.** Kingdom caps an append's size. When the projected event is over the cap, it arrives without `payload` and the append carries `truncated: true`; the other fields are whole. A holder that needs the full body reads it from the provider.

```ts
import { SignetClient, SignetSocket } from '@inixiative/signet';

const signet = await SignetClient.fromFile(credentialFile);
const { eventChannels = [] } = await signet.describe();
const socket = new SignetSocket({
  client: signet,
  eventStreams: {
    onEvent: ({ resourceId }, { type, event }) => notify(resourceId, event.id, type, event),
    onGap: ({ resourceId }, { after, seq }) => console.warn(`${resourceId}: seq ${after} -> ${seq}`),
    onClosed: ({ resourceId }, reason) => console.log(`stopped listening on ${resourceId}: ${reason}`),
  },
});
for (const { channels } of eventChannels)
  for (const channel of channels) socket.openEventChannel(channel.resourceId);
socket.start();
```

Kingdom's OpenAPI spec (`/openapi/docs`) publishes each step's raw HTTP call and credentials.

MIT
