import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { OAuthTokens } from './OAuthPKCE.js';

const AUTH_FILE = path.join(os.homedir(), '.ontofelia', 'auth.json');

export class TokenStore {
  async save(tokens: OAuthTokens): Promise<void> {
    const dir = path.dirname(AUTH_FILE);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(AUTH_FILE, JSON.stringify(tokens, null, 2), { mode: 0o600 });
  }

  async load(): Promise<OAuthTokens | null> {
    try {
      const content = await fs.readFile(AUTH_FILE, 'utf-8');
      return JSON.parse(content) as OAuthTokens;
    } catch {
      return null;
    }
  }

  async clear(): Promise<void> {
    try {
      await fs.unlink(AUTH_FILE);
    } catch {
      // Ignore if file doesn't exist
    }
  }

  isExpired(tokens: OAuthTokens): boolean {
    return new Date(tokens.expiresAt) <= new Date();
  }
}
