import { describe, it, expect } from 'vitest';
import { ChannelRegistry } from '../registry/ChannelRegistry.js';

describe('channels package', () => {
  it('ChannelRegistry initializes', () => {
    const registry = new ChannelRegistry();
    expect(registry.list().length).toBe(0);
  });
});
