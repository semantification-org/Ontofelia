import { ToolAuditEntry } from '@ontofelia/core';
import * as fs from 'fs/promises';
import * as path from 'path';

import * as crypto from 'crypto';

export class AuditLog {
  private logDir: string;
  private lastHash: string | null = null;

  constructor(logDir: string) {
    this.logDir = logDir;
  }

  private getLogPath(date?: Date): string {
    const d = date || new Date();
    const today = d.toISOString().split('T')[0];
    return path.join(this.logDir, `audit-${today}.jsonl`);
  }

  private async ensureDir() {
    try {
      await fs.mkdir(this.logDir, { recursive: true });
    } catch (e: unknown) {
      if ((e as { code?: string }).code !== 'EEXIST') throw e;
    }
  }

  private maskPayload(obj: unknown): unknown {
    if (typeof obj === 'string') {
      return obj.length > 2000 ? obj.substring(0, 2000) + '... [TRUNCATED]' : obj;
    }
    if (Array.isArray(obj)) {
      return obj.map(item => this.maskPayload(item));
    }
    if (obj !== null && typeof obj === 'object') {
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj)) {
        if (/token|secret|password|key/i.test(k)) {
          result[k] = '***';
        } else {
          result[k] = this.maskPayload(v);
        }
      }
      return result;
    }
    return obj;
  }

  private async cleanupOldLogs() {
    try {
      const files = await fs.readdir(this.logDir);
      const now = Date.now();
      const ninetyDays = 90 * 24 * 60 * 60 * 1000;
      for (const file of files) {
        if (file.startsWith('audit-') && file.endsWith('.jsonl')) {
          const filePath = path.join(this.logDir, file);
          const stat = await fs.stat(filePath);
          if (now - stat.mtimeMs > ninetyDays) {
            await fs.rm(filePath, { force: true });
          }
        }
      }
    } catch {
      // ignore
    }
  }

  async log(entry: ToolAuditEntry): Promise<void> {
    await this.ensureDir();
    
    const maskedEntry = {
      ...entry,
      input: this.maskPayload(entry.input),
      output: this.maskPayload(entry.output),
    };
    
    const entryString = JSON.stringify(maskedEntry);
    
    // Hash chain
    const oldHash = this.lastHash;
    const hash = crypto.createHash('sha256').update((oldHash || '') + entryString).digest('hex');
    this.lastHash = hash;
    
    const finalObj = { ...maskedEntry, _hash: hash, _prevHash: oldHash };
    const line = JSON.stringify(finalObj) + '\n';
    
    const logPath = this.getLogPath();
    await fs.appendFile(logPath, line, 'utf-8');
    
    // Cleanup old logs in background (fire and forget)
    this.cleanupOldLogs().catch(() => {});
  }

  async logDeny(entry: Omit<ToolAuditEntry, 'success' | 'output'>): Promise<void> {
    await this.log({
      ...entry,
      success: false,
      output: null,
      policyDecision: 'DENY',
    });
  }

  async recent(n: number): Promise<ToolAuditEntry[]> {
    try {
      const logPath = this.getLogPath();
      const content = await fs.readFile(logPath, 'utf-8');
      const lines = content.trim().split('\n');
      const recentLines = lines.slice(-n).filter(l => l.length > 0);
      return recentLines.map(line => JSON.parse(line));
    } catch (e: unknown) {
      if ((e as { code?: string }).code === 'ENOENT') {
        return [];
      }
      throw e;
    }
  }
}
