import {
  calculateJwkThumbprint,
  decodeProtectedHeader,
  importJWK,
  type JWK,
  jwtVerify,
  SignJWT,
} from 'jose';
import { publicClientKeySchema } from './contracts';

export const digestCredential = async (value: string): Promise<string> =>
  Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))).toString(
    'base64url',
  );
export const proofTarget = (url: string): string => {
  const target = new URL(url);
  target.search = '';
  target.hash = '';
  return target.href;
};
export const verifySignetProof = async (input: {
  proof: string;
  url: string;
  method: string;
  now: Date;
  token?: string;
  keyThumbprint?: string;
}) => {
  if (input.proof.length > 8192) throw new Error('Invalid proof');
  const header = decodeProtectedHeader(input.proof);
  const publicKey = publicClientKeySchema.parse(header.jwk);
  const keyThumbprint = await calculateJwkThumbprint(publicKey);
  if (input.keyThumbprint && input.keyThumbprint !== keyThumbprint)
    throw new Error('Wrong proof key');
  const { payload } = await jwtVerify(input.proof, await importJWK(publicKey, 'ES256'), {
    algorithms: ['ES256'],
    typ: 'dpop+jwt',
    currentDate: input.now,
    requiredClaims: ['iat', 'jti', 'htu', 'htm', 'nonce'],
  });
  const now = Math.floor(input.now.getTime() / 1000);
  if (
    !Number.isInteger(payload.iat) ||
    payload.iat! < now - 60 ||
    payload.iat! > now + 5 ||
    typeof payload.jti !== 'string' ||
    payload.jti.length < 16 ||
    payload.jti.length > 128 ||
    typeof payload.nonce !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(payload.nonce) ||
    payload.htu !== proofTarget(input.url) ||
    payload.htm !== input.method.toUpperCase() ||
    (input.token && payload.ath !== (await digestCredential(input.token)))
  )
    throw new Error('Invalid proof binding');
  return { publicKey, keyThumbprint, proofId: payload.jti, nonce: payload.nonce };
};
export const createSignetProof = async (input: {
  privateKey: JWK;
  publicKey: JWK;
  nonce: string;
  url: string;
  method: string;
  token?: string;
  proofId?: string;
}) =>
  new SignJWT({
    htu: proofTarget(input.url),
    htm: input.method.toUpperCase(),
    nonce: input.nonce,
    ...(input.token ? { ath: await digestCredential(input.token) } : {}),
  })
    .setProtectedHeader({
      alg: 'ES256',
      typ: 'dpop+jwt',
      jwk: publicClientKeySchema.parse(input.publicKey),
    })
    .setIssuedAt()
    .setJti(input.proofId ?? crypto.randomUUID())
    .sign(await importJWK(input.privateKey, 'ES256'));

export const keyThumbprint = (key: unknown) =>
  calculateJwkThumbprint(publicClientKeySchema.parse(key));
