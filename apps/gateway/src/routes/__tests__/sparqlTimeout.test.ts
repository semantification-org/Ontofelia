import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import {
  OxigraphAdapter, OxigraphDiskAdapter, OxigraphQueryExecutor, QueryTimeoutError, createQueryExecutor,
  InProcessQueryExecutor, DiskQueryExecutor,
} from '@ontofelia/semantic-memory';
import { InMemoryAdapter } from '@ontofelia/semantic-memory';
import memoryRoutes from '../memory.js';
import type { GatewayContext } from '../../context.js';

const GRAPH = 'urn:ontofelia:worldview';
const EX = 'http://example.org/';
const DEADLINE_MS = 200;
// Transitive closure over a chain is roughly quadratic; 2000 nodes take a few
// seconds and a few hundred MB in a plain oxigraph store, far above DEADLINE_MS.
const CHAIN = 2000;

const SLOW = `SELECT ?a ?b WHERE { GRAPH <${GRAPH}> { ?a <${EX}next>* ?b } }`;
const CHEAP = `SELECT ?o WHERE { GRAPH <${GRAPH}> { <${EX}n/0> <${EX}next> ?o } }`;

async function makeStore(dataDir: string): Promise<OxigraphAdapter> {
  const store = new OxigraphAdapter();
  await store.initialize({ backend: 'oxigraph', type: 'embedded', dataDir, port: 0, endpoint: '' });
  await store.insertTriples(GRAPH, Array.from({ length: CHAIN }, (_, i) => ({
    subject: `${EX}n/${i}`, predicate: `${EX}next`, object: `${EX}n/${i + 1}`,
  })));
  return store;
}

describe('POST /api/knowledge/sparql with a worker deadline', () => {
  let app: FastifyInstance;
  let store: OxigraphAdapter;
  let dataDir: string;

  const post = (query: string) => app.inject({ method: 'POST', url: '/api/knowledge/sparql', payload: { query } });

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sparql-timeout-'));
    store = await makeStore(dataDir);
    app = Fastify();
    app.get('/ping', async () => ({ ok: true }));
    await app.register(memoryRoutes, {
      triplestore: store,
      config: { memory: { sparqlTimeoutMs: DEADLINE_MS } },
    } as unknown as GatewayContext);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('answers a normal SELECT with the usual shape', async () => {
    const res = await post(CHEAP);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      type: 'bindings',
      variables: ['o'],
      bindings: [{ o: { type: 'uri', value: EX + 'n/1' } }],
      truncated: false,
    });
    const ask = await post(`ASK { GRAPH <${GRAPH}> { <${EX}n/0> <${EX}next> <${EX}n/1> } }`);
    expect(ask.json()).toEqual({ type: 'boolean', boolean: true });
  });

  it('returns the same bindings as the adapter itself', async () => {
    await store.insertTriples(GRAPH, [
      { subject: EX + 'lit', predicate: EX + 'label', object: { value: 'Hallo', language: 'de' } },
      { subject: EX + 'lit', predicate: EX + 'label', object: { value: 'plain' } },
    ]);
    // ORDER BY: row order is otherwise unspecified and differs between replicas.
    const q = `SELECT ?s ?o WHERE { GRAPH <${GRAPH}> { ?s <${EX}label> ?o } } ORDER BY ?o`;
    const direct = await store.query(q);
    const viaRoute = (await post(q)).json();
    expect(direct.bindings).toHaveLength(2);
    expect(viaRoute.variables).toEqual(direct.variables);
    expect(viaRoute.bindings).toEqual(JSON.parse(JSON.stringify(direct.bindings)));
  });

  it('returns 504 at the deadline, keeps the event loop free, and recovers', async () => {
    // Warm the worker so the measurement excludes spawn and replica load.
    expect((await post(CHEAP)).statusCode).toBe(200);

    let maxGap = 0;
    let last = Date.now();
    const ticker = setInterval(() => {
      const now = Date.now();
      maxGap = Math.max(maxGap, now - last);
      last = now;
    }, 10);

    const started = Date.now();
    const slow = post(SLOW);
    await new Promise((r) => setTimeout(r, 50));
    const pingStarted = Date.now();
    const ping = await app.inject({ method: 'GET', url: '/ping' });
    const pingMs = Date.now() - pingStarted;
    const res = await slow;
    const elapsed = Date.now() - started;
    clearInterval(ticker);

    expect(res.statusCode).toBe(504);
    expect(res.json()).toEqual({ error: `Query exceeded the time limit of ${DEADLINE_MS} ms` });
    expect(elapsed).toBeLessThan(DEADLINE_MS * 2);
    expect(ping.statusCode).toBe(200);
    expect(pingMs).toBeLessThan(100);
    expect(maxGap).toBeLessThan(100);
    console.log(`timeout latency ${elapsed} ms (deadline ${DEADLINE_MS}), ping ${pingMs} ms, max timer gap ${maxGap} ms`);

    // A fresh worker serves the next query.
    const after = await post(CHEAP);
    expect(after.statusCode).toBe(200);
    expect(after.json().bindings).toHaveLength(1);
  });

  it('sees data written through the adapter after an earlier query', async () => {
    const q = `SELECT ?o WHERE { GRAPH <${GRAPH}> { <${EX}fresh> <${EX}p> ?o } }`;
    expect((await post(q)).json().bindings).toEqual([]);
    await store.insertTriples(GRAPH, [{ subject: EX + 'fresh', predicate: EX + 'p', object: EX + 'v' }]);
    expect((await post(q)).json().bindings).toEqual([{ o: { type: 'uri', value: EX + 'v' } }]);
  });
});

describe('OxigraphQueryExecutor', () => {
  it('treats a missing data file as an empty replica', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sparql-exec-'));
    const exec = new OxigraphQueryExecutor(path.join(dir, 'dataset.nq'));
    try {
      const res = await exec.execute('SELECT * WHERE { GRAPH ?g { ?s ?p ?o } }', 1000);
      expect(res).toEqual({ type: 'bindings', variables: [], bindings: [] });
    } finally {
      await exec.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects with a timeout error and queues queries one at a time', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sparql-exec-'));
    const store = await makeStore(dir);
    const exec = createQueryExecutor(store);
    expect(exec).toBeInstanceOf(OxigraphQueryExecutor);
    try {
      const [slow, cheap] = await Promise.allSettled([exec.execute(SLOW, DEADLINE_MS), exec.execute(CHEAP, 5000)]);
      expect(slow.status).toBe('rejected');
      expect((slow as PromiseRejectedResult).reason).toBeInstanceOf(QueryTimeoutError);
      expect(cheap.status).toBe('fulfilled');
    } finally {
      await exec.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports a worker crash as an error and starts a fresh worker next time', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sparql-exec-'));
    const script = path.join(dir, 'fake-worker.mjs');
    fs.writeFileSync(script, `
      import { parentPort } from 'worker_threads';
      parentPort.on('message', (req) => {
        if (req.query.includes('CRASH')) process.exit(3);
        parentPort.postMessage({ id: req.id, kind: 'started' });
        parentPort.postMessage({ id: req.id, kind: 'result', result: { type: 'boolean', boolean: true } });
      });
    `);
    const exec = new OxigraphQueryExecutor(path.join(dir, 'dataset.nq'), pathToFileURL(script));
    try {
      const crashed = await exec.execute('CRASH', 1000).catch((e: Error) => e);
      expect(crashed).toBeInstanceOf(Error);
      expect(crashed).not.toBeInstanceOf(QueryTimeoutError);
      expect(await exec.execute('ok', 1000)).toEqual({ type: 'boolean', boolean: true });
    } finally {
      await exec.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('terminates the worker on close and refuses further queries', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sparql-exec-'));
    const exec = new OxigraphQueryExecutor(path.join(dir, 'dataset.nq'));
    try {
      await exec.execute('ASK { }', 1000);
      const worker = (exec as unknown as { worker: { threadId: number } | null }).worker;
      expect(worker).not.toBeNull();
      const exited = new Promise<void>((resolve) => (worker as unknown as NodeJS.EventEmitter).once('exit', () => resolve()));
      await exec.close();
      await exited; // resolves only if the worker thread really ended
      await expect(exec.execute('ASK { }', 1000)).rejects.toThrow(/closed/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('closes the worker when the app closes', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sparql-exec-'));
    const store = await makeStore(dir);
    const app = Fastify();
    await app.register(memoryRoutes, { triplestore: store } as unknown as GatewayContext);
    await app.ready();
    try {
      expect((await app.inject({ method: 'POST', url: '/api/knowledge/sparql', payload: { query: CHEAP } })).statusCode).toBe(200);
      await app.close(); // would hang if the worker kept the process or the hook were missing
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses the in-process executor for other backends', () => {
    expect(createQueryExecutor(new InMemoryAdapter())).toBeInstanceOf(InProcessQueryExecutor);
  });
});

// The on-disk backend cancels the query inside the native store. Like the other
// disk tests, this is skipped when the native binary was not built, unless the
// disk run was requested explicitly (then a missing binary must fail).
const diskRequested = process.env.ONTOFELIA_TEST_OXIGRAPH_STORE === 'disk';
let diskAvailable = true;
{
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sparql-disk-probe-'));
  try {
    const probe = new OxigraphDiskAdapter();
    await probe.initialize({ backend: 'oxigraph', type: 'embedded', dataDir: probeDir, port: 0, endpoint: '' });
    await probe.stop();
  } catch {
    diskAvailable = false;
  } finally {
    fs.rmSync(probeDir, { recursive: true, force: true });
  }
}

describe.skipIf(!diskAvailable && !diskRequested)('POST /api/knowledge/sparql on the on-disk store', () => {
  // Three chained transitive closures over a 300-link chain run for over a minute
  // uncancelled; the store checks for cancellation as it reads quads.
  const NEXT = `<${EX}next>`;
  const RUNAWAY = `SELECT (COUNT(*) AS ?n) WHERE { GRAPH <${GRAPH}> { ?a ${NEXT}* ?b . ?b ${NEXT}* ?c . ?c ${NEXT}* ?d } }`;
  let app: FastifyInstance;
  let store: OxigraphDiskAdapter;
  let dataDir: string;

  const post = (query: string) => app.inject({ method: 'POST', url: '/api/knowledge/sparql', payload: { query } });

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sparql-timeout-disk-'));
    store = new OxigraphDiskAdapter();
    await store.initialize({ backend: 'oxigraph', type: 'embedded', dataDir, port: 0, endpoint: '' });
    await store.insertTriples(GRAPH, Array.from({ length: 300 }, (_, i) => ({
      subject: `${EX}n/${i}`, predicate: `${EX}next`, object: `${EX}n/${i + 1}`,
    })));
    app = Fastify();
    app.get('/ping', async () => ({ ok: true }));
    await app.register(memoryRoutes, {
      triplestore: store,
      config: { memory: { sparqlTimeoutMs: DEADLINE_MS } },
    } as unknown as GatewayContext);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await store.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('uses the disk executor', () => {
    expect(createQueryExecutor(store)).toBeInstanceOf(DiskQueryExecutor);
  });

  it('answers a normal SELECT with the usual shape', async () => {
    const res = await post(CHEAP);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      type: 'bindings',
      variables: ['o'],
      bindings: [{ o: { type: 'uri', value: EX + 'n/1' } }],
      truncated: false,
    });
  });

  it('returns 504 at the deadline, keeps the event loop free, and recovers', async () => {
    let maxGap = 0;
    let last = Date.now();
    const ticker = setInterval(() => {
      const now = Date.now();
      maxGap = Math.max(maxGap, now - last);
      last = now;
    }, 10);

    const started = Date.now();
    const slow = post(RUNAWAY);
    await new Promise((r) => setTimeout(r, 50));
    const ping = await app.inject({ method: 'GET', url: '/ping' });
    const res = await slow;
    const elapsed = Date.now() - started;
    clearInterval(ticker);

    expect(res.statusCode).toBe(504);
    expect(res.json()).toEqual({ error: `Query exceeded the time limit of ${DEADLINE_MS} ms` });
    expect(elapsed).toBeLessThan(3000);
    expect(ping.statusCode).toBe(200);
    expect(maxGap).toBeLessThan(150);

    const after = await post(CHEAP);
    expect(after.statusCode).toBe(200);
    expect(after.json().bindings).toHaveLength(1);
  });
});
