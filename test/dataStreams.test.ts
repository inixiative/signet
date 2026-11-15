import { expect, test } from 'bun:test';
import {
  closeIsReopened,
  type DataStreamGap,
  type DataStreamOptions,
  reopenedCloseReasons,
} from '../src';
import { type DataStreamFamily, DataStreams } from '../src/dataStreams';

type Key = { id: string };
const family = (gap: 'resync' | 'deliver'): DataStreamFamily<Key, null, unknown> => ({
  name: (key) => `x:${key.id}`,
  owns: (stream) => stream.startsWith('x:'),
  snapshot: () => ({ snapshot: null }),
  append: (_type, payload) => payload,
  gap,
});
const hold = (
  gap: 'resync' | 'deliver',
  options: DataStreamOptions = {},
  onAppend: (append: unknown) => void | Promise<void> = () => {},
) => {
  const sent: Record<string, unknown>[] = [];
  const gaps: DataStreamGap[] = [];
  const errors: unknown[] = [];
  const reopening: string[] = [];
  const streams = new DataStreams<Key, null, unknown>(
    family(gap),
    (frame) => void sent.push(frame),
    {
      onSnapshot: () => {},
      onAppend: (_key, append) => onAppend(append),
      onGap: (_key, jump) => void gaps.push(jump),
      onReopening: (_key, reason) => void reopening.push(reason),
      onError: (error) => void errors.push(error),
    },
    { openBurst: 1000, ...options },
  );
  streams.up();
  streams.open({ id: '1' });
  return { streams, sent, gaps, errors, reopening };
};
const snapshot = (seq: number) => ({
  category: 'data',
  action: 'snapshot',
  stream: 'x:1',
  seq,
  payload: {},
});
const append = (seq: number, payload: unknown = {}) => ({
  category: 'data',
  action: 'append',
  type: 'append',
  stream: 'x:1',
  seq,
  payload,
});
const opens = (sent: Record<string, unknown>[]) =>
  sent.filter((frame) => frame.action === 'open').length;

test('a Kingdom that keeps answering revised is reopened once at once, then with backoff', async () => {
  const { streams, sent, reopening } = hold('deliver', { retryBaseMs: 20 });
  const rejected = async () => {
    streams.receive({ type: 'openRejected', stream: 'x:1', reason: 'revised' });
    await Bun.sleep(5);
  };
  await rejected();
  expect(opens(sent)).toBe(2);
  // The reopen is rejected too: the next waits out the backoff (40 ms), and the one after 80 ms.
  await rejected();
  expect(opens(sent)).toBe(2);
  await Bun.sleep(60);
  expect(opens(sent)).toBe(3);
  await rejected();
  await Bun.sleep(40);
  expect(opens(sent)).toBe(3);
  await Bun.sleep(70);
  expect(opens(sent)).toBe(4);
  expect(reopening).toEqual(['revised', 'revised', 'revised']);
  // Once it opens, the next revision is again reopened at once.
  streams.receive(snapshot(1));
  await Bun.sleep(0);
  streams.receive({ type: 'closed', stream: 'x:1', reason: 'revised' });
  await Bun.sleep(0);
  expect(opens(sent)).toBe(5);
  streams.down();
});

test('the closes a stream is reopened after are one exported list', () => {
  expect([...reopenedCloseReasons]).toEqual(['revised', 'presentationExpired', 'hostOffline']);
  expect(closeIsReopened('hostOffline')).toBe(true);
  for (const reason of ['revoked', 'expired', 'unauthorized', 'rejected', null] as const)
    expect(closeIsReopened(reason)).toBe(false);
});

test('a deliver stream reports a seq that went back, and the jump after it', async () => {
  const { streams, gaps } = hold('deliver');
  streams.receive(snapshot(100));
  streams.receive(append(101));
  streams.receive(append(5));
  streams.receive(append(7));
  streams.receive(append(8));
  await Bun.sleep(5);
  expect(gaps).toEqual([
    { after: 101, seq: 5 },
    { after: 5, seq: 7 },
  ]);
});

test('handlers that fall behind lose appends past the bound, once reported, and the gap shows', async () => {
  let release = () => {};
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const delivered: unknown[] = [];
  const { streams, gaps, errors } = hold('deliver', { maxQueuedFrames: 3 }, async (payload) => {
    await blocked;
    delivered.push(payload);
  });
  streams.receive(snapshot(0));
  for (let seq = 1; seq <= 10; seq++) streams.receive(append(seq, seq));
  // Kingdom's control frames are never dropped, however far behind the handlers are.
  streams.receive({ type: 'opened', stream: 'x:1' });
  release();
  await Bun.sleep(5);
  expect(delivered).toEqual([1, 2]);
  expect(errors.map(String)).toEqual([
    'Error: x:1: handlers are behind; appends are dropped until they catch up',
  ]);
  streams.receive(append(11, 11));
  await Bun.sleep(5);
  expect(delivered).toEqual([1, 2, 11]);
  expect(gaps).toEqual([{ after: 2, seq: 11 }]);
});
