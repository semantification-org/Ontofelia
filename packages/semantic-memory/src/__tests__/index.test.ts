import { describe, it, expect } from 'vitest';
import { InMemoryAdapter } from '../index.js';

describe('InMemoryAdapter', () => {
  it('should initialize and return health', async () => {
    const adapter = new InMemoryAdapter();
    await adapter.initialize({ backend: 'memory', type: 'embedded', dataDir: '', port: 0, endpoint: '' });
    const health = await adapter.healthCheck();
    expect(health.healthy).toBe(true);
  });
});
