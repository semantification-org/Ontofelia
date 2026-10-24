import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import oxigraph from 'oxigraph';
import type { Quad, Term } from 'oxigraph';
import type { DiskStore as DiskStoreType } from '../index.js';

const requireCjs = createRequire(import.meta.url);
const indexPath = resolve(import.meta.dirname, '..', 'index.js');

let DiskStore: typeof DiskStoreType | undefined;
let skipReason = '';
try {
  ({ DiskStore } = requireCjs(indexPath) as { DiskStore: typeof DiskStoreType });
} catch (e) {
  skipReason = (e as Error).message.split('\n')[0];
  console.log(
    `[disk-store] tests skipped: native binary not available (${skipReason}). ` +
      'Build it with ONTOFELIA_BUILD_DISK_STORE=1 pnpm --filter @ontofelia/disk-store build',
  );
}

const NQ = 'application/n-quads';
const NT = 'application/n-triples';
const G1 = 'urn:test:g1';
const G2 = 'urn:test:g2';
const G3 = 'urn:test:g3';
const XSD = 'http://www.w3.org/2001/XMLSchema#';

// ---------- dataset ----------

function lit(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
  return `"${escaped}"`;
}

/** 66 quads over 3 named graphs plus 3 default-graph quads, with awkward literals. */
function buildDataset(): string {
  const lines: string[] = [];
  const graphs = [G1, G2, G3];
  const awkward = [
    'He said "hello"',
    'back\\slash and \\n literal',
    'line one\nline two\r\nline three',
    'tab\there',
    'unicode: äöü 世界 \u{1F600}',
  ];
  graphs.forEach((g, gi) => {
    for (let i = 0; i < 8; i++) {
      const s = `<urn:test:s${gi}-${i}>`;
      lines.push(`${s} <urn:test:name> ${lit(`name ${gi}-${i}`)}@${i % 2 ? 'en' : 'de'} <${g}> .`);
      lines.push(`${s} <urn:test:age> "${20 + i}"^^<${XSD}integer> <${g}> .`);
    }
    awkward.slice(0, 3).forEach((v, k) => {
      lines.push(`<urn:test:w${gi}> <urn:test:text${k}> ${lit(v)} <${g}> .`);
    });
    lines.push(`<urn:test:s${gi}-0> <urn:test:alt> ${lit('alt only for first')} <${g}> .`);
    lines.push(`<urn:test:s${gi}-1> <urn:test:when> "2026-01-0${gi + 1}T10:00:00Z"^^<${XSD}dateTime> <${g}> .`);
    lines.push(`<urn:test:s${gi}-1> <urn:test:knows> <urn:test:s${gi}-2> <${g}> .`);
  });
  awkward.slice(3).forEach((v, k) => {
    lines.push(`<urn:test:d${k}> <urn:test:text> ${lit(v)} .`);
  });
  lines.push(`<urn:test:d0> <urn:test:name> ${lit('default graph')}@en .`);
  return lines.join('\n') + '\n';
}

function sortedLines(text: string): string[] {
  return text.split('\n').filter((l) => l.length > 0).sort();
}

// ---------- result normalisation ----------

interface JsonTerm {
  type: string;
  value: string;
  'xml:lang'?: string;
  datatype?: string;
}

function canonicalJsonTerm(t: JsonTerm): string {
  if (t.type === 'uri') return `<${t.value}>`;
  if (t.type === 'bnode') return `_:${t.value}`;
  const v = JSON.stringify(t.value);
  if (t['xml:lang']) return `${v}@${t['xml:lang'].toLowerCase()}`;
  if (t.datatype && t.datatype !== `${XSD}string`) return `${v}^^<${t.datatype}>`;
  return v;
}

function canonicalJsTerm(t: Term): string {
  if (t.termType === 'NamedNode') return `<${t.value}>`;
  if (t.termType === 'BlankNode') return `_:${t.value}`;
  if (t.termType === 'Literal') {
    const v = JSON.stringify(t.value);
    if (t.language) return `${v}@${t.language.toLowerCase()}`;
    if (t.datatype.value !== `${XSD}string`) return `${v}^^<${t.datatype.value}>`;
    return v;
  }
  throw new Error(`unexpected term type ${t.termType}`);
}

function nativeBindings(json: string): string[] {
  const parsed = JSON.parse(json) as { results: { bindings: Record<string, JsonTerm>[] } };
  return parsed.results.bindings
    .map((row) =>
      Object.keys(row)
        .sort()
        .map((k) => `${k}=${canonicalJsonTerm(row[k])}`)
        .join(' '),
    )
    .sort();
}

function jsBindings(rows: Map<string, Term>[]): string[] {
  return rows
    .map((row) =>
      [...row.keys()]
        .sort()
        .map((k) => `${k}=${canonicalJsTerm(row.get(k) as Term)}`)
        .join(' '),
    )
    .sort();
}

// ---------- fixtures ----------

const tmpDirs: string[] = [];
const openStores: DiskStoreType[] = [];

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'disk-store-test-'));
  tmpDirs.push(dir);
  return join(dir, 'store');
}

function track(store: DiskStoreType): DiskStoreType {
  openStores.push(store);
  return store;
}

describe.skipIf(!DiskStore)('DiskStore (native on-disk store)', () => {
  const Store = DiskStore as typeof DiskStoreType;
  const dataset = buildDataset();
  let path: string;

  beforeEach(() => {
    path = freshDir();
  });

  afterEach(() => {
    // Release the RocksDB lock before the directory is removed.
    for (const s of openStores.splice(0)) s.close();
    for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('has the expected dataset shape', () => {
    // 3 graphs x (16 + 3 + 3) + 3 default-graph quads = 69; the JS reference agrees below.
    expect(sortedLines(dataset).length).toBe(69);
  });

  it('loads n-quads into a named graph and round-trips through dump', () => {
    const store = track(Store.open(path));
    expect(store.len()).toBe(0);
    const g1Only = sortedLines(dataset).filter((l) => l.endsWith(`<${G1}> .`));
    expect(g1Only.length).toBe(22);
    store.load(g1Only.join('\n') + '\n', NQ);
    expect(store.len()).toBe(22);
    expect(sortedLines(store.dump(NQ))).toEqual(g1Only);

    // whole dataset, triples loaded into a named graph via toGraph
    store.load(`<urn:test:x> <urn:test:p> ${lit('a "q"\nb')} .\n`, NT, 'urn:test:extra');
    expect(store.len()).toBe(23);
    expect(store.dump(NQ)).toContain(`<urn:test:extra> .`);

    // full dataset round trip in a second store
    const second = track(Store.open(freshDir()));
    second.load(dataset, NQ);
    expect(second.len()).toBe(69);
    expect(sortedLines(second.dump(NQ))).toEqual(sortedLines(dataset));
  });

  it('accepts trig and turtle', () => {
    const store = track(Store.open(path));
    store.load(`<urn:test:a> <urn:test:p> "t" .`, 'text/turtle');
    store.load(`GRAPH <urn:test:tg> { <urn:test:a> <urn:test:p> "g" . }`, 'application/trig');
    store.load(`<urn:test:a> <urn:test:p> "n" .`, NT, 'urn:test:ng');
    expect(store.len()).toBe(3);
  });

  it('matches npm oxigraph on SELECT, ASK, CONSTRUCT and defaultGraph queries', () => {
    const disk = track(Store.open(path));
    disk.load(dataset, NQ);
    const wasm = new oxigraph.Store();
    wasm.load(dataset, { format: NQ });
    expect(disk.len()).toBe(wasm.dump({ format: NQ }).split('\n').filter(Boolean).length);

    const selects = [
      'SELECT ?g ?s ?p ?o WHERE { GRAPH ?g { ?s ?p ?o } }',
      'SELECT ?s ?name ?alt WHERE { GRAPH ?g { ?s <urn:test:name> ?name . OPTIONAL { ?s <urn:test:alt> ?alt } } }',
      'SELECT ?s ?o WHERE { GRAPH ?g { ?s <urn:test:age> ?o . FILTER(?o > 25) } }',
      'SELECT ?s ?n WHERE { GRAPH ?g { ?s <urn:test:name> ?n . FILTER(langMatches(lang(?n), "en")) } }',
      'SELECT ?s ?o WHERE { GRAPH ?g { ?s <urn:test:text0> ?o } }',
      'SELECT (COUNT(*) AS ?n) WHERE { GRAPH ?g { ?s ?p ?o } }',
      'SELECT ?s ?o WHERE { ?s ?p ?o }',
    ];
    for (const q of selects) {
      const native = nativeBindings(disk.query(q));
      expect(native.length, q).toBeGreaterThan(0);
      expect(native, q).toEqual(jsBindings(wasm.query(q) as Map<string, Term>[]));
    }

    // the awkward literals really came back byte-exact
    const texts = nativeBindings(disk.query('SELECT ?o WHERE { GRAPH <urn:test:g1> { <urn:test:w0> <urn:test:text2> ?o } }'));
    expect(texts).toEqual([`o=${JSON.stringify('line one\nline two\r\nline three')}`]);

    // ASK
    const askTrue = 'ASK { GRAPH <urn:test:g2> { <urn:test:s1-0> <urn:test:age> 20 } }';
    const askTrue2 = `ASK { GRAPH <urn:test:g2> { <urn:test:s1-0> <urn:test:age> "20"^^<${XSD}integer> } }`;
    const askFalse = 'ASK { GRAPH <urn:test:g2> { <urn:test:s1-0> <urn:test:age> "nope" } }';
    for (const [q, expected] of [[askTrue, true], [askTrue2, true], [askFalse, false]] as const) {
      const native = (JSON.parse(disk.query(q)) as { boolean: boolean }).boolean;
      expect(native, q).toBe(expected);
      expect(wasm.query(q), q).toBe(expected);
    }

    // CONSTRUCT as a set of N-Triples lines (default-graph N-Quads lines are N-Triples lines)
    const constructs = [
      'CONSTRUCT { ?s ?p ?o } WHERE { GRAPH ?g { ?s ?p ?o } }',
      'CONSTRUCT { ?s <urn:test:label> ?n } WHERE { GRAPH ?g { ?s <urn:test:name> ?n } }',
      'DESCRIBE <urn:test:d0>',
    ];
    for (const q of constructs) {
      const nativeLines = sortedLines(disk.query(q));
      expect(nativeLines.length, q).toBeGreaterThan(0);
      const jsStore = new oxigraph.Store(wasm.query(q) as Quad[]);
      const jsLines = sortedLines(jsStore.dump({ format: NQ }));
      expect(new Set(nativeLines), q).toEqual(new Set(jsLines));
    }

    // defaultGraph restriction
    for (const g of [G1, G2, G3]) {
      for (const q of [
        'SELECT ?s ?p ?o WHERE { ?s ?p ?o }',
        'SELECT ?s ?n WHERE { ?s <urn:test:name> ?n . OPTIONAL { ?s <urn:test:alt> ?alt } }',
      ]) {
        const native = nativeBindings(disk.query(q, g));
        expect(native.length, `${g} ${q}`).toBeGreaterThan(0);
        expect(native, `${g} ${q}`).toEqual(
          jsBindings(wasm.query(q, { default_graph: oxigraph.namedNode(g) }) as Map<string, Term>[]),
        );
      }
    }
    const inG1 = nativeBindings(disk.query('SELECT ?s WHERE { ?s <urn:test:age> ?a }', G1));
    expect(inG1.length).toBe(8);
    // without defaultGraph only the store's default graph is visible
    expect(nativeBindings(disk.query('SELECT ?s WHERE { ?s <urn:test:age> ?a }')).length).toBe(0);
  });

  it('applies INSERT DATA and DELETE WHERE', () => {
    const store = track(Store.open(path));
    store.load(dataset, NQ);
    const base = store.len();
    const count = () =>
      Number(
        (JSON.parse(store.query('SELECT (COUNT(*) AS ?n) WHERE { GRAPH ?g { ?s <urn:test:flag> ?o } }')) as {
          results: { bindings: { n: { value: string } }[] };
        }).results.bindings[0].n.value,
      );
    expect(count()).toBe(0);

    store.update(
      `INSERT DATA { GRAPH <urn:test:g1> { <urn:test:f1> <urn:test:flag> "one" . <urn:test:f2> <urn:test:flag> "tw\\"o\\n" } }`,
    );
    expect(store.len()).toBe(base + 2);
    expect(count()).toBe(2);
    expect(
      (JSON.parse(store.query('ASK { GRAPH <urn:test:g1> { <urn:test:f2> <urn:test:flag> "tw\\"o\\n" } }')) as { boolean: boolean }).boolean,
    ).toBe(true);

    store.update('DELETE WHERE { GRAPH ?g { ?s <urn:test:flag> ?o } }');
    expect(store.len()).toBe(base);
    expect(count()).toBe(0);

    store.update('DELETE WHERE { GRAPH <urn:test:g3> { ?s ?p ?o } }');
    expect(store.len()).toBe(base - 22);
  });

  it('persists on disk across processes', () => {
    const writer = Store.open(path);
    writer.load(dataset, NQ);
    writer.flush();
    writer.close();

    const script = `
      const { DiskStore } = require(${JSON.stringify(indexPath)});
      const s = DiskStore.openReadOnly(process.argv[1]);
      process.stdout.write(JSON.stringify({ len: s.len(), dump: s.dump('application/n-quads') }));
      s.close();
    `;
    const out = execFileSync(process.execPath, ['-e', script, path], { encoding: 'utf8' });
    const child = JSON.parse(out) as { len: number; dump: string };
    expect(child.len).toBe(69);
    expect(sortedLines(child.dump)).toEqual(sortedLines(dataset));

    // a read-write child sees it too and can write; the parent reopens and sees that write
    const rwScript = `
      const { DiskStore } = require(${JSON.stringify(indexPath)});
      const s = DiskStore.open(process.argv[1]);
      s.update('INSERT DATA { GRAPH <urn:test:g1> { <urn:test:child> <urn:test:wrote> "yes" } }');
      s.flush();
      process.stdout.write(String(s.len()));
      s.close();
    `;
    expect(execFileSync(process.execPath, ['-e', rwScript, path], { encoding: 'utf8' })).toBe('70');
    const reopened = track(Store.open(path));
    expect(reopened.len()).toBe(70);
  });

  it('opens read-only: reads work, writes throw', () => {
    const writer = Store.open(path);
    writer.load(dataset, NQ);
    writer.close();

    const ro = track(Store.openReadOnly(path));
    expect(ro.len()).toBe(69);
    expect(sortedLines(ro.dump(NQ))).toEqual(sortedLines(dataset));
    expect(nativeBindings(ro.query('SELECT ?s WHERE { GRAPH <urn:test:g1> { ?s <urn:test:age> ?a } }')).length).toBe(8);

    expect(() => ro.load('<urn:a> <urn:b> <urn:c> <urn:g> .\n', NQ)).toThrow(/.+/);
    expect(() => ro.update('INSERT DATA { <urn:a> <urn:b> <urn:c> }')).toThrow(/.+/);
    expect(() => ro.update('DELETE WHERE { GRAPH ?g { ?s ?p ?o } }')).toThrow(/.+/);
    expect(ro.len()).toBe(69);

    // a missing directory cannot be opened read-only
    expect(() => Store.openReadOnly(join(path, 'does-not-exist'))).toThrow(/.+/);
  });

  it('reports errors as JS exceptions and stays usable', () => {
    const store = track(Store.open(path));
    store.load(dataset, NQ);
    const before = store.len();

    expect(() => store.query('SELEKT * WHERE {')).toThrow(/.+/);
    expect(() => store.query('SELECT ?s WHERE { ?s ?p }')).toThrow(/.+/);
    expect(() => store.update('INSERT DATA { not sparql')).toThrow(/.+/);
    expect(() => store.load('<urn:a> <urn:b> "unterminated <urn:g> .\n', NQ)).toThrow(/.+/);
    expect(() => store.load('this is not n-quads at all\n', NQ)).toThrow(/.+/);
    expect(() => store.load('<urn:a> <urn:b> <urn:c> .', 'text/nonsense')).toThrow(/unsupported RDF format/);
    expect(() => store.dump('text/nonsense')).toThrow(/unsupported RDF format/);
    expect(() => store.dump('text/turtle')).toThrow(/.+/); // a triple format cannot hold a dataset
    expect(() => store.load('<urn:a> <urn:b> <urn:c> .', NT, 'not an iri')).toThrow(/invalid graph IRI/);
    expect(() => store.query('SELECT * WHERE { ?s ?p ?o }', 'not an iri')).toThrow(/invalid graph IRI/);

    // a failed load is atomic: nothing from the bad document was inserted
    expect(() => store.load('<urn:ok> <urn:b> <urn:c> <urn:g> .\nbroken line\n', NQ)).toThrow(/.+/);
    expect(store.len()).toBe(before);

    // still fully usable
    store.update('INSERT DATA { GRAPH <urn:test:g1> { <urn:after> <urn:p> "ok" } }');
    expect(store.len()).toBe(before + 1);
    expect(nativeBindings(store.query('SELECT ?o WHERE { GRAPH <urn:test:g1> { <urn:after> <urn:p> ?o } }'))).toEqual(['o="ok"']);
  });

  it('close() releases the lock and later calls throw', () => {
    const first = Store.open(path);
    first.load(dataset, NQ);
    expect(() => Store.open(path)).toThrow(/.+/); // directory lock held
    first.close();
    first.close(); // idempotent
    expect(() => first.len()).toThrow(/closed/);
    const second = track(Store.open(path));
    expect(second.len()).toBe(69);
  });
});
