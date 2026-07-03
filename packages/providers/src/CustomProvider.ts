import { ProviderConfig } from '@ontofelia/core';
import { OpenAICompatibleProvider } from './OpenAICompatibleProvider.js';

// Generic adapter for any OpenAI-compatible chat-completions API
// (LM Studio, vLLM, text-generation-webui, ...). Unlike the named
// providers there is no sensible default endpoint, so baseUrl is required.
export class CustomProvider extends OpenAICompatibleProvider {
  readonly name = 'custom';

  async initialize(config: ProviderConfig): Promise<void> {
    await super.initialize(config);
    if (!config.baseUrl) {
      throw new Error("Custom provider requires 'baseUrl' in the provider config (e.g. http://localhost:1234/v1).");
    }
    this.baseUrl = config.baseUrl;
  }

  protected getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    };
    const apiKey = this.config.apiKey;
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }
    return headers;
  }
}
