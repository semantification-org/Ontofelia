import { describe, it, expect, vi, beforeEach, afterEach, MockInstance } from 'vitest';
import { Command } from 'commander';
import { registerDoctorCommand } from '../commands/doctor.js';
import * as fs from 'fs/promises';

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as Record<string, unknown>),
    readFile: vi.fn(),
    access: vi.fn()
  };
});

vi.mock('child_process', () => ({
  execFile: vi.fn((cmd, args, cb) => cb(null, 'Server Version: 24.0.0', ''))
}));

const originalFetch = global.fetch;

describe('doctor command', () => {
  let program: Command;
  let logSpy: MockInstance;
  let errorSpy: MockInstance;
  let exitSpy: MockInstance;

  beforeEach(() => {
    program = new Command();
    registerDoctorCommand(program);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    global.fetch = originalFetch;
  });

  it('fails if config missing or invalid JSON', async () => {
    vi.mocked(fs.readFile).mockRejectedValue(new Error('ENOENT'));
    await program.parseAsync(['node', 'test', 'doctor']);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Doctor failed'));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('reports valid config correctly', async () => {
    vi.mocked(fs.readFile).mockResolvedValue('{}');
    vi.mocked(fs.access).mockResolvedValue(undefined);
    global.fetch = vi.fn().mockResolvedValue({ ok: true });

    await program.parseAsync(['node', 'test', 'doctor']);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Configuration is valid.'));
  });

  it('reports fuseki missing', async () => {
    vi.mocked(fs.readFile).mockResolvedValue('{}');
    vi.mocked(fs.access).mockResolvedValue(undefined);
    global.fetch = vi.fn().mockRejectedValue(new Error('Connection refused'));

    await program.parseAsync(['node', 'test', 'doctor']);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Fuseki Triplestore is not reachable'));
  });

  it('reports missing session and workspace dir', async () => {
    vi.mocked(fs.readFile).mockResolvedValue('{}');
    vi.mocked(fs.access).mockRejectedValue(new Error('ENOENT'));
    global.fetch = vi.fn().mockResolvedValue({ ok: true });

    await program.parseAsync(['node', 'test', 'doctor']);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Default Agent Session Store missing'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Workspace directory missing'));
  });
});
