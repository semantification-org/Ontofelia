import { describe, it, expect } from 'vitest';
import { ProviderFactory } from '../ProviderFactory.js';

describe('ProviderFactory', () => {
  it('should instantiate MockProvider', () => {
    const provider = ProviderFactory.create('mock');
    expect(provider.name).toBe('mock');
  });
});
