import { ProviderConfig } from '@ontofelia/core';
import { OpenAICompatibleProvider } from './OpenAICompatibleProvider.js';

export class OpenRouterProvider extends OpenAICompatibleProvider {
  readonly name = 'openrouter';

  async initialize(config: ProviderConfig): Promise<void> {
    await super.initialize(config);
    this.baseUrl = config.baseUrl || 'https://openrouter.ai/api/v1';
  }

  protected getHeaders(): Record<string, string> {
    const apiKey = this.config.apiKey || process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      throw new Error('OpenRouter API key is missing. Set config.apiKey or OPENROUTER_API_KEY environment variable.');
    }
    
    return {
      'Authorization': `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://ontofelia.semantification.org',
      'X-Title': 'Ontofelia Agent',
      'Content-Type': 'application/json'
    };
  }
}
