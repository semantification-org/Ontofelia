import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { getDefaultConfig, validateConfig, saveConfig, loadConfig } from '../index.js';

describe('config package', () => {
  const tempDir = path.join(os.tmpdir(), 'ontofelia-test-config');
  const tempConfigFile = path.join(tempDir, 'ontofelia.json5');

  beforeEach(async () => {
    await fs.mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it('should provide default config', () => {
    const config = getDefaultConfig();
    expect(config.version).toBe(1);
    expect(config.gateway.port).toBe(18780);
  });

  it('should validate valid config', () => {
    const config = getDefaultConfig();
    config.gateway.token = 'secret123';
    
    const result = validateConfig(config);
    expect(result.isOk()).toBe(true);
  });

  it('should save and load config', async () => {
    const config = getDefaultConfig();
    config.gateway.token = 'test-token';
    config.gateway.port = 9999;
    
    await saveConfig(config, tempConfigFile);
    
    const loaded = await loadConfig(tempConfigFile);
    expect(loaded.gateway.token).toBe('test-token');
    expect(loaded.gateway.port).toBe(9999);
  });

  it('should apply environment fallbacks', async () => {
    const config = getDefaultConfig();
    config.gateway.token = 'default-token';
    await saveConfig(config, tempConfigFile);
    
    vi.stubEnv('ONTOFELIA_TOKEN', 'env-token');
    vi.stubEnv('ONTOFELIA_PORT', '8888');
    
    const loaded = await loadConfig(tempConfigFile);
    expect(loaded.gateway.token).toBe('env-token');
    expect(loaded.gateway.port).toBe(8888);
  });
});
