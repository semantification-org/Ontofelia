import { describe, it, expect } from 'vitest';
import { ok } from '../index.js';

describe('core', () => {
  it('should be true', () => {
    expect(ok(true).isOk()).toBe(true);
  });
});
