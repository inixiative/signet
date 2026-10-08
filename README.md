# @inixiative/signet

Present Kingdom Signets.

A **Signet** is Kingdom's only grant for using an integration. It names the resources, operations, lens and limits, and it can be revoked. Its grantee is a user or an integration, for example a paired Foundry or a machine's local Archive. The grantee presents it with an access token plus a DPoP proof signed by its device key (RFC 9449).

This package is the one implementation of that protocol, shared by Kingdom (which verifies) and Archive, Foundry and Oracle (which present):

- `contracts`: the wire schemas: keys, lenses, proposals, pairing requests, delivered credentials, `describe` and `execute`.
- `proof`: create and verify DPoP proofs (ES256, nonce-bound, access-token-bound).
- `files`: private 0600 JSON files for keys and credentials.
- `client`:
  - an **Installation** (a local Foundry, Archive or Oracle) is an actor known to Kingdom by its key: `registerInstallation`, then `requestRegistration` returns a review code a person claims in Kingdom (a `registerIntegration` Inquiry), then `collectSignet` and `saveCollectedSignet`. `installationInquiries`, `installationSignets`, `cancelInstallationInquiry`, `enrollInstallationSignet` and `rotateInstallationKey` act as the installation;
  - `InstallationSocket`, Kingdom's live line to an installation: it proves the key, receives a snapshot of the installation's inquiries and Signets on connect and on every change, keeps the installation's integrations marked online, advertises its viewer URL, and polls the same reads while the socket is down;
  - `SignetClient`, which renews its access token and signs each `describe` / `execute` call.

```ts
import {
  collectSignet, generateSignetKey, InstallationSocket, registerInstallation, requestRegistration,
  saveCollectedSignet, SignetClient, writePrivateJson,
} from '@inixiative/signet';

await writePrivateJson(keyFile, generateSignetKey());
await registerInstallation(kingdom, keyFile, { kind: 'archive', name: 'Laptop Archive', sourceId });
const { reviewCode } = await requestRegistration(kingdom, keyFile, {
  name: 'Laptop Archive', lifecycle: 'ongoing', resources: [], expiresAt: null, maxRequests: null, maxConcurrent: 4,
});
// Show reviewCode; someone claims it in Kingdom. The socket tells you when the inquiry resolves.
const socket = new InstallationSocket({
  url: kingdom,
  keyFile,
  onSnapshot: async ({ inquiries }) => {
    const approved = inquiries.find((inquiry) => inquiry.status === 'approved' && inquiry.signetId);
    const collected = approved && (await collectSignet(kingdom, keyFile, approved.id));
    if (collected) await saveCollectedSignet(credentialFile, kingdom, keyFile, collected);
  },
});
socket.start();

const signet = new SignetClient(kingdom, credentialFile, signetId);
await signet.execute({ integrationId, operation: 'sessions.write', input: { resourceId, snapshot, previousDigest: null } });
```

MIT
