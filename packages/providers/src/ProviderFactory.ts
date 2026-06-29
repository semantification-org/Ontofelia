import { ProviderAdapter } from '@ontofelia/core';
import { MockProvider } from '@ontofelia/testkit';
import { OpenRouterProvider } from './OpenRouterProvider.js';
import { OpenAIProvider } from './OpenAIProvider.js';
import { OpenAICodexProvider } from './OpenAICodexProvider.js';

export class ProviderFactory {
  static create(providerName: string): ProviderAdapter {
    switch (providerName) {
      case 'openrouter':
        return new OpenRouterProvider();
      case 'openai':
        return new OpenAIProvider();
      case 'openai-codex':
        return new OpenAICodexProvider();
      case 'mock':
        return new MockProvider();
      default:
        throw new Error(`Unknown provider: ${providerName}`);
    }
  }
}
