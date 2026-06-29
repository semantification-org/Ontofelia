import { ProviderConfig } from '@ontofelia/core';
import { OpenAICompatibleProvider } from './OpenAICompatibleProvider.js';
import { TokenStore } from './auth/TokenStore.js';
import { OAuthPKCE } from './auth/OAuthPKCE.js';

export class OpenAIProvider extends OpenAICompatibleProvider {
  readonly name = 'openai';
  private tokenStore = new TokenStore();
  private oauthPKCE = new OAuthPKCE();

  async initialize(config: ProviderConfig): Promise<void> {
    await super.initialize(config);
    this.baseUrl = config.baseUrl || 'https://api.openai.com/v1';
  }

  protected getHeaders(): Record<string, string> {
    const token = this.config.oauthToken || this.config.apiKey || process.env.OPENAI_API_KEY;
    if (!token) {
      throw new Error('OpenAI API key or OAuth token is missing. Run "ontofelia auth login" or set OPENAI_API_KEY.');
    }
    
    return {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    };
  }

  // Try to load the saved OAuth token automatically.
  async loadStoredToken(): Promise<string | null> {
    const tokens = await this.tokenStore.load();
    if (!tokens) return null;
    
    if (this.tokenStore.isExpired(tokens)) {
      // Try to refresh the token.
      if (tokens.refreshToken) {
        try {
          const refreshed = await this.oauthPKCE.refreshToken(tokens.refreshToken);
          await this.tokenStore.save(refreshed);
          return refreshed.accessToken;
        } catch {
          return null; // Refresh failed, user needs to re-login
        }
      }
      return null;
    }
    
    return tokens.accessToken;
  }
}
