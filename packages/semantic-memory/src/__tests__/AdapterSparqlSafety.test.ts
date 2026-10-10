import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import oxigraph from 'oxigraph';
import type { Triple } from '@ontofelia/core';
import { OxigraphAdapter } from '../adapters/OxigraphAdapter.js';
import { FusekiAdapter } from '../adapters/FusekiAdapter.js';
import { KnowledgeEngine } from '../KnowledgeEngine.js';

const PWN = 'urn:pwn';
const G = 'urn:g';

const IRI_PAYLOAD =
  'urn:a> . } } ; INSERT DATA { GRAPH <urn:pwn> { <urn:pwn:a> <urn:pwn:b> <urn:pwn:c> } } ' +
  '; INSERT DATA { GRAPH <urn:g> { <urn:s> <urn:p> <urn:x';
const LITERAL_PAYLOAD =
  'x\\" . } } ; INSERT DATA { GRAPH <urn:pwn> { <urn:pwn:a> <urn:pwn:b> <urn:pwn:c> } } ' +
  '; INSERT DATA { GRAPH <urn:g> { <urn:s> <urn:p> <urn:x> } } #';

async function makeStore(): Promise<OxigraphAdapter> {
  const store = new OxigraphAdapter();
  await store.initialize({
    backend: 'oxigraph',
    type: 'embedded',
    dataDir: mkdtempSync(join(tmpdir(), 'adapter-safety-')),
    port: 0,
    endpoint: '',
  });
  return store;
}

async function count(store: OxigraphAdapter, graph: string): Promise<number> {
  const res = await store.query(`SELECT ?s ?p ?o WHERE { GRAPH <${graph}> { ?s ?p ?o } }`);
  return res.bindings?.length ?? 0;
}

async function totalQuads(store: OxigraphAdapter): Promise<number> {
  const res = await store.query('SELECT ?g ?s ?p ?o WHERE { GRAPH ?g { ?s ?p ?o } }');
  return res.bindings?.length ?? 0;
}

describe('OxigraphAdapter SPARQL safety', () => {
  let store: OxigraphAdapter;
  beforeEach(async () => { store = await makeStore(); });

  it('rejects an IRI-shaped object payload and injects nothing', async () => {
    const t: Triple = { subject: 'urn:s', predicate: 'urn:p', object: IRI_PAYLOAD };
    await expect(store.insertTriples(G, [t])).rejects.toThrow(/Invalid IRI/);
    expect(await count(store, PWN)).toBe(0);
    expect(await totalQuads(store)).toBe(0);
  });

  it('rejects a {type:uri} object payload', async () => {
    const t: Triple = { subject: 'urn:s', predicate: 'urn:p', object: { type: 'uri', value: IRI_PAYLOAD } };
    await expect(store.insertTriples(G, [t])).rejects.toThrow(/Invalid IRI/);
    expect(await count(store, PWN)).toBe(0);
  });

  it('rejects hostile subject, predicate and graph', async () => {
    const bad = 'urn:x> <urn:y> <urn:z> } } ; CLEAR ALL ; INSERT DATA { GRAPH <urn:pwn> { <urn:a';
    await expect(store.insertTriples(G, [{ subject: bad, predicate: 'urn:p', object: 'v' }])).rejects.toThrow(/Invalid IRI/);
    await expect(store.insertTriples(G, [{ subject: 'urn:s', predicate: bad, object: 'v' }])).rejects.toThrow(/Invalid IRI/);
    await expect(store.insertTriples(bad, [{ subject: 'urn:s', predicate: 'urn:p', object: 'v' }])).rejects.toThrow(/Invalid IRI/);
    await expect(store.deleteGraph(bad)).rejects.toThrow(/Invalid IRI/);
    await expect(store.getGraph(bad)).rejects.toThrow(/Invalid IRI/);
    expect(await totalQuads(store)).toBe(0);
  });

  it('rejects a bad language tag and a bad blank node label', async () => {
    await expect(store.insertTriples(G, [
      { subject: 'urn:s', predicate: 'urn:p', object: { value: 'v', language: 'en" . } } ; CLEAR ALL ; #' } },
    ])).rejects.toThrow(/language tag/);
    await expect(store.insertTriples(G, [
      { subject: '_:b . } } ; CLEAR ALL ; #', predicate: 'urn:p', object: 'v' },
    ])).rejects.toThrow(/blank node/);
    expect(await totalQuads(store)).toBe(0);
  });

  it('stores a backslash+quote literal payload byte-exact and injects nothing', async () => {
    await store.insertTriples(G, [{ subject: 'urn:s', predicate: 'urn:p', object: LITERAL_PAYLOAD }]);
    expect(await count(store, PWN)).toBe(0);
    const res = await store.query(`SELECT ?o WHERE { GRAPH <${G}> { <urn:s> <urn:p> ?o } }`);
    expect(res.bindings).toHaveLength(1);
    expect(res.bindings![0].o.value).toBe(LITERAL_PAYLOAD);
  });

  it('accepts valid language-tagged literals and blank node subjects', async () => {
    await store.insertTriples(G, [
      { subject: '_:b1', predicate: 'urn:p', object: { value: 'hallo', language: 'de-CH' } },
    ]);
    const res = await store.query(`SELECT ?o WHERE { GRAPH <${G}> { ?s <urn:p> ?o } }`);
    expect(res.bindings![0].o.value).toBe('hallo');
    expect(res.bindings![0].o.language).toBe('de-ch');
  });

  it('deleteTriples with a hostile IRI throws and leaves the store unchanged', async () => {
    await store.insertTriples(G, [{ subject: 'urn:s', predicate: 'urn:p', object: 'keep' }]);
    const before = await store.exportDataset();
    const evil = 'urn:s> <urn:p> "keep" } } ; CLEAR ALL ; DELETE DATA { GRAPH <urn:g> { <urn:s';
    await expect(store.deleteTriples(G, [{ subject: evil, predicate: 'urn:p', object: 'keep' }])).rejects.toThrow(/Invalid IRI/);
    await expect(store.deleteTriples(G, [{ subject: 'urn:s', predicate: 'urn:p', object: IRI_PAYLOAD }])).rejects.toThrow(/Invalid IRI/);
    expect(await store.exportDataset()).toBe(before);
  });

  it('CONSTRUCT output with CR, TAB, quote and backslash parses back to the identical literal', async () => {
    const value = 'a\rb\tc"d\\e\nf';
    await store.insertTriples(G, [
      { subject: 'urn:s', predicate: 'urn:p', object: value },
      { subject: 'urn:s', predicate: 'urn:q', object: { value: 'x\ry', language: 'en' } },
    ]);
    const res = await store.query(`CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${G}> { ?s ?p ?o } }`);
    expect(res.type).toBe('graph');

    const second = new oxigraph.Store();
    second.load(res.graph!, { format: 'text/turtle' });
    const rows = second.query('SELECT ?p ?o WHERE { ?s ?p ?o }') as Map<string, oxigraph.Term>[];
    const byP = new Map(rows.map((r) => [r.get('p')!.value, r.get('o') as oxigraph.Literal]));
    expect(byP.size).toBe(2);
    expect(byP.get('urn:p')!.value).toBe(value);
    expect(byP.get('urn:q')!.value).toBe('x\ry');
    expect(byP.get('urn:q')!.language).toBe('en');
  });

  describe('through KnowledgeEngine.storeFact', () => {
    let errSpy: ReturnType<typeof vi.spyOn>;
    beforeEach(() => { errSpy = vi.spyOn(console, 'error').mockImplementation(() => {}); });
    afterEach(() => { errSpy.mockRestore(); });

    it('a literal object with CR does not make reasoning fail', async () => {
      const engine = new KnowledgeEngine(store);
      const r = await engine.storeFact(
        {
          subject: 'Anna', subjectType: 'Person', predicate: 'notes',
          object: 'line one\rline two', objectType: 'literal', sourceKind: 'user',
        },
        { agentId: 'ontofelia', userId: 'owner', sessionId: 's1', isOwner: true },
      );
      expect(r.success).toBe(true);
      const messages = errSpy.mock.calls.map((c) => String(c[0]));
      expect(messages.filter((m) => m.includes('Reasoning failed'))).toEqual([]);
    });
  });
});

describe('FusekiAdapter query building', () => {
  let adapter: FusekiAdapter;
  let fetchMock: ReturnType<typeof vi.fn>;
  const realFetch = globalThis.fetch;

  beforeEach(async () => {
    adapter = new FusekiAdapter();
    await adapter.initialize({
      backend: 'fuseki', type: 'external', dataDir: '', port: 3030, endpoint: 'http://127.0.0.1:3030/ds',
    } as never);
    fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => '', statusText: 'OK' });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });
  afterEach(() => { globalThis.fetch = realFetch; });

  it('throws on a hostile IRI object and sends nothing', async () => {
    await expect(adapter.insertTriples(G, [{ subject: 'urn:s', predicate: 'urn:p', object: IRI_PAYLOAD }]))
      .rejects.toThrow(/Invalid IRI/);
    await expect(adapter.insertTriples(G, [{ subject: 'urn:s', predicate: 'urn:p', object: { type: 'uri', value: IRI_PAYLOAD } }]))
      .rejects.toThrow(/Invalid IRI/);
    await expect(adapter.deleteTriples(G, [{ subject: IRI_PAYLOAD, predicate: 'urn:p', object: 'v' }]))
      .rejects.toThrow(/Invalid IRI/);
    await expect(adapter.insertTriples(IRI_PAYLOAD, [{ subject: 'urn:s', predicate: 'urn:p', object: 'v' }]))
      .rejects.toThrow(/Invalid IRI/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a bad language tag', async () => {
    await expect(adapter.insertTriples(G, [
      { subject: 'urn:s', predicate: 'urn:p', object: { value: 'v', language: 'en"x' } },
    ])).rejects.toThrow(/language tag/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('escapes literals and puts one statement per line', async () => {
    await adapter.insertTriples(G, [
      { subject: 'urn:s', predicate: 'urn:p', object: LITERAL_PAYLOAD },
      { subject: 'urn:s', predicate: 'urn:q', object: 'a\rb' },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = String((fetchMock.mock.calls[0][1] as { body: string }).body);
    // The whole payload must sit inside one properly escaped literal.
    expect(body).toContain('"x\\\\\\" . } } ; INSERT DATA { GRAPH <urn:pwn>');
    expect(body).toContain('"a\\rb"');
    expect(body).not.toContain('\r');
    expect(body.split('\n').filter((l) => l.includes('<urn:s> <urn:'))).toHaveLength(2);

    // The generated update is real SPARQL: executing it injects nothing.
    const check = new oxigraph.Store();
    check.update(body);
    const rows = check.query('SELECT ?s WHERE { GRAPH <urn:pwn> { ?s ?p ?o } }') as unknown[];
    expect(rows).toHaveLength(0);
    const all = check.query('SELECT ?o WHERE { GRAPH <urn:g> { ?s ?p ?o } }') as Map<string, oxigraph.Term>[];
    expect(all.map((r) => r.get('o')!.value).sort()).toEqual(['a\rb', LITERAL_PAYLOAD].sort());
  });
});
