import { describe, it, expect } from 'vitest';
import { security } from '../index.js';

describe('security', () => {
  it('should be true', () => {
    expect(security).toBe(true);
  });
});
