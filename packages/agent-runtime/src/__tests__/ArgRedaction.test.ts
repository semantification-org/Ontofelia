import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  defaultArgRedactionRules,
  hashArgValue,
  parseArgRedactionRules,
  redactToolArgs,
} from '../cognitive/ArgRedaction.js';

// An obviously fake key for the tests; the real one is generated per instance.
const KEY = Buffer.alloc(32, 7);
const mac = (s: string, key: Buffer = KEY) => createHmac('sha256', key).update(s).digest('hex');

// Obviously fake credentials; none of these is a real secret.
const SK = 'sk' + '-test-0000000000000000000000000000';
const HEX40 = '0123456789abcdef0123456789abcdef01234567';
const JWT = 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJ0ZXN0In0.fakesignature0000';
const BEARER = 'Authorization: Bearer test-token-0000000000';

describe('redactToolArgs', () => {
  const rules = defaultArgRedactionRules();

  it('keeps the brief keys-only and masks secret-shaped values by their keyed digest', () => {
    const r = redactToolArgs(
      { query: 'plain question', note: SK, blob: HEX40, tok: JWT, header: BEARER },
      rules,
      KEY,
    );
    expect(r.brief).toBe('query, note, blob, tok, header');
    const by = new Map(r.masked.map((m) => [m.path, m.digest]));
    expect(by.get('note')).toBe(mac(SK));
    expect(by.get('blob')).toBe(mac(HEX40));
    expect(by.get('tok')).toBe(mac(JWT));
    expect(by.get('header')).toBe(mac(BEARER));
    expect(by.has('query')).toBe(false);
    expect(JSON.stringify(r)).not.toContain(SK);
    expect(JSON.stringify(r)).not.toContain(HEX40);
    expect(JSON.stringify(r)).not.toContain(JWT);
    expect(JSON.stringify(r)).not.toContain('test-token-0000000000');
  });

  it('masks by key name at any depth, whatever the value looks like', () => {
    const r = redactToolArgs(
      {
        password: 'hunter2-not-real',
        headers: { Cookie: 'a=b', 'X-Api-Key': 'short', Accept: 'text/plain' },
        list: [{ authToken: 1234 }, { fine: 'ok' }],
        apiKeyValue: { nested: 'x' },
      },
      rules,
      KEY,
    );
    const paths = r.masked.map((m) => m.path).sort();
    expect(paths).toEqual(['apiKeyValue', 'headers.Cookie', 'headers.X-Api-Key', 'list[0].authToken', 'password'].sort());
    expect(r.masked.find((m) => m.path === 'list[0].authToken')?.digest).toBe(mac('1234'));
    expect(r.masked.find((m) => m.path === 'apiKeyValue')?.digest).toBe(mac(JSON.stringify({ nested: 'x' })));
  });

  it('equal values hash equal, different values differ', () => {
    const a = redactToolArgs({ token: 'same' }, rules, KEY).masked[0].digest;
    const b = redactToolArgs({ token: 'same' }, rules, KEY).masked[0].digest;
    const c = redactToolArgs({ token: 'other' }, rules, KEY).masked[0].digest;
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(hashArgValue('same', KEY)).toBe(a);
    expect(redactToolArgs({ token: 'same' }, rules, KEY).masked[0].scheme).toBe('hmac-sha256');
  });

  it('does not mask ordinary values and never lists a secret-shaped key', () => {
    const r = redactToolArgs({ path: '/tmp/a.txt', count: 3, flag: true, [SK]: 'x' }, rules);
    expect(r.masked).toEqual([]);
    expect(r.brief).not.toContain(SK);
    expect(r.brief.split(', ')[0]).toBe('path');
  });

  it('bounds the number of masked entries and a deep structure still gets judged', () => {
    const many = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`token${i}`, `v${i}`]));
    expect(redactToolArgs(many, rules).masked.length).toBeLessThanOrEqual(20);
    const deep = { a: { b: { c: { d: { e: SK } } } } };
    const r = redactToolArgs(deep, rules);
    expect(r.masked).toHaveLength(1);
    expect(JSON.stringify(r)).not.toContain(SK);
  });

  it('returns an empty result for non-object args', () => {
    expect(redactToolArgs(undefined, rules)).toEqual({ brief: '', masked: [] });
    expect(redactToolArgs([1, 2], rules)).toEqual({ brief: '', masked: [] });
  });
});

describe('parseArgRedactionRules', () => {
  it('adds configured patterns to the defaults and never removes a default', () => {
    const rules = parseArgRedactionRules(JSON.stringify({ keyPatterns: ['^pin$'], valuePatterns: ['^\\d{16}$'] }));
    const r = redactToolArgs({ pin: 1, card: '1234567812345678', token: 'x', free: 'y' }, rules);
    expect(r.masked.map((m) => m.path).sort()).toEqual(['card', 'pin', 'token']);
  });

  it('ignores invalid, oversized and backtracking-shaped patterns, and broken JSON', () => {
    const bad = parseArgRedactionRules(
      JSON.stringify({ keyPatterns: ['(', '(a+)+$', 'x'.repeat(500), 42], valuePatterns: 'nope' }),
    );
    expect(bad.keyPatterns).toHaveLength(defaultArgRedactionRules().keyPatterns.length);
    expect(parseArgRedactionRules('{not json').keyPatterns).toHaveLength(defaultArgRedactionRules().keyPatterns.length);
    expect(parseArgRedactionRules(undefined).valuePatterns).toHaveLength(defaultArgRedactionRules().valuePatterns.length);
  });
});
