import { existsSync } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  cancelInstallationInquiry,
  collectSignet,
  enrollInstallationSignet,
  enrollSignet,
  installationInquiries,
  installationSignets,
  kingdomUrl,
  registerInstallation,
  requestRegistration,
  SignetHttpError,
  type SignetRequestOptions,
  saveCollectedSignet,
  signetCredentialSchema,
} from './client';
import type {
  InstallationKind,
  InstallationSnapshot,
  OwnerRef,
  RegistrationRequest,
} from './contracts';
import { readPrivateJson } from './files';
import { installationDirectory, installationPaths, signetCredentialFile } from './installation';
import { InstallationSocket } from './installationSocket';

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

/**
 * One holder at a time per installation directory, so two processes never enroll or write
 * credentials over each other. Every hold in this package takes it; take it to write a Signet
 * credential into the directory by other means.
 */
export async function withHoldLock<T>(directory: string, fn: () => Promise<T>): Promise<T> {
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
  signets: Pick<
    InstallationSnapshot['signets'][number],
    'signetId' | 'integrationId' | 'owner' | 'enrollmentId'
  >[],
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

export type PersonSignet = {
  signetId: string;
  /** The Signet's current revision, as the person read it (`/me/overview`); Kingdom refuses a stale one. */
  expectedRevision: number;
  integrationId: string;
  owner?: OwnerRef;
};

export type HeldPersonSignet = {
  signetId: string;
  integrationId: string;
  owner?: OwnerRef;
  credentialFile: string;
  /** False when a credential file was already held and kept. */
  enrolled: boolean;
};

/**
 * Enrolls this installation's key on Signets issued to the person a Kingdom API token belongs to,
 * under the same lock as `holdInstallationSignets`, so a person login and an installation sync
 * never enroll over each other. A Signet whose credential file already parses is kept unless
 * `replace` is set. The token authorizes the enrollment and is never written.
 */
export async function holdPersonSignets(
  url: string,
  keyFile: string,
  directory: string,
  apiToken: string,
  signets: readonly PersonSignet[],
  options: SignetRequestOptions & { name: string; replace?: boolean },
): Promise<HeldPersonSignet[]> {
  const { name, replace, ...request } = options;
  return withHoldLock(directory, async () => {
    const held: HeldPersonSignet[] = [];
    for (const signet of signets) {
      const credentialFile = signetCredentialFile(directory, signet.signetId);
      const kept = !replace && (await heldEnrollment(credentialFile));
      if (!kept) {
        const enrolled = await enrollSignet(
          url,
          keyFile,
          apiToken,
          { signetId: signet.signetId, expectedRevision: signet.expectedRevision, name },
          request,
        );
        await saveCollectedSignet(credentialFile, url, keyFile, {
          ...enrolled,
          integrationId: signet.integrationId,
          ...(signet.owner ? { owner: signet.owner } : {}),
        });
      }
      held.push({
        signetId: signet.signetId,
        integrationId: signet.integrationId,
        ...(signet.owner ? { owner: signet.owner } : {}),
        credentialFile,
        enrolled: !kept,
      });
    }
    return held;
  });
}

/** Which Signets each Kingdom lists for this installation: one read per Kingdom; null when it refused or is unreachable. */
export async function listedSignets(root: string, urls: readonly string[]) {
  const listed = new Map<string, Set<string> | null>();
  await Promise.all(
    [...new Set(urls)].map(async (url) => {
      const { keyFile } = installationPaths(root, url);
      try {
        if (!existsSync(keyFile)) throw Error('No installation key');
        const { signets } = await installationSignets(url, keyFile, { timeoutMs: 5000 });
        listed.set(url, new Set(signets.map((signet) => signet.signetId)));
      } catch {
        listed.set(url, null);
      }
    }),
  );
  return listed;
}

/** The local file of a Signet this installation holds, enrolling it now if Kingdom lists it but no file exists yet. */
export async function heldSignetFile(root: string, url: string, signetId: string) {
  const { keyFile, directory } = await installationDirectory(root, url);
  const file = signetCredentialFile(directory, signetId);
  if (existsSync(file)) return file;
  const listed = (await installationSignets(url, keyFile)).signets.filter(
    (signet) => signet.signetId === signetId,
  );
  if (!listed.length) throw Error(`Kingdom does not list Signet ${signetId} for this installation`);
  await holdInstallationSignets(url, keyFile, directory, listed);
  if (!existsSync(file)) throw Error(`Signet ${signetId} could not be enrolled here`);
  return file;
}

/**
 * Withdraws every open registration of this installation, so a later approval in Kingdom mints no
 * integration nothing collects. One pairing runs at a time per installation, so every open
 * registration belongs to a pairing that no longer waits. Kingdom's refusals are thrown.
 */
export async function withdrawRegistration(root: string, url: string) {
  const origin = kingdomUrl(url);
  const { keyFile } = installationPaths(root, origin);
  if (!existsSync(keyFile)) return [];
  const { inquiries } = await installationInquiries(origin, keyFile);
  const open = inquiries.filter(
    (inquiry) => inquiry.type === 'registerIntegration' && openStatuses.has(inquiry.status),
  );
  for (const inquiry of open) await cancelInstallationInquiry(origin, keyFile, inquiry.id);
  return open.map((inquiry) => inquiry.id);
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
  /**
   * Failures while waiting (a poll Kingdom refused, a dropped socket); waiting continues, except
   * at the deadline, where repeated failures end it.
   */
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
    review: pending.reviewUrl,
    expiresAt: pending.expiresAt,
  });
  const retryBaseMs = input.socketOptions?.retryBaseMs ?? 1_000;
  const inquiry = await new Promise<InstallationSnapshot['inquiries'][number]>(
    (resolve, reject) => {
      let deadline: ReturnType<typeof setTimeout> | undefined;
      let retry: ReturnType<typeof setTimeout> | undefined;
      let done = false;
      let claimed = false;
      // Refusals that count toward revocation, each at least a backoff step after the last.
      const refusals: number[] = [];
      // The review code's expiry until a claim creates the inquiry; then the inquiry's own.
      let waitUntil: string | null = pending.expiresAt;
      const onAbort = () => {
        stop();
        reject(input.signal?.reason);
      };
      const stop = () => {
        done = true;
        clearTimeout(deadline);
        clearTimeout(retry);
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
        const delay = Math.max(0, Date.parse(until) + expiryGraceMs - Date.now());
        deadline =
          delay > maxTimerMs
            ? setTimeout(() => arm(until), maxTimerMs)
            : setTimeout(() => void check(until), delay);
      };
      const follow = (snapshot: Snapshot) => {
        refusals.length = 0;
        const unread = snapshot.dropped.filter((drop) => drop.list === 'inquiries');
        if (unread.length)
          input.onError?.(Error(`Could not read ${unread.length} inquiries from Kingdom`));
        const settled = settledInquiry(snapshot, earlier, baseline.declinedAt, claimed);
        if (settled) return finish(settled);
        const inquiry = newInquiry(snapshot, earlier);
        if (!inquiry) return;
        claimed = true;
        if (inquiry.expiresAt !== waitUntil) arm(inquiry.expiresAt);
      };
      // Kingdom refuses a revoked installation's key (the revoke frame only reaches a live socket),
      // but a 401 can also be a passing failure; only a refusal that persists ends the wait.
      const refused = (error: unknown) => {
        const refusal =
          error instanceof SignetHttpError && (error.status === 401 || error.status === 403);
        const last = refusals.at(-1);
        if (
          refusal &&
          (last === undefined || Date.now() - last >= retryBaseMs * 2 ** refusals.length)
        )
          refusals.push(Date.now());
        if (refusal && refusals.length >= refusalsToRevoke) return finish(revoked());
        input.onError?.(error);
      };
      const check = async (until: string) => {
        let last: Snapshot | null = null;
        for (let attempt = 0; !last && attempt < 3; attempt++) {
          if (attempt)
            await new Promise((wake) => {
              retry = setTimeout(wake, retryBaseMs * 2 ** attempt);
            });
          if (done) return;
          last = await installationInquiries(url, keyFile).catch((error) => {
            refused(error);
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
        onError: refused,
        onSnapshot: follow,
        onRevoked: () => finish(revoked()),
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
/** Slack past an expiry (clock skew, a claim in its last second) before giving up. */
const expiryGraceMs = 5_000;
/** Consecutive refusals of this installation's key, a backoff step apart, that mean revoked. */
const refusalsToRevoke = 3;
/** Kingdom can still approve these. */
const openStatuses = new Set(['sent', 'changesRequested']);

type Snapshot = Pick<InstallationSnapshot, 'pending' | 'declinedAt' | 'inquiries' | 'dropped'>;

const expired = () => Error('The review code expired before it was claimed; pair again');
const revoked = () => Error('Kingdom revoked this installation');
const withdrawn = () => Error('The registration was withdrawn in Kingdom');
const unapproved = () => Error('The registration expired in Kingdom before it was approved');
const unconfirmed = () =>
  Error('Could not reach Kingdom to confirm the registration; check Kingdom before pairing again');

const newInquiry = (snapshot: Snapshot, earlier: Set<string>) =>
  snapshot.inquiries.find((item) => item.type === 'registerIntegration' && !earlier.has(item.id));

const settledInquiry = (
  snapshot: Snapshot,
  earlier: Set<string>,
  earlierDeclinedAt: string | null,
  claimed: boolean,
) => {
  if (snapshot.declinedAt && snapshot.declinedAt !== earlierDeclinedAt)
    return Error('The registration was declined in Kingdom');
  const inquiry = newInquiry(snapshot, earlier);
  if (inquiry?.status === 'approved') return inquiry;
  if (inquiry && !openStatuses.has(inquiry.status))
    return Error(`The registration was ${inquiry.status} in Kingdom`);
  // An inquiry this package couldn't read is not a withdrawn or expired one: keep waiting.
  if (!inquiry && snapshot.dropped.some((drop) => drop.list === 'inquiries')) return null;
  // A canceled inquiry is soft-deleted, so it drops out of the snapshot.
  if (!inquiry && claimed) return withdrawn();
  if (!inquiry && !snapshot.pending) return expired();
  return null;
};
