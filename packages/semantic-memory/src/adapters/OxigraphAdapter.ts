import { TriplestoreAdapter, TriplestoreConfig, SparqlResult, RdfFormat, Triple, HealthResult } from '@ontofelia/core';
import oxigraph from 'oxigraph';
import * as fs from 'fs/promises';
import { existsSync } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { sparqlIri } from '../utils/SparqlSyntax.js';
import { sparqlTripleLine } from '../utils/TripleSyntax.js';
import { convertOxigraphResult } from './oxigraphResult.js';

/**
 * Adapter for the embedded Oxigraph triplestore.
 *
 * NOTE: The `oxigraph` npm package (0.5.x) is a WebAssembly build whose
 * `Store` is purely in-memory — it has no on-disk RocksDB store and no
 * `Store.backup()`. The constructor signature is `new Store(quads?)`, so
 * passing a directory path (as an older API allowed) makes the WASM layer
 * treat the string as an iterable and throws `Reflect.get called on
 * non-object`.
 *
 * To still provide persistence we serialise the whole dataset to an
 * N-Quads file inside `dataDir` and reload it on startup. Every mutating
 * operation flushes back to that file.
 *
 * Persistence model: a mutating call changes the in-memory store, then awaits a
 * flush (full N-Quads dump, temp file, atomic rename). Flushes run one at a
 * time. Concurrent writes that arrive before a queued flush has started share
 * that flush, so a burst of N writes costs one or two dumps instead of N. Each
 * caller's promise still resolves only after a flush that started after its own
 * write has completed, so durability is "after the awaited write resolves".
 * A crash before that point loses the in-flight writes, as it always did. See
 * `flush()` for the exact guarantee and the error behaviour.
 */
export class OxigraphAdapter implements TriplestoreAdapter {
  readonly backend = 'oxigraph';
  status: 'stopped' | 'starting' | 'running' | 'error' = 'stopped';
  private config!: TriplestoreConfig;
  private store!: oxigraph.Store;
  private dataDir!: string;
  private dataFile!: string;

  /** Depth of nested/overlapping `batch()` calls currently in progress. */
  private batchDepth = 0;
  /** Set when a write happened while `batchDepth > 0` and flush was deferred. */
  private dirty = false;

  /** Serialised N-Quads format string understood by oxigraph. */
  private static readonly NQUADS_MIME = 'application/n-quads';

  /** Absolute path of the N-Quads file this adapter keeps in sync after every mutation. */
  get dataFilePath(): string {
    return this.dataFile;
  }

  async initialize(config: TriplestoreConfig): Promise<void> {
    this.config = config;

    // Replace ~ with home directory if needed
    let dataDir = this.config.dataDir;
    if (dataDir.startsWith('~')) {
      dataDir = dataDir.replace('~', os.homedir());
    }
    this.dataDir = dataDir;
    this.dataFile = path.join(dataDir, 'dataset.nq');

    // Ensure directory exists
    await fs.mkdir(dataDir, { recursive: true });

    // Initialize embedded (in-memory) store
    this.store = new oxigraph.Store();

    // Rehydrate from the persisted dataset if one exists
    if (existsSync(this.dataFile)) {
      try {
        const data = await fs.readFile(this.dataFile, 'utf-8');
        if (data.trim().length > 0) {
          this.store.load(data, { format: OxigraphAdapter.NQUADS_MIME });
        }
      } catch (e) {
        throw new Error(`Failed to load persisted Oxigraph dataset: ${(e as Error).message}`);
      }
    }

    this.status = 'running';
  }

  /** Tail of the flush queue: writers share one temp file, so flushes must not overlap. */
  private flushTail: Promise<void> = Promise.resolve();

  /**
   * The flush that is queued but has not started yet, if any. A write that
   * arrives while it is set joins it instead of queueing another flush.
   */
  private pendingFlush: Promise<void> | null = null;

  /**
   * Serialise the full dataset back to disk, coalescing concurrent requests.
   *
   * Guarantee (the durability contract for callers): every caller mutates the
   * in-memory store first, synchronously, and only then calls flush(). The
   * promise it gets back resolves only after a flush that STARTED after that
   * mutation has COMPLETED (dump, write and rename). Why this holds:
   *  - a flush marks itself as started (clears `pendingFlush`) immediately
   *    before it dumps, in the same synchronous step, so every write that
   *    joins a pending flush happened before that dump and is part of it;
   *  - a write that comes after the dump has started finds no pending flush and
   *    queues a new one, which runs after the current one (flushes never
   *    overlap and share one temp file);
   *  - the dump always reads the latest state, so the last flush to finish
   *    leaves the latest state on disk.
   * If a flush fails, every caller that joined it gets the rejection; the next
   * write queues a fresh flush and tries again.
   *
   * Durability is "after the awaited write resolves". A crash before that
   * loses the in-flight writes, exactly as before coalescing.
   */
  private flush(): Promise<void> {
    if (this.pendingFlush) return this.pendingFlush;
    const run = this.flushTail.then(() => {
      this.pendingFlush = null; // started: later writes need their own flush
      return this.flushNow();
    });
    this.pendingFlush = run;
    this.flushTail = run.catch(() => undefined);
    return run;
  }

  /** Number of full-dataset dumps written to disk since this adapter started. */
  private dumpsWritten = 0;

  /**
   * Read-only counter of full-dataset dumps (one per completed flush attempt,
   * after coalescing) since this adapter started. Numbers only; used by the
   * soak metrics to estimate dumps per turn. It is never reset.
   */
  get dumpCount(): number {
    return this.dumpsWritten;
  }

  private async flushNow(): Promise<void> {
    try {
      this.dumpsWritten++;
      const nquads = this.store.dump({ format: OxigraphAdapter.NQUADS_MIME });
      // Atomic write: write to a temp file then rename
      const tmp = `${this.dataFile}.tmp`;
      await fs.writeFile(tmp, nquads, 'utf-8');
      await fs.rename(tmp, this.dataFile);
    } catch (e) {
      throw new Error(`Failed to persist Oxigraph dataset: ${(e as Error).message}`);
    }
  }

  /**
   * Persist now, unless a `batch()` is in progress — then just mark the
   * store dirty so the outermost `batch()` flushes once on the way out.
   */
  private async persistOrDefer(): Promise<void> {
    if (this.batchDepth === 0) {
      await this.flush();
    } else {
      this.dirty = true;
    }
  }

  /**
   * Run `fn` with all writes it performs (directly, or via nested write
   * calls / nested `batch()` calls) coalesced into a single `flush()` once
   * the OUTERMOST batch ends — this is what lets `KnowledgeEngine.storeFact()`
   * persist once instead of once per internal write.
   *
   * Durability note: if the process crashes mid-batch, the disk is left at
   * the state from before the batch started (no partially-written fact ever
   * reaches disk) — the deferred flush simply never ran. If `fn` throws, the
   * `finally` below still flushes whatever was written in memory before the
   * throw (same as today's per-call behaviour, where a later write in a
   * multi-write operation failing still leaves earlier writes persisted) —
   * there is no in-memory rollback on error, mid-batch or not.
   */
  async batch<T>(fn: () => Promise<T>): Promise<T> {
    this.batchDepth++;
    try {
      return await fn();
    } finally {
      this.batchDepth--;
      if (this.batchDepth === 0 && this.dirty) {
        this.dirty = false;
        await this.flush();
      }
    }
  }

  async start(): Promise<void> {
    this.status = 'running';
  }

  async stop(): Promise<void> {
    // Persist on shutdown; the in-memory store is otherwise lost.
    if (this.status === 'running') {
      await this.flush();
    }
    this.status = 'stopped';
  }

  async healthCheck(): Promise<HealthResult> {
    return {
      healthy: this.status === 'running',
      component: 'OxigraphAdapter',
      checkedAt: new Date().toISOString()
    };
  }

  async query(sparql: string, namedGraph?: string): Promise<SparqlResult> {
    try {
      const result = namedGraph
        ? this.store.query(sparql, { default_graph: oxigraph.namedNode(namedGraph) })
        : this.store.query(sparql);
      return convertOxigraphResult(result);
    } catch (e) {
      throw new Error(`SPARQL Query failed in Oxigraph: ${(e as Error).message}`);
    }
  }

  async update(sparql: string): Promise<void> {
    try {
      this.store.update(sparql);
      await this.persistOrDefer();
    } catch (e) {
      throw new Error(`SPARQL Update failed in Oxigraph: ${(e as Error).message}`);
    }
  }

  async getGraph(graphUri: string, _format: RdfFormat = 'turtle'): Promise<string> {
    // Construct query for a single graph
    const sparql = `CONSTRUCT { ?s ?p ?o } WHERE { GRAPH ${sparqlIri(graphUri)} { ?s ?p ?o } }`;
    const result = await this.query(sparql);
    return result.graph || '';
  }

  async putGraph(graphUri: string, data: string, format: RdfFormat = 'turtle'): Promise<void> {
    const mime = format === 'jsonld' ? 'application/ld+json' :
                 format === 'ntriples' ? 'application/n-triples' :
                 format === 'rdfxml' ? 'application/rdf+xml' : 'text/turtle';

    try {
      const graphNode = oxigraph.namedNode(graphUri);
      this.store.load(data, { format: mime, to_graph_name: graphNode });
      await this.persistOrDefer();
    } catch (e) {
      throw new Error(`putGraph failed in Oxigraph: ${(e as Error).message}`);
    }
  }

  async deleteGraph(graphUri: string): Promise<void> {
    // SILENT: deleting a graph that does not exist is a no-op, as on Fuseki (404 tolerated).
    const sparql = `CLEAR SILENT GRAPH ${sparqlIri(graphUri)}`;
    await this.update(sparql);
  }

  async insertTriples(graphUri: string, triples: Triple[]): Promise<void> {
    if (triples.length === 0) return;

    const lines = triples.map(sparqlTripleLine).join('\n');

    const sparql = `INSERT DATA { GRAPH ${sparqlIri(graphUri)} { ${lines} } }`;
    await this.update(sparql);
  }

  async deleteTriples(graphUri: string, triples: Triple[]): Promise<void> {
    if (triples.length === 0) return;

    const lines = triples.map(sparqlTripleLine).join('\n');

    const sparql = `DELETE DATA { GRAPH ${sparqlIri(graphUri)} { ${lines} } }`;
    await this.update(sparql);
  }

  async ask(sparql: string): Promise<boolean> {
    const res = await this.query(sparql);
    return res.type === 'boolean' ? res.boolean! : false;
  }

  async exportDataset(_format: RdfFormat = 'turtle'): Promise<string> {
    return this.store.dump({ format: OxigraphAdapter.NQUADS_MIME });
  }

  async importDataset(data: string, format: RdfFormat = 'turtle', graphUri?: string): Promise<void> {
    if (format === 'trig') {
      this.store.load(data, { format: 'application/trig' });
    } else {
      if (!graphUri) {
        throw new Error(`importDataset: format '${format}' carries no graph; pass a target graph URI`);
      }
      const mime = format === 'jsonld' ? 'application/ld+json' :
                   format === 'ntriples' ? 'application/n-triples' :
                   format === 'rdfxml' ? 'application/rdf+xml' : 'text/turtle';
      this.store.load(data, { format: mime, to_graph_name: oxigraph.namedNode(graphUri) });
    }
    await this.persistOrDefer();
  }

  async backup(targetDir: string): Promise<string> {
    // The WASM Oxigraph build has no Store.backup(); serialise the dataset
    // to an N-Quads file in the target directory instead.
    await fs.mkdir(targetDir, { recursive: true });
    const backupPath = path.join(targetDir, `oxigraph-backup-${Date.now()}.nq`);
    const nquads = this.store.dump({ format: OxigraphAdapter.NQUADS_MIME });
    await fs.writeFile(backupPath, nquads, 'utf-8');
    return backupPath;
  }

  async restore(backupPath: string): Promise<void> {
    if (!existsSync(backupPath)) {
      throw new Error(`Backup file not found: ${backupPath}`);
    }
    const data = await fs.readFile(backupPath, 'utf-8');
    // Replace current dataset with the backup contents.
    this.store = new oxigraph.Store();
    if (data.trim().length > 0) {
      this.store.load(data, { format: OxigraphAdapter.NQUADS_MIME });
    }
    await this.persistOrDefer();
  }
}
