# Integration events

An integration that receives its provider's events (GitHub, Slack, Linear) streams each one to the Signets whose grant picks its kind. Design: Kingdom `docs/INTEGRATION-EVENTS.md`.

Event kinds are operation leaves (`events.<event>.<action>`, built by `eventOperationKey`). They are picked like any other operation and streamed, never executed.

## Channels

A channel is one resource a Signet holds event operations on.

`describe` and each held Signet in the installation snapshot carry `eventChannels` (`eventChannelMapSchema`):

- per integration: `{ id, provider, name }`;
- per channel: `{ resourceId, kind, name, events, stream }`.

They are read per entry: an integration or channel this package can't read is dropped and listed in `dropped`, and the Signet is kept. The field is absent when Kingdom sent none (a Kingdom from before integration events), which says nothing about what the Signet holds.

## Holding a channel

`SignetSocket` takes `eventStreams` (`EventStreamHandlers`) and holds a channel by its resource: `openEventChannel(resourceId)`, `leaveEventChannel(resourceId)`, `heldEventChannels()`. `InstallationSocket` takes the same for the Signets an installation holds, keyed `{ signetId, resourceId }`.

Each channel is one `accessEvents` stream on the same socket that carries thread streams, run by the same code (`DataStreams`, wired once for both sockets by `HolderStreams`).

| What happens | What the socket does |
| --- | --- |
| the holder's Signet is revised | reopens under the new revision at once; with backoff if Kingdom refuses that reopen as `revised` too |
| the presentation lapsed | authenticates again on a new connection and reopens |
| the socket dropped | reopens what it held; reported once (`onDisconnected`) |
| Kingdom sends `resync` (its own subscriber reconnected) | reopens |
| the host is offline | retries with backoff |
| revocation, expiry, or a refused open | ends the channel (`onClosed`) |

- A close the stream is reopened after is reported first (`onReopening(channel, reason)`). `reopenedCloseReasons` lists them (`revised`, `presentationExpired`, `hostOffline`); `closeIsReopened(reason)` tests one.
- A close reason is about the holder's own Signet. `revoked`, `revised`, `expired` and `enrollmentRevoked` never describe anything else. A change elsewhere closes a stream as `unauthorized`, with no further reason, once nothing admits it.
- A refused presentation is reported as a `SignetPresentationRefused` error.

**Pacing.** Kingdom closes a socket that sends more than 120 frames in ten seconds, so opens are paced at ten per two and a half seconds for each kind of stream (`openBurst`, `openWindowMs` on either socket). A holder of many channels sees them open over a few windows, after every reconnect too. Thread streams are paced the same way. Leaves are not paced, so leaving more than about a hundred streams at once costs a reconnect.

## Live only

A channel's snapshot is always empty, and nothing is replayed. `onEvent(channel, { type, event }, seq)` receives each event as that channel's Signet projects it, from the moment Kingdom opens the channel (`onOpened`, again after every reopen). A holder that is offline misses what is published meanwhile, as it does between a close and the reopen, and there is nowhere to read it back from.

## Gaps

A thread stream whose `seq` jumps reopens for a fresh snapshot, which holds what it missed. A channel's snapshot holds nothing, so every append is delivered whatever its `seq`, and a `seq` that isn't the next one is reported: `onGap(channel, { after, seq })`, just before the event that showed it.

A gap means one of two things this package can't tell apart:

- Kingdom's counter for the stream expired after 24 quiet hours and restarted from the clock (nothing was lost), or
- appends in between never arrived (they are gone).

A reconnect reports no gap; it shows as `onOpened`.

Frames are handled one at a time, so a slow handler holds back the ones behind it. Past `maxQueuedFrames` waiting (1,000 unless set on the socket), appends are dropped, reported once through `onError`, and show as a gap on a channel or a resync on a thread, at the next append or once the handlers have caught up.

## Duplicates

Nothing is deduped here: an event is delivered once per channel it arrives on. A holder with two Signets on one resource gets the event on both channels, each cut by its own Signet's lens, so the two bodies can differ.

Every event carries `id`, a UUID Kingdom mints once per event after dropping the provider's retried deliveries (it does so for three days, by the provider's delivery id). The `id` is the same on every channel and a lens can't drop it, so a consumer that must act once dedupes on `event.id`.

## What a lens can name

An event reaches a holder as the `IntegrationEvent` row its Signet's lens projects. A lens at an `events.*` branch names only these fields (`integrationEventFieldSchema`):

`id`, `integrationId`, `provider`, `at`, `actor`, `scope`, `mentions`, `assignees`, `requestedReviewers`, `subject`, `excerpt`, `payload`

- `payload` is the provider's whole event as it arrived; a lens keeps or drops it whole.
- `id` can be filtered on and never left out; Kingdom refuses a lens that omits it.
- `type` rides outside the projected body on every append, and the provider's delivery id (`eventId`) stays in Kingdom, so a lens that picks or filters on either does not compose.

## Truncation

Kingdom caps an append's size. A projected event over the cap arrives without `payload`, with `truncated: true` on the append; the other fields are whole. A holder that needs the full body reads it from the provider.

## Example

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
