/**
 * The per-instance key for the digests of masked tool arguments
 * (docs/cognitive-architecture/06 §11).
 *
 * A plain hash of a weak secret can be guessed by brute force, so the equality
 * handle of a masked argument is an HMAC-SHA256 under a key that only this
 * instance holds. The key is 32 random bytes, generated once, kept in a file of
 * the agent's state directory with mode 0600, created atomically. It is never
 * logged, printed, written to the triplestore, passed in argv or put in an error
 * message.
 */

import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

/** Name of the key file inside the state directory. */
export const ARG_DIGEST_KEY_FILE = 'arg-digest.key';
const KEY_BYTES = 32;
const KEY_HEX = /^[0-9a-f]{64}$/;

/** Where the cycle gets the key from; `undefined` means no digest is stored. */
export interface ArgDigestKeySource {
  get(): Promise<Buffer | undefined>;
}

/** A key held in memory (tests inject one; it never touches the disk). */
export function fixedKeySource(key: Buffer): ArgDigestKeySource {
  const copy = Buffer.from(key);
  return { get: async () => copy };
}

/**
 * The key file of `stateDir`: read when it exists and is valid, otherwise
 * created. Loaded once and cached; a failure is reported through `onError`
 * (without any key material) and gives `undefined`, so no digest is stored
 * rather than a weak one.
 */
export function fileKeySource(stateDir: string, onError?: (err: unknown) => void): ArgDigestKeySource {
  let loaded: Promise<Buffer | undefined> | undefined;
  return {
    get: () => {
      loaded ??= loadOrCreateKey(stateDir).catch((e: unknown) => {
        // Only the error class and code: a path or a message never carries the key.
        const code = (e as NodeJS.ErrnoException)?.code;
        onError?.(new Error(`argument digest key unavailable${code ? ` (${code})` : ''}`));
        return undefined;
      });
      return loaded;
    },
  };
}

async function readKey(file: string): Promise<Buffer | undefined> {
  let text: string;
  try {
    text = (await fs.readFile(file, 'utf8')).trim();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
  if (!KEY_HEX.test(text)) throw new Error('argument digest key file is not a valid key');
  // A key file other users could read is tightened, never trusted as it is.
  await fs.chmod(file, 0o600);
  return Buffer.from(text, 'hex');
}

/**
 * Read the key, or create it: the bytes go to a private temporary file (mode
 * 0600, exclusive) and are linked to the final name, which fails when the name
 * exists. A concurrent creator therefore never leaves a half-written key, and
 * the loser reads the winner's.
 */
export async function loadOrCreateKey(stateDir: string): Promise<Buffer> {
  const file = path.join(stateDir, ARG_DIGEST_KEY_FILE);
  const existing = await readKey(file);
  if (existing) return existing;

  await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
  const key = randomBytes(KEY_BYTES);
  const tmp = path.join(stateDir, `.${ARG_DIGEST_KEY_FILE}.${process.pid}.${randomBytes(6).toString('hex')}`);
  const handle = await fs.open(tmp, 'wx', 0o600);
  try {
    await handle.writeFile(`${key.toString('hex')}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.link(tmp, file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  } finally {
    await fs.unlink(tmp).catch(() => undefined);
  }
  const stored = await readKey(file);
  if (!stored) throw new Error('argument digest key was not created');
  return stored;
}
