/**
 * Argument redaction for procedural traces (doc 06 §2).
 *
 * A skill trace never stores an argument value. It stores the argument *keys*
 * (`toolArgsBrief`) and, for every argument the redaction rules mask, the
 * keyed digest of the masked value (HMAC-SHA256 under a per-instance key, see
 * ArgDigestKey.ts), so two calls can be compared for equality without the value
 * being kept. A plain hash of a weak value, e.g. a 4-digit PIN, can be guessed by
 * brute force; the key makes that impossible without the instance's key file. The
 * keys-only brief remains the main protection. Without a key no digest is made.
 *
 * Rules: a conservative built-in set that cannot be switched off, plus optional
 * additions from the setup graph (`cog:argRedactionRules` on the cognitive
 * config subject, one JSON literal):
 *
 *   {"keyPatterns": ["session", "^pin$"], "valuePatterns": ["^[0-9]{16}$"]}
 *
 * Built-in key rule: any key (at any depth) matching
 * `token|secret|passw|key|auth|cookie|credential`, case-insensitive; the whole
 * value under such a key is masked. Built-in value rules: anything
 * {@link looksLikeSecret} flags, a hex run of 32 or more characters, a long
 * base64-like run (40 or more), and a `Bearer`/`Basic` credential of 8 or more
 * characters. Configured patterns only add to these. A pattern that is invalid,
 * longer than 120 characters or shaped for catastrophic backtracking (a repeated
 * group) is ignored; at most 20 patterns per list are used.
 */

import { createHmac } from 'node:crypto';
import { looksLikeSecret } from './privacyClass.js';

export interface ArgRedactionRules {
  keyPatterns: RegExp[];
  valuePatterns: RegExp[];
}

/** The digest schemes of a masked argument; `sha256` is the unkeyed one of older records. */
export type ArgDigestScheme = 'hmac-sha256' | 'sha256';

export interface MaskedArg {
  /** Dotted path of the argument, sanitised (keys and `[index]` only). */
  path: string;
  /** Lower-case hex HMAC-SHA256 of the raw value (a string as is, else its JSON); absent without a key. */
  digest?: string;
  scheme?: ArgDigestScheme;
}

export interface RedactedArgs {
  /** Keys-only brief, never a value. */
  brief: string;
  masked: MaskedArg[];
}

const MAX_PATTERNS = 20;
const MAX_PATTERN_LENGTH = 120;
const MAX_DEPTH = 4;
const MAX_MASKED = 20;
const MAX_TESTED_CHARS = 4096;

const DEFAULT_KEY_PATTERNS: RegExp[] = [/token|secret|passw|key|auth|cookie|credential/i];
const DEFAULT_VALUE_PATTERNS: RegExp[] = [
  /\b[0-9a-f]{32,}\b/i,
  /[A-Za-z0-9+/_-]{40,}={0,2}/,
  /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/i,
];

/** The built-in rules (the result when nothing is configured or the config is broken). */
export function defaultArgRedactionRules(): ArgRedactionRules {
  return { keyPatterns: [...DEFAULT_KEY_PATTERNS], valuePatterns: [...DEFAULT_VALUE_PATTERNS] };
}

function compileSafe(src: unknown): RegExp | undefined {
  if (typeof src !== 'string' || src === '' || src.length > MAX_PATTERN_LENGTH) return undefined;
  // A repeated group is how catastrophic backtracking starts; refuse it.
  if (/\)\s*(?:[+*]|\{\d)/.test(src)) return undefined;
  try {
    return new RegExp(src, 'i');
  } catch {
    return undefined;
  }
}

/**
 * Parse the configured rules (the JSON literal from the setup graph) and merge
 * them with the built-ins. Never throws; anything unusable is ignored.
 */
export function parseArgRedactionRules(raw: string | undefined): ArgRedactionRules {
  const rules = defaultArgRedactionRules();
  if (!raw || raw.length > 8192) return rules;
  let cfg: unknown;
  try {
    cfg = JSON.parse(raw);
  } catch {
    return rules;
  }
  if (typeof cfg !== 'object' || cfg === null) return rules;
  const take = (list: unknown, into: RegExp[]) => {
    if (!Array.isArray(list)) return;
    for (const src of list.slice(0, MAX_PATTERNS)) {
      const re = compileSafe(src);
      if (re) into.push(re);
    }
  };
  take((cfg as Record<string, unknown>).keyPatterns, rules.keyPatterns);
  take((cfg as Record<string, unknown>).valuePatterns, rules.valuePatterns);
  return rules;
}

/** HMAC-SHA256 (hex) of a value under `key`: a string as is, anything else as JSON. */
export function hashArgValue(value: unknown, key: Buffer): string {
  const text = typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value));
  return createHmac('sha256', key).update(text).digest('hex');
}

function keyMatches(key: string, rules: ArgRedactionRules): boolean {
  const k = key.slice(0, 200);
  return rules.keyPatterns.some((re) => re.test(k));
}

function valueMatches(value: string, rules: ArgRedactionRules): boolean {
  const v = value.slice(0, MAX_TESTED_CHARS);
  return looksLikeSecret(v) || rules.valuePatterns.some((re) => re.test(v));
}

/** A key shown in a path or brief: never longer than 64, never secret-shaped. */
function safeKey(key: string): string {
  const k = key.slice(0, 64);
  if (looksLikeSecret(k) || /[0-9a-f]{32,}/i.test(k)) return '_';
  return k.replace(/[^A-Za-z0-9_-]/g, '_');
}

/**
 * Redact one tool call's arguments: a keys-only brief and the keyed digest of
 * every masked value (only the path when no `key` is given). Pure; reads
 * nothing; never returns a raw value.
 */
export function redactToolArgs(args: unknown, rules: ArgRedactionRules, key?: Buffer): RedactedArgs {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    return { brief: '', masked: [] };
  }
  const masked: MaskedArg[] = [];
  const mask = (path: string, value: unknown) => {
    if (masked.length >= MAX_MASKED) return;
    masked.push(key ? { path, digest: hashArgValue(value, key), scheme: 'hmac-sha256' } : { path });
  };
  const walk = (value: unknown, path: string, depth: number) => {
    if (typeof value === 'string') {
      if (valueMatches(value, rules)) mask(path, value);
      return;
    }
    if (typeof value !== 'object' || value === null) return; // number / boolean / null / undefined
    if (depth >= MAX_DEPTH) {
      // Too deep to inspect leaf by leaf: judge the whole serialisation.
      const text = (JSON.stringify(value) ?? '').slice(0, MAX_TESTED_CHARS);
      if (valueMatches(text, rules)) mask(path, value);
      return;
    }
    if (Array.isArray(value)) {
      value.slice(0, 50).forEach((item, i) => walk(item, `${path}[${i}]`, depth + 1));
      return;
    }
    for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, 50)) {
      const p = `${path}.${safeKey(k)}`;
      if (keyMatches(k, rules)) mask(p, v);
      else walk(v, p, depth + 1);
    }
  };
  const keys = Object.keys(args as Record<string, unknown>);
  for (const [k, v] of Object.entries(args as Record<string, unknown>).slice(0, 50)) {
    const p = safeKey(k);
    if (keyMatches(k, rules)) mask(p, v);
    else walk(v, p, 1);
  }
  return { brief: keys.map(safeKey).join(', ').slice(0, 400), masked };
}
