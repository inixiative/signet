## 0.15.0 — grant lenses narrow the operations lens; a where goes in, a lens comes out

- **Breaking: a grant's lens layers narrow the resource kind's generated operations lens**
  (R-SIG-18). The base Kingdom generates under `baseLensId(provider, kind)` is a tree with one
  branch per operation, each listing the rows it reads; a layer turns on the branches it keeps and
  narrows the rows there. Layers written against the old row-rooted bases (a `Thread` or `Commit`
  root) no longer compose: Kingdom rewrites stored ones, and a holder must write new layers on the
  operations tree (`narrowingAtOperation`, `conditionAtOperation`, `operationRecord`,
  `operationRows`, `projectionVisit`).
- **Breaking: `projectionFilters` and `projectionShows` take an `operation`** and read that
  operation's branch: `projectionFilters(projection, operation)`,
  `projectionShows(projection, operation, field)`. A branch left off holds every row back, and so
  does a `where` on any visit from the anchor down to the branch, not only on the branch itself.
- **New: `where` on a resource ask and on a grant view.** An ask (`signetResourceSchema`,
  `requestedResourceSchema`, `registeredResourceSchema`) may carry the incoming condition its calls
  must meet; a grant view (`signetGrantSchema`) shows the composed one, every link above it
  included, and a holder must apply it before its lens. `grantWhereSchema` accepts only a non-empty,
  positive json-rules condition (`validateRule(where, { positive: true })`) of at most
  `grantWhereLimit` (16,000) characters as JSON, which makes `@inixiative/json-rules` a runtime
  peer.
- **New: `owner` on a proposal.** `signetProposalSchema` (and `signetRequestSchema`) may name the
  one owner a request asks, as `namedOwnerSchema`: no other keys, the ids its model is keyed by
  (`ownerIdFields`: User a `userId`; Organization an `organizationId`; Space an `organizationId`
  and `spaceId`; OrganizationUser an `organizationId` and `userId`; SpaceUser all three) and every
  other id null.
- **New: event channels**, through which a Signet holder listens to its integration's events, and
  stream pacing and reporting options on the sockets.
