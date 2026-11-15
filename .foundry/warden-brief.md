# signet, for its Wardens

signet (`@inixiative/signet`) is a small published Bun/TypeScript package and the one
implementation of Kingdom's Signet protocol: Kingdom verifies, and Archive, Foundry, Oracle and KCP
present. A Signet is Kingdom's only grant for using integrations; it is presented with a Kingdom
access token plus a DPoP proof signed by the holder's device key. The package does not decide
permissions: Kingdom does. Decisions about Signets are recorded in
`docs/rules/permissions-and-signets.md` (the docs repo); a change that contradicts one goes to Aron
first.

## Shape of the repository

- Three entries, shipped as TypeScript source (`files: ["src"]`): `.` (`src/index.ts`),
  `./contracts` (`src/contracts.ts`, the wire schemas) and `./proof` (`src/proof.ts`).
- Wire contracts: `contracts.ts`, which re-exports `grants.ts`, `lens.ts`, `operations.ts`, and one
  module per declared resource kind: `threads.ts` (the `conversation` kind), `archive.ts`,
  `github.ts`, `events.ts`.
- Presenting: `client.ts` (Installation and person calls, `SignetClient`), `proof.ts`, `files.ts`
  (private 0600 JSON), `installation.ts` (the on-disk layout), `installationPairing.ts`
  (pairing and holding credentials), `holders.ts` (the describe cache).
- Sockets: `installationSocket.ts` (Kingdom's line to an Installation, and the conversation host),
  `signetSocket.ts` (a member's presentation socket), `threadStreams.ts` (`accessThread` streams).
- `test/`: bun tests. `bun run check` runs typecheck, Biome and the tests. Docs: `README.md` only.

## Systems other code depends on

- Every schema Kingdom and the presenters share; Kingdom's catalog, input check and dispatch read
  the declared operations, so a new operation is added here first.
- Grant rows: a row names one resource or a scope (a whole integration, or a project's resources of
  one kind), so a reader never assumes one resource per row. Operation picks are resolved once
  (`resolveOperationPicks`), and json-rules lens layers narrow a base lens (`baseLensId`). Grants
  carry no terms.
- Conversations: one `conversation` resource per shared thread, its `externalId` the thread id.
  Its catalog holds the calls (`thread.*`, `prompt.resolve`) and seven permissions nothing calls
  (`member.*`, `agent.*`), picked like any other operation; `full` holds them all. Whether a
  member's sends wait for review (`outbound`) is the host's own setting, not on the grant.
- Per-entry reads: an entry this package can't read is dropped into `dropped`, never failing the
  whole read.
- `SignetClient` (shared per-file token renewal), `pairInstallation`, `holdInstallationSignets`
  (never deletes a credential file) and `withHoldLock`, `InstallationSocket`, `SignetSocket`.
- Breaking wire changes are hard cuts (no compatibility while pre-users); consumers move together.

## Words used here

Signet, owner, recipient, holder, grant row, resource, IntegrationResource, Project, operation
pick, leaf, `full`, lens, layer, base lens, scope, Installation, integration, inquiry, registration,
review code, enrollment, presentation, credential file, access token, renewal credential, DPoP
proof, nonce, describe, execute, declared operation, snapshot, `dropped`, conversation, conversation
permission, member, host, audience, `externalId`, floor, conch, subscription, lease, journalSeq,
seq, resync.
