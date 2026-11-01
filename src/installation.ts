import { existsSync } from 'node:fs';
import { chmod, lstat, mkdir, readdir } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import {
  generateSignetKey,
  kingdomUrl,
  type SignetCredential,
  signetCredentialSchema,
} from './client';
import { readPrivateJson, writePrivateJson } from './files';

/**
 * Where an installation keeps what it holds for one Kingdom under `root`, without creating
 * anything: one directory per Kingdom host, its key, and one file per Signet.
 */
export function installationPaths(root: string, url: string) {
  const directory = join(resolve(root), new URL(kingdomUrl(url)).host);
  return { directory, keyFile: join(directory, 'installation-key.json') };
}

/** `installationPaths`, creating the installation key on first use. */
export async function installationDirectory(root: string, url: string) {
  const paths = installationPaths(root, url);
  if (!existsSync(paths.keyFile)) await writePrivateJson(paths.keyFile, generateSignetKey());
  return paths;
}

export const signetCredentialFile = (directory: string, signetId: string) =>
  join(directory, `signet-${signetId}.json`);

/** Creates `path` as a 0700 directory owned by this user, or makes an existing one so. */
export async function privateDirectory(path: string) {
  const directory = resolve(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw Error(`${directory} must be a directory owned by this user`);
  await chmod(directory, 0o700);
}

/** The name an installation registers under unless its person picks one: `<product> on <host>`. */
export const defaultInstallationName = (product: string) =>
  `${product} on ${hostname()}`.slice(0, 120);

export type HeldCredential = SignetCredential & { credentialFile: string };

const credentialFileName = /^signet-[0-9a-f-]{36}\.json$/;

/** Every Signet credential file in one Kingdom's installation directory that parses; others are skipped. */
export async function heldCredentials(directory: string): Promise<HeldCredential[]> {
  const names = await readdir(directory).catch(() => [] as string[]);
  const held = await Promise.all(
    names
      .filter((name) => credentialFileName.test(name))
      .map(async (name) => {
        const credentialFile = join(directory, name);
        const parsed = signetCredentialSchema.safeParse(
          await readPrivateJson(credentialFile).catch(() => null),
        );
        return parsed.success ? [{ ...parsed.data, credentialFile }] : [];
      }),
  );
  return held.flat();
}
