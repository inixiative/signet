import { z } from 'zod';
import { SignetClient, SignetHttpError } from './client';
import {
  type ParsedSignetDescription,
  parseSignetDescription,
  type SignetHolder,
  signetHolderSchema,
} from './contracts';

/**
 * A held Signet as Kingdom's extended `access/describe` reports it, with its `holder` (null for a
 * person-held Signet). Read per entry (`parseSignetDescription`), so a resource this package can't
 * read costs that resource, never the holder.
 */
export const parseHeldSignetDescription = (value: unknown) => ({
  ...parseSignetDescription(value),
  holder: z.object({ holder: signetHolderSchema.nullable() }).parse(value).holder,
});

export interface HolderView {
  /** `described`: Kingdom answered; `revoked`: Kingdom refused the Signet (403); `unavailable`: no answer. */
  status: 'described' | 'revoked' | 'unavailable';
  holder: SignetHolder | null;
  description: ParsedSignetDescription | null;
  checkedAt: number;
}

/** One held Signet: the Kingdom it is from, its id, and the credential file that presents it. */
export type HeldSignetRef = { url: string; signetId: string; credentialFile: string };

export type DescribeHeldSignet<Ref extends HeldSignetRef = HeldSignetRef> = (
  signet: Ref,
) => Promise<unknown>;

const describeWithSignet: DescribeHeldSignet = async ({ url, credentialFile, signetId }) =>
  new SignetClient(url, credentialFile, signetId).post('describe', { signetId }, undefined, {
    timeoutMs: 5_000,
  });

/**
 * Descriptions per held Signet, cached: read at most once per `ttlMs`, again after the
 * installation socket reports a change (`stale()`), and shared by concurrent readers. Entries are
 * keyed by `keyOf` (default: the credential file), the same key `forget` takes.
 */
export class SignetHolders<Ref extends HeldSignetRef = HeldSignetRef> {
  private cache = new Map<string, { view: HolderView; stale: boolean }>();
  private inflight = new Map<string, Promise<HolderView>>();
  private readonly ttlMs: number;
  private readonly describe: DescribeHeldSignet<Ref>;
  private readonly keyOf: (signet: Ref) => string;
  constructor(
    options: {
      ttlMs?: number;
      describe?: DescribeHeldSignet<Ref>;
      keyOf?: (signet: Ref) => string;
    } = {},
  ) {
    this.ttlMs = options.ttlMs ?? 10 * 60_000;
    this.describe = options.describe ?? describeWithSignet;
    this.keyOf = options.keyOf ?? ((signet) => signet.credentialFile);
  }

  /** The installation snapshot changed: what Kingdom holds may have too. */
  stale() {
    for (const entry of this.cache.values()) entry.stale = true;
  }

  forget(key: string) {
    this.cache.delete(key);
  }

  /** The cached view when fresh; otherwise a new read, waiting at most `waitMs` before answering with the last one. */
  async get(signet: Ref, waitMs = 3_000): Promise<HolderView> {
    const key = this.keyOf(signet);
    const cached = this.cache.get(key);
    if (cached && !cached.stale && Date.now() - cached.view.checkedAt < this.ttlMs)
      return cached.view;
    let read = this.inflight.get(key);
    if (!read) {
      read = this.read(signet).then((view) => {
        this.cache.set(key, { view, stale: false });
        return view;
      });
      read.finally(() => this.inflight.delete(key)).catch(() => {});
      this.inflight.set(key, read);
    }
    const fallback: HolderView = cached?.view ?? {
      status: 'unavailable',
      holder: null,
      description: null,
      checkedAt: Date.now(),
    };
    return Promise.race([
      read,
      new Promise<HolderView>((resolve) => setTimeout(() => resolve(fallback), waitMs).unref?.()),
    ]);
  }

  private async read(signet: Ref): Promise<HolderView> {
    const checkedAt = Date.now();
    try {
      const description = parseHeldSignetDescription(await this.describe(signet));
      return { status: 'described', holder: description.holder, description, checkedAt };
    } catch (error) {
      const status =
        error instanceof SignetHttpError && error.status === 403 ? 'revoked' : 'unavailable';
      return { status, holder: null, description: null, checkedAt };
    }
  }
}
