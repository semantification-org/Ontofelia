import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SparqlResult, TriplestoreConfig } from '@ontofelia/core';
import { OxigraphAdapter } from '../adapters/OxigraphAdapter.js';
import { OxigraphDiskAdapter } from '../adapters/OxigraphDiskAdapter.js';
import { createOxigraphTestAdapter } from './helpers/oxigraphTestAdapter.js';
import { DiskQueryExecutor, InProcessQueryExecutor, QueryTimeoutError, createQueryExecutor } from '../adapters/QueryExecutor.js';

const diskRequested = process.env.ONTOFELIA_TEST_OXIGRAPH_STORE === 'disk';

let nativeAvailable = true;
try {
  createRequire(import.meta.url)('@ontofelia/disk-store');
} catch {
  nativeAvailable = false;
}

// Skip only when the binary is missing AND the disk run was not requested. A
// requested disk run with a missing binary must fail, so it is not skipped.
const skipDisk = !nativeAvailable && !diskRequested;
if (skipDisk) {
  console.log(
    '[OxigraphDiskAdapter] tests skipped: native on-disk store not available. ' +
      'Build it with ONTOFELIA_BUILD_DISK_STORE=1 pnpm --filter @ontofelia/disk-store build',
  );
}
const suite = skipDisk ? describe.skip : describe;

const G1 = 'urn:test:g1';
const G2 = 'urn:test:g2';
const XSD = 'http://www.w3.org/2001/XMLSchema#';

const DATA = `
<urn:s:a> <urn:p:name> "Alice" .
<urn:s:a> <urn:p:label> "Alice"@en .
<urn:s:a> <urn:p:label> "Alicia"@es .
<urn:s:a> <urn:p:age> "42"^^<${XSD}integer> .
<urn:s:a> <urn:p:when> "2026-10-24T10:00:00Z"^^<${XSD}dateTime> .
<urn:s:a> <urn:p:knows> <urn:s:b> .
<urn:s:a> <urn:p:note> "she said \\"hi\\"\\nline two\\ttab \\\\ back \\u00e9\\u00fc \\u4e16\\u754c \\U0001F600" .
<urn:s:b> <urn:p:name> "Bob" .
<urn:s:b> <urn:p:friend> _:x .
_:x <urn:p:name> "Blank" .
`;

function config(dataDir: string): TriplestoreConfig {
  return { backend: 'oxigraph', type: 'embedded', dataDir, port: 0, endpoint: '' };
}

/** Blank node labels are generated per store, so compare their shape, not the label. */
function maskBlankLabels(r: SparqlResult): SparqlResult {
  const copy = JSON.parse(JSON.stringify(r)) as SparqlResult;
  for (const row of copy.bindings ?? []) {
    for (const t of Object.values(row)) {
      if (t.type === 'bnode') t.value = '_';
    }
  }
  if (copy.graph) copy.graph = copy.graph.replace(/_:[A-Za-z0-9_.-]+/g, '_:b');
  return copy;
}

suite('OxigraphDiskAdapter', () => {
  let dirs: string[];
  let opened: Array<{ stop(): Promise<void> }>;

  const tmp = () => {
    const d = mkdtempSync(join(tmpdir(), 'oxigraph-disk-'));
    dirs.push(d);
    return d;
  };
  const openDisk = async (dir: string) => {
    const a = new OxigraphDiskAdapter();
    await a.initialize(config(dir));
    opened.push(a);
    return a;
  };
  const openFile = async () => {
    const a = new OxigraphAdapter();
    await a.initialize(config(tmp()));
    opened.push(a);
    return a;
  };

  beforeEach(() => {
    dirs = [];
    opened = [];
  });
  afterEach(async () => {
    for (const a of opened) await a.stop();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  describe('parity with OxigraphAdapter', () => {
    const loadBoth = async () => {
      const file = await openFile();
      const disk = await openDisk(tmp());
      for (const a of [file, disk]) {
        await a.putGraph(G1, DATA, 'ntriples');
        await a.putGraph(G2, '<urn:s:c> <urn:p:name> "Carol"@de .\n', 'ntriples');
      }
      return { file, disk };
    };

    const SELECT_ALL = 'SELECT ?g ?s ?p ?o WHERE { GRAPH ?g { ?s ?p ?o } }';

    it('returns the same SELECT bindings, keys in projection order', async () => {
      const { file, disk } = await loadBoth();
      const q = `SELECT ?s ?p ?o ?g WHERE { GRAPH ?g { ?s ?p ?o } FILTER(!isBlank(?s) && !isBlank(?o)) } ORDER BY ?g ?s ?p ?o`;
      const a = await file.query(q);
      const b = await disk.query(q);
      expect(b).toEqual(a);
      expect(a.bindings!.length).toBeGreaterThan(8);
      expect(b.variables).toEqual(a.variables);
    });

    it('keeps typed, language-tagged, quoted, multi-line and unicode literals identical', async () => {
      const { file, disk } = await loadBoth();
      const q = `SELECT ?o WHERE { GRAPH <${G1}> { <urn:s:a> ?p ?o } } ORDER BY ?p ?o`;
      const a = await file.query(q);
      const b = await disk.query(q);
      expect(b).toEqual(a);
      const values = b.bindings!.map(r => r.o.value);
      expect(values).toContain('she said "hi"\nline two\ttab \\ back éü 世界 😀');
      const age = b.bindings!.find(r => r.o.value === '42')!.o;
      expect(age.datatype).toBe(`${XSD}integer`);
      const es = b.bindings!.find(r => r.o.value === 'Alicia')!.o;
      expect(es.language).toBe('es');
    });

    it('returns the same bindings for a blank node (labels aside)', async () => {
      const { file, disk } = await loadBoth();
      const q = `SELECT ?s ?o WHERE { GRAPH <${G1}> { ?s <urn:p:name> ?o . FILTER(isBlank(?s)) } }`;
      const a = await file.query(q);
      const b = await disk.query(q);
      expect(a.bindings).toHaveLength(1);
      expect(b.bindings![0].s.type).toBe('bnode');
      expect(maskBlankLabels(b)).toEqual(maskBlankLabels(a));
    });

    it('omits unbound variables the same way', async () => {
      const { file, disk } = await loadBoth();
      const q = `SELECT ?s ?knows WHERE { GRAPH <${G1}> { ?s <urn:p:name> ?n . OPTIONAL { ?s <urn:p:knows> ?knows } FILTER(!isBlank(?s)) } } ORDER BY ?s`;
      const a = await file.query(q);
      const b = await disk.query(q);
      expect(b).toEqual(a);
      expect(b.bindings!.some(r => !('knows' in r))).toBe(true);
    });

    it('returns the same SELECT result with a namedGraph default graph', async () => {
      const { file, disk } = await loadBoth();
      const q = 'SELECT ?s ?p ?o WHERE { ?s ?p ?o } ORDER BY ?s ?p ?o';
      const a = await file.query(q, G2);
      const b = await disk.query(q, G2);
      expect(b).toEqual(a);
      expect(b.bindings).toHaveLength(1);
      expect(b.bindings![0].o).toEqual({ type: 'literal', value: 'Carol', language: 'de', datatype: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#langString' });
      // Without a namedGraph the default graph is empty on both.
      expect((await disk.query(q)).bindings).toEqual((await file.query(q)).bindings);
      expect((await disk.query(q)).bindings).toHaveLength(0);
    });

    it('returns the same ASK result', async () => {
      const { file, disk } = await loadBoth();
      for (const q of [
        `ASK { GRAPH <${G1}> { <urn:s:a> <urn:p:knows> <urn:s:b> } }`,
        `ASK { GRAPH <${G1}> { <urn:s:a> <urn:p:knows> <urn:s:zzz> } }`,
      ]) {
        expect(await disk.query(q)).toEqual(await file.query(q));
        expect(await disk.ask(q)).toBe(await file.ask(q));
      }
      expect(await disk.ask(`ASK { GRAPH <${G1}> { <urn:s:a> <urn:p:knows> <urn:s:b> } }`)).toBe(true);
    });

    it('returns the same CONSTRUCT graph', async () => {
      const { file, disk } = await loadBoth();
      const q = `CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${G1}> { ?s ?p ?o . FILTER(!isBlank(?s) && !isBlank(?o)) } }`;
      const a = await file.query(q);
      const b = await disk.query(q);
      expect(a.type).toBe('graph');
      const lines = (r: SparqlResult) => r.graph!.split('\n').filter(Boolean).sort();
      expect(lines(b)).toEqual(lines(a));
      expect(lines(b).length).toBeGreaterThan(7);
      // An empty CONSTRUCT converts the same way on both.
      const empty = `CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <urn:test:none> { ?s ?p ?o } }`;
      expect(await disk.query(empty)).toEqual(await file.query(empty));
    });

    it('returns the same getGraph text for a graph without blank nodes', async () => {
      const { file, disk } = await loadBoth();
      const lines = (s: string) => s.split('\n').filter(Boolean).sort();
      expect(lines(await disk.getGraph(G2))).toEqual(lines(await file.getGraph(G2)));
      expect(lines(await disk.getGraph(G2))).toEqual(['<urn:s:c> <urn:p:name> "Carol"@de .']);
      expect(await disk.getGraph('urn:test:missing')).toBe(await file.getGraph('urn:test:missing'));
      // The graph with blank nodes keeps the same number of lines.
      expect(lines(await disk.getGraph(G1))).toHaveLength(lines(await file.getGraph(G1)).length);
    });

    it('applies insertTriples, deleteTriples, deleteGraph and update alike', async () => {
      const { file, disk } = await loadBoth();
      for (const a of [file, disk]) {
        await a.insertTriples(G2, [
          { subject: 'urn:s:c', predicate: 'urn:p:says', object: 'quote " and\nnewline' },
          { subject: 'urn:s:c', predicate: 'urn:p:ref', object: { type: 'uri', value: 'urn:s:a' } },
        ]);
        await a.deleteTriples(G2, [{ subject: 'urn:s:c', predicate: 'urn:p:ref', object: { type: 'uri', value: 'urn:s:a' } }]);
        await a.update(`INSERT DATA { GRAPH <urn:test:g3> { <urn:s:d> <urn:p:x> "1" } }`);
        await a.deleteGraph('urn:test:g3');
      }
      const q = 'SELECT ?g ?s ?p ?o WHERE { GRAPH ?g { ?s ?p ?o } FILTER(!isBlank(?s) && !isBlank(?o)) } ORDER BY ?g ?s ?p ?o';
      expect(await disk.query(q)).toEqual(await file.query(q));
      expect((await disk.query(SELECT_ALL)).bindings!.some(r => r.g.value === 'urn:test:g3')).toBe(false);
    });

    it('wraps errors the same way', async () => {
      const { file, disk } = await loadBoth();
      await expect(disk.query('SELEKT nonsense')).rejects.toThrow(/^SPARQL Query failed in Oxigraph: /);
      await expect(file.query('SELEKT nonsense')).rejects.toThrow(/^SPARQL Query failed in Oxigraph: /);
      await expect(disk.update('INSERT nonsense')).rejects.toThrow(/^SPARQL Update failed in Oxigraph: /);
      await expect(disk.putGraph(G1, 'not turtle <<<', 'turtle')).rejects.toThrow(/^putGraph failed in Oxigraph: /);
    });
  });

  describe('persistence', () => {
    it('keeps the data after stop() and reopen on the same directory', async () => {
      const dir = tmp();
      const a = await openDisk(dir);
      await a.putGraph(G1, DATA, 'ntriples');
      await a.insertTriples(G2, [{ subject: 'urn:s:c', predicate: 'urn:p:name', object: 'Carol' }]);
      const before = await a.query(`SELECT ?s ?p ?o WHERE { GRAPH <${G1}> { ?s ?p ?o } FILTER(!isBlank(?s) && !isBlank(?o)) } ORDER BY ?s ?p ?o`);
      await a.stop();
      await a.stop(); // idempotent
      expect((await a.healthCheck()).healthy).toBe(false);

      const b = await openDisk(dir);
      const after = await b.query(`SELECT ?s ?p ?o WHERE { GRAPH <${G1}> { ?s ?p ?o } FILTER(!isBlank(?s) && !isBlank(?o)) } ORDER BY ?s ?p ?o`);
      expect(after).toEqual(before);
      expect(await b.ask(`ASK { GRAPH <${G2}> { <urn:s:c> <urn:p:name> "Carol" } }`)).toBe(true);
      expect(await b.healthCheck()).toMatchObject({ healthy: true, component: 'OxigraphDiskAdapter' });
    });

    it('does not read or write dataset.nq', async () => {
      const dir = tmp();
      writeFileSync(join(dir, 'dataset.nq'), '<urn:old:s> <urn:old:p> "old" <urn:old:g> .\n');
      const a = await openDisk(dir);
      expect(await a.ask('ASK { GRAPH ?g { ?s ?p ?o } }')).toBe(false);
      await a.insertTriples(G1, [{ subject: 'urn:s:a', predicate: 'urn:p:b', object: 'c' }]);
      expect(readFileSync(join(dir, 'dataset.nq'), 'utf-8')).toBe('<urn:old:s> <urn:old:p> "old" <urn:old:g> .\n');
    });

    it('reopens after stop() with start()', async () => {
      const a = await openDisk(tmp());
      await a.insertTriples(G1, [{ subject: 'urn:s:a', predicate: 'urn:p:b', object: 'c' }]);
      await a.stop();
      await a.start();
      expect(await a.ask(`ASK { GRAPH <${G1}> { <urn:s:a> <urn:p:b> "c" } }`)).toBe(true);
    });

    it('runs batch() with nesting and keeps writes made before a throw', async () => {
      const a = await openDisk(tmp());
      await a.batch(async () => {
        await a.insertTriples(G1, [{ subject: 'urn:s:a', predicate: 'urn:p:b', object: '1' }]);
        await a.batch(async () => {
          await a.insertTriples(G1, [{ subject: 'urn:s:a', predicate: 'urn:p:b', object: '2' }]);
        });
      });
      await expect(a.batch(async () => {
        await a.insertTriples(G1, [{ subject: 'urn:s:a', predicate: 'urn:p:b', object: '3' }]);
        throw new Error('boom');
      })).rejects.toThrow('boom');
      const res = await a.query(`SELECT ?o WHERE { GRAPH <${G1}> { ?s ?p ?o } } ORDER BY ?o`);
      expect(res.bindings!.map(r => r.o.value)).toEqual(['1', '2', '3']);
    });
  });

  describe('backup and restore', () => {
    it('round-trips through an N-Quads backup into a fresh store', async () => {
      const src = await openDisk(tmp());
      await src.putGraph(G1, DATA, 'ntriples');
      const target = tmp();
      const file = await src.backup(target);
      expect(file).toMatch(/oxigraph-backup-\d+\.nq$/);

      const dst = await openDisk(tmp());
      await dst.restore(file);
      const q = `SELECT ?g ?s ?p ?o WHERE { GRAPH ?g { ?s ?p ?o } FILTER(!isBlank(?s) && !isBlank(?o)) } ORDER BY ?g ?s ?p ?o`;
      expect(await dst.query(q)).toEqual(await src.query(q));
    });

    it('restore replaces existing data', async () => {
      const src = await openDisk(tmp());
      await src.insertTriples(G1, [{ subject: 'urn:s:keep', predicate: 'urn:p:b', object: 'c' }]);
      const file = await src.backup(tmp());

      const dst = await openDisk(tmp());
      await dst.insertTriples(G2, [{ subject: 'urn:s:gone', predicate: 'urn:p:b', object: 'c' }]);
      await dst.restore(file);
      expect(await dst.ask(`ASK { GRAPH <${G1}> { <urn:s:keep> ?p ?o } }`)).toBe(true);
      expect(await dst.ask(`ASK { GRAPH <${G2}> { <urn:s:gone> ?p ?o } }`)).toBe(false);
    });

    it('keeps the old data when the backup does not parse, and rejects a missing file', async () => {
      const a = await openDisk(tmp());
      await a.insertTriples(G1, [{ subject: 'urn:s:keep', predicate: 'urn:p:b', object: 'c' }]);
      const bad = join(tmp(), 'bad.nq');
      writeFileSync(bad, 'this is not n-quads\n');
      await expect(a.restore(bad)).rejects.toThrow();
      expect(await a.ask(`ASK { GRAPH <${G1}> { <urn:s:keep> ?p ?o } }`)).toBe(true);
      await expect(a.restore(join(tmp(), 'missing.nq'))).rejects.toThrow(/Backup file not found/);
    });

    it('restores a backup written by the file adapter', async () => {
      const file = await openFile();
      await file.putGraph(G1, DATA, 'ntriples');
      const backup = await file.backup(tmp());
      const disk = await openDisk(tmp());
      await disk.restore(backup);
      const q = `SELECT ?s ?p ?o WHERE { GRAPH <${G1}> { ?s ?p ?o } FILTER(!isBlank(?s) && !isBlank(?o)) } ORDER BY ?s ?p ?o`;
      expect(await disk.query(q)).toEqual(await file.query(q));
    });
  });

  describe('importFileDataset', () => {
    const NQ =
      `<urn:s:a> <urn:p:name> "Alice" <${G1}> .\n` +
      `<urn:s:a> <urn:p:label> "Alicia"@es <${G1}> .\n` +
      `<urn:s:b> <urn:p:name> "Bob" <${G2}> .\n` +
      `<urn:s:c> <urn:p:name> "Default" .\n`;
    const writeNq = (content: string) => {
      const f = join(tmp(), 'dataset.nq');
      writeFileSync(f, content);
      return f;
    };
    const count = async (a: OxigraphDiskAdapter, where: string) =>
      Number((await a.query(`SELECT (COUNT(*) AS ?n) WHERE { ${where} }`)).bindings![0].n.value);

    it('imports into an empty store and keeps the graphs', async () => {
      const a = await openDisk(tmp());
      const r = await a.importFileDataset(writeNq(NQ));
      expect(r).toEqual({ imported: true, quads: 4 });
      expect(await count(a, `GRAPH <${G1}> { ?s ?p ?o }`)).toBe(2);
      expect(await count(a, `GRAPH <${G2}> { ?s ?p ?o }`)).toBe(1);
      expect(await count(a, '?s ?p ?o')).toBe(1);
      expect(await a.ask(`ASK { GRAPH <${G1}> { <urn:s:a> <urn:p:label> "Alicia"@es } }`)).toBe(true);
      expect(await a.ask(`ASK { <urn:s:c> <urn:p:name> "Default" }`)).toBe(true);
    });

    it('does not import twice and does not duplicate', async () => {
      const a = await openDisk(tmp());
      const f = writeNq(NQ);
      await a.importFileDataset(f);
      const r = await a.importFileDataset(f);
      expect(r).toEqual({ imported: false, quads: 4, reason: 'store not empty' });
      expect(await count(a, 'GRAPH ?g { ?s ?p ?o }')).toBe(3);
    });

    it('does not import into a store that already holds data', async () => {
      const a = await openDisk(tmp());
      await a.putGraph(G2, '<urn:s:x> <urn:p:name> "X" .\n', 'ntriples');
      const r = await a.importFileDataset(writeNq(NQ));
      expect(r).toEqual({ imported: false, quads: 1, reason: 'store not empty' });
    });

    it('reports a missing file', async () => {
      const a = await openDisk(tmp());
      const r = await a.importFileDataset(join(tmp(), 'missing.nq'));
      expect(r).toEqual({ imported: false, quads: 0, reason: 'no file' });
    });

    it('reports a zero-byte file', async () => {
      const a = await openDisk(tmp());
      const r = await a.importFileDataset(writeNq(''));
      expect(r).toEqual({ imported: false, quads: 0, reason: 'empty file' });
    });

    it('throws naming the file for a malformed file and leaves the store empty', async () => {
      const a = await openDisk(tmp());
      const f = writeNq(`${NQ}this is not n-quads\n`);
      await expect(a.importFileDataset(f)).rejects.toThrow(f);
      expect(await count(a, 'GRAPH ?g { ?s ?p ?o }')).toBe(0);
      expect(await count(a, '?s ?p ?o')).toBe(0);
      expect(await a.exportDataset()).toBe('');
    });

    it('leaves the source file unchanged', async () => {
      const a = await openDisk(tmp());
      const f = writeNq(NQ);
      await a.importFileDataset(f);
      expect(readFileSync(f, 'utf-8')).toBe(NQ);
    });
  });

  describe('query deadline', () => {
    const DEADLINE_MS = 200;
    // Three chained transitive closures over a 300-link chain: over a minute of
    // work without cancellation, and it reads quads all the time, which is where
    // evaluation checks for cancellation.
    const RUNAWAY =
      `SELECT (COUNT(*) AS ?n) WHERE { GRAPH <${G1}> { ?a <urn:p:n>* ?b . ?b <urn:p:n>* ?c . ?c <urn:p:n>* ?d } }`;

    it('createQueryExecutor picks the DiskQueryExecutor for this adapter only', async () => {
      const disk = await openDisk(tmp());
      const executor = createQueryExecutor(disk);
      expect(executor).toBeInstanceOf(DiskQueryExecutor);
      expect(executor).not.toBeInstanceOf(InProcessQueryExecutor);
      await executor.close();
      await executor.close(); // safe to call more than once
    });

    it('cancels a runaway query with QueryTimeoutError and keeps serving', async () => {
      const a = await openDisk(tmp());
      await a.insertTriples(G1, Array.from({ length: 300 }, (_, i) => ({
        subject: `urn:s:${i}`, predicate: 'urn:p:n', object: `urn:s:${i + 1}`,
      })));
      const executor = createQueryExecutor(a);

      const started = Date.now();
      const failure = await executor.execute(RUNAWAY, DEADLINE_MS).then(() => undefined, (e: unknown) => e);
      const elapsed = Date.now() - started;
      expect(failure).toBeInstanceOf(QueryTimeoutError);
      expect((failure as QueryTimeoutError).deadlineMs).toBe(DEADLINE_MS);
      expect(elapsed).toBeLessThan(3000);

      const ok = await executor.execute(`SELECT ?o WHERE { GRAPH <${G1}> { <urn:s:7> <urn:p:n> ?o } }`, 5000);
      expect(ok.type).toBe('bindings');
      expect(ok.bindings).toHaveLength(1);
      expect(ok.bindings![0].o.value).toBe('urn:s:8');

      // writes still go through, and the adapter's own query() is unchanged
      await a.insertTriples(G1, [{ subject: 'urn:s:new', predicate: 'urn:p:n', object: 'urn:o:new' }]);
      expect(await a.ask(`ASK { GRAPH <${G1}> { <urn:s:new> <urn:p:n> <urn:o:new> } }`)).toBe(true);
    });

    it('answers at the deadline even when the native task only stops at its next read', async () => {
      const a = await openDisk(tmp());
      await a.insertTriples('urn:p:g', Array.from({ length: 300 }, (_, i) => ({
        subject: `urn:p:s${i}`, predicate: 'urn:p:next', object: `urn:p:s${i + 1}`,
      })));
      // Unconstrained cross product: the evaluation reads the next quad only
      // rarely, so the native cancellation alone answers seconds after the deadline.
      const CROSS =
        'SELECT (COUNT(*) AS ?c) WHERE { GRAPH <urn:p:g> { ?a ?b ?c . ?d ?e ?f . ?g ?h ?i . ?j ?k ?l } }';
      // Keep the native promise so the test can wait for its background task.
      const store = (a as unknown as { store: { queryAsync(...args: unknown[]): Promise<string> } }).store;
      const original = store.queryAsync.bind(store);
      const natives: Array<Promise<string>> = [];
      store.queryAsync = (...args: unknown[]) => {
        const p = original(...args);
        natives.push(p);
        return p;
      };
      const executor = createQueryExecutor(a);

      const started = Date.now();
      const failure = await executor.execute(CROSS, 300).then(() => undefined, (e: unknown) => e);
      const elapsed = Date.now() - started;
      expect(failure).toBeInstanceOf(QueryTimeoutError);
      expect(elapsed).toBeGreaterThanOrEqual(300);
      expect(elapsed).toBeLessThan(1500);

      // The native task finishes on its own thread later; wait for it so it does
      // not run into the next test, then check the store still answers.
      expect(natives).toHaveLength(1);
      await natives[0].then(() => undefined, () => undefined);
      const ok = await executor.execute(`SELECT ?o WHERE { GRAPH <urn:p:g> { <urn:p:s7> <urn:p:next> ?o } }`, 5000);
      expect(ok.bindings![0].o.value).toBe('urn:p:s8');
      // the wait for the background task takes several seconds, longer than the default timeout
    }, 30_000);

    it('wraps other failures like query() does', async () => {
      const a = await openDisk(tmp());
      const error = await a.queryWithDeadline('SELEKT nonsense', 1000).then(() => undefined, (e: unknown) => e);
      expect(error).not.toBeInstanceOf(QueryTimeoutError);
      expect((error as Error).message).toMatch(/^SPARQL Query failed in Oxigraph:/);
    });

    it('returns the same result as query() when the deadline is not hit', async () => {
      const a = await openDisk(tmp());
      await a.importDataset(DATA, 'ntriples', G1);
      for (const q of [
        `SELECT ?s ?p ?o WHERE { GRAPH <${G1}> { ?s ?p ?o } }`,
        `ASK { GRAPH <${G1}> { <urn:s:a> <urn:p:name> "Alice" } }`,
        `CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${G1}> { ?s ?p ?o } }`,
      ]) {
        expect(maskBlankLabels(await a.queryWithDeadline(q, 5000)), q).toEqual(maskBlankLabels(await a.query(q)));
      }
    });
  });

  describe('importDataset', () => {
    it('throws for a triple format without a graph', async () => {
      const a = await openDisk(tmp());
      await expect(a.importDataset('<urn:s> <urn:p> "o" .', 'ntriples')).rejects.toThrow(/carries no graph/);
      await expect(a.importDataset('@prefix : <urn:> . :s :p :o .', 'turtle')).rejects.toThrow(/carries no graph/);
      expect(await a.ask('ASK { GRAPH ?g { ?s ?p ?o } }')).toBe(false);
    });

    it('loads a triple format into the given graph and keeps TriG graphs', async () => {
      const a = await openDisk(tmp());
      await a.importDataset('<urn:s> <urn:p> "o" .', 'ntriples', G1);
      await a.importDataset(`<${G2}> { <urn:s2> <urn:p> "o2" . }`, 'trig');
      expect(await a.ask(`ASK { GRAPH <${G1}> { <urn:s> <urn:p> "o" } }`)).toBe(true);
      expect(await a.ask(`ASK { GRAPH <${G2}> { <urn:s2> <urn:p> "o2" } }`)).toBe(true);
      const exported = await a.exportDataset();
      expect(exported).toContain(`<urn:s> <urn:p> "o" <${G1}> .`);
    });
  });
});

describe('createOxigraphTestAdapter', () => {
  it.skipIf(!diskRequested)('returns an OxigraphDiskAdapter when ONTOFELIA_TEST_OXIGRAPH_STORE=disk', () => {
    expect(createOxigraphTestAdapter()).toBeInstanceOf(OxigraphDiskAdapter);
  });

  it.skipIf(diskRequested)('returns the file adapter by default', () => {
    expect(createOxigraphTestAdapter()).toBeInstanceOf(OxigraphAdapter);
  });
});
