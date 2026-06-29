import { describe, it, expect } from 'vitest';
import { PluginRegistry } from '../index.js';

describe('plugins', () => {
  it('should initialize registry', () => {
    const registry = new PluginRegistry();
    expect(registry).toBeDefined();
  });
});
