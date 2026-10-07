import { createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import {
  type AccessRequest,
  accessResultSchema,
  collectedSignetSchema,
  type IntegrationPairingProposal,
  nonceSchema,
  ownerRefSchema,
  type PrivateClientKey,
  type PublicClientKey,
  privateClientKeySchema,
  publicClientKeySchema,
  renewalCredentialPattern,
  signetCredentialsSchema,
  signetDescriptionSchema,
  signetRequestResponseSchema,
} from './contracts';
import { readPrivateJson, writePrivateJson } from './files';
import { createSignetProof } from './proof';

/** A Kingdom API origin: HTTPS, or HTTP on loopback, with no path or credentials. */
export const kingdomOrigin = (value: string) => {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/' ||
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
  )
    throw Error('Kingdom requires an HTTPS origin or loopback HTTP');
  return url.origin;
};

export const signetCredentialFileSchema = signetCredentialsSchema
  .extend({
    url: z.string().transform(kingdomOrigin),
    signetId: z.uuid(),
    integrationId: z.uuid().optional(),
    owner: ownerRefSchema.optional(),
    keyFile: z.string().refine(isAbsolute, 'keyFile must be absolute'),
    renewalCredential: z.string().regex(renewalCredentialPattern),
  })
  .strict();
export type SignetCredentialFile = z.infer<typeof signetCredentialFileSchema>;

export const generateClientKey = (): PrivateClientKey =>
  privateClientKeySchema.parse(
    generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ format: 'jwk' }),
  );
export const publicKeyOf = (key: unknown): PublicClientKey =>
  publicClientKeySchema.parse(
    createPublicKey(
      createPrivateKey({ key: privateClientKeySchema.parse(key), format: 'jwk' }),
    ).export({ format: 'jwk' }),
  );

export class SignetHttpError extends Error {
  constructor(
    readonly status: number,
    readonly detail?: string,
  ) {
    super(`Signet request refused (${status})${detail ? `: ${detail}` : ''}`);
  }
}

export interface SignetRequestOptions {
  signal?: AbortSignal;
  /** Defaults to 20 s; raise it for large uploads. */
  timeoutMs?: number;
  maxResponseBytes?: number;
}
const requestSignal = ({ signal, timeoutMs = 20000 }: SignetRequestOptions = {}) =>
  signal
    ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);

/** Stop this caller waiting without cancelling shared work (credential renewal). */
function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void pending.catch(() => {});
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener('abort', aborted, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
}

const errorDetail = async (response: Response) => {
  try {
    const text = (await response.text()).slice(0, 4096);
    const body = JSON.parse(text) as { message?: unknown; error?: { message?: unknown } };
    const message = body.error?.message ?? body.message;
    return typeof message === 'string' ? message.slice(0, 500) : undefined;
  } catch {
    return undefined;
  }
};

/** POST to Kingdom's access API and return the response's `data`. */
export async function kingdomPost(
  url: string,
  action: string,
  body: unknown,
  headers: Record<string, string> = {},
  options: SignetRequestOptions & { onDispatch?: () => void } = {},
): Promise<unknown> {
  if (!/^[a-zA-Z]+$/.test(action)) throw Error('Invalid Signet action');
  const signal = requestSignal(options);
  signal.throwIfAborted();
  const serialized = JSON.stringify(body);
  options.onDispatch?.();
  signal.throwIfAborted();
  const pendingResponse = fetch(`${kingdomOrigin(url)}/api/v1/access/${action}`, {
    method: 'POST',
    redirect: 'error',
    signal,
    headers: { 'content-type': 'application/json', ...headers },
    body: serialized,
  });
  // Also close a response from a transport that settles after cancellation.
  void pendingResponse.then(
    (response) => {
      if (signal.aborted) void response.body?.cancel().catch(() => {});
    },
    () => {},
  );
  const response = await abortable(pendingResponse, signal);
  if (signal.aborted) {
    void response.body?.cancel().catch(() => {});
    signal.throwIfAborted();
  }
  if (!response.ok) throw new SignetHttpError(response.status, await errorDetail(response));
  const reader = response.body?.getReader();
  if (!reader) throw Error('Signet response unavailable');
  const limit = options.maxResponseBytes ?? 1_048_576;
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const next = await abortable(reader.read(), signal);
      signal.throwIfAborted();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > limit) throw Error('Signet response exceeds limit');
      chunks.push(next.value);
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
  signal.throwIfAborted();
  return z.object({ data: z.unknown() }).parse(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    .data;
}

/** A DPoP proof for one call to `action`, bound to a fresh Kingdom nonce (and the token, if any). */
export async function signetProof(
  url: string,
  action: string,
  key: PrivateClientKey,
  token?: string,
  options: SignetRequestOptions = {},
): Promise<string> {
  const { nonce } = z
    .object({ nonce: nonceSchema })
    .parse(await kingdomPost(url, 'nonce', {}, {}, options));
  return createSignetProof({
    privateKey: key,
    publicKey: publicKeyOf(key),
    nonce,
    url: `${kingdomOrigin(url)}/api/v1/access/${action}`,
    method: 'POST',
    token,
  });
}

const readKey = async (keyFile: string) =>
  privateClientKeySchema.parse(await readPrivateJson(keyFile));

export type PairingTerms = Omit<IntegrationPairingProposal, 'lifecycle' | 'taskId'>;

/** Ask Kingdom to pair this device as an integration. The owner approves the review code in Kingdom. */
export async function requestPairing(
  url: string,
  keyFile: string,
  terms: PairingTerms,
  options: SignetRequestOptions = {},
) {
  const key = await readKey(keyFile);
  return signetRequestResponseSchema.parse(
    await kingdomPost(
      url,
      'requestSignet',
      { ...terms, lifecycle: 'ongoing', publicKey: publicKeyOf(key) },
      { DPoP: await signetProof(url, 'requestSignet', key, undefined, options) },
      options,
    ),
  );
}

/**
 * Collect an approved pairing. Returns null while it awaits review (Kingdom answers 409; stop
 * polling at the request's expiresAt) and throws once it is denied (403).
 */
export async function collectPairing(
  url: string,
  keyFile: string,
  deviceCode: string,
  options: SignetRequestOptions = {},
) {
  const key = await readKey(keyFile);
  try {
    return collectedSignetSchema.parse(
      await kingdomPost(
        url,
        'collectSignet',
        { deviceCode },
        { DPoP: await signetProof(url, 'collectSignet', key, undefined, options) },
        options,
      ),
    );
  } catch (error) {
    if (error instanceof SignetHttpError && error.status === 409) return null;
    throw error;
  }
}

/** Write a collected pairing next to its key; returns what a SignetClient needs. */
export async function saveCollectedSignet(
  credentialFile: string,
  url: string,
  keyFile: string,
  collected: z.infer<typeof collectedSignetSchema>,
) {
  const credential = signetCredentialFileSchema.parse({ ...collected, url, keyFile });
  await writePrivateJson(credentialFile, credential);
  return credential;
}

const renewalResponseSchema = signetCredentialsSchema.omit({ renewalCredential: true });
const refreshing = new Map<string, Promise<SignetCredentialFile>>();

export type SignetAction = 'describe' | 'execute' | 'closeTask' | 'verifyAuthority' | 'settleTask';
const signetActions: SignetAction[] = [
  'describe',
  'execute',
  'closeTask',
  'verifyAuthority',
  'settleTask',
];

/** Presents one enrolled Signet: renews its access token and signs each call with the device key. */
export class SignetClient {
  constructor(
    private readonly credentialFile: string,
    private readonly expected: { url?: string; signetId?: string } = {},
  ) {}

  async credentials(force = false, options: SignetRequestOptions = {}, allowRenewal = true) {
    const signal = requestSignal(options);
    const credential = signetCredentialFileSchema.parse(
      await abortable(readPrivateJson(this.credentialFile), signal),
    );
    if (
      (this.expected.url && credential.url !== kingdomOrigin(this.expected.url)) ||
      (this.expected.signetId && credential.signetId !== this.expected.signetId)
    )
      throw Error('Signet credential audience mismatch');
    if (Date.parse(credential.idleExpiresAt) <= Date.now())
      throw Error('Signet enrollment idle timeout; enroll this device again');
    if (!allowRenewal) {
      if (Date.parse(credential.expiresAt) <= Date.now())
        throw Error('This call requires an unexpired existing access token');
      return credential;
    }
    if (!force && Date.parse(credential.expiresAt) > Date.now() + 30000) return credential;
    if (Date.parse(credential.renewalExpiresAt) <= Date.now())
      throw Error('Signet enrollment expired; request renewed approval');
    const existing = refreshing.get(this.credentialFile);
    if (existing) return abortable(existing, signal);
    const refresh = (async () => {
      // Renewal belongs to the credential file, not the first waiting caller.
      const key = await readKey(credential.keyFile);
      const response = renewalResponseSchema.parse(
        await kingdomPost(
          credential.url,
          'renewSignet',
          { renewalCredential: credential.renewalCredential },
          { DPoP: await signetProof(credential.url, 'renewSignet', key) },
        ),
      );
      if (
        response.enrollmentId !== credential.enrollmentId ||
        response.lifecycle !== credential.lifecycle ||
        response.taskId !== credential.taskId
      )
        throw Error('Signet enrollment changed');
      const updated = signetCredentialFileSchema.parse({ ...credential, ...response });
      await writePrivateJson(this.credentialFile, updated);
      return updated;
    })();
    refreshing.set(this.credentialFile, refresh);
    const settled = refresh.finally(() => refreshing.delete(this.credentialFile));
    return abortable(settled, signal);
  }

  async renew(options: SignetRequestOptions = {}): Promise<void> {
    await this.credentials(true, options);
  }

  async post(
    action: SignetAction,
    body: unknown,
    options: SignetRequestOptions & { onDispatch?: () => void } = {},
  ) {
    if (!signetActions.includes(action)) throw Error('Unsupported Signet action');
    const credential = await this.credentials(false, options, action !== 'settleTask');
    const key = await readKey(credential.keyFile);
    const proof = await signetProof(credential.url, action, key, credential.accessToken, options);
    return kingdomPost(
      credential.url,
      action,
      body,
      { authorization: `DPoP ${credential.accessToken}`, DPoP: proof },
      options,
    );
  }

  async describe(options: SignetRequestOptions = {}) {
    const { signetId } = await this.credentials(false, options);
    return signetDescriptionSchema.parse(await this.post('describe', { signetId }, options));
  }

  /** Run one integration operation through the Signet. Each call is a new request id. */
  async execute(
    request: Omit<AccessRequest, 'requestId' | 'signetId'>,
    options: SignetRequestOptions = {},
  ) {
    const { signetId } = await this.credentials(false, options);
    return accessResultSchema.parse(
      await this.post('execute', { ...request, signetId, requestId: crypto.randomUUID() }, options),
    );
  }
}
