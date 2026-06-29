import * as crypto from 'crypto';
import * as http from 'http';
import { exec } from 'child_process';
import { createInterface } from 'readline';

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt: string;  // ISO timestamp
  tokenType: string;
}

export interface PKCEConfig {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  clientId: string;
  redirectUri: string;
  callbackPort: number;
}

const OPENAI_PKCE_CONFIG: PKCEConfig = {
  authorizationEndpoint: 'https://auth.openai.com/oauth/authorize',
  tokenEndpoint: 'https://auth.openai.com/oauth/token',
  clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
  redirectUri: 'http://localhost:1455/auth/callback',
  callbackPort: 1455,
};

export class OAuthPKCE {
  private config: PKCEConfig;
  
  constructor(config?: Partial<PKCEConfig>) {
    this.config = { ...OPENAI_PKCE_CONFIG, ...config };
  }

  // Generate code_verifier (43-128 characters, URL-safe).
  private generateCodeVerifier(): string {
    return crypto.randomBytes(32).toString('base64url');
  }

  // Calculate code_challenge = base64url(sha256(verifier)).
  private generateCodeChallenge(verifier: string): string {
    return crypto.createHash('sha256').update(verifier).digest('base64url');
  }

  // Generate state for CSRF protection.
  private generateState(): string {
    return crypto.randomBytes(16).toString('hex');
  }

  // Main method: runs the complete PKCE flow.
  async login(): Promise<OAuthTokens> {
    const codeVerifier = this.generateCodeVerifier();
    const codeChallenge = this.generateCodeChallenge(codeVerifier);
    const state = this.generateState();

    // Build authorization URL.
    const authUrl = new URL(this.config.authorizationEndpoint);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', this.config.clientId);
    authUrl.searchParams.set('redirect_uri', this.config.redirectUri);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    authUrl.searchParams.set('code_challenge', codeChallenge);
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('scope', 'openid profile email offline_access');

    const fullAuthUrl = authUrl.toString();

    // Always show the URL.
    console.log();
    console.log('  Open this link in your browser:');
    console.log();
    console.log(`  \x1b[4m\x1b[36m${fullAuthUrl}\x1b[0m`);
    console.log();

    // Try to open the browser (may not work in WSL).
    this.tryOpenBrowser(fullAuthUrl);

    // Race: localhost callback vs. manual URL paste.
    const authCode = await this.waitForAuth(fullAuthUrl, state);

    // Token Exchange
    const tokens = await this.exchangeCode(authCode, codeVerifier);
    return tokens;
  }

  // Tries both callback server and manual URL paste at the same time.
  private async waitForAuth(authUrl: string, expectedState: string): Promise<string> {
    return new Promise((resolve, reject) => {
      let resolved = false;

      // --- Method 1: local callback server ---
      const server = http.createServer((req, res) => {
        if (resolved) return;
        const url = new URL(req.url || '', `http://localhost:${this.config.callbackPort}`);
        
        if (url.pathname === '/auth/callback') {
          const code = url.searchParams.get('code');
          const returnedState = url.searchParams.get('state');
          const error = url.searchParams.get('error');

          if (error) {
            res.writeHead(400, { 'Content-Type': 'text/html' });
            res.end('<html><body><h1>Authentication Failed</h1></body></html>');
            if (!resolved) { resolved = true; cleanup(); reject(new Error(`OAuth error: ${error}`)); }
            return;
          }

          if (returnedState !== expectedState) {
            res.writeHead(400, { 'Content-Type': 'text/html' });
            res.end('<html><body><h1>State Mismatch</h1></body></html>');
            return; // Don't reject, user can try paste
          }

          if (code) {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(`<html><body style="font-family: sans-serif; text-align: center; padding: 60px;">
              <h1>✅ Login successful!</h1>
              <p>You can close this window.</p>
            </body></html>`);
            if (!resolved) { resolved = true; cleanup(); resolve(code); }
          }
        }
      });

      server.on('error', () => {
        // Port is occupied — not a problem; the user can paste the URL.
      });

      server.listen(this.config.callbackPort, '127.0.0.1', () => {
        // Server is running.
      });
      // Don't let the callback server keep the process alive on its own — the
      // command flow controls the lifetime; cleanup() closes it explicitly.
      server.unref();

      // --- Method 2: manual URL paste ---
      console.log('  You will be redirected after login.');
      console.log('  If the redirect does not work automatically:');
      console.log('  → Copy the complete URL from the browser address bar');
      console.log('  → Paste it here and press Enter:');
      console.log();

      const rl = createInterface({ input: process.stdin, output: process.stdout });

      rl.on('line', (line: string) => {
        if (resolved) return;
        const trimmed = line.trim();
        if (!trimmed) return;

        try {
          const callbackUrl = new URL(trimmed);
          const code = callbackUrl.searchParams.get('code');
          const returnedState = callbackUrl.searchParams.get('state');

          if (!code) {
            console.log('  ⚠ No code found in the URL. Please paste the complete redirect URL.');
            return;
          }

          if (returnedState && returnedState !== expectedState) {
            console.log('  ⚠ State does not match. Please try again.');
            return;
          }

          resolved = true;
          cleanup();
          resolve(code);
        } catch {
          console.log('  ⚠ Invalid URL. Please paste the complete URL from the browser.');
        }
      });

      // Cleanup helper
      const cleanup = () => {
        try { rl.close(); } catch { /* ignore */ }
        try { server.close(); } catch { /* ignore */ }
        clearTimeout(timeout);
      };

      // Timeout
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          cleanup();
          reject(new Error('OAuth login timed out (5 min). Please try again.'));
        }
      }, 300000); // 5 minutes
    });
  }

  private tryOpenBrowser(url: string): void {
    try {
      // WSL: try the Windows browser.
      exec(`/mnt/c/Windows/System32/cmd.exe /c start "" "${url}"`, (err) => {
        if (err) {
          // Fallback: Linux
          exec(`xdg-open "${url}"`, () => { /* ignore */ });
        }
      });
    } catch {
      // No browser available — the user can use the printed link.
    }
  }

  // Exchange auth_code for access_token.
  private async exchangeCode(code: string, codeVerifier: string): Promise<OAuthTokens> {
    const res = await fetch(this.config.tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        client_id: this.config.clientId,
        code,
        redirect_uri: this.config.redirectUri,
        code_verifier: codeVerifier
      })
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Token exchange failed: ${res.status} - ${text}`);
    }

    const data = await res.json() as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
      token_type: string;
    };

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: new Date(Date.now() + data.expires_in * 1000).toISOString(),
      tokenType: data.token_type
    };
  }

  // Token refresh (when refresh_token exists).
  async refreshToken(refreshToken: string): Promise<OAuthTokens> {
    const res = await fetch(this.config.tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        client_id: this.config.clientId,
        refresh_token: refreshToken
      })
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Token refresh failed: ${res.status} - ${text}`);
    }

    const data = await res.json() as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
      token_type: string;
    };

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || refreshToken,
      expiresAt: new Date(Date.now() + data.expires_in * 1000).toISOString(),
      tokenType: data.token_type
    };
  }
}
