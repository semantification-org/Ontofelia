import { ProviderConfig } from '@ontofelia/core';
import { OpenAICompatibleProvider } from './OpenAICompatibleProvider.js';

export class OllamaProvider extends OpenAICompatibleProvider {
  readonly name = 'ollama';

  static readonly DEFAULT_BASE_URL = 'http://localhost:11434/v1';

  async initialize(config: ProviderConfig): Promise<void> {
    await super.initialize(config);
    this.baseUrl = config.baseUrl || OllamaProvider.DEFAULT_BASE_URL;
  }

  protected getHeaders(): Record<string, string> {
    // A local Ollama server needs no API key. If one is configured anyway
    // (e.g. Ollama behind an authenticating reverse proxy), send it.
    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    };
    if (this.config.apiKey) {
      headers['Authorization'] = `Bearer ${this.config.apiKey}`;
    }
    return headers;
  }
}
