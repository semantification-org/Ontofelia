import { TriplestoreAdapter, TriplestoreConfig, SparqlResult, RdfFormat, Triple, HealthResult } from '@ontofelia/core';
import oxigraph from 'oxigraph';
import type { Term } from 'oxigraph';
import type { DiskStore } from '@ontofelia/disk-store';
import * as fs from 'fs/promises';
import { existsSync } from 'fs';
import { createRequire } from 'module';
import * as path from 'path';
import * as os from 'os';
import { sparqlIri } from '../utils/SparqlSyntax.js';
import { sparqlTripleLine } from '../utils/TripleSyntax.js';
import { convertOxigraphResult } from './oxigraphResult.js';

const NQUADS_MIME = 'application/n-quads';
const NTRIPLES_MIME = 'application/n-triples';

const NATIVE_STORE_UNAVAILABLE =
  'The native on-disk store is not available. Build it with: ' +
  'ONTOFELIA_BUILD_DISK_STORE=1 pnpm --filter @ontofelia/disk-store build';

type DiskStoreModule = { DiskStore: typeof DiskStore };
let diskStoreModule: DiskStoreModule | undefined;

/**
 * Loads the native addon on first use, so importing this package works on
 * machines where the binary was never built. Throws with build instructions
 * when it is missing.
 */
function loadDiskStore(): DiskStoreModule {
  if (!diskStoreModule) {
    try {
      const requireCjs = createRequire(import.meta.url);
      diskStoreModule = requireCjs('@ontofelia/disk-store') as DiskStoreModule;
    } catch (e) {
      const reason = (e as Error).message.split('\n')[0];
      throw new Error(`${NATIVE_STORE_UNAVAILABLE} (${reason})`);
    }
  }
  return diskStoreModule;
}

/** One term of a SPARQL JSON result, as the native store emits it. */
interface JsonTerm {
  type: string;
  value: string;
  'xml:lang'?: string;
  datatype?: string;
}

interface JsonResults {
  head?: { vars?: string[] };
  boolean?: boolean;
  results?: { bindings: Array<Record<string, JsonTerm>> };
}

function jsonTermToOxigraph(t: JsonTerm): Term | undefined {
  switch (t.type) {
    case 'uri':
      return oxigraph.namedNode(t.value);
    case 'bnode':
      return oxigraph.blankNode(t.value);
    case 'literal':
    case 'typed-literal':
      if (t['xml:lang']) return oxigraph.literal(t.value, t['xml:lang']);
      if (t.datatype) return oxigraph.literal(t.value, oxigraph.namedNode(t.datatype));
      return oxigraph.literal(t.value);
    default:
      // e.g. RDF-star triple terms: the in-memory adapter drops these too.
      return undefined;
  }
}

/**
 * Converts the text the native store returns into the value shape
 * `oxigraph.Store.query` has, then reuses the shared converter so both
 * embedded backends produce identical `SparqlResult` objects.
 */
function convertDiskResult(text: string): SparqlResult {
  if (text.trimStart().startsWith('{')) {
    const json = JSON.parse(text) as JsonResults;
    if (typeof json.boolean === 'boolean') {
      return convertOxigraphResult(json.boolean);
    }
    const vars = json.head?.vars ?? [];
    const rows = (json.results?.bindings ?? []).map(binding => {
      const row = new Map<string, Term>();
      for (const v of vars) {
        const raw = binding[v];
        if (!raw) continue;
        const term = jsonTermToOxigraph(raw);
        if (term) row.set(v, term);
      }
      return row;
    });
    return convertOxigraphResult(rows);
  }
  // CONSTRUCT / DESCRIBE: N-Triples, parsed in file order.
  const quads = text.trim().length === 0 ? [] : oxigraph.parse(text, { format: NTRIPLES_MIME });
  return convertOxigraphResult(quads);
}

function tripleMime(format: RdfFormat): string {
  return format === 'jsonld' ? 'application/ld+json' :
         format === 'ntriples' ? 'application/n-triples' :
         format === 'rdfxml' ? 'application/rdf+xml' : 'text/turtle';
}

/**
 * Adapter for the embedded Oxigraph triplestore on the native on-disk store
 * (`@ontofelia/disk-store`, RocksDB).
 *
 * Persistence model: the dataset lives in a RocksDB directory (`dataDir`).
 * Every write is committed by the store itself before the call returns, so
 * there is no full-dataset dump and no flush queue; the cost of a write does
 * not grow with the size of the dataset. `stop()` flushes the write-ahead log
 * and memtables and releases the directory lock. Only one process can have the
 * directory open at a time.
 *
 * One difference to `OxigraphAdapter`: `batch()` does not defer anything.
 * Each write inside it is durable on its own, so a crash in the middle of a
 * `batch()` can leave the writes made so far on disk. The file adapter leaves
 * the state from before the batch in that case, because its single deferred
 * dump never ran. If `fn` throws, earlier writes stay (no rollback), as in the
 * file adapter.
 *
 * `initialize()` starts from whatever the directory holds and never reads
 * `dataset.nq` itself. To move an existing install over, the caller runs
 * `importFileDataset()` once right after `initialize()`: it loads the file
 * adapter's N-Quads file when (and only when) the store is still empty, and
 * leaves the file untouched, so it stays as a way back. `backup()` writes the
 * same N-Quads file format as the file adapter, so backups are interchangeable.
 *
 * It exposes no `dataFilePath` or `dumpCount`, so `createQueryExecutor` falls
 * back to the in-process executor for this adapter (no worker, no hard query
 * deadline). A worker for the on-disk store is a later step.
 */
export class OxigraphDiskAdapter implements TriplestoreAdapter {
  readonly backend = 'oxigraph';
  status: 'stopped' | 'starting' | 'running' | 'error' = 'stopped';
  private config!: TriplestoreConfig;
  private store: DiskStore | undefined;
  private dataDir!: string;

  /** Depth of nested `batch()` calls; kept only so nesting is allowed. */
  private batchDepth = 0;

  async initialize(config: TriplestoreConfig): Promise<void> {
    this.config = config;
    const { DiskStore: Native } = loadDiskStore();

    let dataDir = this.config.dataDir;
    if (dataDir.startsWith('~')) {
      dataDir = dataDir.replace('~', os.homedir());
    }
    this.dataDir = dataDir;

    await fs.mkdir(dataDir, { recursive: true });
    this.store = Native.open(dataDir);
    this.status = 'running';
  }

  private requireStore(): DiskStore {
    if (!this.store) {
      throw new Error('Oxigraph on-disk store is not open (call initialize() or start())');
    }
    return this.store;
  }

  async batch<T>(fn: () => Promise<T>): Promise<T> {
    this.batchDepth++;
    try {
      return await fn();
    } finally {
      this.batchDepth--;
    }
  }

  async start(): Promise<void> {
    // Reopen after stop(); a no-op while the store is open.
    if (!this.store && this.dataDir) {
      this.store = loadDiskStore().DiskStore.open(this.dataDir);
    }
    this.status = 'running';
  }

  async stop(): Promise<void> {
    const store = this.store;
    this.store = undefined;
    this.status = 'stopped';
    if (store) {
      try {
        store.flush();
      } finally {
        store.close();
      }
    }
  }

  async healthCheck(): Promise<HealthResult> {
    return {
      healthy: this.status === 'running',
      component: 'OxigraphDiskAdapter',
      checkedAt: new Date().toISOString()
    };
  }

  async query(sparql: string, namedGraph?: string): Promise<SparqlResult> {
    try {
      const text = this.requireStore().query(sparql, namedGraph);
      return convertDiskResult(text);
    } catch (e) {
      throw new Error(`SPARQL Query failed in Oxigraph: ${(e as Error).message}`);
    }
  }

  async update(sparql: string): Promise<void> {
    try {
      this.requireStore().update(sparql);
    } catch (e) {
      throw new Error(`SPARQL Update failed in Oxigraph: ${(e as Error).message}`);
    }
  }

  async getGraph(graphUri: string, _format: RdfFormat = 'turtle'): Promise<string> {
    const sparql = `CONSTRUCT { ?s ?p ?o } WHERE { GRAPH ${sparqlIri(graphUri)} { ?s ?p ?o } }`;
    const result = await this.query(sparql);
    return result.graph || '';
  }

  async putGraph(graphUri: string, data: string, format: RdfFormat = 'turtle'): Promise<void> {
    try {
      this.requireStore().load(data, tripleMime(format), graphUri);
    } catch (e) {
      throw new Error(`putGraph failed in Oxigraph: ${(e as Error).message}`);
    }
  }

  async deleteGraph(graphUri: string): Promise<void> {
    await this.update(`CLEAR GRAPH ${sparqlIri(graphUri)}`);
  }

  async insertTriples(graphUri: string, triples: Triple[]): Promise<void> {
    if (triples.length === 0) return;
    const lines = triples.map(sparqlTripleLine).join('\n');
    await this.update(`INSERT DATA { GRAPH ${sparqlIri(graphUri)} { ${lines} } }`);
  }

  async deleteTriples(graphUri: string, triples: Triple[]): Promise<void> {
    if (triples.length === 0) return;
    const lines = triples.map(sparqlTripleLine).join('\n');
    await this.update(`DELETE DATA { GRAPH ${sparqlIri(graphUri)} { ${lines} } }`);
  }

  async ask(sparql: string): Promise<boolean> {
    const res = await this.query(sparql);
    return res.type === 'boolean' ? res.boolean! : false;
  }

  async exportDataset(_format: RdfFormat = 'turtle'): Promise<string> {
    return this.requireStore().dump(NQUADS_MIME);
  }

  async importDataset(data: string, format: RdfFormat = 'turtle', graphUri?: string): Promise<void> {
    const store = this.requireStore();
    if (format === 'trig') {
      store.load(data, 'application/trig');
      return;
    }
    if (!graphUri) {
      throw new Error(`importDataset: format '${format}' carries no graph; pass a target graph URI`);
    }
    store.load(data, tripleMime(format), graphUri);
  }

  /**
   * One-time import of the file adapter's `dataset.nq`. Loads the file as
   * N-Quads (quads keep their graphs) only when the store holds no quads and
   * the file exists and has content; otherwise it reports why it did not.
   * The source file is only read, never modified or deleted. If the file does
   * not parse, the store is cleared again (it was empty before) and the error,
   * which names the file, is rethrown.
   */
  async importFileDataset(
    nquadsPath: string
  ): Promise<{ imported: boolean; quads: number; reason?: string }> {
    const store = this.requireStore();
    const before = store.len();
    if (before > 0) return { imported: false, quads: before, reason: 'store not empty' };
    if (!existsSync(nquadsPath)) return { imported: false, quads: 0, reason: 'no file' };
    const data = await fs.readFile(nquadsPath, 'utf-8');
    if (data.trim().length === 0) return { imported: false, quads: 0, reason: 'empty file' };
    try {
      store.load(data, NQUADS_MIME);
      store.flush();
    } catch (e) {
      store.update('CLEAR ALL');
      throw new Error(`Could not import ${nquadsPath} into the on-disk store: ${(e as Error).message}`);
    }
    return { imported: true, quads: store.len() };
  }

  async backup(targetDir: string): Promise<string> {
    await fs.mkdir(targetDir, { recursive: true });
    const backupPath = path.join(targetDir, `oxigraph-backup-${Date.now()}.nq`);
    await fs.writeFile(backupPath, this.requireStore().dump(NQUADS_MIME), 'utf-8');
    return backupPath;
  }

  async restore(backupPath: string): Promise<void> {
    if (!existsSync(backupPath)) {
      throw new Error(`Backup file not found: ${backupPath}`);
    }
    const data = await fs.readFile(backupPath, 'utf-8');
    const store = this.requireStore();
    // Replace the current dataset with the backup contents. The load is atomic
    // but clear + load are two steps, so keep the old contents in memory and
    // put them back if the backup does not parse.
    const before = store.dump(NQUADS_MIME);
    store.update('CLEAR ALL');
    if (data.trim().length === 0) return;
    try {
      store.load(data, NQUADS_MIME);
    } catch (e) {
      store.update('CLEAR ALL');
      if (before.trim().length > 0) store.load(before, NQUADS_MIME);
      throw e;
    }
  }
}
