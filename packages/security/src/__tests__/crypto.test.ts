import { describe, it, expect } from 'vitest';
import { safeCompareSecret } from '../crypto.js';

describe('safeCompareSecret', () => {
  it('returns true for matching secrets', () => {
    expect(safeCompareSecret('mysecret', 'mysecret')).toBe(true);
  });

  it('returns false for mismatched secrets', () => {
    expect(safeCompareSecret('mysecret1', 'mysecret2')).toBe(false);
  });

  it('returns false for secrets of different lengths', () => {
    expect(safeCompareSecret('short', 'longersecret')).toBe(false);
    expect(safeCompareSecret('longersecret', 'short')).toBe(false);
  });

  it('handles null or undefined input safely', () => {
    expect(safeCompareSecret(null, 'secret')).toBe(false);
    expect(safeCompareSecret(undefined, 'secret')).toBe(false);
  });

  it('handles empty strings', () => {
    expect(safeCompareSecret('', '')).toBe(true);
    expect(safeCompareSecret('', 'secret')).toBe(false);
    expect(safeCompareSecret('secret', '')).toBe(false);
  });
});
