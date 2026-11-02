# @inixiative/signet

Present Kingdom Signets.

A **Signet** is Kingdom's only grant for using an integration. It names the resources, operations, lens and limits, and it can be revoked. Its grantee is a user or an integration, for example a paired Foundry or a machine's local Archive. The grantee presents it with an access token plus a DPoP proof signed by its device key (RFC 9449).

This package is the one implementation of that protocol, shared by Kingdom (which verifies) and Archive, Foundry and Oracle (which present):

- `contracts`: the wire schemas: keys, grants (operation picks, lens layers, terms), proposals, pairing requests, delivered credentials, `describe` and `execute`, and the conversation frames.
- `proof`: create and verify DPoP proofs (ES256, nonce-bound, access-token-bound).
- `files`: private 0600 JSON files for keys and credentials.
- `client`:
  - an **Installation** (a local Foundry, Archive or Oracle) is an actor known to Kingdom by its key: `registerInstallation`, then `requestRegistration` asks for what it needs (the owner it expects, by organization id or slug, and resources by id or by kind and name, with their operations) and returns a review code a person claims in Kingdom (a `registerIntegration` Inquiry), where the review opens with that owner and those resources selected, then `collectSignet` and `saveCollectedSignet`. `installationInquiries`, `installationSignets`, `cancelInstallationInquiry`, `enrollInstallationSignet` and `rotateInstallationKey` act as the installation;
  - `pairInstallation` does the whole pairing (register, request, wait on the socket, confirm the owner, collect) and `holdInstallationSignets` keeps one credential file per Signet the installation's integrations hold, enrolling later grants and dropping revoked ones;
  - `InstallationSocket`, Kingdom's live line to an installation: it proves the key, receives a snapshot of the installation's inquiries and Signets on connect and on every change, keeps the installation's integrations marked online, advertises its viewer URL, and polls the same reads while the socket is down;
  - a **person or their agent** acts as themselves with a Kingdom API token plus a proof from its key: `requestSignet` asks for a Signet on an integration (a `signetRequest` Inquiry, approved at once when the caller manages the integration), `awaitSignet` polls `collectSignet` until it is approved, and `enrollSignet` enrolls the key on a Signet an owner granted directly (`owner/grant`). `saveCollectedSignet` writes either result next to the key;
  - `installation`: the layout every installation shares, under one root per product (a Foundry's `kingdom/`, `~/.kcp`): one directory per Kingdom host with its key and one file per Signet (`installationPaths`, `installationDirectory`, `signetCredentialFile`, `heldCredentials`), `privateDirectory`, and `defaultInstallationName(product)`. `listedSignets`, `heldSignetFile` and `withdrawRegistration` read and act on it. `holdPersonSignets` enrolls the key on Signets issued to a person, under the same per-directory `withHoldLock` as `holdInstallationSignets`, so a person login and an installation sync never enroll over each other;
  - `SignetHolders`, a cache of each held Signet's `access/describe` (with its `holder`), keyed by credential file or by the caller's own `keyOf`, refreshed after `stale()`;
  - `SignetClient`, which renews its access token and signs each call: `describe`, `execute`, task settlement, and the run actions a Foundry uses for inference (`resolveRun`, `delegateRun`, `renewRun`, `revokeRun`), and for a subscription run `releaseSubscription`, `reportSubscriptionLimits` and `reportCredentialRejected` (the provider rejected the login a release handed out).

```ts
import { holdInstallationSignets, InstallationSocket, pairInstallation, SignetClient } from '@inixiative/signet';

const paired = await pairInstallation({
  url: kingdom, root: dataDir, kind: 'archive', name: 'Laptop Archive', sourceId,
  terms: {
    name: 'Laptop Archive', lifecycle: 'ongoing', expiresAt: null, maxRequests: null, maxConcurrent: 4,
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
await signet.execute({ integrationId, operation: 'sessions.write', input: { resourceId, snapshot, previousDigest: null } });
```

A person's agent, with an API token minted in Kingdom:

```ts
import { awaitSignet, enrollSignet, generateSignetKey, requestSignet, saveCollectedSignet, SignetClient, writePrivateJson } from '@inixiative/signet';

await writePrivateJson(keyFile, generateSignetKey());
const { requestId, reviewCode } = await requestSignet(kingdom, keyFile, apiToken, {
  name: 'Research agent', integrationId, lifecycle: 'ongoing', expiresAt: null, maxRequests: null, maxConcurrent: 1,
  resources: [{ resourceModel: 'IntegrationResource', integrationResourceId, operations: { picks: ['documents.read'] } }],
});
const collected = await awaitSignet(kingdom, keyFile, requestId); // or, for a granted Signet:
// const collected = await enrollSignet(kingdom, keyFile, apiToken, { signetId, expectedRevision, name: 'Research agent' });
await saveCollectedSignet(credentialFile, kingdom, keyFile, collected);
const signet = await SignetClient.fromFile(credentialFile);
await signet.describe();
```

## Grants

A Signet revision grants one row per resource (`grantResourceSchema`), false polymorphic on `resourceModel`:

- **`IntegrationResource`**: `full`, or `operations` (the resolved leaves; absent when `full`), `lens` (json-rules layers) and `terms` (per kind). `full` reaches everything the resource offers, now and as its catalog grows, capped live by the integration's baseline. It is a different axis from `Integration.full` / `Token.full`, which let a delegate act with its owner's whole authority.
- **`Project`**: a Kingdom project the Signet may be used in. Nothing else: no `full`, operations, lens or terms.

**Operation picks.** A provider's catalog is a flat list of dotted leaf keys per resource kind (`commits.read`, `events.pull_request.review_requested`). A party asks with `operationPickSchema`: `{ full: true }` or `{ picks }`, each pick a leaf or a prefix ending `.*` (`commits.*`, `events.pull_request.*`). `resolveOperationPicks(leaves, pick)` resolves picks to leaves once, when the grant is saved (a pick that reaches nothing throws `OperationPickError`, code `unknown_operation_pick`), so a later catalog addition reaches only `full` rows. `operationTree(leaves)` derives the nested tree a grant UI offers, every node with the pick that takes it. `narrowsOperations(inner, outer)`: a full `outer` contains everything, and a full `inner` under an `outer` that is not full is never a narrowing. `permitsOperation(scope, operation)` answers one operation; `scopeRefusal(scope, catalog, refusal)` runs a per-operation refusal over every catalog operation a row reaches (all of them when full, so re-run it when the catalog grows).

**Lens.** A grant's lens is a chain of json-rules layers over the integration's base lens for the resource's model, which Kingdom's catalog holds as code under `provider:kind`. A root `where` filters rows; picks and omits trim the shape; no lens means the base. A party writes one layer (`lensLayerSchema`, a json-rules narrowing without its parent); Kingdom stores it as a `StoredLens` record (`storedLensLayerSchema`) under the base, an approver's layer under the request's, so every layer ANDs and an approver can only narrow. This package depends on json-rules for types only, and checks only a layer's envelope: Kingdom validates (`validateNarrowing`), composes (`composeLens`) and applies (`projectRows`) the layers. The base's id is `baseLensId(provider, kind)`. The refusals below read a `GrantLens`: the grant's own layers plus `projectLens` of the composed chain (`projectionFilters`, `projectionShows`). A `where` runs over a row: `repositoryCallRow(input)` (`{ sha }`) for a repository call, `threadRow(threadId)` (`{ id }`) for a thread.

**Terms** are neither operations nor lens: how a holder takes part (`grantTermsSchema`, strict per kind; `grantTermsFitKind(kind, terms)`). Today only `threads` has terms.

What a party asks for (`signetResourceSchema` by id, `requestedResourceSchema` by id or by kind) carries picks, its own lens layer and terms (a request has no kind, so Kingdom checks `grantTermsFitKind` once it resolves the resource); what a holder reads (`signetGrantSchema`) is the stored row plus the resource's `kind`.

## Declared operations

An integration whose operations Kingdom executes generically declares them here, one module per resource kind: `threads.ts` for a Foundry's `threads` resource, `archive.ts` for an Archive's `archiveLibrary`, `github.ts` for a GitHub `repository` (reads by object id). Each declares its operation enum, display names and the input each operation takes. `declaredOperationSchema` and `operationInputSchemas` join them (operation names are unique across contracts), `operationInputKeys(operation)` gives the `access/execute` keys an operation takes besides `resourceId` and `limit`, and `operationInputFromAccess(operation, input)` picks and parses exactly those. Kingdom's catalog, its input check and its dispatch read these, so a new operation is added here first.

- **Archive** (`archiveLibrary`): `documents.read`, `documents.search`, `sessions.write`, `sessions.delete`. `archiveSourceOperations` (`sessions.write`, `sessions.delete`) are a paired local Archive acting on its own sessions: Kingdom binds them to its `sourceId`, so their grant takes no lens. `archiveLensRefusal(operation, lens)` says why a grant can't carry its lens (search needs content over every document: no `where`, `content` shown), and `archiveGrantRefusal(scope, lens)` checks a whole row.
- **GitHub** (`repository`): `commits.read`, `trees.read`, `blobs.read`. A grant pins commits with a `where` over the call's `{ sha }`; reading a commit never reaches its tree, so `repositoryLensRefusal(operation, lens)` (and `repositoryGrantRefusal(scope, lens)` for a row) refuses trees and blobs under a pinned grant.

## Agent conversations

A conversation wraps a host Foundry's main thread (Kingdom `docs/AGENT-CONVERSATIONS.md`, Foundry `docs/reference/CONVERSATIONS.md`). A member is a Signet on the host Foundry's one `threads` resource; Kingdom admits each call and relays it over the host's Installation socket, and stores no conversation or message.

- **Terms.** A member's `threads` terms (`threadsTermsSchema`) are `{ view: 'own' | 'thread', delivery: 'note' | 'turn', outbound: 'review' | 'auto', floor: { mayTake } }`, each defaulting to its narrowest value (`threadsTerms(terms)` reads them so). Which threads a member reaches is the grant's lens (a `where` over the thread's `id`), which Kingdom applies at admission. `narrowsThreadsTerms` is the rule for approving someone else's request: `own` < `thread`, `note` < `turn`, `review` < `auto`, `floor.mayTake` only where asked. Kingdom relays the terms on every frame (`terms`).
- **Join requests** may name a resource by kind: `requestSignet` takes `{ resourceKind: 'threads', operations, lens, terms }`, and Kingdom resolves it before review.
- **Per-entry reads.** `installationInquiries`, `installationSignets`, the socket snapshot and `describe` read each entry on its own. An entry this package can't read is dropped and listed in `dropped`, and the rest is kept. Inside a Signet, resources are read one by one: a resource this package can't read (a term from a newer Kingdom, terms that don't fit its resource's kind) is dropped, and the Signet stays, so an installation never loses a held Signet, or mistakes a member for revoked, over one resource. The snapshot carries `hostedSignets` (members of this Foundry's conversations) and `hostedSignetRequests` (join requests aimed at its integrations); held Signets carry their `resources`.
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
  input: { resourceId, threadId, postId: crypto.randomUUID(), text: 'The role you wanted opened' },
});
```

Kingdom's OpenAPI spec (`/openapi/docs`) publishes each step's raw HTTP call and credentials.

MIT
