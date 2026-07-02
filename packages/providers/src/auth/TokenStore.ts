import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { OAuthTokens } from './OAuthPKCE.js';

function defaultAuthFile(): string {
  return path.join(os.homedir(), '.ontofelia', 'auth.json');
}

export class TokenStore {
  private readonly authFile: string;

  // The auth file path can be overridden for testing; by default it is derived
  // lazily from os.homedir() so callers/tests can control the home directory.
  constructor(authFile?: string) {
    this.authFile = authFile ?? defaultAuthFile();
  }

  async save(tokens: OAuthTokens): Promise<void> {
    const dir = path.dirname(this.authFile);
    await fs.mkdir(dir, { recursive: true });
    // Persist the full token shape, including the optional accountId (used for
    // the ChatGPT `chatgpt-account-id` header). Fields are written explicitly so
    // the on-disk shape is stable and documented.
    const payload: OAuthTokens = {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      tokenType: tokens.tokenType,
      ...(tokens.accountId ? { accountId: tokens.accountId } : {})
    };
    await fs.writeFile(this.authFile, JSON.stringify(payload, null, 2), { mode: 0o600 });
  }

  async load(): Promise<OAuthTokens | null> {
    try {
      const content = await fs.readFile(this.authFile, 'utf-8');
      // Backward compatible: old auth.json files have no `accountId`; JSON.parse
      // simply leaves it undefined, which is a valid OAuthTokens value.
      return JSON.parse(content) as OAuthTokens;
    } catch {
      return null;
    }
  }

  async clear(): Promise<void> {
    try {
      await fs.unlink(this.authFile);
    } catch {
      // Ignore if file doesn't exist
    }
  }

  isExpired(tokens: OAuthTokens): boolean {
    return new Date(tokens.expiresAt) <= new Date();
  }
}
