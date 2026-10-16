import { describe, it, expect } from 'vitest';
import { compareIso, compareIsoDesc } from '../time.js';

describe('compareIso', () => {
  it('orders by instant where the strings sort the other way', () => {
    expect('2026-10-15T19:51:41.4Z' > '2026-10-15T19:51:41.431Z').toBe(true); // the trap
    expect(compareIso('2026-10-15T19:51:41.4Z', '2026-10-15T19:51:41.431Z')).toBe(-1);
    expect(compareIsoDesc('2026-10-15T19:51:41.4Z', '2026-10-15T19:51:41.431Z')).toBe(1);
  });
  it('treats trimmed and padded fractions as equal', () => {
    expect(compareIso('2026-10-15T19:51:41.4Z', '2026-10-15T19:51:41.400Z')).toBe(0);
  });
  it('sorts an unparseable value first and stays total', () => {
    expect(compareIso('garbage', '2026-10-15T19:51:41Z')).toBe(-1);
    expect(compareIso('2026-10-15T19:51:41Z', 'garbage')).toBe(1);
    expect(compareIso('a', 'b')).toBe(-1);
  });
});
