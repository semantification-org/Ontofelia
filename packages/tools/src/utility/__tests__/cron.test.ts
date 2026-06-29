import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CronManageTool } from '../cron.js';
import * as cp from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const TEST_HOME = path.join(os.tmpdir(), 'ontofelia-cron-test');

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
});
