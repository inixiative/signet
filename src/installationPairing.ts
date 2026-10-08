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
import type { InstallationKind, OwnerRef, RegistrationTerms } from './contracts';
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
  terms: RegistrationTerms;
  onReview: (review: { reviewCode: string; review: string; expiresAt: string }) => void;
  confirmOwner?: (owner: { ownerName: string | null; owner: OwnerRef | null }) => Promise<boolean>;
  /** Failures while waiting (a poll Kingdom refused, a dropped socket); waiting continues. */
  onError?: (error: unknown) => void;
  signal?: AbortSignal;
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
    review: `${url}/dashboard?reviewSignet=${pending.reviewCode}`,
    expiresAt: pending.expiresAt,
  });
  const inquiry = await new Promise<InstallationSnapshot['inquiries'][number]>(
    (resolve, reject) => {
      const socket = new InstallationSocket({
        url,
        keyFile,
        ...input.socketOptions,
        onError: input.onError,
        onSnapshot: (snapshot) => {
          const settled = settledInquiry(snapshot, earlier, baseline.declinedAt);
          if (!settled) return;
          socket.close();
          if (settled instanceof Error) reject(settled);
          else resolve(settled);
        },
        onRevoked: () => reject(Error('Kingdom revoked this installation')),
      });
      if (input.signal?.aborted) return reject(input.signal.reason);
      input.signal?.addEventListener('abort', () => {
        socket.close();
        reject(input.signal!.reason);
      });
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

const settledInquiry = (
  snapshot: InstallationSnapshot,
  earlier: Set<string>,
  earlierDeclinedAt: string | null,
) => {
  if (snapshot.declinedAt && snapshot.declinedAt !== earlierDeclinedAt)
    return Error('The registration was declined in Kingdom');
  const inquiry = snapshot.inquiries.find(
    (item) => item.type === 'registerIntegration' && !earlier.has(item.id),
  );
  if (inquiry?.status === 'approved') return inquiry;
  if (inquiry && inquiry.status !== 'sent')
    return Error(`The registration was ${inquiry.status} in Kingdom`);
  if (!inquiry && !snapshot.pending)
    return Error('The review code expired before it was claimed; pair again');
  return null;
};
