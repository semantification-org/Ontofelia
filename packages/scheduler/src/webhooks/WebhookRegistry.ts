import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { createLogger } from '@ontofelia/core';

export interface WebhookConfig {
  id: string;
  name: string;
  path: string;            // URL-Pfad, z.B. "/webhooks/github"
  secret: string;          // HMAC secret or bearer token
  authMethod: 'hmac-sha256' | 'bearer';
  agentId: string;
  prompt?: string;         // Optionaler Prefix-Prompt
  enabled: boolean;
  maxPayloadBytes: number; // Default: 1MB
  createdAt: string;
  replayWindowMs: number;  // Default: 300000 (5 Min)
}

export class WebhookRegistry {
  private webhooks = new Map<string, WebhookConfig>();
  private recentNonces = new Map<string, number>();  // nonce → timestamp
  private logger = createLogger('scheduler');
  private webhooksFilePath: string;

  constructor(private storePath: string) {
    this.webhooksFilePath = path.join(this.storePath, 'webhooks.json');
  }

  async load(): Promise<void> {
    try {
      await fs.mkdir(this.storePath, { recursive: true });
      const data = await fs.readFile(this.webhooksFilePath, 'utf-8');
      const parsed = JSON.parse(data) as WebhookConfig[];
      
      for (const wh of parsed) {
        this.webhooks.set(wh.id, wh);
      }
      this.logger.info(`Loaded ${this.webhooks.size} webhooks.`);
    } catch (e: unknown) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') {
        this.logger.info('No webhooks file found, starting fresh.');
      } else {
        this.logger.error(`Failed to load webhooks: ${err.message}`);
      }
    }
  }

  async save(): Promise<void> {
    try {
      await fs.mkdir(this.storePath, { recursive: true });
      const data = Array.from(this.webhooks.values());
      await fs.writeFile(this.webhooksFilePath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (e: unknown) {
      this.logger.error(`Failed to save webhooks: ${(e as Error).message}`);
    }
  }

  async create(config: Omit<WebhookConfig, 'id' | 'createdAt'>): Promise<WebhookConfig> {
    const id = crypto.randomUUID();
    const newWebhook: WebhookConfig = {
      ...config,
      id,
      createdAt: new Date().toISOString()
    };
    
    // Basic path validation
    if (!newWebhook.path.startsWith('/webhooks/')) {
      if (newWebhook.path.startsWith('/')) {
        newWebhook.path = `/webhooks${newWebhook.path}`;
      } else {
        newWebhook.path = `/webhooks/${newWebhook.path}`;
      }
    }
    
    // Ensure path uniqueness
    if (this.getByPath(newWebhook.path)) {
      throw new Error(`Webhook with path ${newWebhook.path} already exists`);
    }

    this.webhooks.set(id, newWebhook);
    await this.save();
    return newWebhook;
  }

  async delete(id: string): Promise<boolean> {
    const removed = this.webhooks.delete(id);
    if (removed) {
      await this.save();
    }
    return removed;
  }

  get(id: string): WebhookConfig | undefined {
    return this.webhooks.get(id);
  }

  getByPath(webhookPath: string): WebhookConfig | undefined {
    for (const wh of this.webhooks.values()) {
      if (wh.path === webhookPath) return wh;
    }
    return undefined;
  }

  list(): WebhookConfig[] {
    return Array.from(this.webhooks.values());
  }

  validateRequest(webhook: WebhookConfig, headers: Record<string, string | string[] | undefined>, body: string): { valid: boolean; error?: string } {
    if (webhook.authMethod === 'bearer') {
      const authHeader = headers['authorization'] || headers['Authorization'];
      if (!authHeader) {
        return { valid: false, error: 'Missing Authorization header' };
      }
      const tokenStr = Array.isArray(authHeader) ? authHeader[0] : authHeader;
      if (!tokenStr.startsWith('Bearer ') || tokenStr.split(' ')[1] !== webhook.secret) {
        return { valid: false, error: 'Invalid Bearer token' };
      }
      return { valid: true };
    } else if (webhook.authMethod === 'hmac-sha256') {
      const sigHeader = headers['x-signature-256'];
      if (!sigHeader) {
        return { valid: false, error: 'Missing X-Signature-256 header' };
      }
      const sigStr = Array.isArray(sigHeader) ? sigHeader[0] : sigHeader;
      
      const expectedSig = crypto.createHmac('sha256', webhook.secret).update(body).digest('hex');
      const expectedSigWithPrefix = `sha256=${expectedSig}`; // Some systems use prefix
      
      if (sigStr !== expectedSig && sigStr !== expectedSigWithPrefix) {
        return { valid: false, error: 'Invalid HMAC signature' };
      }
      return { valid: true };
    }
    
    return { valid: false, error: 'Unknown auth method' };
  }

  checkReplay(nonce: string, replayWindowMs: number = 300000): boolean {
    const now = Date.now();
    
    // Periodic cleanup of old nonces
    if (Math.random() < 0.1) {
      for (const [key, timestamp] of this.recentNonces.entries()) {
        if (now - timestamp > replayWindowMs) {
          this.recentNonces.delete(key);
        }
      }
    }
    
    if (this.recentNonces.has(nonce)) {
      const timestamp = this.recentNonces.get(nonce)!;
      if (now - timestamp <= replayWindowMs) {
        return true; // Replay detected
      }
    }
    
    this.recentNonces.set(nonce, now);
    return false;
  }
}
