import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { InMemoryAdapter } from '@ontofelia/semantic-memory';
import { FastifyInstance } from 'fastify';
import { startGateway } from '../../index.js';
import { getDefaultConfig, OntofeliaConfig } from '@ontofelia/config';

const MARKER = 'distinctive-backup-literal-1556';
const SUBJECT = 'urn:test:backup-subject';
const GRAPH = 'urn:ontofelia:claims';

// Isolated HOME: the route writes backups and audit entries below os.homedir().
function useIsolatedHome(): { restore: () => void } {
  const previous = process.env.HOME;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ontofelia-memtest-'));
  process.env.HOME = dir;
  return {
    restore: () => {
      if (previous === undefined) delete process.env.HOME;
      else process.env.HOME = previous;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

// Capture the adapter instance the gateway creates so tests can seed and inspect it.
function captureAdapter(): { get: () => InMemoryAdapter; release: () => void } {
  let captured: InMemoryAdapter | undefined;
  const original = InMemoryAdapter.prototype.initialize;
  const spy = vi.spyOn(InMemoryAdapter.prototype, 'initialize').mockImplementation(function (this: InMemoryAdapter, cfg) {
    captured = this;
    return original.call(this, cfg);
  });
  return { get: () => captured!, release: () => spy.mockRestore() };
}

const tripleCount = async (adapter: InMemoryAdapter): Promise<number> => {
  const r = await adapter.query('SELECT (COUNT(*) AS ?n) WHERE { { ?s ?p ?o } UNION { GRAPH ?g { ?s ?p ?o } } }');
  return Number(r.bindings![0].n.value);
};

describe('Memory Routes', () => {
  let fastify: FastifyInstance;
  let config: OntofeliaConfig;
  let home: { restore: () => void };
  let adapter: ReturnType<typeof captureAdapter>;

  beforeAll(async () => {
    home = useIsolatedHome();
    adapter = captureAdapter();
    delete (globalThis as Record<symbol, unknown>)[Symbol.for('ontofelia-gateway-started')];
    config = getDefaultConfig();
    config.gateway.token = 'test-secret';
    config.gateway.port = 0;
    config.memory.backend = 'memory';
    fastify = await startGateway(config);
    adapter.release();
  });

  afterAll(async () => {
    await fastify.close();
    home.restore();
  });

  beforeEach(() => {
    delete (globalThis as Record<symbol, unknown>)[Symbol.for('ontofelia-gateway-started')];
  });

  it('returns registered named graph Turtle dumps', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/api/knowledge/graphs', headers: { authorization: 'Bearer test-secret' } });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.agentId).toBe('ontofelia');
    expect(Array.isArray(body.graphs)).toBe(true);

    const uris = body.graphs.map((graph: { uri: string }) => graph.uri);
    expect(uris).toContain('urn:ontofelia:self');
    expect(uris).toContain('urn:shared:ontology');

    const selfGraph = body.graphs.find((graph: { uri: string }) => graph.uri === 'urn:ontofelia:self');
    expect(selfGraph.role).toBe('self');
    expect(selfGraph.agentId).toBe('ontofelia');
    expect(typeof selfGraph.turtle).toBe('string');
  });

  it('rejects /api/knowledge deletion without confirm', async () => {
    const res = await fastify.inject({ method: 'DELETE', url: '/api/knowledge', headers: { authorization: 'Bearer test-secret' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/Missing confirm/);
  });

  it('writes a non-empty backup containing the stored triple before dropping', async () => {
    const store = adapter.get();
    await store.insertTriples(GRAPH, [{ subject: SUBJECT, predicate: 'urn:test:says', object: { value: MARKER } }]);
    expect(await tripleCount(store)).toBeGreaterThan(0);

    const res = await fastify.inject({ method: 'DELETE', url: '/api/knowledge?confirm=true', headers: { authorization: 'Bearer test-secret' } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.deleted).toBe(true);
    expect(body.backupBytes).toBeGreaterThan(0);

    expect(fs.existsSync(body.backupPath)).toBe(true);
    expect(path.dirname(body.backupPath).startsWith(process.env.HOME!)).toBe(true);
    const content = fs.readFileSync(body.backupPath, 'utf-8');
    expect(fs.statSync(body.backupPath).size).toBe(body.backupBytes);
    expect(content).toContain(MARKER);
    expect(fs.readdirSync(path.dirname(body.backupPath)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    // The TBox reload is best-effort and may re-add ontology triples, but the data is gone.
    expect(await store.exportDataset()).not.toContain(MARKER);
  });

  it('enforces rate limit on knowledge deletion', async () => {
    // Delete already called in previous test
    const res = await fastify.inject({ method: 'DELETE', url: '/api/knowledge?confirm=true', headers: { authorization: 'Bearer test-secret' } });
    expect(res.statusCode).toBe(429);
    expect(res.json().error).toMatch(/Rate limit exceeded/);
  });

  it('allows fetching ontology versions', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/api/ontology/versions', headers: { authorization: 'Bearer test-secret' } });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json())).toBe(true);
  });

  it('allows fetching ontology proposals', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/api/ontology/proposals', headers: { authorization: 'Bearer test-secret' } });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json())).toBe(true);
  });
});

describe('Memory Routes: empty backup guard', () => {
  let fastify: FastifyInstance;
  let home: { restore: () => void };
  let adapter: ReturnType<typeof captureAdapter>;

  beforeAll(async () => {
    home = useIsolatedHome();
    adapter = captureAdapter();
    delete (globalThis as Record<symbol, unknown>)[Symbol.for('ontofelia-gateway-started')];
    const config = getDefaultConfig();
    config.gateway.token = 'test-secret';
    config.gateway.port = 0;
    config.memory.backend = 'memory';
    fastify = await startGateway(config);
    adapter.release();
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await fastify.close();
    home.restore();
  });

  it('refuses to drop when the backup is empty', async () => {
    const store = adapter.get();
    await store.insertTriples(GRAPH, [{ subject: SUBJECT, predicate: 'urn:test:says', object: { value: MARKER } }]);
    const before = await tripleCount(store);
    expect(before).toBeGreaterThan(0);
    vi.spyOn(store, 'exportDataset').mockResolvedValue('');

    const res = await fastify.inject({ method: 'DELETE', url: '/api/knowledge?confirm=true', headers: { authorization: 'Bearer test-secret' } });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toMatch(/backup is empty although the store holds \d+ triples — nothing deleted/);
    expect(res.json().deleted).toBeUndefined();

    expect(await tripleCount(store)).toBe(before);
    const backupDir = path.join(process.env.HOME!, '.ontofelia', 'backups');
    const leftovers = fs.existsSync(backupDir) ? fs.readdirSync(backupDir).filter((f) => f.startsWith('knowledge-')) : [];
    expect(leftovers).toEqual([]);
  });
});
