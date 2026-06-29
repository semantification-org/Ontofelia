import Database from 'better-sqlite3';
import { ChannelType } from '@ontofelia/core';

export interface AllowlistEntry {
  channel: ChannelType;
  senderId: string;
  displayName?: string;
  pairedAt: string;
  pairedBy: string; // 'pairing' or 'manual'
}

export class AllowlistStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.initDb();
  }

  private initDb() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS allowlist (
        channel TEXT NOT NULL,
        senderId TEXT NOT NULL,
        displayName TEXT,
        pairedAt TEXT NOT NULL,
        pairedBy TEXT NOT NULL,
        PRIMARY KEY (channel, senderId)
      );
    `);
  }

  async add(entry: Omit<AllowlistEntry, 'pairedAt'>): Promise<void> {
    const pairedAt = new Date().toISOString();
    this.db.prepare(`
      INSERT OR REPLACE INTO allowlist (channel, senderId, displayName, pairedAt, pairedBy)
      VALUES (@channel, @senderId, @displayName, @pairedAt, @pairedBy)
    `).run({ ...entry, pairedAt });
  }

  async remove(channel: ChannelType, senderId: string): Promise<boolean> {
    const result = this.db.prepare('DELETE FROM allowlist WHERE channel = ? AND senderId = ?').run(channel, senderId);
    return result.changes > 0;
  }

  async isAllowed(channel: ChannelType, senderId: string): Promise<boolean> {
    const row = this.db.prepare('SELECT 1 FROM allowlist WHERE channel = ? AND senderId = ?').get(channel, senderId);
    return !!row;
  }

  async list(channel?: ChannelType): Promise<AllowlistEntry[]> {
    if (channel) {
      return this.db.prepare('SELECT * FROM allowlist WHERE channel = ?').all(channel) as AllowlistEntry[];
    }
    return this.db.prepare('SELECT * FROM allowlist').all() as AllowlistEntry[];
  }
}
