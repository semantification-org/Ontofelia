import { describe, it, expect } from 'vitest';
import { SkillRegistry } from '../index.js';

describe('skills', () => {
  it('should initialize registry', () => {
    const registry = new SkillRegistry();
    expect(registry).toBeDefined();
  });
});
