import { expect, test } from 'bun:test';
import {
  type ViewerHostFrame,
  type ViewerKingdomFrame,
  viewerBodyChunkBytes,
  viewerHostFrameSchema,
  viewerKingdomFrameSchema,
  viewerMaxRequestBodyBytes,
} from '../src/contracts';
import { type ViewerHandlers, ViewerRelay, type ViewerSocketPeer } from '../src/viewerRelay';

const origin = 'https://foundry.example.test';
const line = (handlers: ViewerHandlers, serving = true) => {
  const sent: ViewerKingdomFrame[] = [];
  const state = { buffered: 0 };
  const errors: unknown[] = [];
  const relay = new ViewerRelay(
    handlers,
    {
      send: (frame) => {
        sent.push(viewerKingdomFrameSchema.parse(frame));
        return true;
      },
      buffered: () => state.buffered,
      onError: (error) => void errors.push(error),
    },
    { serving, bodyIdleMs: 60 },
  );
  const receive = (frame: ViewerHostFrame) => relay.receive(viewerHostFrameSchema.parse(frame));
  return { relay, sent, state, receive, errors };
};
const until = async (met: () => boolean) => {
  for (let waited = 0; !met() && waited < 3_000; waited += 5) await Bun.sleep(5);
  expect(met()).toBe(true);
};
const head = (
  requestId: string,
  over: Partial<ViewerHostFrame & { type: 'viewer.request' }> = {},
) =>
  ({
    type: 'viewer.request',
    requestId,
    origin,
    method: 'GET',
    path: '/api/health?full=1',
    headers: { accept: 'application/json' },
    hasBody: false,
    ...over,
  }) as ViewerHostFrame;
const requestIdOf = (frame: ViewerKingdomFrame) => ('requestId' in frame ? frame.requestId : null);
const bodyOf = (sent: ViewerKingdomFrame[], requestId: string) =>
  Buffer.concat(
    sent.flatMap((frame) =>
      frame.action === 'viewer.response.body' && frame.requestId === requestId
        ? [Buffer.from(frame.data, 'base64')]
        : [],
    ),
  );
const ended = (sent: ViewerKingdomFrame[], requestId: string) =>
  sent.some(
    (frame) =>
      requestIdOf(frame) === requestId &&
      (frame.action === 'viewer.response.body'
        ? frame.last
        : frame.action === 'viewer.response' && !frame.hasBody),
  );

test('a request reaches the viewer as the address the browser used, and its answer comes back in body frames no larger than the limit', async () => {
  const big = new Uint8Array(viewerBodyChunkBytes * 2 + 17).map((_, index) => index % 251);
  const seen: { url: string; method: string; accept: string | null }[] = [];
  const { sent, receive } = line({
    request: (request) => {
      seen.push({
        url: request.url,
        method: request.method,
        accept: request.headers.get('accept'),
      });
      return new Response(big, {
        status: 200,
        headers: { 'content-type': 'image/png', etag: '"a"' },
      });
    },
  });
  const requestId = Bun.randomUUIDv7();
  receive(head(requestId));
  await until(() => ended(sent, requestId));
  expect(seen).toEqual([
    { url: `${origin}/api/health?full=1`, method: 'GET', accept: 'application/json' },
  ]);
  expect(sent[0]).toMatchObject({
    action: 'viewer.response',
    requestId,
    status: 200,
    hasBody: true,
    headers: { 'content-type': 'image/png', etag: '"a"' },
  });
  expect(bodyOf(sent, requestId).equals(Buffer.from(big))).toBe(true);
  const bodies = sent.filter((frame) => frame.action === 'viewer.response.body');
  expect(bodies.length).toBeGreaterThanOrEqual(4);
  expect(bodies.filter((frame) => frame.last)).toHaveLength(1);
  expect(bodies.at(-1)?.last).toBe(true);
});

test('a request body arrives whole; one past the limit is answered 413 and never reaches the viewer', async () => {
  const bodies: number[] = [];
  const { sent, receive } = line({
    request: async (request) => {
      bodies.push((await request.arrayBuffer()).byteLength);
      return new Response(null, { status: 204 });
    },
  });
  const chunk = Buffer.alloc(viewerBodyChunkBytes, 7).toString('base64');
  const post = (requestId: string, chunks: number) => {
    receive(head(requestId, { method: 'POST', path: '/api/attachments/images', hasBody: true }));
    for (let index = 0; index < chunks; index++)
      receive({ type: 'viewer.request.body', requestId, data: chunk, last: index === chunks - 1 });
  };
  const fits = Bun.randomUUIDv7();
  post(fits, 3);
  await until(() => ended(sent, fits));
  expect(bodies).toEqual([viewerBodyChunkBytes * 3]);
  expect(sent.find((frame) => requestIdOf(frame) === fits)).toMatchObject({
    status: 204,
    hasBody: false,
  });

  const tooLarge = Bun.randomUUIDv7();
  post(tooLarge, Math.floor(viewerMaxRequestBodyBytes / viewerBodyChunkBytes) + 1);
  await until(() => ended(sent, tooLarge));
  expect(sent.filter((frame) => requestIdOf(frame) === tooLarge)).toEqual([
    { action: 'viewer.response', requestId: tooLarge, status: 413, headers: {}, hasBody: false },
  ]);
  expect(bodies).toHaveLength(1);
});

test('a viewer that is not served answers 403 and refuses sockets; switching it tells Kingdom and ends what was open', async () => {
  let asked = 0;
  const closed: (number | undefined)[] = [];
  const { relay, sent, receive } = line(
    {
      request: () => {
        asked += 1;
        return new Response('ok');
      },
      socket: () => ({ message: () => {}, close: (code) => void closed.push(code) }),
    },
    false,
  );
  relay.announce();
  const refused = Bun.randomUUIDv7();
  receive(head(refused));
  const socketId = Bun.randomUUIDv7();
  receive({ type: 'viewer.socket.open', socketId, origin, path: '/ws', headers: {} });
  expect(sent).toEqual([
    { action: 'viewer.serving', serving: false },
    { action: 'viewer.response', requestId: refused, status: 403, headers: {}, hasBody: false },
    { action: 'viewer.socket.close', socketId, code: 1008, reason: 'viewer not served' },
  ]);
  expect(asked).toBe(0);

  relay.serve(true);
  expect(sent.at(-1)).toEqual({ action: 'viewer.serving', serving: true });
  const held = Bun.randomUUIDv7();
  receive({ type: 'viewer.socket.open', socketId: held, origin, path: '/ws', headers: {} });
  await until(() => sent.some((frame) => frame.action === 'viewer.socket.opened'));
  relay.serve(false);
  expect(closed).toEqual([1001]);
  expect(sent.at(-1)).toEqual({ action: 'viewer.serving', serving: false });
});

test("the viewer's socket: what it sends while accepting follows the opened frame, in order; messages and closes pass both ways", async () => {
  const got: string[] = [];
  const closes: (number | undefined)[] = [];
  let peer: ViewerSocketPeer | undefined;
  const { sent, receive } = line({
    request: () => new Response(null, { status: 404 }),
    socket: async (request, browser) => {
      peer = browser;
      browser.send(`hello ${new URL(request.url).pathname}${new URL(request.url).search}`);
      await Bun.sleep(10);
      browser.send('second');
      return { message: (data) => void got.push(data), close: (code) => void closes.push(code) };
    },
  });
  const socketId = Bun.randomUUIDv7();
  receive({ type: 'viewer.socket.open', socketId, origin, path: '/ws?client=1', headers: {} });
  await until(() => sent.length === 3);
  expect(sent).toEqual([
    { action: 'viewer.socket.opened', socketId },
    { action: 'viewer.socket.message', socketId, data: 'hello /ws?client=1' },
    { action: 'viewer.socket.message', socketId, data: 'second' },
  ]);
  receive({ type: 'viewer.socket.message', socketId, data: 'from the browser' });
  expect(got).toEqual(['from the browser']);
  receive({ type: 'viewer.socket.close', socketId, code: 1000 });
  expect(closes).toEqual([1000]);
  peer?.send('after close');
  peer?.close(1000);
  expect(sent).toHaveLength(3);

  const second = Bun.randomUUIDv7();
  receive({ type: 'viewer.socket.open', socketId: second, origin, path: '/ws', headers: {} });
  await until(() =>
    sent.some((frame) => frame.action === 'viewer.socket.opened' && frame.socketId === second),
  );
  peer?.close(4001, 'viewer restarting');
  expect(sent.at(-1)).toEqual({
    action: 'viewer.socket.close',
    socketId: second,
    code: 4001,
    reason: 'viewer restarting',
  });
});

test('a cancelled request stops being answered, and a dropped line ends requests and sockets', async () => {
  const aborted: string[] = [];
  const closes: (number | undefined)[] = [];
  const { relay, sent, receive } = line({
    request: (request) =>
      new Promise<Response>((_resolve, reject) => {
        request.signal.addEventListener('abort', () => {
          aborted.push(new URL(request.url).pathname);
          reject(Error('aborted'));
        });
      }),
    socket: () => ({ message: () => {}, close: (code) => void closes.push(code) }),
  });
  const cancelled = Bun.randomUUIDv7();
  receive(head(cancelled, { path: '/slow' }));
  receive({ type: 'viewer.request.cancel', requestId: cancelled });
  const dropped = Bun.randomUUIDv7();
  receive(head(dropped, { path: '/slower' }));
  const socketId = Bun.randomUUIDv7();
  receive({ type: 'viewer.socket.open', socketId, origin, path: '/ws', headers: {} });
  await until(() => sent.some((frame) => frame.action === 'viewer.socket.opened'));
  relay.down();
  await Bun.sleep(20);
  expect(aborted).toEqual(['/slow', '/slower']);
  expect(closes).toEqual([1001]);
  expect(sent).toEqual([{ action: 'viewer.socket.opened', socketId }]);
});

test('body frames wait while the socket has more than a megabyte still to send', async () => {
  const { sent, state, receive } = line({
    request: () => new Response(new Uint8Array(viewerBodyChunkBytes * 3)),
  });
  state.buffered = 2 * 1024 * 1024;
  const requestId = Bun.randomUUIDv7();
  receive(head(requestId));
  await Bun.sleep(60);
  expect(sent.filter((frame) => frame.action === 'viewer.response.body')).toHaveLength(0);
  state.buffered = 0;
  await until(() => ended(sent, requestId));
  expect(bodyOf(sent, requestId).byteLength).toBe(viewerBodyChunkBytes * 3);
});

test('a viewer that throws is answered 502', async () => {
  const { sent, receive } = line({
    request: () => {
      throw Error('viewer broke');
    },
  });
  const requestId = Bun.randomUUIDv7();
  receive(head(requestId));
  await until(() => ended(sent, requestId));
  expect(sent).toEqual([
    { action: 'viewer.response', requestId, status: 502, headers: {}, hasBody: false },
  ]);
});

test('a body that fails part way ends with a frame marked cut short, not a normal end', async () => {
  const { sent, receive } = line({
    request: () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2, 3]));
          },
          pull() {
            throw Error('the file went away');
          },
        }),
      ),
  });
  const requestId = Bun.randomUUIDv7();
  receive(head(requestId));
  await until(() => ended(sent, requestId));
  expect(sent.at(-1)).toEqual({
    action: 'viewer.response.body',
    requestId,
    data: '',
    last: true,
    cutShort: true,
  });
});

test('cancelling ends a response stream that has gone quiet', async () => {
  let cancelled = false;
  const { sent, receive } = line({
    request: () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: first\n\n'));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      ),
  });
  const requestId = Bun.randomUUIDv7();
  receive(head(requestId));
  await until(() => sent.some((frame) => frame.action === 'viewer.response.body'));
  receive({ type: 'viewer.request.cancel', requestId });
  await until(() => cancelled);
  expect(sent.filter((frame) => frame.action === 'viewer.response.body' && frame.last)).toEqual([]);
});

test('a frame that breaks the contract is answered at once: 400 for a request, a close for a socket', async () => {
  const { relay, sent, errors } = line({
    request: () => new Response('ok'),
    socket: () => ({ message: () => {}, close: () => {} }),
  });
  const requestId = Bun.randomUUIDv7();
  relay.receive({ ...head(requestId), hasBody: true });
  relay.receive({ ...head(requestId), path: 'no-leading-slash' });
  const socketId = Bun.randomUUIDv7();
  relay.receive({ type: 'viewer.socket.message', socketId, data: 7 });
  expect(sent).toEqual([
    { action: 'viewer.response', requestId, status: 400, headers: {}, hasBody: false },
    { action: 'viewer.response', requestId, status: 400, headers: {}, hasBody: false },
    { action: 'viewer.socket.close', socketId, code: 1008, reason: 'invalid frame' },
  ]);
  expect(errors).toHaveLength(3);
});

test('a request whose body stops arriving is answered 408; frames after its last one change nothing', async () => {
  let asked = 0;
  const { sent, receive } = line({
    request: async (request) => {
      asked += 1;
      await request.arrayBuffer();
      return new Response(null, { status: 204 });
    },
  });
  const stalled = Bun.randomUUIDv7();
  receive(head(stalled, { method: 'POST', hasBody: true }));
  receive({ type: 'viewer.request.body', requestId: stalled, data: 'AAAA', last: false });
  await until(() => ended(sent, stalled));
  expect(sent).toEqual([
    { action: 'viewer.response', requestId: stalled, status: 408, headers: {}, hasBody: false },
  ]);
  expect(asked).toBe(0);

  const whole = Bun.randomUUIDv7();
  receive(head(whole, { method: 'POST', hasBody: true }));
  receive({ type: 'viewer.request.body', requestId: whole, data: 'AAAA', last: true });
  receive({ type: 'viewer.request.body', requestId: whole, data: 'AAAA', last: true });
  await until(() => ended(sent, whole));
  await Bun.sleep(80);
  expect(asked).toBe(1);
  expect(sent.filter((frame) => requestIdOf(frame) === whole)).toHaveLength(1);
});

test('what the viewer sends is made fit for Kingdom: no set-cookie, close codes and reasons the wire allows, a refused socket closed', async () => {
  let peer: ViewerSocketPeer | undefined;
  let accept = true;
  const { sent, receive, errors } = line({
    request: () =>
      new Response(null, {
        status: 204,
        headers: [
          ['set-cookie', 'a=1'],
          ['set-cookie', 'b=2'],
          ['x-kept', 'yes'],
        ],
      }),
    socket: (_request, browser) => {
      peer = browser;
      return accept ? { message: () => {}, close: () => {} } : null;
    },
  });
  const requestId = Bun.randomUUIDv7();
  receive(head(requestId));
  await until(() => ended(sent, requestId));
  expect(sent[0]).toMatchObject({ headers: { 'x-kept': 'yes' } });
  expect(sent[0]).not.toHaveProperty('headers.set-cookie');

  const socketId = Bun.randomUUIDv7();
  receive({ type: 'viewer.socket.open', socketId, origin, path: '/ws', headers: {} });
  await until(() => sent.some((frame) => frame.action === 'viewer.socket.opened'));
  peer?.close(1006, 'é'.repeat(100));
  const closed = sent.at(-1);
  expect(closed).toMatchObject({ action: 'viewer.socket.close', socketId, code: 1011 });
  expect(closed?.action === 'viewer.socket.close' && Buffer.byteLength(closed.reason ?? '')).toBe(
    122,
  );

  accept = false;
  const refused = Bun.randomUUIDv7();
  receive({ type: 'viewer.socket.open', socketId: refused, origin, path: '/ws', headers: {} });
  await until(() => sent.at(-1) !== closed);
  expect(sent.at(-1)).toEqual({
    action: 'viewer.socket.close',
    socketId: refused,
    code: 1008,
    reason: 'viewer refused the socket',
  });
  expect(errors).toEqual([]);
});
