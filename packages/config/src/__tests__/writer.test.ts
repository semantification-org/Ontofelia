import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import JSON5 from 'json5';
import { updateConfigField } from '../writer.js';

describe('updateConfigField', () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ontofelia-config-test-'));
    configPath = path.join(tmpDir, 'ontofelia.json5');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('writes valid update and validates', async () => {
    await fs.writeFile(configPath, JSON5.stringify({ provider: { defaultModel: 'old-model' } }));
    
    await updateConfigField(configPath, 'provider.defaultModel', 'new-model');
    
    const updated = await fs.readFile(configPath, 'utf-8');
    const parsed = JSON5.parse(updated);
    expect(parsed.provider.defaultModel).toBe('new-model');
  });

  it('rejects invalid value', async () => {
    await fs.writeFile(configPath, JSON5.stringify({ gateway: { port: 8080 } }));
    
    // Zod throws when gateway.port is set to a string
    await expect(updateConfigField(configPath, 'gateway.port', 'abc')).rejects.toThrow();
    
    // File remains unchanged
    const unchanged = await fs.readFile(configPath, 'utf-8');
    const parsed = JSON5.parse(unchanged);
    expect(parsed.gateway.port).toBe(8080);
  });

  it('creates backup file', async () => {
    await fs.writeFile(configPath, JSON5.stringify({ memory: { backend: 'memory' } }));
    
    await updateConfigField(configPath, 'memory.backend', 'fuseki');
    
    const backupContent = await fs.readFile(configPath + '.bak', 'utf-8');
    const parsedBackup = JSON5.parse(backupContent);
    expect(parsedBackup.memory.backend).toBe('memory');
  });
});
