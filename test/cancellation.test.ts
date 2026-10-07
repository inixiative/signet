import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateSignetKey, SignetClient, signetPost } from '../src/client';
import { writePrivateJson } from '../src/files';

const url = 'https://kingdom.example';
const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
const transport = (fn: (url: string, init: RequestInit) => Promise<Response> | Response) => {
  const spy = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(
      (input: string | URL | Request, init?: RequestInit) =>
        Promise.resolve(fn(String(input), init!)),
      { preconnect: globalThis.fetch.preconnect },
    ),
  );
  cleanup.push(() => spy.mockRestore());
  return spy;
};
const data = (value: unknown) => Response.json({ data: value });
const nonce = () => data({ nonce: 'n'.repeat(43) });
async function fixture(expired = false) {
  const dir = await mkdtemp(join(tmpdir(), 'signet-cancel-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const keyFile = join(dir, 'key.json'),
    credentialFile = join(dir, 'credential.json');
  await writePrivateJson(keyFile, generateSignetKey());
  const credential = {
    url,
    signetId: crypto.randomUUID(),
    enrollmentId: crypto.randomUUID(),
    lifecycle: 'ongoing',
    taskId: null,
    keyFile,
    renewalCredential: 'signet_renew_' + 'r'.repeat(43),
    accessToken: 'kingdom_' + 't'.repeat(43),
    expiresAt: new Date(Date.now() + (expired ? -1000 : 300000)).toISOString(),
    renewalExpiresAt: new Date(Date.now() + 3600000).toISOString(),
    idleExpiresAt: new Date(Date.now() + 3600000).toISOString(),
    tokenType: 'DPoP',
  };
  await writePrivateJson(credentialFile, credential);
  return {
    client: new SignetClient(url, credentialFile, credential.signetId),
    credentialFile,
    credential,
    renewal: {
      enrollmentId: credential.enrollmentId,
      lifecycle: credential.lifecycle,
      taskId: null,
      accessToken: 'kingdom_' + 'u'.repeat(43),
      expiresAt: new Date(Date.now() + 300000).toISOString(),
      renewalExpiresAt: credential.renewalExpiresAt,
      idleExpiresAt: credential.idleExpiresAt,
      tokenType: 'DPoP',
    },
  };
}

test('already canceled caller never reads credentials or fetches', async () => {
  const spy = transport(() => {
    throw Error('unexpected network');
  });
  const signal = AbortSignal.abort(new Error('stopped'));
  const client = new SignetClient(url, '/missing', crypto.randomUUID());
  await expect(client.post('verifyAuthority', {}, undefined, { signal })).rejects.toThrow(
    'stopped',
  );
  expect(spy).not.toHaveBeenCalled();
});

test('authority action retains DPoP endpoint/token binding and existing dispatch callback', async () => {
  const f = await fixture();
  let dispatched = 0;
  const body = {
    requestId: crypto.randomUUID(),
    bindingDigest: 'a'.repeat(64),
    check: { kind: 'caller' },
  };
  const spy = transport((target, init) => {
    if (target.endsWith('/nonce')) return nonce();
    expect(target).toBe(url + '/api/v1/access/verifyAuthority');
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe('DPoP ' + f.credential.accessToken);
    const proof = JSON.parse(Buffer.from(headers.DPoP!.split('.')[1]!, 'base64url').toString());
    expect(proof.htu).toBe(target);
    expect(proof.htm).toBe('POST');
    expect(proof.ath).toBeString();
    expect(JSON.parse(init.body as string)).toEqual(body);
    expect(init.redirect).toBe('error');
    return data({ observed: true });
  });
  expect(
    await f.client.post('verifyAuthority', body, () => {
      dispatched++;
    }),
  ).toEqual({ observed: true });
  expect(spy).toHaveBeenCalledTimes(2);
  expect(dispatched).toBe(1);
});

test('canceling nonce acquisition refuses a late proof and never dispatches business work', async () => {
  const f = await fixture(),
    controller = new AbortController();
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<Response>();
  const spy = transport(() => {
    entered.resolve();
    return release.promise;
  });
  const pending = f.client.post('execute', {}, undefined, { signal: controller.signal });
  const rejected = pending.catch((error) => error);
  await entered.promise;
  controller.abort(new Error('nonce stopped'));
  expect(((await rejected) as Error).message).toBe('nonce stopped');
  release.resolve(nonce());
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(spy).toHaveBeenCalledTimes(1);
});

test('cancellation inside dispatch guard is rechecked before fetch', async () => {
  const controller = new AbortController();
  const spy = transport(() => {
    throw Error('unexpected network');
  });
  await expect(
    signetPost(url, 'execute', {}, {}, () => controller.abort(new Error('revoked')), {
      signal: controller.signal,
    }),
  ).rejects.toThrow('revoked');
  expect(spy).not.toHaveBeenCalled();
});

test('abort interrupts a stalled response body and cancels its reader', async () => {
  const controller = new AbortController(),
    reading = Promise.withResolvers<void>();
  let canceled = false;
  transport(
    () =>
      new Response(
        new ReadableStream(
          {
            pull() {
              reading.resolve();
            },
            cancel() {
              canceled = true;
            },
          },
          { highWaterMark: 0 },
        ),
      ),
  );
  const pending = signetPost(url, 'verifyAuthority', {}, {}, undefined, {
    signal: controller.signal,
  });
  const rejected = pending.catch((error) => error);
  await reading.promise;
  controller.abort(new Error('body stopped'));
  expect(((await rejected) as Error).message).toBe('body stopped');
  expect(canceled).toBe(true);
});

test('first caller cancellation leaves one shared renewal for another caller', async () => {
  const f = await fixture(true),
    controller = new AbortController();
  const renewing = Promise.withResolvers<void>(),
    release = Promise.withResolvers<Response>();
  let renewals = 0,
    operations = 0;
  transport((target) => {
    if (target.endsWith('/nonce')) return nonce();
    if (target.endsWith('/renewSignet')) {
      renewals++;
      renewing.resolve();
      return release.promise;
    }
    operations++;
    return data({ observed: true });
  });
  const first = f.client.post('verifyAuthority', {}, undefined, { signal: controller.signal });
  const rejected = first.catch((error) => error);
  await renewing.promise;
  const second = f.client.post('describe', {});
  controller.abort(new Error('first stopped'));
  expect(((await rejected) as Error).message).toBe('first stopped');
  release.resolve(data(f.renewal));
  expect(await second).toEqual({ observed: true });
  expect(renewals).toBe(1);
  expect(operations).toBe(1);
});

test('failed shared renewal releases its slot; business calls are never retried', async () => {
  const f = await fixture(true);
  let renewals = 0,
    operations = 0;
  transport((target) => {
    if (target.endsWith('/nonce')) return nonce();
    if (target.endsWith('/renewSignet')) {
      renewals++;
      return renewals === 1 ? new Response(null, { status: 503 }) : data(f.renewal);
    }
    operations++;
    return new Response(null, { status: 503 });
  });
  await expect(f.client.post('execute', {})).rejects.toThrow('503');
  await expect(f.client.post('execute', {})).rejects.toThrow('503');
  expect(renewals).toBe(2);
  expect(operations).toBe(1);
});

test('bounded body handling still refuses oversized responses', async () => {
  transport(() => new Response('x'.repeat(1_048_577)));
  await expect(signetPost(url, 'verifyAuthority', {})).rejects.toThrow('exceeds limit');
});

test('unknown runtime action is refused before reading credentials or requesting proof', async () => {
  const spy = transport(() => {
    throw Error('unexpected network');
  });
  const client = new SignetClient(url, '/missing', crypto.randomUUID());
  await expect(client.post('deleteEverything' as 'describe', {})).rejects.toThrow(
    'Unsupported Signet action',
  );
  expect(spy).not.toHaveBeenCalled();
});

for (const seconds of [300, 15]) {
  test(`settlement uses existing token with ${seconds}s remaining without renewal and uses fresh proofs on explicit replay`, async () => {
    const f = await fixture();
    f.credential.expiresAt = new Date(Date.now() + seconds * 1000).toISOString();
    await writePrivateJson(f.credentialFile, f.credential);
    const proofs: string[] = [];
    const body = {
      requestId: crypto.randomUUID(),
      deliverBefore: new Date(Date.now() + 10000).toISOString(),
    };
    const spy = transport((target, init) => {
      if (target.endsWith('/nonce')) return nonce();
      expect(target).toBe(url + '/api/v1/access/settleTask');
      const headers = init.headers as Record<string, string>;
      expect(headers.authorization).toBe('DPoP ' + f.credential.accessToken);
      proofs.push(headers.DPoP!);
      const proof = JSON.parse(Buffer.from(headers.DPoP!.split('.')[1]!, 'base64url').toString());
      expect(proof.htu).toBe(target);
      expect(JSON.parse(init.body as string)).toEqual(body);
      return data({ settlementId: 'same', dataAccess: false });
    });
    const first = await f.client.post('settleTask', body);
    expect(await f.client.post('settleTask', body)).toEqual(first);
    expect(proofs[0]).not.toBe(proofs[1]);
    expect(spy).toHaveBeenCalledTimes(4);
  });
}

test('expired settlement token refuses before network and never renews', async () => {
  const f = await fixture(true);
  const spy = transport(() => {
    throw Error('unexpected network');
  });
  await expect(f.client.post('settleTask', {})).rejects.toThrow('unexpired existing access token');
  expect(spy).not.toHaveBeenCalled();
});

test('uncertain settlement is not retried or renewed automatically', async () => {
  const f = await fixture();
  const spy = transport((target) =>
    target.endsWith('/nonce') ? nonce() : new Response(null, { status: 503 }),
  );
  await expect(f.client.post('settleTask', {})).rejects.toThrow('503');
  expect(spy).toHaveBeenCalledTimes(2);
});

test('settlement cancellation at dispatch guard prevents business request', async () => {
  const f = await fixture(),
    controller = new AbortController();
  const spy = transport((target) => {
    expect(target.endsWith('/nonce')).toBe(true);
    return nonce();
  });
  await expect(
    f.client.post('settleTask', {}, () => controller.abort(new Error('local consent revoked')), {
      signal: controller.signal,
    }),
  ).rejects.toThrow('local consent revoked');
  expect(spy).toHaveBeenCalledTimes(1);
});
