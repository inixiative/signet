# Installations and holders

How a holder gets a Signet, keeps its credential files current, and calls with it. There are two kinds of holder:

- an **Installation**: a Foundry, Archive, Oracle or Chorus on a machine (`installationKindSchema`), known to Kingdom by its key. It holds Signets granted to the integration it became when it paired.
- a **person or their agent**, acting as themselves with a Kingdom API token plus a proof from its own key.

## Pairing an installation

`pairInstallation` does the whole pairing:

1. **Register** the key (`registerInstallation`). Kingdom retires the key of an Installation it removed (an unclaimed or orphaned sweep, or a disconnect); pairing answers that refusal by setting the old key aside and registering a new one.
2. **Request** what it needs (`requestRegistration`): the owner it expects (by organization id or slug) and resources by id or by kind and name, with their operations. Kingdom returns a review code (`onReview`).
3. **A person claims the code in Kingdom.** This is a `registerIntegration` Inquiry. The review opens with that owner and those resources selected.
4. **Wait** on the socket, falling back to polling.
5. **Confirm the owner** (`confirmOwner`), then **collect** the Signet (`collectSignet`, `saveCollectedSignet`).

The result carries `keyFile`, `directory`, `credentialFile` and `integrationId`: the integration this installation became.

`withdrawRegistration` withdraws an open pairing.

## Acting as the installation

| Function | Does |
| --- | --- |
| `installationInquiries` | The installation's inquiries. |
| `installationSignets` | The Signets its integrations hold. |
| `enrollInstallationSignet` | Enrolls the key on one held Signet. |
| `rotateInstallationKey` | Replaces the key. |
| `cancelInstallationInquiry` | Withdraws an open inquiry. |
| `requestEntitlementChange` | Asks to change what a held Signet carries (below). |

**Changing a held Signet.** `requestEntitlementChange` names resources to add (by id or by kind), projects by id, and held rows to remove by id. Kingdom resolves the resources to entitlements and opens its one `changeEntitlements` Inquiry, addressed to the Signet. Whoever can manage the Signet answers it with a whole copy of the change, narrower or wider than the request. Each entitlement in that copy is checked by the ordinary grant check on the approver and applied as a new revision of the same Signet.

- One ask is open per Signet. A second is refused with 409; withdraw the first with `cancelInstallationInquiry`.
- The ask's `reviewUrl` is also on the installation's inquiries.

## Keeping credential files current

`holdInstallationSignets(url, keyFile, directory, signets)` keeps one credential file per Signet the installation's integrations hold. It enrolls new grants and re-enrolls when Kingdom no longer reports the file's enrollment as current (a rotated key, a revoked or expired enrollment).

It never deletes a file. A Signet missing from a snapshot (a paused integration) keeps its file.

`holdPersonSignets(url, keyFile, directory, apiToken, signets, { name, replace? })` enrolls the key on Signets issued to a person (each with its `expectedRevision`). It keeps any file that already parses unless `replace` is set, and does not re-enroll a stale enrollment the way the installation hold does. Both run under one per-directory lock (`withHoldLock`), so a person login and an installation sync never enroll over each other.

## The installation socket

`InstallationSocket` is Kingdom's live line to an installation. It:

- proves the key and receives a snapshot of the installation's inquiries and Signets on connect and on every change (`onSnapshot`);
- keeps the installation's integrations marked online, reporting `sessionCount` on each ping;
- serves the relayed operations the installation hosts (`operations`; see [OPERATIONS.md](OPERATIONS.md));
- holds conversation and event streams for the Signets the installation holds (`threadStreams`, `eventStreams`; see [CONVERSATIONS.md](CONVERSATIONS.md), [EVENTS.md](EVENTS.md));
- serves the installation's own web viewer through Kingdom (below);
- polls the same reads while it is down.

Entries are read one by one: an inquiry or Signet this package can't read is dropped and listed in `dropped`, and the rest is kept.

### Serving a viewer through Kingdom

A Foundry's viewer opens inside Kingdom, with traffic forwarded over this socket. The installation passes `viewer` (`ViewerHandlers`): `request` answers a web `Request` with a `Response`, and `socket` accepts the viewer's WebSocket. `ViewerRelay` turns Kingdom's `viewer.*` frames into those calls and back, so the handlers never see a frame. `serveViewer(serving)` switches it on and off (`viewerServing`, default on).

Limits both sides hold: `viewerBodyChunkBytes`, `viewerMaxRequestBodyBytes`, `viewerMaxSocketMessageChars`. A viewer path must have exactly one leading slash (`//host/x` and `/\host/x` are refused): a bad request is answered 400, and a bad socket open is closed with 1008.

## On-disk layout

Every installation uses one layout under a root per product (a Foundry's `kingdom/`, `~/.kcp`): one directory per Kingdom host, holding its key and one file per Signet.

| Function | Gives |
| --- | --- |
| `installationPaths`, `installationDirectory` | The host directory and key file. |
| `signetCredentialFile` | One Signet's file. |
| `heldCredentials` | Every held file. |
| `heldSignetCredential` | One file, or null when it is missing or an older client wrote it. |
| `heldSignetFile` | One file, enrolling again a Signet whose file is missing or unreadable while Kingdom lists it. |
| `listedSignets(root, urls)` | Which Signets each Kingdom lists for the installation, null where it refused or is unreachable. |
| `privateDirectory` | Creates an owned `0700` directory, or makes an existing one so. |
| `defaultInstallationName(product)` | `<product> on <hostname>`. |

## A person's agent

| Function | Does |
| --- | --- |
| `requestSignet` | Asks for a Signet over the resources it names. This is a `signetRequest` Inquiry, approved at once when the caller manages every integration it asks on. |
| `awaitSignet` | Polls `collectSignet` until the request is approved. |
| `enrollSignet` | Enrolls the key on a Signet an owner granted directly. |
| `saveCollectedSignet` | Writes either result next to the key. |

## Calling with a Signet

`SignetClient.fromFile(credentialFile)` presents one enrolled Signet. It renews its access token and signs each call with the device key.

- `describe()` returns what the Signet holds now.
- `execute({ integrationId, operation, input })` runs one operation. Every call gets a new request id. Event and permission leaves can't be executed, and neither can `inference.create`, which goes through the run actions.
- `socketPresentation()` is what `SignetSocket` authenticates with.
- `post(action, …)` sends the other actions:

| Action | For |
| --- | --- |
| `completeTask` | Closes a `task` Signet with a completion receipt. |
| `closeTask` | Ends a `task` Signet as completed or cancelled. |
| `verifyAuthority` | Reads whether the enrolled Signet currently holds authority over a resource. It admits nothing and reserves no quota. |
| `resolveRun`, `delegateRun`, `renewRun`, `revokeRun` | A Foundry's native run on the owner's capacity: resolve the run against the Signet, hand the harness a refresh credential restricted to that run, renew, revoke. |
| `releaseSubscription` | Releases the subscription login for a resolved run to the presenting Foundry, and records usage. |
| `reportSubscriptionLimits` | Reporting the provider's limits for that login. |
| `reportCredentialRejected` | Reporting that the provider rejected the login a release handed out. |

`SignetHolders` caches each held Signet's `access/describe` (with its `holder`), keyed by credential file or by the caller's own `keyOf`, and re-reads after `stale()` or once `ttlMs` (10 minutes by default) has passed. Each view is `described`, `revoked` (Kingdom refused with 403) or `unavailable`.
