import { describe, it, expect } from 'vitest';
import { MockProvider } from '../index.js';

describe('testkit', () => {
  it('MockProvider initializes', async () => {
    const provider = new MockProvider();
    expect(provider.name).toBe('mock');
  });
});
