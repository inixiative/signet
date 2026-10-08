import { existsSync } from 'node:fs';
import { readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import {
  collectSignet,
  enrollInstallationSignet,
  generateSignetKey,
  kingdomUrl,
  registerInstallation,
  requestRegistration,
  saveCollectedSignet,
} from './client';
import type { InstallationKind, OwnerRef, RegistrationTerms } from './contracts';
import { writePrivateJson } from './files';
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

/**
 * Makes the local Signet files match a snapshot: enrolls this installation's key on every Signet
 * its integrations hold that it has no file for (later grants included), and deletes the files of
 * Signets Kingdom no longer lists.
 */
export async function holdInstallationSignets(
  url: string,
  keyFile: string,
  directory: string,
  signets: InstallationSnapshot['signets'],
): Promise<HeldSignet[]> {
  const listed = new Set(signets.map((signet) => signet.signetId));
  for (const file of await readdir(directory)) {
    const match = /^signet-([0-9a-f-]{36})\.json$/.exec(file);
    if (match && !listed.has(match[1]!)) await unlink(join(directory, file)).catch(() => {});
  }
  const held: HeldSignet[] = [];
  for (const signet of signets) {
    const credentialFile = signetCredentialFile(directory, signet.signetId);
    if (!existsSync(credentialFile))
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
  const askedAt = Date.now();
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
        onSnapshot: (snapshot) => {
          const settled = settledInquiry(snapshot, askedAt);
          if (!settled) return;
          socket.close();
          if (settled instanceof Error) reject(settled);
          else resolve(settled);
        },
        onRevoked: () => reject(Error('Kingdom revoked this installation')),
      });
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

const settledInquiry = (snapshot: InstallationSnapshot, askedAt: number) => {
  if (snapshot.declinedAt && Date.parse(snapshot.declinedAt) >= askedAt)
    return Error('The registration was declined in Kingdom');
  const inquiry = snapshot.inquiries.find(
    (item) => item.type === 'registerIntegration' && Date.parse(item.createdAt) >= askedAt,
  );
  if (inquiry?.status === 'approved') return inquiry;
  if (inquiry && inquiry.status !== 'sent')
    return Error(`The registration was ${inquiry.status} in Kingdom`);
  if (!inquiry && !snapshot.pending)
    return Error('The review code expired before it was claimed; pair again');
  return null;
};
