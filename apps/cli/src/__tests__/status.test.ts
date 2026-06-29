import { describe, it, expect, vi, beforeEach, afterEach, MockInstance } from 'vitest';
import { Command } from 'commander';
import { registerStatusCommand } from '../commands/status.js';
import * as configPkg from '@ontofelia/config';
import * as processUtils from '../utils/process.js';

vi.mock('@ontofelia/config', () => ({
  loadConfig: vi.fn(),
}));

vi.mock('../utils/process.js', () => ({
  readPid: vi.fn(),
}));

const originalFetch = global.fetch;

describe('status command', () => {
  let program: Command;
  let logSpy: MockInstance;

  beforeEach(() => {
    program = new Command();
    registerStatusCommand(program);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.mocked(configPkg.loadConfig).mockResolvedValue({
      gateway: { port: 18780, token: 'test' }
    } as unknown as Awaited<ReturnType<typeof configPkg.loadConfig>>);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    global.fetch = originalFetch;
  });

  it('shows stopped when no PID', async () => {
    vi.mocked(processUtils.readPid).mockResolvedValue(null);
    await program.parseAsync(['node', 'test', 'status']);
    
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Gateway        stopped'));
  });

  it('shows gateway status when running', async () => {
    vi.mocked(processUtils.readPid).mockResolvedValue(1234);
    
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        version: '1.0.0',
        uptime: 3600,
        agents: { total: 1, running: 1 },
        channels: { total: 1, connected: 1 },
        memory: { backend: 'fuseki', status: 'running', tripleCount: 42 }
      })
    });

    await program.parseAsync(['node', 'test', 'status']);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Gateway        running (PID 1234)'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Agents         1/1 running'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Channels       1/1 connected'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Knowledge Graph fuseki (42 triples)'));
  });

  it('shows error if API not responding', async () => {
    vi.mocked(processUtils.readPid).mockResolvedValue(1234);
    
    global.fetch = vi.fn().mockRejectedValue(new Error('fetch failed'));

    await program.parseAsync(['node', 'test', 'status']);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Gateway process found but API not responding'));
  });
});
