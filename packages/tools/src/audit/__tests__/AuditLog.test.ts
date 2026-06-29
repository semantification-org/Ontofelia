import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AuditLog } from '../AuditLog.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

describe('AuditLog', () => {
  let logDir: string;
  let auditLog: AuditLog;

  beforeEach(async () => {
    logDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ontofelia-audit-test-'));
    auditLog = new AuditLog(logDir);
  });

  afterEach(async () => {
    await fs.rm(logDir, { recursive: true, force: true });
  });

  it('masks secrets in payloads', async () => {
    await auditLog.log({
      toolName: 'test',
      timestamp: 'now',
      duration: 10,
      input: { mySecretToken: 'super-secret', otherValue: 'public' },
      output: { api_key: 'hidden' },
      success: true,
      permissions: []
    });

    const recent = await auditLog.recent(1);
    expect(recent).toHaveLength(1);
    const entry = recent[0] as { input: Record<string, unknown>; output: Record<string, unknown> };
    expect(entry.input.mySecretToken).toBe('***');
    expect(entry.input.otherValue).toBe('public');
    expect(entry.output.api_key).toBe('***');
  });

  it('truncates large strings', async () => {
    const hugeString = 'a'.repeat(3000);
    await auditLog.log({
      toolName: 'test',
      timestamp: 'now',
      duration: 10,
      input: hugeString,
      output: null,
      success: true,
      permissions: []
    });

    const recent = await auditLog.recent(1);
    const entry = recent[0] as { input: string };
    expect(entry.input).toContain('[TRUNCATED]');
    expect(entry.input.length).toBeLessThan(2100);
  });

  it('logs deny entry properly', async () => {
    await auditLog.logDeny({
      toolName: 'bad_tool',
      timestamp: 'now',
      duration: 0,
      input: 'bad input',
      permissions: ['shell:exec']
    });

    const recent = await auditLog.recent(1);
    const entry = recent[0];
    expect(entry.success).toBe(false);
    expect(entry.policyDecision).toBe('DENY');
    expect(entry.toolName).toBe('bad_tool');
  });

  it('maintains a valid hash chain', async () => {
    await auditLog.log({ toolName: 't1', timestamp: '1', duration: 1, input: '', output: '', success: true, permissions: [] });
    await auditLog.log({ toolName: 't2', timestamp: '2', duration: 1, input: '', output: '', success: true, permissions: [] });

    const recent = await auditLog.recent(2);
    expect(recent).toHaveLength(2);
    
    const entry1 = recent[0] as unknown as { _hash: string; _prevHash?: string };
    const entry2 = recent[1] as unknown as { _hash: string; _prevHash?: string };

    expect(entry1._hash).toBeDefined();
    expect(entry2._hash).toBeDefined();
    expect(entry2._prevHash).toBe(entry1._hash);
  });
});
