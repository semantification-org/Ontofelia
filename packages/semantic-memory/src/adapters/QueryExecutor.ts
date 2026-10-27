import { Worker } from 'worker_threads';
import { fileURLToPath } from 'url';
import type { SparqlResult, TriplestoreAdapter } from '@ontofelia/core';
import { OxigraphAdapter } from './OxigraphAdapter.js';
import { OxigraphDiskAdapter } from './OxigraphDiskAdapter.js';
import { QueryTimeoutError } from './QueryTimeoutError.js';

export { QueryTimeoutError };

/** Runs read-only queries with a deadline. */
export interface QueryExecutor {
  execute(query: string, deadlineMs: number): Promise<SparqlResult>;
  /** Releases resources (terminates the worker). Safe to call more than once. */
  close(): Promise<void>;
}

/**
 * Calls `triplestore.query` directly. No real timeout is possible: a
 * synchronous in-process query cannot be interrupted, so the deadline is only
 * enforced by backends that honour it themselves (Fuseki aborts its HTTP
 * request). Used for every backend other than the two embedded Oxigraph ones.
 */
export class InProcessQueryExecutor implements QueryExecutor {
  constructor(private readonly triplestore: TriplestoreAdapter) {}

  execute(query: string, _deadlineMs: number): Promise<SparqlResult> {
    return this.triplestore.query(query);
  }

  async close(): Promise<void> {}
}

/**
 * Runs queries on the native on-disk store's own thread-pool task, which the
 * store cancels at the deadline (`OxigraphDiskAdapter.queryWithDeadline`). The
 * main thread is never blocked and there is no worker or replica to manage.
 * No queue: RocksDB reads are safe to run concurrently, and each query carries
 * its own deadline from the moment it starts.
 */
export class DiskQueryExecutor implements QueryExecutor {
  constructor(private readonly adapter: OxigraphDiskAdapter) {}

  execute(query: string, deadlineMs: number): Promise<SparqlResult> {
    return this.adapter.queryWithDeadline(query, deadlineMs);
  }

  async close(): Promise<void> {}
}

interface Pending {
  id: number;
  deadlineMs: number;
  timer: NodeJS.Timeout | null;
  resolve: (r: SparqlResult) => void;
  reject: (e: Error) => void;
}

/**
 * Runs queries in a `worker_threads` worker that owns its own oxigraph
 * replica, so a runaway query can be killed with `terminate()` without
 * touching the main thread.
 *
 * - The replica is loaded from the adapter's `dataset.nq`; before each query
 *   the worker reloads it when the file changed (the adapter replaces it by
 *   atomic rename). A missing file is an empty replica. The replica doubles
 *   the dataset's memory.
 * - Concurrency is 1: queries queue. The deadline starts when the worker has
 *   refreshed its replica and begins evaluating, so queue wait and reload time
 *   are not charged to the query.
 * - On timeout the worker is terminated and the caller gets a
 *   `QueryTimeoutError`; the next query lazily starts a fresh worker (and
 *   reloads the data). A worker crash rejects the running query with a plain
 *   Error and is handled the same way.
 *
 * The worker script is `OxigraphQueryWorker.js`, compiled next to this module,
 * so this class only works from compiled output (not from `.ts` sources).
 */
export class OxigraphQueryExecutor implements QueryExecutor {
  private worker: Worker | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  private nextId = 1;
  private current: Pending | null = null;
  private closed = false;

  constructor(
    private readonly dataFile: string,
    private readonly workerUrl: URL = new URL('./OxigraphQueryWorker.js', import.meta.url),
  ) {}

  execute(query: string, deadlineMs: number): Promise<SparqlResult> {
    const run = this.tail.then(() => this.runOne(query, deadlineMs));
    this.tail = run.catch(() => undefined);
    return run;
  }

  private spawn(): Worker {
    const worker = new Worker(fileURLToPath(this.workerUrl));
    worker.on('message', (msg: { id: number; kind: string; result?: SparqlResult; message?: string }) => {
      const cur = this.current;
      if (!cur || cur.id !== msg.id || this.worker !== worker) return;
      if (msg.kind === 'started') {
        cur.timer = setTimeout(() => this.timeout(cur), cur.deadlineMs);
        return;
      }
      this.settle(cur);
      if (msg.kind === 'result') cur.resolve(msg.result as SparqlResult);
      else cur.reject(new Error(msg.message ?? 'Query failed in worker'));
    });
    const dead = (err: Error) => {
      // Ignore workers already replaced or retired (timeout, close).
      if (this.worker !== worker) return;
      this.worker = null;
      const cur = this.current;
      if (cur) {
        this.settle(cur);
        cur.reject(err);
      }
    };
    worker.on('error', (e) => dead(e instanceof Error ? e : new Error(String(e))));
    worker.on('exit', (code) => dead(new Error(`Query worker exited unexpectedly (code ${code})`)));
    return worker;
  }

  private settle(cur: Pending): void {
    if (cur.timer) clearTimeout(cur.timer);
    if (this.current === cur) this.current = null;
  }

  private timeout(cur: Pending): void {
    if (this.current !== cur) return;
    this.settle(cur);
    const worker = this.worker;
    this.worker = null; // the exit event is then ignored: nothing is current
    if (worker) void worker.terminate();
    cur.reject(new QueryTimeoutError(cur.deadlineMs));
  }

  private runOne(query: string, deadlineMs: number): Promise<SparqlResult> {
    if (this.closed) return Promise.reject(new Error('Query executor is closed'));
    return new Promise<SparqlResult>((resolve, reject) => {
      const worker = (this.worker ??= this.spawn());
      const cur: Pending = { id: this.nextId++, deadlineMs, timer: null, resolve, reject };
      this.current = cur;
      worker.postMessage({ id: cur.id, dataFile: this.dataFile, query });
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    const worker = this.worker;
    this.worker = null;
    const cur = this.current;
    if (cur) {
      this.settle(cur);
      cur.reject(new Error('Query executor closed'));
    }
    if (worker) await worker.terminate();
  }
}

/**
 * Picks the executor for a backend: a worker for the Oxigraph file backend, the
 * store's own cancellable query for the Oxigraph on-disk backend, in-process
 * otherwise.
 */
export function createQueryExecutor(triplestore: TriplestoreAdapter): QueryExecutor {
  if (triplestore instanceof OxigraphDiskAdapter) {
    return new DiskQueryExecutor(triplestore);
  }
  if (triplestore instanceof OxigraphAdapter) {
    return new OxigraphQueryExecutor(triplestore.dataFilePath);
  }
  return new InProcessQueryExecutor(triplestore);
}
