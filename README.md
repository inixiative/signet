# @inixiative/signet

Present Kingdom Signets.

A **Signet** is Kingdom's only grant for using an integration. It names the resources, operations, lens and limits, and it can be revoked. Its grantee is a user or an integration, for example a paired Foundry or a machine's local Archive. The grantee presents it with an access token plus a DPoP proof signed by its device key (RFC 9449).

This package is the one implementation of that protocol, shared by Kingdom (which verifies) and Archive, Foundry and Oracle (which present):

- `contracts`: the wire schemas: keys, lenses, proposals, pairing requests, delivered credentials, `describe` and `execute`, and the conversation frames.
- `proof`: create and verify DPoP proofs (ES256, nonce-bound, access-token-bound).
- `files`: private 0600 JSON files for keys and credentials.
- `client`:
  - an **Installation** (a local Foundry, Archive or Oracle) is an actor known to Kingdom by its key: `registerInstallation`, then `requestRegistration` asks for what it needs (the owner it expects, by organization id or slug, and resources by id or by kind and name, with their operations) and returns a review code a person claims in Kingdom (a `registerIntegration` Inquiry), where the review opens with that owner and those resources selected, then `collectSignet` and `saveCollectedSignet`. `installationInquiries`, `installationSignets`, `cancelInstallationInquiry`, `enrollInstallationSignet` and `rotateInstallationKey` act as the installation;
  - `pairInstallation` does the whole pairing (register, request, wait on the socket, confirm the owner, collect) and `holdInstallationSignets` keeps one credential file per Signet the installation's integrations hold, enrolling later grants and dropping revoked ones;
  - `InstallationSocket`, Kingdom's live line to an installation: it proves the key, receives a snapshot of the installation's inquiries and Signets on connect and on every change, keeps the installation's integrations marked online, advertises its viewer URL, and polls the same reads while the socket is down;
  - a **person or their agent** acts as themselves with a Kingdom API token plus a proof from its key: `requestSignet` asks for a Signet on an integration (a `signetRequest` Inquiry, approved at once when the caller manages the integration), `awaitSignet` polls `collectSignet` until it is approved, and `enrollSignet` enrolls the key on a Signet an owner granted directly (`owner/grant`). `saveCollectedSignet` writes either result next to the key;
  - `SignetClient`, which renews its access token and signs each call: `describe`, `execute`, task settlement, and the run actions a Foundry uses for inference (`resolveRun`, `delegateRun`, `renewRun`, `revokeRun`), and for a subscription run `releaseSubscription` and `reportSubscriptionLimits`.

```ts
import { holdInstallationSignets, InstallationSocket, pairInstallation, SignetClient } from '@inixiative/signet';

const paired = await pairInstallation({
  url: kingdom, root: dataDir, kind: 'archive', name: 'Laptop Archive', sourceId,
  terms: {
    name: 'Laptop Archive', lifecycle: 'ongoing', expiresAt: null, maxRequests: null, maxConcurrent: 4,
    owner: { ownerModel: 'Organization', organization: 'inixiative' },
    resources: [{ resourceKind: 'archiveLibrary', operations: ['sessions.write'] }],
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
  resources: [{ resourceId, operations: ['documents.read'] }],
});
const collected = await awaitSignet(kingdom, keyFile, requestId); // or, for a granted Signet:
// const collected = await enrollSignet(kingdom, keyFile, apiToken, { signetId, expectedRevision, name: 'Research agent' });
await saveCollectedSignet(credentialFile, kingdom, keyFile, collected);
const signet = await SignetClient.fromFile(credentialFile);
await signet.describe();
```

## Agent conversations

A conversation wraps a host Foundry's main thread (Kingdom `docs/AGENT-CONVERSATIONS.md`, Foundry `docs/reference/CONVERSATIONS.md`). A member is a Signet on the host Foundry's one `threads` resource; Kingdom admits each call and relays it over the host's Installation socket, and stores no conversation or message.

- **Lens.** `signetLensSchema` is a union of strict shapes, `archiveLensSchema | threadsLensSchema`, because a resource grant names its resource by id with no kind. `resourceLensSchema(kind)` gives the shape a kind takes; Kingdom checks every grant with it against the kind it stores. A threads lens is `{ threads, view: 'own' | 'thread', delivery: 'note' | 'turn', outbound: 'review' | 'auto' }`, the terms defaulting to the narrowest value. `threads` is a selector, a union on `form`: v1 builds `{ form: 'ids', ids }` (1–100 thread ids); `withMember` and `tag` are named for standing Signets and fail to parse everywhere until a release adds them, so a new form never widens access silently. `narrowsSignetLens` is the rule for approving someone else's request: a subset of ids, `own` < `thread`, `note` < `turn`, `review` < `auto`.
- **Join requests** may name a resource by kind: `requestSignet` takes `{ resourceKind: 'threads', operations, lens }`, and Kingdom resolves it before review.
- **Per-entry reads.** `installationInquiries`, `installationSignets`, the socket snapshot and `describe` read each entry on its own. An entry this package can't read is dropped and listed in `dropped`, and the rest is kept. Inside a Signet, resources are read one by one: a resource with a lens this package can't read (a selector form from a newer Kingdom, a lens that doesn't fit its resource's kind) is dropped, and the Signet stays, so an installation never loses a held Signet, or mistakes a member for revoked, over one resource. The snapshot carries `hostedSignets` (members of this Foundry's conversations) and `hostedSignetRequests` (join requests aimed at its integrations); held Signets carry their `resources`.
- **Host.** `InstallationSocket` takes `threads`, one handler per operation (`thread.read`, `thread.prompt`, `thread.floor`, `prompt.resolve`, `thread.subscribe`), answering `threadResult(...)` or `threadRefused(code)`. A frame with an unknown selector is refused `unknown_selector` before any handler runs. `thread.subscribe` answers with the member's view and the `journalSeq` it was taken at, and the subscription starts there: `appendThread(subscriptionId, entry)` holds entries pushed meanwhile and never sends one twice. Each append carries a dense per-subscription `seq` (a filtered view skips journal entries, so `journalSeq` can't reveal loss); an entry that can't be sent still spends its `seq`, so Kingdom sees the gap and the member resyncs. A subscription ends on `thread.unsubscribe`, when Kingdom stops re-asserting its lease (`thread.lease`; dropped 90 s after the last one, so one late 45 s sweep is survived), or when the socket drops.
- **Member.** An outside agent holds its live views with `SignetSocket`: it authenticates as its Signet's presentation (`authenticateSignet`, a proof bound to `POST /api/v1/access/signetSocket` with `ath`), renews it before the five-minute token expires (`renewPresentation`), and opens one `accessThread` stream per thread: a snapshot, then appends, with Kingdom's `seq`/`resync` rules. Frames are handled in order, one open is in flight per stream, and Kingdom's close carries the reason: after a revision the stream reopens under the new lens, while the host is offline it retries with backoff, when the presentation lapsed the socket re-presents and reopens, and on revocation or expiry it ends (`onClosed`). Posts are separate `execute` calls (`thread.prompt`), each admitted and metered. A Foundry holding a conversation Signet opens the same streams over its Installation socket (`threadStreams`, `openThread`).

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
