import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { extractAccountId, OAuthTokens } from '../auth/OAuthPKCE.js';
import { TokenStore } from '../auth/TokenStore.js';
import { OpenAICodexProvider } from '../OpenAICodexProvider.js';

// Build a fake JWT: header.payload.signature (only the payload matters here).
function makeJwt(payload: unknown): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64(payload)}.sig`;
}

describe('extractAccountId', () => {
  it('reads the nested OpenAI auth namespace claim', () => {
    const jwt = makeJwt({
      'https://api.openai.com/auth': { chatgpt_account_id: 'acct_123' },
      sub: 'user_1'
    });
    expect(extractAccountId(jwt)).toBe('acct_123');
  });

  it('falls back to a top-level chatgpt_account_id claim', () => {
    const jwt = makeJwt({ chatgpt_account_id: 'acct_top', sub: 'user_1' });
    expect(extractAccountId(jwt)).toBe('acct_top');
  });

  it('falls back to top-level account_id / organization_id', () => {
    expect(extractAccountId(makeJwt({ account_id: 'acct_a' }))).toBe('acct_a');
    expect(extractAccountId(makeJwt({ organization_id: 'org_b' }))).toBe('org_b');
  });

  it('prefers the nested claim over top-level ones', () => {
    const jwt = makeJwt({
      'https://api.openai.com/auth': { chatgpt_account_id: 'acct_nested' },
      chatgpt_account_id: 'acct_top'
    });
    expect(extractAccountId(jwt)).toBe('acct_nested');
  });

  it('returns undefined for missing / malformed / empty input without throwing', () => {
    expect(extractAccountId(undefined)).toBeUndefined();
    expect(extractAccountId(null)).toBeUndefined();
    expect(extractAccountId('')).toBeUndefined();
    expect(extractAccountId('not-a-jwt')).toBeUndefined();
    expect(extractAccountId('a.b')).toBeUndefined(); // payload "b" is not valid JSON
    expect(extractAccountId(makeJwt({ sub: 'user_1' }))).toBeUndefined(); // no id claim
  });
});

describe('TokenStore round-trip', () => {
  let tmpDir: string;
  let authFile: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ontofelia-tokenstore-'));
    authFile = path.join(tmpDir, 'auth.json');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('persists and reloads accountId', async () => {
    const store = new TokenStore(authFile);
    const tokens: OAuthTokens = {
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      tokenType: 'Bearer',
      accountId: 'acct_persist'
    };
    await store.save(tokens);
    const loaded = await store.load();
    expect(loaded?.accountId).toBe('acct_persist');
    expect(loaded?.accessToken).toBe('a');
  });

  it('loads an old auth.json without accountId (backward compatible)', async () => {
    const store = new TokenStore(authFile);
    const legacy = {
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      tokenType: 'Bearer'
    };
    // Write a legacy-shaped file directly.
    await store.save(legacy as OAuthTokens);
    const loaded = await store.load();
    expect(loaded).not.toBeNull();
    expect(loaded?.accountId).toBeUndefined();
    expect(loaded?.accessToken).toBe('a');
  });
});

describe('OpenAICodexProvider.buildCodexHeaders', () => {
  it('includes chatgpt-account-id when accountId is present', () => {
    const provider = new OpenAICodexProvider();
    const headers = provider.buildCodexHeaders('tok', 'acct_123');
    expect(headers['Authorization']).toBe('Bearer tok');
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['chatgpt-account-id']).toBe('acct_123');
  });

  it('omits the header and warns when accountId is missing', () => {
    const provider = new OpenAICodexProvider();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const headers = provider.buildCodexHeaders('tok', undefined);
    expect(headers['chatgpt-account-id']).toBeUndefined();
    expect(headers['Authorization']).toBe('Bearer tok');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
