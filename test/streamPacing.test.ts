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
  payload: { events: [] },
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
