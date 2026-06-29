import Database from 'better-sqlite3';
import { ChannelType } from '@ontofelia/core';

export interface PairingRequest {
  code: string;
  channel: ChannelType;
  senderId: string;
  displayName?: string;
  createdAt: string;
  expiresAt: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
}

export class PairingStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.initDb();
  }

  private initDb() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pairing_requests (
        code TEXT PRIMARY KEY,
        channel TEXT NOT NULL,
        senderId TEXT NOT NULL,
        displayName TEXT,
        createdAt TEXT NOT NULL,
        expiresAt TEXT NOT NULL,
        status TEXT NOT NULL
      );
    `);
  }

  private generateCode(): string {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 8; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
  }

  async createRequest(channel: ChannelType, senderId: string, displayName?: string): Promise<PairingRequest> {
    const pendingCount = this.db.prepare("SELECT COUNT(*) as c FROM pairing_requests WHERE channel = ? AND senderId = ? AND status = 'pending'").get(channel, senderId) as { c: number };
    
    if (pendingCount.c >= 3) {
      throw new Error('Maximum pending pairing requests reached for this sender.');
    }

    let code = this.generateCode();
    // Ensure uniqueness
    while (this.db.prepare('SELECT 1 FROM pairing_requests WHERE code = ?').get(code)) {
      code = this.generateCode();
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + 60 * 60 * 1000);

    const request: PairingRequest = {
      code,
      channel,
      senderId,
      displayName,
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      status: 'pending'
    };

    const stmt = this.db.prepare(`
      INSERT INTO pairing_requests (code, channel, senderId, displayName, createdAt, expiresAt, status)
      VALUES (@code, @channel, @senderId, @displayName, @createdAt, @expiresAt, @status)
    `);

    stmt.run(request);

    return request;
  }

  async isAllowed(channel: ChannelType, senderId: string): Promise<boolean> {
    // This is typically handled by AllowlistStore, but the prompt showed this in PairingStore too.
    // We'll leave it to just check if there is an approved pairing for them.
    const row = this.db.prepare(`
      SELECT 1 FROM pairing_requests 
      WHERE channel = ? AND senderId = ? AND status = 'approved'
    `).get(channel, senderId);
    return !!row;
  }

  async approve(code: string): Promise<PairingRequest | null> {
    const req = this.db.prepare('SELECT * FROM pairing_requests WHERE code = ?').get(code) as PairingRequest | undefined;
    if (!req) return null;
    
    this.db.prepare("UPDATE pairing_requests SET status = 'approved' WHERE code = ?").run(code);
    req.status = 'approved';
    return req;
  }

  async reject(code: string): Promise<PairingRequest | null> {
    const req = this.db.prepare('SELECT * FROM pairing_requests WHERE code = ?').get(code) as PairingRequest | undefined;
    if (!req) return null;
    
    this.db.prepare("UPDATE pairing_requests SET status = 'rejected' WHERE code = ?").run(code);
    req.status = 'rejected';
    return req;
  }

  async listPending(channel?: ChannelType): Promise<PairingRequest[]> {
    if (channel) {
      return this.db.prepare("SELECT * FROM pairing_requests WHERE status = 'pending' AND channel = ?").all(channel) as PairingRequest[];
    }
    return this.db.prepare("SELECT * FROM pairing_requests WHERE status = 'pending'").all() as PairingRequest[];
  }

  async cleanup(): Promise<number> {
    const now = new Date().toISOString();
    const result = this.db.prepare("UPDATE pairing_requests SET status = 'expired' WHERE status = 'pending' AND expiresAt < ?").run(now);
    return result.changes;
  }
}
