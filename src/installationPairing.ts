import { existsSync } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  collectSignet,
  enrollInstallationSignet,
  generateSignetKey,
  installationInquiries,
  kingdomUrl,
  registerInstallation,
  requestRegistration,
  saveCollectedSignet,
  signetCredentialSchema,
} from './client';
import type { InstallationKind, OwnerRef, RegistrationRequest } from './contracts';
import { readPrivateJson, writePrivateJson } from './files';
import { type InstallationSnapshot, InstallationSocket } from './installationSocket';

/** Where an installation keeps what it holds for one Kingdom: its key and one file per Signet. */
export async function installationDirectory(root: string, url: string) {
  const directory = join(root, new URL(kingdomUrl(url)).host);
  const keyFile = join(directory, 'installation-key.json');
  if (!existsSync(keyFile)) await writePrivateJson(keyFile, generateSignetKey());
  return { directory, keyFile };
}

export const signetCredentialFile = (directory: string, signetId: string) =>
  join(directory, `signet-${signetId}.json`);

export type HeldSignet = {
  signetId: string;
  integrationId: string;
  owner: OwnerRef;
  credentialFile: string;
};

const heldEnrollment = async (credentialFile: string) => {
  if (!existsSync(credentialFile)) return null;
  const parsed = signetCredentialSchema.safeParse(
    await readPrivateJson(credentialFile).catch(() => null),
  );
  return parsed.success ? parsed.data.enrollmentId : null;
};

const lockStaleMs = 60_000;

/** One holder at a time per directory, so two processes never enroll over each other. */
async function withHoldLock<T>(directory: string, fn: () => Promise<T>): Promise<T> {
  const lock = join(directory, '.hold-lock');
  for (const started = Date.now(); ; ) {
    try {
      await mkdir(lock);
      break;
    } catch {
      const age = await stat(lock).then(
        (info) => Date.now() - info.mtimeMs,
        () => 0,
      );
      if (age > lockStaleMs) await rm(lock, { recursive: true, force: true });
      else if (Date.now() - started > lockStaleMs) throw Error('Signet holder lock busy');
      else await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  try {
    return await fn();
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

/**
 * Keeps a credential file for every Signet a snapshot lists: enrolls this installation's key when
 * Kingdom reports no current enrollment for it, or when the file holds an enrollment Kingdom no
 * longer reports as current (a key rotation, a revoked or expired enrollment). Files are never
 * deleted here: a Signet missing from a snapshot (a paused integration) keeps its file.
 */
export async function holdInstallationSignets(
  url: string,
  keyFile: string,
  directory: string,
  signets: InstallationSnapshot['signets'],
): Promise<HeldSignet[]> {
  return withHoldLock(directory, async () => {
    const held: HeldSignet[] = [];
    for (const signet of signets) {
      const credentialFile = signetCredentialFile(directory, signet.signetId);
      const enrollmentId = await heldEnrollment(credentialFile);
      if (!enrollmentId || !signet.enrollmentId || enrollmentId !== signet.enrollmentId)
        await saveCollectedSignet(
          credentialFile,
          url,
          keyFile,
          await enrollInstallationSignet(url, keyFile, signet.signetId),
        );
      held.push({
        signetId: signet.signetId,
        integrationId: signet.integrationId,
        owner: signet.owner,
        credentialFile,
      });
    }
    return held;
  });
}

export type InstallationPairing = {
  url: string;
  root: string;
  kind: InstallationKind;
  name: string;
  sourceId?: string;
  terms: RegistrationRequest;
  onReview: (review: { reviewCode: string; review: string; expiresAt: string }) => void;
  confirmOwner?: (owner: { ownerName: string | null; owner: OwnerRef | null }) => Promise<boolean>;
  /** Failures while waiting (a poll Kingdom refused, a dropped socket); waiting continues. */
  onError?: (error: unknown) => void;
  signal?: AbortSignal;
  /** Slack past an expiry (clock skew, a claim in its last second) before giving up. */
  expiryGraceMs?: number;
  socketOptions?: { pollMs?: number; retryBaseMs?: number; authTimeoutMs?: number };
};

/**
 * Registers this installation with Kingdom and asks to become an owner's integration. A person
 * claims the review code in Kingdom; the installation hears the outcome over its socket (polling
 * while the socket is down), confirms the owner, and collects its Signet.
 */
export async function pairInstallation(input: InstallationPairing) {
  const url = kingdomUrl(input.url);
  const { directory, keyFile } = await installationDirectory(input.root, url);
  await registerInstallation(url, keyFile, {
    kind: input.kind,
    name: input.name,
    ...(input.sourceId ? { sourceId: input.sourceId } : {}),
  });
  input.signal?.throwIfAborted();
  const baseline = await installationInquiries(url, keyFile);
  const earlier = new Set(baseline.inquiries.map((inquiry) => inquiry.id));
  const pending = await requestRegistration(url, keyFile, input.terms);
  input.onReview({
    reviewCode: pending.reviewCode,
    review: pending.reviewUrl,
    expiresAt: pending.expiresAt,
  });
  const graceMs = input.expiryGraceMs ?? 5_000;
  const retryBaseMs = input.socketOptions?.retryBaseMs ?? 1_000;
  const inquiry = await new Promise<InstallationSnapshot['inquiries'][number]>(
    (resolve, reject) => {
      let deadline: ReturnType<typeof setTimeout> | undefined;
      let done = false;
      // The review code's expiry until a claim creates the inquiry; then the inquiry's own.
      let waitUntil: string | null = pending.expiresAt;
      const onAbort = () => {
        stop();
        reject(input.signal?.reason);
      };
      const stop = () => {
        done = true;
        clearTimeout(deadline);
        input.signal?.removeEventListener('abort', onAbort);
        socket.close();
      };
      const finish = (settled: ReturnType<typeof settledInquiry>) => {
        if (!settled || done) return;
        stop();
        if (settled instanceof Error) reject(settled);
        else resolve(settled);
      };
      const arm = (until: string | null) => {
        clearTimeout(deadline);
        waitUntil = until;
        if (!until || done) return;
        const delay = Math.max(0, Date.parse(until) + graceMs - Date.now());
        deadline =
          delay > maxTimerMs
            ? setTimeout(() => arm(until), maxTimerMs)
            : setTimeout(() => void check(until), delay);
      };
      const follow = (snapshot: Snapshot) => {
        const settled = settledInquiry(snapshot, earlier, baseline.declinedAt);
        if (settled) return finish(settled);
        const claimed = newInquiry(snapshot, earlier);
        if (claimed && claimed.expiresAt !== waitUntil) arm(claimed.expiresAt);
      };
      const check = async (until: string) => {
        let last: Snapshot | null = null;
        for (let attempt = 0; !last && attempt < 3; attempt++) {
          if (attempt) await new Promise((wake) => setTimeout(wake, retryBaseMs * 2 ** attempt));
          if (done) return;
          last = await installationInquiries(url, keyFile).catch((error) => {
            input.onError?.(error);
            return null;
          });
        }
        if (done || waitUntil !== until) return;
        if (!last) return finish(unconfirmed());
        follow(last);
        if (done || waitUntil !== until) return;
        finish(newInquiry(last, earlier) ? unapproved() : expired());
      };
      const socket = new InstallationSocket({
        url,
        keyFile,
        ...input.socketOptions,
        onError: input.onError,
        onSnapshot: follow,
        onRevoked: () => finish(Error('Kingdom revoked this installation')),
      });
      if (input.signal?.aborted) {
        stop();
        return reject(input.signal.reason);
      }
      input.signal?.addEventListener('abort', onAbort, { once: true });
      arm(waitUntil);
      socket.start();
    },
  );
  if (input.confirmOwner && !(await input.confirmOwner(inquiry)))
    throw Error('Not collected: the owner was not confirmed');
  const collected = await collectSignet(url, keyFile, inquiry.id);
  if (!collected) throw Error('Kingdom has not released the Signet yet; try again');
  const credentialFile = signetCredentialFile(directory, collected.signetId);
  await saveCollectedSignet(credentialFile, url, keyFile, collected);
  return {
    url,
    keyFile,
    directory,
    credentialFile,
    signetId: collected.signetId,
    integrationId: collected.integrationId,
    owner: collected.owner,
    ownerName: inquiry.ownerName,
  };
}

/** setTimeout fires at once past this delay (~24.8 days). */
const maxTimerMs = 2 ** 31 - 1;

type Snapshot = Pick<InstallationSnapshot, 'pending' | 'declinedAt' | 'inquiries'>;

const expired = () => Error('The review code expired before it was claimed; pair again');
const unapproved = () => Error('The registration expired in Kingdom before it was approved');
const unconfirmed = () =>
  Error('Could not reach Kingdom to confirm the registration; check Kingdom before pairing again');

const newInquiry = (snapshot: Snapshot, earlier: Set<string>) =>
  snapshot.inquiries.find((item) => item.type === 'registerIntegration' && !earlier.has(item.id));

const settledInquiry = (
  snapshot: Snapshot,
  earlier: Set<string>,
  earlierDeclinedAt: string | null,
) => {
  if (snapshot.declinedAt && snapshot.declinedAt !== earlierDeclinedAt)
    return Error('The registration was declined in Kingdom');
  const inquiry = newInquiry(snapshot, earlier);
  if (inquiry?.status === 'approved') return inquiry;
  if (inquiry && inquiry.status !== 'sent')
    return Error(`The registration was ${inquiry.status} in Kingdom`);
  if (!inquiry && !snapshot.pending) return expired();
  return null;
};
