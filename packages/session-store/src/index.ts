import Database from 'better-sqlite3';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { SessionRecord, SessionOrigin, TranscriptEntry, SessionPolicy } from '@ontofelia/core';

export function computeSessionKey(scope: SessionPolicy['scope'], origin: SessionOrigin): string {
  switch (scope) {
    case 'main':
      return 'main';
    case 'per-peer':
      return `peer:${origin.senderId}`;
    case 'per-channel-peer':
      return `${origin.channel}:${origin.senderId}`;
    case 'per-account-channel-peer':
      return `${origin.accountId || 'none'}:${origin.channel}:${origin.senderId}`;
    default:
      return 'main';
  }
}

export interface SessionRow {
  sessionId: string;
  agentId: string;
  scope: SessionPolicy['scope'];
  sessionKey: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  totalTokens: number;
  status: SessionRecord['status'];
  origin: string;
  displayName: string | null;
  transcriptPath: string;
}

export class SessionStore {
  private db: Database.Database;
  private transcriptsDir: string;

  constructor(private dataDir: string) {
    if (!fsSync.existsSync(dataDir)) {
      fsSync.mkdirSync(dataDir, { recursive: true });
    }
    this.transcriptsDir = path.join(dataDir, 'transcripts');
    if (!fsSync.existsSync(this.transcriptsDir)) {
      fsSync.mkdirSync(this.transcriptsDir, { recursive: true });
    }

    const dbPath = path.join(dataDir, 'sessions.db');
    this.db = new Database(dbPath);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        sessionId TEXT PRIMARY KEY,
        agentId TEXT NOT NULL,
        scope TEXT NOT NULL,
        sessionKey TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        messageCount INTEGER NOT NULL DEFAULT 0,
        totalTokens INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        origin TEXT NOT NULL,
        displayName TEXT,
        transcriptPath TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_agent_key ON sessions(agentId, sessionKey);
    `);
  }

  async getOrCreateSession(agentId: string, scope: SessionPolicy['scope'], origin: SessionOrigin): Promise<SessionRecord> {
    const sessionKey = computeSessionKey(scope, origin);
    
    const stmt = this.db.prepare('SELECT * FROM sessions WHERE agentId = ? AND sessionKey = ? AND status = ? LIMIT 1');
    const existing = stmt.get(agentId, sessionKey, 'active') as SessionRow | undefined;

    if (existing) {
      return this.mapToRecord(existing);
    }

    const sessionId = crypto.randomUUID();
    const now = new Date().toISOString();
    const transcriptPath = path.join(this.transcriptsDir, `${sessionId}.jsonl`);
    
    const newSession: SessionRecord = {
      sessionId,
      agentId,
      scope,
      sessionKey,
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
      totalTokens: 0,
      status: 'active',
      origin,
      transcriptPath
    };

    const insert = this.db.prepare(`
      INSERT INTO sessions (sessionId, agentId, scope, sessionKey, createdAt, updatedAt, messageCount, totalTokens, status, origin, transcriptPath)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insert.run(
      sessionId,
      agentId,
      scope,
      sessionKey,
      now,
      now,
      0,
      0,
      'active',
      JSON.stringify(origin),
      transcriptPath
    );

    return newSession;
  }

  async getSession(sessionId: string): Promise<SessionRecord | null> {
    const stmt = this.db.prepare('SELECT * FROM sessions WHERE sessionId = ?');
    const row = stmt.get(sessionId) as SessionRow | undefined;
    if (!row) return null;
    return this.mapToRecord(row);
  }

  async listSessions(agentId: string): Promise<SessionRecord[]> {
    const stmt = this.db.prepare('SELECT * FROM sessions WHERE agentId = ? ORDER BY updatedAt DESC');
    const rows = stmt.all(agentId) as SessionRow[];
    return rows.map(r => this.mapToRecord(r));
  }

  async updateSession(sessionId: string, updates: Partial<SessionRecord>): Promise<void> {
    const session = await this.getSession(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);

    const updated = { ...session, ...updates, updatedAt: new Date().toISOString() };
    const stmt = this.db.prepare(`
      UPDATE sessions SET
        updatedAt = ?,
        messageCount = ?,
        totalTokens = ?,
        status = ?,
        displayName = ?
      WHERE sessionId = ?
    `);

    stmt.run(
      updated.updatedAt,
      updated.messageCount,
      updated.totalTokens,
      updated.status,
      updated.displayName || null,
      sessionId
    );
  }

  async resetSession(sessionId: string, mode: 'hard' | 'soft'): Promise<void> {
    const session = await this.getSession(sessionId);
    if (!session) return;

    if (mode === 'hard') {
      try {
        await fs.unlink(session.transcriptPath);
      } catch (e: unknown) {
         
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
      
      const stmt = this.db.prepare(`
        UPDATE sessions SET messageCount = 0, totalTokens = 0, updatedAt = ? WHERE sessionId = ?
      `);
      stmt.run(new Date().toISOString(), sessionId);
    } else {
      // Soft reset: add a special "system" marker message to the transcript to denote reset, 
      // but retain history.
      await this.appendTranscript(sessionId, {
        timestamp: new Date().toISOString(),
        role: 'system',
        content: '[SESSION_RESET_SOFT]',
        metadata: { type: 'system_event' }
      });
    }
  }

  async appendTranscript(sessionId: string, entry: TranscriptEntry): Promise<void> {
    const session = await this.getSession(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);

    await fs.appendFile(session.transcriptPath, JSON.stringify(entry) + '\n');
    
    // Update session counts
    const newCount = session.messageCount + 1;
    const newTokens = session.totalTokens + (entry.tokenCount || 0);
    
    const stmt = this.db.prepare(`
      UPDATE sessions SET messageCount = ?, totalTokens = ?, updatedAt = ? WHERE sessionId = ?
    `);
    stmt.run(newCount, newTokens, new Date().toISOString(), sessionId);
  }

  async loadTranscript(sessionId: string, limit?: number): Promise<TranscriptEntry[]> {
    const session = await this.getSession(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);

    try {
      const content = await fs.readFile(session.transcriptPath, 'utf-8');
      const lines = content.split('\n').filter(l => l.trim() !== '');
      const entries: TranscriptEntry[] = [];
      for (const line of lines) {
        try {
          entries.push(JSON.parse(line) as TranscriptEntry);
        } catch {
          // ignore corrupt lines
        }
      }
      
      if (limit && limit > 0) {
        return entries.slice(-limit);
      }
      return entries;
    } catch (e: unknown) {
       
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw e;
    }
  }

  getTranscriptPath(sessionId: string): string {
    return path.join(this.transcriptsDir, `${sessionId}.jsonl`);
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    const session = await this.getSession(sessionId);
    if (!session) return false;
    try {
      await fs.unlink(session.transcriptPath);
    } catch (e: unknown) {
       
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    this.db.prepare('DELETE FROM sessions WHERE sessionId = ?').run(sessionId);
    return true;
  }

  close(): void {
    this.db.close();
  }

  private mapToRecord(row: SessionRow): SessionRecord {
    return {
      sessionId: row.sessionId,
      agentId: row.agentId,
      scope: row.scope,
      sessionKey: row.sessionKey,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      messageCount: row.messageCount,
      totalTokens: row.totalTokens,
      status: row.status,
      origin: JSON.parse(row.origin),
      displayName: row.displayName || undefined,
      transcriptPath: row.transcriptPath
    };
  }
}
