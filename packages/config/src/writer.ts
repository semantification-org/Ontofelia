import JSON5 from 'json5';
import * as fs from 'fs/promises';
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

export async function updateConfigField(
  configPath: string,
  key: string,
  value: unknown
): Promise<void> {
  // 1. Backup: copy configPath -> configPath + '.bak'
  try {
    await fs.copyFile(configPath, configPath + '.bak');
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw e;
    }
  }

  // 2. Read the original text (missing file: start from an empty config)
  let oldText: string | undefined;
  let parsed: Record<string, unknown> = {};
  try {
    oldText = await fs.readFile(configPath, 'utf-8');
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

  // 6. Write atomically: temp file, then rename.
  const tmpPath = configPath + '.tmp';
  await fs.writeFile(tmpPath, newText, 'utf-8');
  await fs.rename(tmpPath, configPath);
}
