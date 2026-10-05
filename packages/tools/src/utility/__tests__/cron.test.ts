import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { CronManageTool } from '../cron.js';
import * as cp from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';

// Unique per-run directory (not a fixed name in os.tmpdir()) so two users/runs never
// collide over ownership. Computed in vi.hoisted() since vi.mock(...) below is hoisted
// above this module's own top-level code; uses the real os.tmpdir(), not the mock.
const TEST_HOME = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  return mkdtempSync(join(tmpdir(), 'ontofelia-cron-'));
});

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return {
    ...actual,
    homedir: () => TEST_HOME
  };
});

vi.mock('child_process', () => ({
  execFile: vi.fn((cmd, args, opts, cb) => {
    // If cb is the 3rd argument
    if (typeof opts === 'function') {
      opts(null, { stdout: '# ontofelia: myjob\n', stderr: '' });
    } else if (typeof cb === 'function') {
      cb(null, { stdout: '# ontofelia: myjob\n', stderr: '' });
    }
  })
}));

describe('CronManageTool', () => {
  const tool = new CronManageTool(18780);
  const context = { agentId: 'test', sessionId: 'test', workspacePath: '', channelType: 'cli' as const, senderId: 'u', isOwner: true };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await fs.rm(TEST_HOME, { recursive: true, force: true });
  });

  it('rejects invalid labels', async () => {
    const res = await tool.execute({ action: 'add', schedule: '0 9 * * *', label: 'invalid label with spaces' }, context);
    expect(res.success).toBe(true);
    expect(res.output).toMatch(/Invalid label/);
  });

  it('rejects invalid schedules', async () => {
    const res = await tool.execute({ action: 'add', schedule: 'rm -rf /', label: 'test' }, context);
    expect(res.output).toMatch(/Invalid cron schedule format/);
  });

  it('creates payload file and sets crontab with @file', async () => {
    const res = await tool.execute({ action: 'add', schedule: '0 9 * * *', label: 'myjob', wakeMessage: 'hello' }, context);
    
    expect(res.output).toMatch(/Cron job created/);
    
    const payloadPath = path.join(TEST_HOME, '.ontofelia', 'cron', 'job_myjob.json');
    const content = await fs.readFile(payloadPath, 'utf-8');
    expect(content).toContain('hello');

    const execFileCalls = vi.mocked(cp.execFile).mock.calls;
    const crontabSetCall = execFileCalls.find(c => c[0] === 'crontab' && Array.isArray(c[1]) && c[1][0].includes('ontofelia-cron-'));
    expect(crontabSetCall).toBeDefined();
  });

  it('removes payload file and cleans crontab on remove', async () => {
    const payloadPath = path.join(TEST_HOME, '.ontofelia', 'cron', 'job_myjob.json');
    await fs.mkdir(path.dirname(payloadPath), { recursive: true });
    await fs.writeFile(payloadPath, 'dummy', 'utf-8');

    const res = await tool.execute({ action: 'remove', removeLabel: 'myjob' }, context);
    
    expect(res.output).toMatch(/Cron job "myjob" removed/);
    
    const fileExists = await fs.stat(payloadPath).then(() => true).catch(() => false);
    expect(fileExists).toBe(false);
    
    const execFileCalls = vi.mocked(cp.execFile).mock.calls;
    const crontabRemoveCall = execFileCalls.find(c => c[0] === 'crontab' && Array.isArray(c[1]) && c[1][0] === '-r');
    expect(crontabRemoveCall).toBeDefined();
  });

  it('reports the error and does not claim success when `crontab -r` fails', async () => {
    const payloadPath = path.join(TEST_HOME, '.ontofelia', 'cron', 'job_myjob.json');
    await fs.mkdir(path.dirname(payloadPath), { recursive: true });
    await fs.writeFile(payloadPath, 'dummy', 'utf-8');

    vi.mocked(cp.execFile).mockImplementation(((cmd: string, args: unknown, opts: unknown, cb: unknown) => {
      const callback = (typeof opts === 'function' ? opts : cb) as (
        error: Error | null,
        result: { stdout: string; stderr: string },
      ) => void;
      const argv = Array.isArray(args) ? args : [];
      if (cmd === 'crontab' && argv[0] === '-r') {
        callback(new Error('crontab: no crontab for test'), { stdout: '', stderr: '' });
        return undefined;
      }
      callback(null, { stdout: '# ontofelia: myjob\n', stderr: '' });
      return undefined;
    }) as unknown as typeof cp.execFile);

    const res = await tool.execute({ action: 'remove', removeLabel: 'myjob' }, context);

    expect(res.output).toMatch(/❌ Error removing cron job:/);
    expect(res.output).toContain('no crontab for test');
    expect(res.output).not.toMatch(/removed/);
  });

  describe('reserved initiative- label prefix (self-schedule protection)', () => {
    it('refuses to create a job with the reserved prefix', async () => {
      const res = await tool.execute(
        { action: 'add', schedule: '0 9 * * *', label: 'initiative-goal-wake', wakeMessage: 'wake' },
        context,
      );
      expect(res.output).toMatch(/reserved prefix "initiative-"/);
      // Nothing may reach the crontab.
      expect(vi.mocked(cp.execFile).mock.calls.length).toBe(0);
    });

    it('refuses to remove a job with the reserved prefix', async () => {
      const res = await tool.execute({ action: 'remove', removeLabel: 'initiative-nightly' }, context);
      expect(res.output).toMatch(/reserved prefix "initiative-"/);
      expect(vi.mocked(cp.execFile).mock.calls.length).toBe(0);
    });

    it('still allows ordinary labels (prefix must match exactly)', async () => {
      const res = await tool.execute(
        { action: 'add', schedule: '0 9 * * *', label: 'initiativeless-job', wakeMessage: 'hi' },
        context,
      );
      // 'initiativeless-job' does not carry the "initiative-" prefix.
      expect(res.output).toMatch(/Cron job created/);
    });
  });
});
