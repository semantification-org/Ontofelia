/**
 * Components that used to query the (empty) default graph must read named
 * graphs, and adapters must not silently drop data into the default graph.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { OxigraphAdapter } from '../adapters/OxigraphAdapter.js';
import { FusekiAdapter } from '../adapters/FusekiAdapter.js';
import { FusekiManager } from '../fuseki/FusekiManager.js';
import { ReflectionRunner } from '../reflection/ReflectionRunner.js';

const AGENT = 'ontofelia';
let store: OxigraphAdapter;

async function insert(graph: string, triples: string) {
  await store.update(`INSERT DATA { GRAPH <${graph}> { ${triples} } }`);
}

beforeEach(async () => {
  store = new OxigraphAdapter();
  await store.initialize({ backend: 'oxigraph', type: 'embedded',
    dataDir: mkdtempSync(join(tmpdir(), 'graphless-sm-')), port: 0, endpoint: '' } as never);
});

describe('ReflectionRunner triple count', () => {
  const runner = () => new ReflectionRunner(
    store as never,
    { detectConflicts: async () => [], storeConflicts: async () => {} } as never,
    {} as never,
  );

  it('counts the worldview graph and ignores user graphs', async () => {
    await insert(`urn:${AGENT}:worldview`, `<urn:t:w1> <urn:t:p> "1" . <urn:t:w2> <urn:t:p> "2" .`);
    await insert(`urn:${AGENT}:user:alice`, `<urn:t:a> <urn:t:p> "x" . <urn:t:b> <urn:t:p> "y" . <urn:t:c> <urn:t:p> "z" .`);
    const res = await runner().reflect(AGENT);
    expect(res.worldviewTriplesCount).toBe(2);
  });

  it('is zero for an empty worldview even when user graphs hold data', async () => {
    await insert(`urn:${AGENT}:user:alice`, `<urn:t:a> <urn:t:p> "x" .`);
    const res = await runner().reflect(AGENT);
    expect(res.worldviewTriplesCount).toBe(0);
  });
});

describe('FusekiManager config', () => {
  for (const reasoning of [true, false]) {
    it(`does not union named graphs into the default graph (reasoning=${reasoning})`, () => {
      const dir = mkdtempSync(join(tmpdir(), 'fuseki-cfg-'));
      const manager = new FusekiManager({
        dataDir: join(dir, 'tdb2'), port: 0, configPath: join(dir, 'cfg.ttl'),
        fusekiHome: dir, javaPath: 'java', dataset: 'ontofelia', reasoning,
      });
      const ttl = manager.generateConfig();
      expect(ttl).toContain('tdb2:unionDefaultGraph false');
      expect(ttl).not.toContain('unionDefaultGraph true');
      expect(readFileSync(join(dir, 'cfg.ttl'), 'utf-8')).toBe(ttl);
    });
  }
});

describe('OxigraphAdapter.query default graph parameter', () => {
  it('reads the given graph as the default graph and nothing else', async () => {
    await insert('urn:g:one', `<urn:t:s> <urn:t:p> "ONE" .`);
    await insert('urn:g:two', `<urn:t:s> <urn:t:p> "TWO" .`);
    const res = await store.query('SELECT ?o WHERE { ?s ?p ?o }', 'urn:g:one');
    expect(res.bindings?.map(b => b.o.value)).toEqual(['ONE']);
    const none = await store.query('SELECT ?o WHERE { ?s ?p ?o }');
    expect(none.bindings).toHaveLength(0);
  });
});

describe('importDataset target graph', () => {
  const TTL = '<urn:t:s> <urn:t:p> "V" .';

  it('Oxigraph loads a triple format into the given graph', async () => {
    await store.importDataset(TTL, 'turtle', 'urn:g:target');
    const res = await store.query('SELECT ?o WHERE { GRAPH <urn:g:target> { ?s ?p ?o } }');
    expect(res.bindings).toHaveLength(1);
  });

  it('Oxigraph refuses a triple format without a graph', async () => {
    await expect(store.importDataset(TTL, 'turtle')).rejects.toThrow(/graph/i);
    const all = await store.query('SELECT * WHERE { GRAPH ?g { ?s ?p ?o } }');
    expect(all.bindings).toHaveLength(0);
  });

  it('Oxigraph keeps the graphs of TriG', async () => {
    await store.importDataset(`<urn:g:trig> { ${TTL} }`, 'trig');
    const res = await store.query('SELECT ?o WHERE { GRAPH <urn:g:trig> { ?s ?p ?o } }');
    expect(res.bindings).toHaveLength(1);
  });

  describe('FusekiAdapter', () => {
    const originalFetch = global.fetch;
    afterEach(() => { global.fetch = originalFetch; vi.restoreAllMocks(); });
    const adapter = () => {
      const a = new FusekiAdapter();
      (a as unknown as { config: unknown }).config = { endpoint: 'http://127.0.0.1:1/ds' };
      return a;
    };

    it('posts a triple format to the named graph', async () => {
      const f = vi.fn().mockResolvedValue({ ok: true });
      global.fetch = f as never;
      await adapter().importDataset(TTL, 'turtle', 'urn:g:target');
      const [url, init] = f.mock.calls[0];
      expect(String(url)).toContain('graph=urn%3Ag%3Atarget');
      expect(init.method).toBe('POST');
    });

    it('refuses a triple format without a graph and sends nothing', async () => {
      const f = vi.fn();
      global.fetch = f as never;
      await expect(adapter().importDataset(TTL, 'turtle')).rejects.toThrow(/graph/i);
      expect(f).not.toHaveBeenCalled();
    });
  });
});
