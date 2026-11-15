# signet glossary

**Every term signet's region Wardens use, alphabetical, each with the region that holds it.**

<!-- Generated with the region Warden docs by the region pipeline's assemble.py. A term defined by two regions appears once per region. -->

---

## A

**access token**  
The Kingdom token (kingdom_…) presented with each call, renewed by SignetClient. *Region:* [Presenting a Signet](presenting-signets/knowledge.md)

**accessEvents**  
Stream family for one Signet's events on one resource (accessEventsStreamName). *Region:* [Grants and declared operations](grants-and-operations/knowledge.md)

**accessThread**  
Kingdom stream family for one member's view of one thread (accessThreadStreamName). *Region:* [Agent conversations over threads](agent-conversations/knowledge.md)

**accessThreadCloseReasonSchema**  
Why Kingdom closed a member's stream, e.g. left, revoked; sent on closed and openRejected. *Region:* [Agent conversations over threads](agent-conversations/knowledge.md)

**account**  
Resource kind for an integration's account-level events (accountResourceKind). *Region:* [Grants and declared operations](grants-and-operations/knowledge.md)

**act**  
ask, read or full: what the host's agent may do on a turn that took in the member's words. *Region:* [Agent conversations over threads](agent-conversations/knowledge.md)

**appendThread**  
InstallationSocket method pushing one entry to one subscription with a dense seq. *Region:* [Agent conversations over threads](agent-conversations/knowledge.md)

**archive-operations**  
Class: archiveLibrary operations and their lens refusals and per-call narrowing. *Region:* [Grants and declared operations](grants-and-operations/knowledge.md)

**archiveLibrary**  
Archive's resource kind: documents.read, documents.search, sessions.write, sessions.delete. *Region:* [Grants and declared operations](grants-and-operations/knowledge.md)

**archiveSourceOperations**  
sessions.write and sessions.delete, bound to the Archive's sourceId, granted without a lens. *Region:* [Grants and declared operations](grants-and-operations/knowledge.md)

**authenticateSignet / renewPresentation**  
Socket frames presenting the Signet (proof bound to POST /api/v1/access/signetSocket with ath) and renewing before five-minute expiry. *Region:* [Agent conversations over threads](agent-conversations/knowledge.md)

## B

**base lens**  
The integration's lens for a resource kind, id baseLensId(provider, kind). *Region:* [Grants and declared operations](grants-and-operations/knowledge.md)

## C

**collect**  
Fetch the Signet an approved inquiry minted (collectSignet; null while pending). *Region:* [Obtaining and holding Signets](obtaining-and-holding/knowledge.md)

**credential file**  
One 0600 file per Signet next to the key (signetCredentialFile). *Region:* [Obtaining and holding Signets](obtaining-and-holding/knowledge.md)

**credential file**  
The 0600 file one enrolled Signet is presented from (signetCredentialSchema). *Region:* [Presenting a Signet](presenting-signets/knowledge.md)

## D

**declared operation**  
An operation Kingdom executes generically, declared in threads.ts, archive.ts or github.ts. *Region:* [Grants and declared operations](grants-and-operations/knowledge.md)

**declared-operations**  
Class: the join of every operation the per-kind contracts declare, with their input schemas. *Region:* [Grants and declared operations](grants-and-operations/knowledge.md)

**delivery**  
note or turn: whether a member's message just lands or starts an owner-agent turn. *Region:* [Agent conversations over threads](agent-conversations/knowledge.md)

**describe**  
access/describe: the Signet's id, name, expiry, reachable resources (signetDescriptionSchema). *Region:* [Presenting a Signet](presenting-signets/knowledge.md)

**device key**  
EC P-256 private JWK from generateSignetKey (signetKeySchema). *Region:* [Presenting a Signet](presenting-signets/knowledge.md)

**DPoP proof**  
RFC 9449 ES256 proof signed by the device key, bound to a nonce and the access token. *Region:* [Presenting a Signet](presenting-signets/knowledge.md)

**dropped**  
List of entries a per-entry read couldn't parse; the rest is kept. *Region:* [Obtaining and holding Signets](obtaining-and-holding/knowledge.md)

## E

**enrollment**  
Binding this key to a Signet (enrollSignet, enrollInstallationSignet). *Region:* [Obtaining and holding Signets](obtaining-and-holding/knowledge.md)

**events.<type>**  
Operation key of an event type, from eventOperationKey. *Region:* [Grants and declared operations](grants-and-operations/knowledge.md)

**execute**  
access/execute: run one operation on a resource (accessRequestSchema / accessResultSchema). *Region:* [Presenting a Signet](presenting-signets/knowledge.md)

**expectedRevision**  
Revision enrollSignet expects the granted Signet to be at. *Region:* [Obtaining and holding Signets](obtaining-and-holding/knowledge.md)

## F

**floor**  
Who may speak: floorModeSchema talk, speak-when-spoken-to or conch; floor.mayTake lets a member take the conch. *Region:* [Agent conversations over threads](agent-conversations/knowledge.md)

**full**  
A scope reaching everything a resource offers, now and as its catalog grows. *Region:* [Grants and declared operations](grants-and-operations/knowledge.md)

## G

**github-operations**  
Class: GitHub repository read operations by object id and pinned-commit refusals. *Region:* [Grants and declared operations](grants-and-operations/knowledge.md)

**grant row**  
One resource a Signet revision grants (grantResourceSchema). *Region:* [Grants and declared operations](grants-and-operations/knowledge.md)

**grant-lens**  
Class: the grant lens as json-rules layers over the integration's base lens. *Region:* [Grants and declared operations](grants-and-operations/knowledge.md)

**grant-rows**  
Class: grant row shapes on resourceModel, requested/registered/held resource schemas and per-kind terms. *Region:* [Grants and declared operations](grants-and-operations/knowledge.md)

**GrantLens**  
A grant's own layers plus the projection of the composed chain, read by refusals. *Region:* [Grants and declared operations](grants-and-operations/knowledge.md)

## H

**hold lock**  
Per-directory lock so a person login and an installation sync never enroll over each other (withHoldLock). *Region:* [Obtaining and holding Signets](obtaining-and-holding/knowledge.md)

**holder**  
Block describe returns for an Integration-held Signet (signetHolderSchema). *Region:* [Presenting a Signet](presenting-signets/knowledge.md)

**holder-cache**  
Class: SignetHolders describe cache and parseHeldSignetDescription. *Region:* [Obtaining and holding Signets](obtaining-and-holding/knowledge.md)

**hostedSignets / hostedSignetRequests**  
Snapshot lists of this Foundry's conversation members and join requests marked inOrg or outside. *Region:* [Agent conversations over threads](agent-conversations/knowledge.md)

## I

**Inquiry**  
A pending ask in Kingdom: registerIntegration for an Installation, signetRequest for a person. *Region:* [Obtaining and holding Signets](obtaining-and-holding/knowledge.md)

**Installation**  
A local Foundry, Archive or Oracle known to Kingdom by its key. *Region:* [Obtaining and holding Signets](obtaining-and-holding/knowledge.md)

**installation-calls**  
Class: an Installation acting as itself by key, and their wire bodies. *Region:* [Obtaining and holding Signets](obtaining-and-holding/knowledge.md)

**installation-layout**  
Class: one directory per Kingdom host under a product root, with a key and one file per Signet. *Region:* [Obtaining and holding Signets](obtaining-and-holding/knowledge.md)

**installation-socket**  
Class: InstallationSocket, Kingdom's live line to an Installation. *Region:* [Obtaining and holding Signets](obtaining-and-holding/knowledge.md)

**integration-events**  
Class: the normalized provider event envelope, account resource, events.<type> keys and accessEvents stream names. *Region:* [Grants and declared operations](grants-and-operations/knowledge.md)

**IntegrationResource**  
Grant row on an integration's resource with full or operations, lens and terms. *Region:* [Grants and declared operations](grants-and-operations/knowledge.md)

## J

**journalSeq**  
The journal position a thread view was taken at; a subscription starts there. *Region:* [Agent conversations over threads](agent-conversations/knowledge.md)

## K

**key rotation**  
Moving an installation to a new key with both signing during the move (rotateInstallationKey). *Region:* [Obtaining and holding Signets](obtaining-and-holding/knowledge.md)

**keys-and-proof**  
Class: EC P-256 device keys and ES256 DPoP proofs. *Region:* [Presenting a Signet](presenting-signets/knowledge.md)

**Kingdom**  
The service that verifies Signets and decides permissions. *Region:* [Presenting a Signet](presenting-signets/knowledge.md)

**Kingdom API token**  
Token a person mints in Kingdom to act as themselves. *Region:* [Obtaining and holding Signets](obtaining-and-holding/knowledge.md)

## L

**lens layer**  
One json-rules narrowing without its parent (lensLayerSchema). *Region:* [Grants and declared operations](grants-and-operations/knowledge.md)

**lifecycle**  
request, task or ongoing (signetLifecycleSchema). *Region:* [Presenting a Signet](presenting-signets/knowledge.md)

## M

**meetThreadsTerms**  
The narrowest terms both inputs allow, field by field; the starting point of a review. *Region:* [Agent conversations over threads](agent-conversations/knowledge.md)

**member**  
A Signet whose grant row reaches the host Foundry's threads resource on its integration. *Region:* [Agent conversations over threads](agent-conversations/knowledge.md)

## N

**narrowsThreadsTerms**  
True when granted terms are no wider than requested ones: own<thread, note<turn, review<auto, data<instructions, ask<read<full. *Region:* [Agent conversations over threads](agent-conversations/knowledge.md)

**nonce**  
Kingdom-issued value each proof is bound to (signetProof fetches a fresh one). *Region:* [Presenting a Signet](presenting-signets/knowledge.md)

## O

**openThread / leaveThread**  
InstallationSocket methods holding thread views through a Signet the installation holds (needs threadStreams). *Region:* [Agent conversations over threads](agent-conversations/knowledge.md)

**operation pick**  
A leaf key or a dotted prefix ending .* (operationPickKeySchema). *Region:* [Grants and declared operations](grants-and-operations/knowledge.md)

**operation-picks**  
Class: { full } or { picks } operation scopes and the checks over them. *Region:* [Grants and declared operations](grants-and-operations/knowledge.md)

**outbound**  
review or auto: whether host sends to the member wait for owner review. *Region:* [Agent conversations over threads](agent-conversations/knowledge.md)

**owner**  
Who grants the Signet: model plus user, organization and space ids (ownerRefSchema). *Region:* [Presenting a Signet](presenting-signets/knowledge.md)

**ownerKey**  
Kingdom's canonical owner key string built from an owner reference. *Region:* [Presenting a Signet](presenting-signets/knowledge.md)

## P

**pairing**  
Register, request, wait on the socket, confirm the owner and collect (pairInstallation). *Region:* [Obtaining and holding Signets](obtaining-and-holding/knowledge.md)

**pairing-and-holding**  
Class: pairInstallation and keeping held Signets' credential files in sync. *Region:* [Obtaining and holding Signets](obtaining-and-holding/knowledge.md)

**per-entry-reads**  
Class: tolerant readers that drop an unreadable entry into dropped. *Region:* [Obtaining and holding Signets](obtaining-and-holding/knowledge.md)

**person-calls**  
Class: a person or their agent with a Kingdom API token plus key proof. *Region:* [Obtaining and holding Signets](obtaining-and-holding/knowledge.md)

**posts**  
data or instructions: how the host's agent treats a member's posts. *Region:* [Agent conversations over threads](agent-conversations/knowledge.md)

**private-files**  
Class: owned 0600 JSON files in 0700 directories, written atomically. *Region:* [Obtaining and holding Signets](obtaining-and-holding/knowledge.md)

**product root**  
One root per product (a Foundry's kingdom/, ~/.kcp) holding a directory per Kingdom host. *Region:* [Obtaining and holding Signets](obtaining-and-holding/knowledge.md)

**Project**  
Grant row naming a Kingdom project the Signet may be used in; carries nothing else. *Region:* [Grants and declared operations](grants-and-operations/knowledge.md)

**prompt.resolve**  
Operation resolving a held prompt; with thread.read and thread.floor the four threads operations. *Region:* [Agent conversations over threads](agent-conversations/knowledge.md)

**proposal**  
Asked-for terms, resources by id or kind (signetProposalSchema). *Region:* [Presenting a Signet](presenting-signets/knowledge.md)

**public client key**  
The public half of the device key in JWK form (publicClientKeySchema). *Region:* [Presenting a Signet](presenting-signets/knowledge.md)

## R

**recipient**  
Who receives the Signet: a User or an Integration (signetRecipientSchema). *Region:* [Presenting a Signet](presenting-signets/knowledge.md)

**renewal credential**  
Credential that renews the access token (signetRenewSchema). *Region:* [Presenting a Signet](presenting-signets/knowledge.md)

**repository**  
GitHub resource kind: commits.read, trees.read, blobs.read by object id. *Region:* [Grants and declared operations](grants-and-operations/knowledge.md)

**requestAudienceSchema**  
inOrg or outside, decided by Kingdom; the host picks default terms from it. *Region:* [Agent conversations over threads](agent-conversations/knowledge.md)

**resolved operations**  
The concrete leaves a row stores after resolveOperationPicks (resolvedOperationsSchema). *Region:* [Grants and declared operations](grants-and-operations/knowledge.md)

**resourceModel**  
Discriminator of a grant row: IntegrationResource or Project. *Region:* [Grants and declared operations](grants-and-operations/knowledge.md)

**review code**  
Code requestRegistration or requestSignet returns for a person to claim in Kingdom. *Region:* [Obtaining and holding Signets](obtaining-and-holding/knowledge.md)

**review proposal**  
Issued terms, every resource by id (signetReviewProposalSchema). *Region:* [Presenting a Signet](presenting-signets/knowledge.md)

**run actions**  
Foundry inference calls: resolveRun, delegateRun, renewRun, revokeRun, subscription release and limits. *Region:* [Presenting a Signet](presenting-signets/knowledge.md)

## S

**seq**  
Dense per-subscription counter; a skipped number is a gap that makes the member resync. *Region:* [Agent conversations over threads](agent-conversations/knowledge.md)

**Signet**  
Kingdom's only grant for using integrations: owner, recipient, grant rows; revocable. *Region:* [Presenting a Signet](presenting-signets/knowledge.md)

**signet-client**  
Class: presenting an enrolled Signet (SignetClient and its wire bodies). *Region:* [Presenting a Signet](presenting-signets/knowledge.md)

**signet-envelope**  
Class: a Signet's owner, recipient, lifecycle and proposal shapes, apart from its rows. *Region:* [Presenting a Signet](presenting-signets/knowledge.md)

**SignetAction**  
The fixed list of actions SignetClient.post may send. *Region:* [Presenting a Signet](presenting-signets/knowledge.md)

**SignetHttpError**  
Error carrying the HTTP status and detail of a failed Kingdom call. *Region:* [Presenting a Signet](presenting-signets/knowledge.md)

**SignetSocket**  
An outside agent's presentation socket holding its accessThread streams. *Region:* [Agent conversations over threads](agent-conversations/knowledge.md)

**snapshot**  
The installation's inquiries and Signets, pushed on connect and every change (installationSnapshotSchema). *Region:* [Obtaining and holding Signets](obtaining-and-holding/knowledge.md)

**stale()**  
Marks SignetHolders entries for refresh after a socket change. *Region:* [Obtaining and holding Signets](obtaining-and-holding/knowledge.md)

**StoredLens**  
A stored layer record with id and parents (storedLensLayerSchema). *Region:* [Grants and declared operations](grants-and-operations/knowledge.md)

## T

**terms**  
Per-kind rules for how a holder takes part (grantTermsSchema); only threads today. *Region:* [Grants and declared operations](grants-and-operations/knowledge.md)

**thread-host**  
Class: the host Foundry answering members over InstallationSocket's threads option. *Region:* [Agent conversations over threads](agent-conversations/knowledge.md)

**thread-member-streams**  
Class: a member holding live accessThread views via SignetSocket or openThread. *Region:* [Agent conversations over threads](agent-conversations/knowledge.md)

**thread.lease**  
Kingdom re-asserts a subscription; it drops 90 s after the last lease (threadSubscriptionLeaseMs). *Region:* [Agent conversations over threads](agent-conversations/knowledge.md)

**thread.prompt**  
The operation a member posts with, a SignetClient.execute call, admitted and metered. *Region:* [Agent conversations over threads](agent-conversations/knowledge.md)

**ThreadHost**  
The threads option on InstallationSocket: one handler per operation plus thread.subscribe. *Region:* [Agent conversations over threads](agent-conversations/knowledge.md)

**threadResult / threadRefused**  
Build a host's success answer ({ ok: true, result }) or refusal with a threadRefusalSchema reason. *Region:* [Agent conversations over threads](agent-conversations/knowledge.md)

**threads**  
The single resource kind (threadsResourceKind) a member's Signet uses to reach a host's conversation. *Region:* [Agent conversations over threads](agent-conversations/knowledge.md)

**threads-terms**  
Class: the conversation contract, threads terms, operations, input/result/refusal schemas. *Region:* [Agent conversations over threads](agent-conversations/knowledge.md)

**threadsTerms**  
Reads threads terms with every omitted field at its narrowest value. *Region:* [Agent conversations over threads](agent-conversations/knowledge.md)

**threadsTermsSchema**  
A member's terms: view, delivery, outbound, floor.mayTake, posts, act, agent. *Region:* [Agent conversations over threads](agent-conversations/knowledge.md)

**thumbprint**  
JWK thumbprint identifying a public key (keyThumbprint). *Region:* [Presenting a Signet](presenting-signets/knowledge.md)

## U

**unknown_operation_pick**  
Code of OperationPickError: a pick that reaches nothing in the catalog. *Region:* [Grants and declared operations](grants-and-operations/knowledge.md)

## V

**view**  
own (only the member's own exchanges) or thread (the whole thread). *Region:* [Agent conversations over threads](agent-conversations/knowledge.md)

**viewer URL**  
URL the InstallationSocket advertises for the installation. *Region:* [Obtaining and holding Signets](obtaining-and-holding/knowledge.md)

## W

**where**  
A lens's root row filter, run over a call row such as repositoryCallRow's { sha }. *Region:* [Grants and declared operations](grants-and-operations/knowledge.md)
