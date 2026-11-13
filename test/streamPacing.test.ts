import { expect, test } from 'bun:test';
import {
  type AccessEventsAppend,
  accessEventsStreamName,
  type EventStreamKey,
  EventStreams,
} from '../src';

const signetId = Bun.randomUUIDv7();
const key = (): EventStreamKey => ({ signetId, resourceId: Bun.randomUUIDv7() });
const settle = (ms = 30) => Bun.sleep(ms);
const opensOf = (frames: Record<string, unknown>[]) =>
  frames.filter((frame) => frame.action === 'open').map((frame) => String(frame.stream));
const append = (stream: string, seq: number, eventId: string) => ({
  category: 'data',
  action: 'append',
  type: 'append',
  stream,
  seq,
  payload: { eventId, type: 'issues.opened', event: {} } satisfies AccessEventsAppend,
});
const snapshot = (stream: string, seq: number) => ({
  category: 'data',
  action: 'snapshot',
  stream,
  seq,
  payload: { data: { events: [] } },
});

test('many held channels are opened a few at a time, never in one burst', async () => {
  const frames: Record<string, unknown>[] = [];
  const streams = new EventStreams(
    (frame) => frames.push(frame),
    { onEvent: () => {} },
    {
      openBurst: 10,
      openWindowMs: 20,
    },
  );
  const keys = Array.from({ length: 45 }, key);
  for (const each of keys) streams.open(each);

  streams.up();
  expect(opensOf(frames)).toHaveLength(10);

  await settle(25);
  expect(opensOf(frames)).toHaveLength(20);

  await settle(150);
  const opened = opensOf(frames);
  expect(opened).toHaveLength(45);
  expect(new Set(opened).size).toBe(45);
  expect(new Set(opened)).toEqual(new Set(keys.map(accessEventsStreamName)));
});

test('a channel left while it waits its turn is never opened', async () => {
  const frames: Record<string, unknown>[] = [];
  const streams = new EventStreams(
    (frame) => frames.push(frame),
    { onEvent: () => {} },
    {
      openBurst: 1,
      openWindowMs: 20,
    },
  );
  const [first, second] = [key(), key()];
  streams.open(first);
  streams.open(second);
  streams.up();

  streams.leave(second);
  await settle(80);

  expect(opensOf(frames)).toEqual([accessEventsStreamName(first)]);
  expect(streams.held()).toEqual([first]);
});

test('a socket that drops while channels wait opens each of them once it is back', async () => {
  const frames: Record<string, unknown>[] = [];
  const streams = new EventStreams(
    (frame) => frames.push(frame),
    { onEvent: () => {} },
    {
      openBurst: 2,
      openWindowMs: 20,
    },
  );
  const keys = Array.from({ length: 5 }, key);
  for (const each of keys) streams.open(each);
  streams.up();
  streams.down();
  frames.length = 0;

  streams.up();
  await settle(150);

  const opened = opensOf(frames);
  expect(opened).toHaveLength(5);
  expect(new Set(opened).size).toBe(5);
});

test('an error handler that throws does not stop the events that follow', async () => {
  const delivered: string[] = [];
  const streams = new EventStreams(() => {}, {
    onEvent: (_channel, event) => {
      if (event.eventId === 'first') throw Error('consumer failed');
      delivered.push(event.eventId);
    },
    onError: () => {
      throw Error('reporter failed');
    },
  });
  const held = key();
  const stream = accessEventsStreamName(held);
  streams.open(held);
  streams.up();
  streams.receive(snapshot(stream, 10));

  streams.receive(append(stream, 11, 'first'));
  streams.receive(append(stream, 12, 'second'));
  streams.receive(append(stream, 13, 'third'));
  await settle();

  expect(delivered).toEqual(['second', 'third']);
});

test('a throwing error handler does not stop a channel from opening or from reporting gaps', async () => {
  const opened: string[] = [];
  const delivered: string[] = [];
  const gaps: number[] = [];
  const streams = new EventStreams(() => {}, {
    onOpened: (channel) => void opened.push(channel.resourceId),
    onEvent: (_channel, event) => void delivered.push(event.eventId),
    onGap: (_channel, gap) => void gaps.push(gap.seq),
    onError: () => {
      throw Error('reporter failed');
    },
  });
  const held = key();
  const stream = accessEventsStreamName(held);
  streams.open(held);
  streams.up();

  streams.receive({
    ...snapshot(stream, 10),
    payload: { data: { events: [{ unexpected: true }] } },
  });
  streams.receive(append(stream, 11, 'first'));
  streams.receive(append(stream, 15, 'after a jump'));
  await settle();

  expect(opened).toEqual([held.resourceId]);
  expect(delivered).toEqual(['first', 'after a jump']);
  expect(gaps).toEqual([15]);
});

test('a gap handler that rejects is reported and the event still arrives', async () => {
  const errors: unknown[] = [];
  const delivered: string[] = [];
  const streams = new EventStreams(() => {}, {
    onEvent: (_channel, event) => void delivered.push(event.eventId),
    onGap: (async () => {
      throw Error('gap handler failed');
    }) as () => void,
    onError: (error) => void errors.push(error),
  });
  const held = key();
  const stream = accessEventsStreamName(held);
  streams.open(held);
  streams.up();
  streams.receive(snapshot(stream, 10));

  streams.receive(append(stream, 20, 'after a jump'));
  await settle();

  expect(delivered).toEqual(['after a jump']);
  expect(errors).toHaveLength(1);
});

test('a burst of zero still opens one stream per window', async () => {
  const frames: Record<string, unknown>[] = [];
  const streams = new EventStreams(
    (frame) => frames.push(frame),
    { onEvent: () => {} },
    { openBurst: 0, openWindowMs: 20 },
  );
  streams.open(key());
  streams.open(key());
  streams.up();
  expect(opensOf(frames)).toHaveLength(1);
  await settle(120);

  expect(opensOf(frames)).toHaveLength(2);
});

test('a burst or window that is not a usable number falls back to the default pacing', async () => {
  for (const options of [{ openBurst: Number.NaN }, { openBurst: Number.POSITIVE_INFINITY }]) {
    const frames: Record<string, unknown>[] = [];
    const streams = new EventStreams((frame) => frames.push(frame), { onEvent: () => {} }, options);
    for (let count = 0; count < 25; count++) streams.open(key());
    streams.up();
    expect(opensOf(frames)).toHaveLength(10);
    streams.down();
  }
});

test('an error handler that rejects, and a closed handler that rejects, stop nothing', async () => {
  const delivered: string[] = [];
  const reported: unknown[] = [];
  const streams = new EventStreams(() => {}, {
    onEvent: (_channel, event) => {
      if (event.eventId === 'first') throw Error('consumer failed');
      delivered.push(event.eventId);
    },
    onClosed: (async () => {
      throw Error('closed handler failed');
    }) as () => void,
    onError: (async (error: unknown) => {
      reported.push(error);
      throw Error('reporter failed');
    }) as (error: unknown) => void,
  });
  const [held, other] = [key(), key()];
  streams.open(held);
  streams.open(other);
  streams.up();
  streams.receive(snapshot(accessEventsStreamName(held), 10));
  streams.receive(snapshot(accessEventsStreamName(other), 10));

  streams.receive(append(accessEventsStreamName(held), 11, 'first'));
  streams.receive({ type: 'closed', stream: accessEventsStreamName(other), reason: 'revoked' });
  streams.receive(append(accessEventsStreamName(held), 12, 'second'));
  await settle();

  expect(delivered).toEqual(['second']);
  expect(reported).toHaveLength(2);
  expect(streams.held()).toEqual([held]);
});

test('a close Kingdom will be reopened after is reported with its reason before the reopen', async () => {
  const frames: Record<string, unknown>[] = [];
  const reopening: string[] = [];
  const closed: unknown[] = [];
  const streams = new EventStreams(
    (frame) => frames.push(frame),
    {
      onEvent: () => {},
      onReopening: (_channel, reason) => void reopening.push(reason),
      onClosed: (_channel, reason) => void closed.push(reason),
    },
    { retryBaseMs: 10 },
  );
  const held = key();
  const stream = accessEventsStreamName(held);
  streams.open(held);
  streams.up();
  streams.receive(snapshot(stream, 10));

  streams.receive({ type: 'closed', stream, reason: 'revised' });
  await settle();
  streams.receive(snapshot(stream, 20));
  streams.receive({ type: 'closed', stream, reason: 'hostOffline' });
  await settle(80);

  expect(reopening).toEqual(['revised', 'hostOffline']);
  expect(closed).toEqual([]);
  expect(opensOf(frames)).toHaveLength(3);
});

test('a close that ends a channel is not reported as reopening', async () => {
  const reopening: string[] = [];
  const closed: unknown[] = [];
  const streams = new EventStreams(() => {}, {
    onEvent: () => {},
    onReopening: (_channel, reason) => void reopening.push(reason),
    onClosed: (_channel, reason) => void closed.push(reason),
  });
  const held = key();
  const stream = accessEventsStreamName(held);
  streams.open(held);
  streams.up();
  streams.receive(snapshot(stream, 10));

  streams.receive({ type: 'closed', stream, reason: 'revoked' });
  await settle();

  expect(reopening).toEqual([]);
  expect(closed).toEqual(['revoked']);
});
