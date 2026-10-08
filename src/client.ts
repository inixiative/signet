import { createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import {
  type AccessRequest,
  accessResultSchema,
  accessTokenPattern,
  collectedSignetSchema,
  type InstallationKind,
  installationInquiriesResponseSchema,
  installationSignetsResponseSchema,
  nonceSchema,
  ownerRefSchema,
  publicClientKeySchema,
  type RegistrationTerms,
  registerInstallationResponseSchema,
  renewalCredentialPattern,
  requestRegistrationResponseSchema,
  signetDescriptionSchema,
  signetKeySchema,
  signetLifecycleSchema,
} from './contracts';
import { readPrivateJson, writePrivateJson } from './files';
import { createSignetProof } from './proof';

/** A Kingdom API origin: HTTPS, or HTTP on loopback, with no path or credentials. */
export const kingdomUrl = (value: string) => {
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

/** What a presenting client keeps on disk (0600) for one enrolled Signet. */
export const signetCredentialSchema = z
  .object({
    url: z.string().transform(kingdomUrl),
    signetId: z.uuid(),
    integrationId: z.uuid().optional(),
    owner: ownerRefSchema.optional(),
    enrollmentId: z.uuid(),
    lifecycle: signetLifecycleSchema,
    taskId: z.uuid().nullable(),
    keyFile: z.string().refine(isAbsolute),
    renewalCredential: z.string().regex(renewalCredentialPattern),
    accessToken: z.string().regex(accessTokenPattern),
    expiresAt: z.iso.datetime(),
    renewalExpiresAt: z.iso.datetime(),
    idleExpiresAt: z.iso.datetime(),
    tokenType: z.literal('DPoP'),
  })
  .strict();
export type SignetCredential = z.infer<typeof signetCredentialSchema>;
export const deliveredSignetSchema = signetCredentialSchema.omit({ url: true, keyFile: true });
const renewalResponseSchema = deliveredSignetSchema.omit({
  signetId: true,
  integrationId: true,
  owner: true,
  renewalCredential: true,
});
const refreshing = new Map<string, Promise<SignetCredential>>();

export const generateSignetKey = () =>
  signetKeySchema.parse(
    generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ format: 'jwk' }),
  );
export const signetPublicKey = (key: unknown) =>
  publicClientKeySchema.parse(
    createPublicKey(createPrivateKey({ key: signetKeySchema.parse(key), format: 'jwk' })).export({
      format: 'jwk',
    }),
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
}
const requestSignal = ({ signal, timeoutMs = 20000 }: SignetRequestOptions = {}) =>
  signal
    ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);

/** Stop this caller waiting without canceling shared credential renewal. */
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
    const body = JSON.parse((await response.text()).slice(0, 4096)) as {
      message?: unknown;
      error?: { message?: unknown };
    };
    const message = body.error?.message ?? body.message;
    return typeof message === 'string' ? message.slice(0, 500) : undefined;
  } catch {
    return undefined;
  }
};

/** POST to Kingdom's access API and return the response's `data`. */
export async function signetPost(
  url: string,
  action: string,
  body: unknown,
  headers: Record<string, string> = {},
  onDispatch?: () => void,
  options: SignetRequestOptions = {},
): Promise<unknown> {
  if (!/^[a-zA-Z]+$/.test(action)) throw Error('Invalid Signet action');
  const signal = requestSignal(options);
  signal.throwIfAborted();
  const serialized = JSON.stringify(body);
  onDispatch?.();
  signal.throwIfAborted();
  const pendingResponse = fetch(`${kingdomUrl(url)}/api/v1/access/${action}`, {
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
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const next = await abortable(reader.read(), signal);
      signal.throwIfAborted();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > 1_048_576) throw Error('Signet response exceeds limit');
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
  keyFile: string,
  token?: string,
  options: SignetRequestOptions = {},
): Promise<string> {
  const signal = requestSignal(options);
  signal.throwIfAborted();
  const key = signetKeySchema.parse(await abortable(readPrivateJson(keyFile), signal));
  signal.throwIfAborted();
  const { nonce } = z
    .object({ nonce: nonceSchema })
    .parse(await signetPost(url, 'nonce', {}, {}, undefined, { signal }));
  signal.throwIfAborted();
  return createSignetProof({
    privateKey: key,
    publicKey: signetPublicKey(key),
    nonce,
    url: `${kingdomUrl(url)}/api/v1/access/${action}`,
    method: 'POST',
    token,
  });
}

/** A call an Installation makes as itself: no access token, a DPoP proof by its key. */
async function installationPost<T>(
  url: string,
  keyFile: string,
  action: string,
  body: unknown,
  schema: z.ZodType<T>,
  options: SignetRequestOptions = {},
): Promise<T> {
  return schema.parse(
    await signetPost(
      url,
      action,
      body,
      { DPoP: await signetProof(url, action, keyFile, undefined, options) },
      undefined,
      options,
    ),
  );
}

/** Make this installation known to Kingdom. Idempotent for the same key. */
export const registerInstallation = (
  url: string,
  keyFile: string,
  installation: { kind: InstallationKind; name: string; sourceId?: string },
  options: SignetRequestOptions = {},
) =>
  readPrivateJson(keyFile).then((key) =>
    installationPost(
      url,
      keyFile,
      'registerInstallation',
      { ...installation, publicKey: signetPublicKey(key) },
      registerInstallationResponseSchema,
      options,
    ),
  );

/** Ask to be registered as an integration; a person claims the review code in Kingdom. */
export const requestRegistration = (
  url: string,
  keyFile: string,
  terms: RegistrationTerms,
  options: SignetRequestOptions = {},
) =>
  installationPost(
    url,
    keyFile,
    'requestRegistration',
    { terms },
    requestRegistrationResponseSchema,
    options,
  );

/** This installation's pending request and its inquiries. */
export const installationInquiries = (
  url: string,
  keyFile: string,
  options: SignetRequestOptions = {},
) =>
  installationPost(
    url,
    keyFile,
    'installationInquiries',
    {},
    installationInquiriesResponseSchema,
    options,
  );

export const cancelInstallationInquiry = (
  url: string,
  keyFile: string,
  inquiryId: string,
  options: SignetRequestOptions = {},
) =>
  installationPost(
    url,
    keyFile,
    'cancelInstallationInquiry',
    { inquiryId },
    z.object({ id: z.uuid() }),
    options,
  );

/**
 * Collect the Signet an approved inquiry minted. Returns null while it awaits review (Kingdom
 * answers 409) and throws once it is declined, denied or past its delivery deadline (403).
 */
export async function collectSignet(
  url: string,
  keyFile: string,
  inquiryId: string,
  options: SignetRequestOptions = {},
) {
  try {
    return await installationPost(
      url,
      keyFile,
      'collectSignet',
      { inquiryId },
      collectedSignetSchema,
      options,
    );
  } catch (error) {
    if (error instanceof SignetHttpError && error.status === 409) return null;
    throw error;
  }
}

/** The Signets held by this installation's integrations. */
export const installationSignets = (
  url: string,
  keyFile: string,
  options: SignetRequestOptions = {},
) =>
  installationPost(
    url,
    keyFile,
    'installationSignets',
    {},
    installationSignetsResponseSchema,
    options,
  );

/** Enroll this installation's key on a Signet one of its integrations holds. */
export const enrollInstallationSignet = (
  url: string,
  keyFile: string,
  signetId: string,
  options: SignetRequestOptions = {},
) =>
  installationPost(
    url,
    keyFile,
    'enrollInstallationSignet',
    { signetId },
    collectedSignetSchema,
    options,
  );

/** Move this installation to a new key; both keys sign. Re-enroll its Signets afterwards. */
export async function rotateInstallationKey(
  url: string,
  keyFile: string,
  newKeyFile: string,
  options: SignetRequestOptions = {},
) {
  const publicKey = signetPublicKey(await readPrivateJson(newKeyFile));
  const proof = await signetProof(url, 'rotateInstallationKey', newKeyFile, undefined, options);
  return installationPost(
    url,
    keyFile,
    'rotateInstallationKey',
    { publicKey, proof },
    registerInstallationResponseSchema,
    options,
  );
}

/** Write a collected Signet next to its key; the file is what a SignetClient presents. */
export async function saveCollectedSignet(
  credentialFile: string,
  url: string,
  keyFile: string,
  collected: z.infer<typeof collectedSignetSchema>,
) {
  const credential = signetCredentialSchema.parse({ ...collected, url, keyFile });
  await writePrivateJson(credentialFile, credential);
  return credential;
}

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
    readonly url: string,
    private credentialFile: string,
    private signetId: string,
  ) {
    this.url = kingdomUrl(url);
  }
  /** A client for the Signet a credential file holds. */
  static async fromFile(credentialFile: string) {
    const credential = signetCredentialSchema.parse(await readPrivateJson(credentialFile));
    return new SignetClient(credential.url, credentialFile, credential.signetId);
  }
  private async credentials(force = false, signal = requestSignal(), allowRenewal = true) {
    signal.throwIfAborted();
    const credential = signetCredentialSchema.parse(
      await abortable(readPrivateJson(this.credentialFile), signal),
    );
    signal.throwIfAborted();
    if (credential.url !== this.url || credential.signetId !== this.signetId)
      throw Error('Signet credential audience mismatch');
    if (Date.parse(credential.idleExpiresAt) <= Date.now())
      throw Error('Signet enrollment idle timeout; enroll this device again');
    if (!allowRenewal) {
      if (Date.parse(credential.expiresAt) <= Date.now())
        throw Error('Task settlement requires an unexpired existing access token');
      return credential;
    }
    if (!force && Date.parse(credential.expiresAt) > Date.now() + 30000) return credential;
    if (Date.parse(credential.renewalExpiresAt) <= Date.now())
      throw Error('Signet enrollment expired; request renewed approval');
    const existing = refreshing.get(this.credentialFile);
    if (existing) return abortable(existing, signal);
    const refresh = (async () => {
      // Renewal belongs to the credential file, not the first waiting caller.
      const refreshSignal = requestSignal();
      const response = renewalResponseSchema.parse(
        await signetPost(
          this.url,
          'renewSignet',
          { renewalCredential: credential.renewalCredential },
          {
            DPoP: await signetProof(this.url, 'renewSignet', credential.keyFile, undefined, {
              signal: refreshSignal,
            }),
          },
          undefined,
          { signal: refreshSignal },
        ),
      );
      if (
        response.enrollmentId !== credential.enrollmentId ||
        response.lifecycle !== credential.lifecycle ||
        response.taskId !== credential.taskId
      )
        throw Error('Signet enrollment changed');
      const updated = signetCredentialSchema.parse({ ...credential, ...response });
      await writePrivateJson(this.credentialFile, updated);
      return updated;
    })();
    refreshing.set(this.credentialFile, refresh);
    const settled = refresh.finally(() => refreshing.delete(this.credentialFile));
    return abortable(settled, signal);
  }
  async renew(options: SignetRequestOptions = {}): Promise<void> {
    const signal = requestSignal(options);
    await this.credentials(true, signal);
    signal.throwIfAborted();
  }
  async post(
    action: SignetAction,
    body: unknown,
    onDispatch?: () => void,
    options: SignetRequestOptions = {},
  ) {
    if (!signetActions.includes(action)) throw Error('Unsupported Signet action');
    const signal = requestSignal(options);
    signal.throwIfAborted();
    const credential = await this.credentials(false, signal, action !== 'settleTask');
    signal.throwIfAborted();
    const proof = await signetProof(this.url, action, credential.keyFile, credential.accessToken, {
      signal,
      timeoutMs: options.timeoutMs,
    });
    signal.throwIfAborted();
    return signetPost(
      this.url,
      action,
      body,
      { authorization: `DPoP ${credential.accessToken}`, DPoP: proof },
      onDispatch,
      { signal, timeoutMs: options.timeoutMs },
    );
  }
  async describe(options: SignetRequestOptions = {}) {
    return signetDescriptionSchema.parse(
      await this.post('describe', { signetId: this.signetId }, undefined, options),
    );
  }
  /** Run one integration operation through the Signet; every call is a new request id. */
  async execute(
    request: Omit<AccessRequest, 'requestId' | 'signetId'>,
    options: SignetRequestOptions = {},
  ) {
    return accessResultSchema.parse(
      await this.post(
        'execute',
        { ...request, signetId: this.signetId, requestId: crypto.randomUUID() },
        undefined,
        options,
      ),
    );
  }
}
