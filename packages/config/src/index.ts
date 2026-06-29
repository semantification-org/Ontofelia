import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import JSON5 from 'json5';
import { defu } from 'defu';
import { Result, ok, err, OntofeliaError, createLogger } from '@ontofelia/core';
import { configSchema, OntofeliaConfig, ValidationError } from './schema.js';

export * from './schema.js';
export * from './writer.js';

const logger = createLogger('config');

export class MigrationError extends OntofeliaError {
  public version: number;
  constructor(message: string, version: number) {
    super(message, 'INTERNAL_ERROR');
    this.name = 'MigrationError';
    this.version = version;
  }
}

const DEFAULT_CONFIG_PATH = path.join(os.homedir(), '.ontofelia', 'ontofelia.json5');

export function getDefaultConfig(): OntofeliaConfig {
  return configSchema.parse({});
}

export function validateConfig(config: unknown): Result<OntofeliaConfig, ValidationError[]> {
  const result = configSchema.safeParse(config);
  if (result.success) {
    return ok(result.data);
  } else {
    // Log warnings for unknown keys if possible, but zod strips or passthroughs depending on config.
    // For now we just return the validation errors.
    return err(result.error.issues);
  }
}

export function migrateConfig(config: unknown, fromVersion: number): Result<OntofeliaConfig, MigrationError> {
  // Currently we only have version 1.
  if (fromVersion !== 1) {
    return err(new MigrationError(`Cannot migrate from unknown version ${fromVersion}`, fromVersion));
  }
  
  const validation = validateConfig(config);
  if (validation.isOk()) {
    return validation as unknown as Result<OntofeliaConfig, MigrationError>;
  }
  
  return err(new MigrationError('Configuration is invalid and cannot be migrated', fromVersion));
}

function applyEnvFallbacks(config: OntofeliaConfig): OntofeliaConfig {
  const cloned = JSON.parse(JSON.stringify(config)) as OntofeliaConfig;
  
  if (process.env.ONTOFELIA_TOKEN) {
    cloned.gateway.token = process.env.ONTOFELIA_TOKEN;
  }
  if (process.env.ONTOFELIA_PORT) {
    const port = parseInt(process.env.ONTOFELIA_PORT, 10);
    if (!isNaN(port)) {
      cloned.gateway.port = port;
    }
  }
  if (process.env.ONTOFELIA_BIND) {
    const bind = process.env.ONTOFELIA_BIND;
    if (['loopback', 'lan', 'tailnet', 'custom'].includes(bind)) {
      cloned.gateway.bind = bind as 'loopback' | 'lan' | 'tailnet' | 'custom';
    }
  }
  
  return cloned;
}

export async function loadConfig(configPath: string = DEFAULT_CONFIG_PATH): Promise<OntofeliaConfig> {
  try {
    const content = await fs.readFile(configPath, 'utf-8');
    const parsed = JSON5.parse(content);
    
    // Merge with defaults
    const merged = defu(parsed, getDefaultConfig());
    
    const validationResult = validateConfig(merged);
    
    if (validationResult.isErr()) {
      logger.error({ errors: validationResult.error }, 'Configuration validation failed');
      throw new Error('Invalid configuration');
    }
    
    const finalConfig = applyEnvFallbacks(validationResult.value);
    return finalConfig;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      logger.info(`Config file not found at ${configPath}, returning defaults`);
      return applyEnvFallbacks(getDefaultConfig());
    }
    throw error;
  }
}

export async function saveConfig(config: OntofeliaConfig, configPath: string = DEFAULT_CONFIG_PATH): Promise<void> {
  const validationResult = validateConfig(config);
  if (validationResult.isErr()) {
    throw new Error('Cannot save invalid configuration');
  }
  
  const content = JSON5.stringify(config, null, 2);
  const dir = path.dirname(configPath);
  
  await fs.mkdir(dir, { recursive: true });
  
  // Create backup if file exists
  try {
    const stats = await fs.stat(configPath);
    if (stats.isFile()) {
      const backupPath = `${configPath}.backup.${Date.now()}`;
      await fs.copyFile(configPath, backupPath);
      logger.info(`Created config backup at ${backupPath}`);
    }
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn({ err: e }, 'Failed to create config backup');
    }
  }
  
  await fs.writeFile(configPath, content, 'utf-8');
  logger.info(`Saved config to ${configPath}`);
}
