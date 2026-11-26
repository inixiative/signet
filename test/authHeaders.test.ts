import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  generateSignetKey,
  SignetClient,
  SignetHttpError,
  saveCollectedSignet,
  signetPost,
  signetProofFor,
  verifySignetProof,
  writePrivateJson,
} from '../src';

describe('signetProofFor, SignetClient.authHeaders, and structured SignetHttpError refusals', () => {
  test('parses structured refusal code and message from Kingdom error details', async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        Response.json(
          {
            message: 'chorus_warming; execution 0199-test',
            details: [{ code: 'chorus_warming', message: 'Chorus host is warming' }],
          },
          { status: 503 },
        ),
    });
    try {
      const error = await signetPost(server.url.href, 'execute', {}).catch((caught) => caught);
      expect(error).toBeInstanceOf(SignetHttpError);
      const httpError = error as SignetHttpError;
      expect(httpError.status).toBe(503);
      expect(httpError.detail).toBe('chorus_warming; execution 0199-test');
      expect(httpError.refusal).toBe('chorus_warming');
      expect(httpError.refusalMessage).toBe('Chorus host is warming');
    } finally {
      server.stop(true);
    }
  });

  test('authHeaders signs arbitrary GET/DELETE Kingdom endpoints with DPoP proof bound to method and path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'signet-auth-headers-'));
    const nonce = 'A'.repeat(43);
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        if (new URL(req.url).pathname === '/api/v1/access/nonce') {
          return Response.json({ data: { nonce } });
        }
        return new Response('not found', { status: 404 });
      },
    });
    try {
      const keyFile = join(dir, 'key.json');
      const credFile = join(dir, 'cred.json');
      await writePrivateJson(keyFile, generateSignetKey());
      const accessToken = `kingdom_${'B'.repeat(43)}`;
      await saveCollectedSignet(credFile, server.url.origin, keyFile, {
        signetId: Bun.randomUUIDv7(),
        enrollmentId: Bun.randomUUIDv7(),
        lifecycle: 'ongoing',
        taskId: null,
        renewalCredential: `signet_renew_${'C'.repeat(43)}`,
        accessToken,
        expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
        renewalExpiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
        idleExpiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
        tokenType: 'DPoP',
      });

      const client = await SignetClient.fromFile(credFile);
      const headers = await client.authHeaders('GET', '/api/v1/systemFile?projectId=proj-1');
      expect(headers.authorization).toBe(`DPoP ${accessToken}`);

      const verified = await verifySignetProof({
        proof: headers.DPoP,
        url: `${server.url.origin}/api/v1/systemFile?projectId=proj-1`,
        method: 'GET',
        now: new Date(),
        token: accessToken,
      });
      expect(verified.nonce).toBe(nonce);

      await expect(
        signetProofFor(server.url.origin, 'GET', '//evil.test/x', keyFile),
      ).rejects.toThrow('Invalid Signet request path');
    } finally {
      server.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
