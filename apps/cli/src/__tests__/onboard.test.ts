import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { registerOnboardCommand } from '../commands/onboard.js';
import * as fs from 'fs/promises';
import * as configPkg from '@ontofelia/config';

vi.mock('@ontofelia/config', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as Record<string, unknown>),
    saveConfig: vi.fn(),
  };
});

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as Record<string, unknown>),
    mkdir: vi.fn(),
    access: vi.fn(),
    writeFile: vi.fn()
  };
});

vi.mock('child_process', () => ({
  execFile: vi.fn((cmd, args, cb) => cb(null, 'java version 17', ''))
}));

describe('onboard command', () => {
  let program: Command;

  beforeEach(() => {
    program = new Command();
    registerOnboardCommand(program);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    // onboard ends with an explicit process.exit(0) (see onboard.ts) to avoid
    // hanging on a leftover readline/OAuth handle; stub it so the test runner
    // doesn't treat the intentional exit as a failure.
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('runs non-interactive mode and generates config', async () => {
    vi.mocked(fs.access).mockRejectedValue(new Error('ENOENT')); // File doesn't exist

    await program.parseAsync(['node', 'test', 'onboard', '--non-interactive']);

    // Check config saved
    expect(configPkg.saveConfig).toHaveBeenCalled();
    const savedConfig = vi.mocked(configPkg.saveConfig).mock.calls[0][0];

    // Check token was generated (32 bytes = 64 hex chars)
    expect(savedConfig.gateway.token).toHaveLength(64);
    expect(savedConfig.provider.name).toBe('mock');

    // Check folders created
    expect(fs.mkdir).toHaveBeenCalledWith(expect.stringContaining('workspace'), expect.anything());

    // Check default files created
    expect(fs.writeFile).toHaveBeenCalledWith(expect.stringContaining('SOUL.md'), expect.any(String), 'utf-8');
    expect(fs.writeFile).toHaveBeenCalledWith(expect.stringContaining('IDENTITY.md'), expect.any(String), 'utf-8');
    expect(fs.writeFile).toHaveBeenCalledWith(expect.stringContaining('USER.md'), expect.any(String), 'utf-8');
  });
});
