import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TriplestoreAdapter } from '@ontofelia/core';
import { OxigraphAdapter } from '../adapters/OxigraphAdapter.js';
import { KnowledgeEngine } from '../KnowledgeEngine.js';
import { sparqlIri, sparqlStringLiteral } from '../utils/SparqlSyntax.js';

const ONT = 'urn:shared:ontology#';
const PWN_GRAPH = 'urn:pwn';
const PAYLOAD =
  'x" . } } ; INSERT DATA { GRAPH <urn:pwn> { <urn:pwn:a> <urn:pwn:b> <urn:pwn:c> . #';

async function makeStore(): Promise<TriplestoreAdapter> {
  const store = new OxigraphAdapter();
  await store.initialize({
    backend: 'oxigraph',
    type: 'embedded',
    dataDir: mkdtempSync(join(tmpdir(), 'prov-esc-')),
    port: 0,
    endpoint: '',
  });
  return store;
}

describe('ClaimProvenanceService literal escaping', () => {
  let store: TriplestoreAdapter;
  let engine: KnowledgeEngine;
  const ctx = { agentId: 'ontofelia', userId: 'owner', sessionId: 's1', isOwner: true };

  beforeEach(async () => {
    store = await makeStore();
    engine = new KnowledgeEngine(store);
  });

  const fact = (extra: Record<string, unknown>) => ({
    subject: 'Anna', subjectType: 'Person', predicate: 'likes',
    object: 'Tea', objectType: 'Concept', sourceKind: 'user' as const,
    ...extra,
  });

  async function values(predicate: string): Promise<string[]> {
    const res = await store.query(
      `SELECT ?o WHERE { GRAPH ?g { ?s <${ONT}${predicate}> ?o } }`,
    );
    return (res.bindings ?? []).map((b) => b.o.value);
  }

  async function pwnTripleCount(): Promise<number> {
    const res = await store.query(
      `SELECT ?s ?p ?o WHERE { GRAPH <${PWN_GRAPH}> { ?s ?p ?o } }`,
    );
    return res.bindings?.length ?? 0;
  }

  it('round-trips quote, newline and backslash in sourceSpan', async () => {
    const span = 'Anna says "tea"\nand \\ more';
    const r = await engine.storeFact(fact({ sourceSpan: span }), ctx);
    expect(r.success).toBe(true);
    expect(await values('rawText')).toEqual([span]);
    expect(await values('sourceSpan')).toEqual([span]);
  });

  it('round-trips CR, tab and other text in sourceSpan', async () => {
    const span = 'a\r\nb\tc äö 😀';
    const r = await engine.storeFact(fact({ sourceSpan: span }), ctx);
    expect(r.success).toBe(true);
    expect(await values('rawText')).toEqual([span]);
    expect(await values('sourceSpan')).toEqual([span]);
  });

  it('stores a hostile sourceSpan as plain data', async () => {
    const r = await engine.storeFact(fact({ sourceSpan: PAYLOAD }), ctx);
    expect(r.success).toBe(true);
    expect(await pwnTripleCount()).toBe(0);
    expect(await values('rawText')).toEqual([PAYLOAD]);
    expect(await values('sourceSpan')).toEqual([PAYLOAD]);
  });

  it('keeps a hostile sessionId and channel inert', async () => {
    const r = await engine.storeFact(
      fact({ sourceSpan: 'plain', channel: PAYLOAD, sourceMessageId: PAYLOAD }),
      { ...ctx, sessionId: PAYLOAD },
    );
    expect(r.success).toBe(true);
    expect(await pwnTripleCount()).toBe(0);
    expect(await values('channel')).toEqual([PAYLOAD]);
    expect((await values('sessionId')).every((v) => v === PAYLOAD)).toBe(true);
    // the store is still usable afterwards
    const again = await engine.storeFact(fact({ sourceSpan: 'later' }), ctx);
    expect(again.success).toBe(true);
  });

  it('keeps a hostile ingestionRunId and confidence inert', async () => {
    const r = await engine.storeFact(
      fact({ sourceSpan: 'x', confidenceNumeric: PAYLOAD as unknown as number }),
      { ...ctx, ingestionRunId: PAYLOAD },
    );
    expect(r.success).toBe(true);
    expect(await pwnTripleCount()).toBe(0);
    expect(await values('ingestionRunId')).toEqual([PAYLOAD]);
  });
});

describe('sparqlStringLiteral', () => {
  it('quotes and applies the ECHAR escapes', () => {
    expect(sparqlStringLiteral('plain')).toBe('"plain"');
    expect(sparqlStringLiteral('a"b')).toBe('"a\\"b"');
    expect(sparqlStringLiteral('a\\b')).toBe('"a\\\\b"');
    expect(sparqlStringLiteral('a\nb\rc\td\be\ff')).toBe('"a\\nb\\rc\\td\\be\\ff"');
  });

  it('escapes the backslash before the quote', () => {
    expect(sparqlStringLiteral('\\"')).toBe('"\\\\\\""');
  });

  it('replaces other C0 controls and lone surrogates with U+FFFD', () => {
    expect(sparqlStringLiteral('a\u0000b\u001fc')).toBe('"a�b�c"');
    expect(sparqlStringLiteral('a\ud800b')).toBe('"a�b"');
    expect(sparqlStringLiteral('a\udc00b')).toBe('"a�b"');
  });

  it('keeps valid non-ASCII text and surrogate pairs', () => {
    expect(sparqlStringLiteral('ä 😀 \u007f')).toBe('"ä 😀 \u007f"');
  });

  it('leaves no raw quote, backslash or line break unescaped', () => {
    const lit = sparqlStringLiteral(PAYLOAD + '\n\r');
    const inner = lit.slice(1, -1);
    expect(inner).not.toMatch(/(^|[^\\])(\\\\)*"/);
    expect(inner).not.toMatch(/[\n\r]/);
  });
});

describe('sparqlIri', () => {
  it('wraps a valid IRI', () => {
    expect(sparqlIri('urn:ontofelia:entity:Alice_Smith')).toBe('<urn:ontofelia:entity:Alice_Smith>');
    expect(sparqlIri('http://example.com/a?b=c#d')).toBe('<http://example.com/a?b=c#d>');
  });

  it.each(['<', '>', '"', '{', '}', '|', '^', '`', '\\', ' ', '\n', '\t', '\u0000', '\u007f'])(
    'rejects an IRI containing %j',
    (ch) => {
      expect(() => sparqlIri(`urn:x${ch}y`)).toThrow(/Invalid IRI/);
    },
  );

  it('rejects an empty IRI and an injection attempt', () => {
    expect(() => sparqlIri('')).toThrow(/Invalid IRI/);
    expect(() => sparqlIri('urn:a> } } ; DROP ALL ; <urn:b')).toThrow(/Invalid IRI/);
  });
});
