import JSON5 from 'json5';
import * as fs from 'fs/promises';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { configSchema } from './schema.js';
import { setJson5Value } from './json5Edit.js';

function setField(obj: Record<string, unknown>, parts: string[], value: unknown): Record<string, unknown> {
  // Deep-clone before mutating so the original stays untouched.
  const clone = JSON.parse(JSON.stringify(obj)) as Record<string, unknown>;
  let current: Record<string, unknown> = clone;
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof current[parts[i]] !== 'object' || current[parts[i]] === null) {
      current[parts[i]] = {};
    }
    current = current[parts[i]] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]] = value;
  return clone;
}

const MAX_SYMLINK_HOPS = 40;

// Follow symbolic links (also chains and relative links into other directories) so the write
// lands on the final target and the link itself stays a link. A dangling link resolves to the
// path it points at, which is then created. A path that does not exist is returned as is.
async function resolveWriteTarget(configPath: string): Promise<string> {
  let current = configPath;
  for (let hops = 0; hops <= MAX_SYMLINK_HOPS; hops++) {
    let st;
    try {
      st = await fs.lstat(current);
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        return current;
      }
      throw e;
    }
    if (!st.isSymbolicLink()) {
      return current;
    }
    const linkTarget = await fs.readlink(current);
    current = path.resolve(path.dirname(current), linkTarget);
  }
  throw new Error('Config not written: too many symbolic links');
}

export async function updateConfigField(
  configPath: string,
  key: string,
  value: unknown
): Promise<void> {
  // 0. Resolve the write target and read its permission bits. The config holds tokens and API
  // keys, so a write must neither widen its mode nor replace a symbolic link by a regular file.
  const targetPath = await resolveWriteTarget(configPath);
  let mode: number | undefined;
  try {
    mode = (await fs.stat(targetPath)).mode & 0o7777;
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw e;
    }
  }

  // 1. Backup: copy the resolved config -> configPath + '.bak', with the mode of the original
  const backupPath = configPath + '.bak';
  try {
    await fs.copyFile(targetPath, backupPath);
    if (mode !== undefined) {
      await fs.chmod(backupPath, mode);
    }
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw e;
    }
  }

  // 2. Read the original text (missing file: start from an empty config)
  let oldText: string | undefined;
  let parsed: Record<string, unknown> = {};
  try {
    oldText = await fs.readFile(targetPath, 'utf-8');
    parsed = JSON5.parse(oldText) as Record<string, unknown>;
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw e;
    }
    oldText = undefined;
  }

  // 3. Expected result, set on a clone of the parsed object
  const parts = key.split('.');
  const clone = setField(parsed, parts, value);

  // 4. Validate the whole object; throws if the resulting config is invalid.
  configSchema.parse(clone);

  // 5. Produce the new text
  let newText: string;
  if (oldText === undefined) {
    newText = JSON5.stringify(clone, null, 2);
  } else {
    try {
      newText = setJson5Value(oldText, parts, value);
    } catch (e: unknown) {
      throw new Error(`Config not written: ${(e as Error).message}`);
    }
    // Counter-check: the edited text must parse to exactly the expected object.
    let reparsed: unknown;
    try {
      reparsed = JSON5.parse(newText);
    } catch (e: unknown) {
      throw new Error(`Config not written: edited text does not parse: ${(e as Error).message}`);
    }
    if (!isDeepStrictEqual(reparsed, JSON.parse(JSON.stringify(clone)))) {
      throw new Error('Config not written: edited text does not match the expected config');
    }
  }

  // 6. Write atomically: temp file next to the target (same filesystem), then rename.
  // Exclusive create. An existing config gets a private 0o600 temp file and an explicit chmod to
  // its old mode. A new config is created with 0o666, so the umask yields the same mode a plain
  // write would; it is not chmodded, and no process-wide umask is read (that call is deprecated).
  const tmpPath = `${targetPath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  const handle = await fs.open(tmpPath, 'wx', mode === undefined ? 0o666 : 0o600);
  try {
    try {
      await handle.writeFile(newText, 'utf-8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (mode !== undefined) {
      // Explicit chmod, so the result does not depend on the umask.
      await fs.chmod(tmpPath, mode);
    }
    await fs.rename(tmpPath, targetPath);
  } catch (e: unknown) {
    // On any failure before the rename the config is untouched; remove our own temp file.
    try {
      await fs.unlink(tmpPath);
    } catch (unlinkError: unknown) {
      if ((unlinkError as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw e;
      }
    }
    throw e;
  }
}
