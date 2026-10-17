import JSON5 from 'json5';

/**
 * Minimal, dependency-free JSON5 text locator used to change a single value
 * in a hand-maintained config file without touching anything else (comments,
 * quoting style, indentation, trailing commas).
 */

interface Member {
  key: string;
  valueStart: number;
  valueEnd: number;
  keyStart: number;
  node: Node;
}

interface ObjectNode {
  kind: 'object';
  start: number; // index of '{'
  end: number; // index just after '}'
  members: Member[];
  /** Index of a trailing comma after the last member, or -1. */
  trailingComma: number;
}

interface OtherNode {
  kind: 'other';
  start: number;
  end: number;
}

type Node = ObjectNode | OtherNode;

class ScanError extends Error {}

type QuoteStyle = 'single' | 'double';

class Scanner {
  pos = 0;
  /** Number of string literals (keys included, comments excluded) per delimiter. */
  singleQuoted = 0;
  doubleQuoted = 0;
  constructor(readonly text: string) {}

  fail(msg: string): never {
    throw new ScanError(`Cannot scan JSON5 text at offset ${this.pos}: ${msg}`);
  }

  skipTrivia(): void {
    const t = this.text;
    for (;;) {
      const c = t[this.pos];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ' ' || c === '﻿' || c === ' ' || c === ' ' || c === '\v' || c === '\f') {
        this.pos++;
      } else if (c === '/' && t[this.pos + 1] === '/') {
        this.pos += 2;
        while (this.pos < t.length && t[this.pos] !== '\n' && t[this.pos] !== '\r' && t[this.pos] !== ' ' && t[this.pos] !== ' ') this.pos++;
      } else if (c === '/' && t[this.pos + 1] === '*') {
        const close = t.indexOf('*/', this.pos + 2);
        if (close < 0) this.fail('unterminated block comment');
        this.pos = close + 2;
      } else {
        return;
      }
    }
  }

  scanString(): void {
    const t = this.text;
    const quote = t[this.pos];
    if (quote === "'") this.singleQuoted++;
    else this.doubleQuoted++;
    this.pos++;
    for (;;) {
      if (this.pos >= t.length) this.fail('unterminated string');
      const c = t[this.pos];
      if (c === '\\') {
        this.pos += 2;
      } else if (c === quote) {
        this.pos++;
        return;
      } else if (c === '\n' || c === '\r') {
        this.fail('newline in string');
      } else {
        this.pos++;
      }
    }
  }

  scanKey(): string {
    const t = this.text;
    const c = t[this.pos];
    if (c === '"' || c === "'") {
      const s = this.pos;
      this.scanString();
      return JSON5.parse(t.slice(s, this.pos)) as string;
    }
    const m = /^[\p{L}\p{Nl}$_][\p{L}\p{Nl}\p{Mn}\p{Mc}\p{Nd}\p{Pc}$_‌‍]*/u.exec(t.slice(this.pos));
    if (!m) this.fail('expected object key');
    this.pos += m[0].length;
    return m[0];
  }

  scanValue(): Node {
    this.skipTrivia();
    const t = this.text;
    const start = this.pos;
    const c = t[this.pos];
    if (c === undefined) this.fail('unexpected end of input');
    if (c === '{') return this.scanObject();
    if (c === '[') {
      this.pos++;
      for (;;) {
        this.skipTrivia();
        if (t[this.pos] === ']') {
          this.pos++;
          break;
        }
        this.scanValue();
        this.skipTrivia();
        if (t[this.pos] === ',') this.pos++;
        else if (t[this.pos] !== ']') this.fail('expected , or ] in array');
      }
      return { kind: 'other', start, end: this.pos };
    }
    if (c === '"' || c === "'") {
      this.scanString();
      return { kind: 'other', start, end: this.pos };
    }
    while (this.pos < t.length && !/[\s,\]}/]/.test(t[this.pos])) this.pos++;
    if (this.pos === start) this.fail(`unexpected character ${JSON.stringify(c)}`);
    return { kind: 'other', start, end: this.pos };
  }

  scanObject(): ObjectNode {
    const t = this.text;
    const start = this.pos;
    this.pos++; // {
    const members: Member[] = [];
    let trailingComma = -1;
    for (;;) {
      this.skipTrivia();
      if (t[this.pos] === '}') {
        this.pos++;
        break;
      }
      const keyStart = this.pos;
      const key = this.scanKey();
      this.skipTrivia();
      if (t[this.pos] !== ':') this.fail('expected :');
      this.pos++;
      const node = this.scanValue();
      members.push({ key, keyStart, valueStart: node.start, valueEnd: node.end, node });
      this.skipTrivia();
      if (t[this.pos] === ',') {
        const commaPos = this.pos;
        this.pos++;
        this.skipTrivia();
        if (t[this.pos] === '}') trailingComma = commaPos;
      } else if (t[this.pos] !== '}') {
        this.fail('expected , or } in object');
      }
    }
    return { kind: 'object', start, end: this.pos, members, trailingComma };
  }
}

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function formatKey(key: string): string {
  return IDENT.test(key) ? key : JSON.stringify(key);
}

function lineIndent(text: string, pos: number): string {
  const lineStart = text.lastIndexOf('\n', pos - 1) + 1;
  return /^[ \t]*/.exec(text.slice(lineStart))![0];
}

function onlyIndentBefore(text: string, pos: number): boolean {
  const lineStart = text.lastIndexOf('\n', pos - 1) + 1;
  return /^[ \t]*$/.test(text.slice(lineStart, pos));
}

function quoteSingle(s: string): string {
  return (
    "'" +
    s.replace(/['\\\n\r\t\u2028\u2029\b\f\v\0]/g, (c) => {
      switch (c) {
        case "'": return "\\'";
        case '\\': return '\\\\';
        case '\n': return '\\n';
        case '\r': return '\\r';
        case '\t': return '\\t';
        case '\b': return '\\b';
        case '\f': return '\\f';
        case '\v': return '\\v';
        case '\0': return '\\u0000';
        default: return '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0');
      }
    }) +
    "'"
  );
}

/** Serialise like JSON.stringify, but with the chosen quote style for strings. */
function stringifyStyled(value: unknown, style: QuoteStyle): string {
  const json = JSON.stringify(value);
  if (json === undefined) throw new Error('Value is not JSON serialisable');
  if (style === 'double') return json;
  const walk = (v: unknown): string => {
    if (typeof v === 'string') return quoteSingle(v);
    if (v !== null && typeof v === 'object' && typeof (v as { toJSON?: unknown }).toJSON === 'function') {
      return walk(JSON.parse(JSON.stringify(v)));
    }
    if (Array.isArray(v)) return '[' + v.map((x) => (JSON.stringify(x) === undefined ? 'null' : walk(x))).join(',') + ']';
    if (v !== null && typeof v === 'object') {
      const parts: string[] = [];
      for (const [k, x] of Object.entries(v)) {
        if (JSON.stringify(x) === undefined) continue;
        parts.push(`${quoteSingle(k)}:${walk(x)}`);
      }
      return '{' + parts.join(',') + '}';
    }
    return JSON.stringify(v);
  };
  return walk(JSON.parse(json));
}

function dominantStyle(scanner: Scanner): QuoteStyle {
  return scanner.singleQuoted > scanner.doubleQuoted ? 'single' : 'double';
}

function buildLiteral(path: string[], value: unknown, style: QuoteStyle): string {
  let out = stringifyStyled(value, style);
  for (let i = path.length - 1; i >= 1; i--) {
    out = `{ ${formatKey(path[i])}: ${out} }`;
  }
  return out;
}

/** Skip same-line spaces and one trailing comment after `pos`; returns the new position. */
function skipTrailingComment(text: string, pos: number): number {
  let p = pos;
  while (text[p] === ' ' || text[p] === '\t') p++;
  if (text[p] === '/' && text[p + 1] === '/') {
    while (p < text.length && text[p] !== '\n' && text[p] !== '\r') p++;
    return p;
  }
  if (text[p] === '/' && text[p + 1] === '*') {
    const close = text.indexOf('*/', p + 2);
    if (close >= 0 && !/[\r\n]/.test(text.slice(p, close))) {
      let q = close + 2;
      while (text[q] === ' ' || text[q] === '\t') q++;
      if (q >= text.length || text[q] === '\n' || text[q] === '\r') return q;
    }
  }
  return pos;
}

/**
 * Set the value at `path` (object keys only) inside JSON5 `text` and return the
 * new text. Only the addressed value is replaced; a missing key (or missing
 * intermediate objects) is inserted at the deepest existing object.
 */
export function setJson5Value(text: string, path: string[], value: unknown): string {
  if (path.length === 0) throw new Error('Empty path');
  if (JSON.stringify(value) === undefined) throw new Error('Value is not JSON serialisable');

  const scanner = new Scanner(text);
  let root: Node;
  try {
    root = scanner.scanValue();
    scanner.skipTrivia();
    if (scanner.pos < text.length) scanner.fail('unexpected content after root value');
  } catch (e) {
    if (e instanceof ScanError) throw new Error(e.message);
    throw e;
  }
  if (root.kind !== 'object') throw new Error('Config root is not an object');

  let obj: ObjectNode = root;
  for (let i = 0; i < path.length; i++) {
    const key = path[i];
    let member: Member | undefined;
    for (const m of obj.members) if (m.key === key) member = m;
    if (!member) return insertMember(text, obj, path.slice(i), value, dominantStyle(scanner));
    if (i === path.length - 1) {
      const old = text[member.valueStart];
      const style: QuoteStyle = old === "'" ? 'single' : old === '"' ? 'double' : dominantStyle(scanner);
      const json = stringifyStyled(value, style);
      return text.slice(0, member.valueStart) + json + text.slice(member.valueEnd);
    }
    if (member.node.kind !== 'object') {
      throw new Error(`Path segment "${path.slice(0, i + 1).join('.')}" exists but is not an object`);
    }
    obj = member.node;
  }
  /* c8 ignore next */
  throw new Error('unreachable');
}

function insertMember(text: string, obj: ObjectNode, rest: string[], value: unknown, style: QuoteStyle): string {
  const member = `${formatKey(rest[0])}: ${buildLiteral(rest, value, style)}`;
  const closePos = obj.end - 1;
  const parentIndent = lineIndent(text, obj.start);

  if (obj.members.length === 0) {
    const inner = text.slice(obj.start + 1, closePos);
    const indent = parentIndent + '  ';
    if (/^\s*$/.test(inner)) {
      return text.slice(0, obj.start + 1) + `\n${indent}${member}\n${parentIndent}` + text.slice(closePos);
    }
    return text.slice(0, obj.start + 1) + `\n${indent}${member}` + text.slice(obj.start + 1);
  }

  const last = obj.members[obj.members.length - 1];
  const indent = onlyIndentBefore(text, last.keyStart) ? lineIndent(text, last.keyStart) : parentIndent + '  ';
  const hasTrailing = obj.trailingComma >= 0;
  const afterLast = hasTrailing ? obj.trailingComma + 1 : last.valueEnd;
  const insertAt = skipTrailingComment(text, afterLast);
  const newLine = `\n${indent}${member}${hasTrailing ? ',' : ''}`;
  if (hasTrailing) {
    return text.slice(0, insertAt) + newLine + text.slice(insertAt);
  }
  // Add the missing comma directly after the previous last member.
  return text.slice(0, last.valueEnd) + ',' + text.slice(last.valueEnd, insertAt) + newLine + text.slice(insertAt);
}
