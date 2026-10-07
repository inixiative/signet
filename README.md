# @inixiative/signet

Present Kingdom Signets.

A **Signet** is Kingdom's only grant for using an integration. It names the resources, operations, lens and limits, and it can be revoked. Its grantee is a user or an integration, for example a paired Foundry or a machine's local Archive. The grantee presents it with an access token plus a DPoP proof signed by its device key (RFC 9449).

This package is the one implementation of that protocol, shared by Kingdom (which verifies) and Archive, Foundry and Oracle (which present):

- `contracts`: the wire schemas: keys, lenses, proposals, pairing requests, delivered credentials, `describe` and `execute`.
- `proof`: create and verify DPoP proofs (ES256, nonce-bound, access-token-bound).
- `files`: private 0600 JSON files for keys and credentials.
- `client`:
  - device pairing: `requestPairing`, then the owner approves the review code in Kingdom, then `collectPairing` and `saveCollectedSignet`;
  - `SignetClient`, which renews its access token and signs each `describe` / `execute` call.

```ts
import { collectPairing, generateClientKey, requestPairing, saveCollectedSignet, SignetClient, writePrivateJson } from '@inixiative/signet';

await writePrivateJson(keyFile, generateClientKey());
const pending = await requestPairing(kingdom, keyFile, {
  provider: 'archive', name: 'Laptop Archive', resources: [], expiresAt: null, maxRequests: null, maxConcurrent: 4,
});
// Show pending.reviewCode; poll until approved (null while pending, until pending.expiresAt).
const collected = await collectPairing(kingdom, keyFile, pending.deviceCode);
await saveCollectedSignet(credentialFile, kingdom, keyFile, collected!);

const signet = new SignetClient(credentialFile);
const { operations } = await signet.describe();
await signet.execute({ integrationId, operation: 'sessions.write', input: { resourceId, snapshot, previousDigest: null } });
```

MIT
