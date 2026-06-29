import JSON5 from 'json5';
import * as fs from 'fs/promises';
import { configSchema } from './schema.js';

export async function updateConfigField(
  configPath: string,
  key: string,
  value: unknown
): Promise<void> {
  // 1. Backup: Kopiere configPath → configPath + '.bak'
  try {
    await fs.copyFile(configPath, configPath + '.bak');
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw e;
    }
  }

  // 2. Lies JSON5, parse
  let parsed: Record<string, unknown> = {};
  try {
    const content = await fs.readFile(configPath, 'utf-8');
    parsed = JSON5.parse(content) as Record<string, unknown>;
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw e;
    }
  }

  // 3. Deep-clone before mutating so original is untouched if validation fails
  const clone = JSON.parse(JSON.stringify(parsed)) as Record<string, unknown>;

  // 4. Setze Feld per dot-notation auf dem Klon
  const parts = key.split('.');
  let current: Record<string, unknown> = clone;
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof current[parts[i]] !== 'object' || current[parts[i]] === null) {
      current[parts[i]] = {};
    }
    current = current[parts[i]] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]] = value;

  // 5. Validiere gesamtes Objekt mit configSchema.parse()
  // Throws if the resulting config is invalid — clone keeps original safe.
  configSchema.parse(clone);

  // 6. Write back as JSON5 (only after successful validation).
  await fs.writeFile(configPath, JSON5.stringify(clone, null, 2), 'utf-8');
}
