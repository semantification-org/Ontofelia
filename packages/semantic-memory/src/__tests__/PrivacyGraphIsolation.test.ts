/**
 * REL-2 / Privacy-P0 (OPRO #869) — Graph Isolation Regression Test
 *
 * Verifies that SPARQL queries WITHOUT an explicit GRAPH clause do NOT read
 * data from private named graphs (urn:...:user:*, urn:...:session:*).
 *
 * Background: TODO-001 in review/2026_05_18_antigravity_semantic_memory_todos.md
 * flagged Fuseki's `tdb2:unionDefaultGraph true` as a privacy leak. The live
 * runtime uses OxigraphAdapter whose embedded WASM Store has an empty default
 * graph by default. This test suite guarantees:
 *
 *   1. Data stored in a private named graph is invisible to graph-less queries.
 *   2. Data stored in one user's graph is invisible from another user's graph.
 *   3. Session-scoped data is invisible from graph-less queries.
 *   4. Cross-graph queries via `GRAPH ?g` work (data is present), proving
 *      the test setup is valid (data was actually stored).
 *
 * If this test ever fails, it means the store configuration has
 * changed to union named graphs into the default graph — a privacy breach.
 *
 * The same assertions run against two backends:
 *   - OxigraphAdapter (always), and
 *   - FusekiAdapter against a real Apache Jena Fuseki started through
 *     FusekiManager with its generated product config. This variant runs only
 *     when ONTOFELIA_TEST_FUSEKI_HOME points to a directory holding
 *     `fuseki-server.jar`; otherwise it is skipped with a visible reason.
 *     Fuseki is a JVM: its heap is capped via JAVA_TOOL_OPTIONS (FusekiManager
 *     passes no JVM arguments of its own but the child inherits the environment).
 *
 * A Fuseki-only positive control starts a second Fuseki whose config differs
 * from the product config in exactly one line (`unionDefaultGraph true`) and
 * proves that the leak assertion can actually fire.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { createServer } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { createOxigraphTestAdapter } from './helpers/oxigraphTestAdapter.js';
import { FusekiAdapter } from '../adapters/FusekiAdapter.js';
import { FusekiManager } from '../fuseki/FusekiManager.js';
import type { TriplestoreAdapter } from '@ontofelia/core';

// ── Fixtures ──────────────────────────────────────────────────────────

const ALICE_USER_GRAPH = 'urn:ontofelia:user:alice';
const BOB_USER_GRAPH   = 'urn:ontofelia:user:bob';
const SESSION_GRAPH    = 'urn:ontofelia:session:sess_secret42';
const AGENT_ABOX       = 'urn:ontofelia:agent:ontofelia:abox';

const ALICE_TRIPLE = `
  <urn:person:alice> <http://xmlns.com/foaf/0.1/name> "Alice Nakamura" .
  <urn:person:alice> <urn:shared:ontology#email> "alice@secret.internal" .
`;

const BOB_TRIPLE = `
  <urn:person:bob> <http://xmlns.com/foaf/0.1/name> "Bob Chen" .
`;

const SESSION_TRIPLE = `
  <urn:session:event:1> <urn:shared:ontology#payload> "private session data" .
  <urn:session:event:1> <urn:shared:ontology#cog/occurredAt> "2026-06-01T10:00:00Z" .
`;

const ABOX_TRIPLE = `
  <urn:entity:berlin> <http://www.w3.org/2000/01/rdf-schema#label> "Berlin" .
  <urn:entity:berlin> <urn:shared:ontology#population> "3748148" .
`;

// ── Helpers ───────────────────────────────────────────────────────────

async function makeOxigraphStore(): Promise<TriplestoreAdapter> {
  const store = createOxigraphTestAdapter();
  await store.initialize({
    backend: 'oxigraph',
    type: 'embedded',
    dataDir: `/tmp/privacy-iso-${Math.random().toString(16).slice(2)}`,
    port: 0,
    endpoint: '',
  });
  return store;
}

// ── Fuseki harness ────────────────────────────────────────────────────

const FUSEKI_HOME = process.env.ONTOFELIA_TEST_FUSEKI_HOME ?? '';
const FUSEKI_AVAILABLE = FUSEKI_HOME !== '' && existsSync(join(FUSEKI_HOME, 'fuseki-server.jar'));
const FUSEKI_SKIP_REASON =
  'SKIPPED: set ONTOFELIA_TEST_FUSEKI_HOME to a directory containing fuseki-server.jar to run this variant';
const FUSEKI_JVM_OPTS = '-Xmx512m';
const FUSEKI_TIMEOUT_MS = 90_000;

/** Same as the product manager, but the dataset unions named graphs into the default graph. */
class UnionDefaultGraphFusekiManager extends FusekiManager {
  override generateConfig(): string {
    const product = super.generateConfig();
    const leaky = product.replace('tdb2:unionDefaultGraph false', 'tdb2:unionDefaultGraph true');
    if (leaky === product) throw new Error('product config no longer contains unionDefaultGraph false');
    writeFileSync(this.leakyConfigPath, leaky, 'utf-8');
    return leaky;
  }
  constructor(cfg: ConstructorParameters<typeof FusekiManager>[0], private readonly leakyConfigPath: string) {
    super(cfg);
  }
}

interface RunningFuseki {
  adapter: TriplestoreAdapter;
  stop: () => Promise<void>;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

/** Start a real Fuseki (temp data dir, free port, capped heap) and return a FusekiAdapter. */
async function startFuseki(unionDefaultGraph: boolean): Promise<RunningFuseki> {
  const dir = mkdtempSync(join(tmpdir(), 'fuseki-privacy-'));
  // Fuseki writes run state (FUSEKI_BASE) into its cwd and needs `webapp/` there, so give it a
  // private home that only links the jar and the webapp; the shared distribution stays untouched.
  const home = join(dir, 'home');
  mkdirSync(home);
  symlinkSync(join(FUSEKI_HOME, 'fuseki-server.jar'), join(home, 'fuseki-server.jar'));
  symlinkSync(join(FUSEKI_HOME, 'webapp'), join(home, 'webapp'));
  const port = await freePort();
  const cfg = {
    dataDir: join(dir, 'tdb2'),
    port,
    configPath: join(dir, 'fuseki-config.ttl'),
    fusekiHome: home,
    javaPath: 'java',
    dataset: 'ontofelia',
  };
  const manager = unionDefaultGraph
    ? new UnionDefaultGraphFusekiManager(cfg, cfg.configPath)
    : new FusekiManager(cfg);

  const previousOpts = process.env.JAVA_TOOL_OPTIONS;
  process.env.JAVA_TOOL_OPTIONS = FUSEKI_JVM_OPTS;
  const stop = async () => {
    try {
      await manager.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  try {
    await manager.start();
    const adapter = new FusekiAdapter();
    await adapter.initialize({
      backend: 'fuseki',
      type: 'external',
      dataDir: cfg.dataDir,
      port,
      endpoint: `http://127.0.0.1:${port}/ontofelia`,
    } as never);
    return { adapter, stop };
  } catch (err) {
    await stop();
    throw err;
  } finally {
    if (previousOpts === undefined) delete process.env.JAVA_TOOL_OPTIONS;
    else process.env.JAVA_TOOL_OPTIONS = previousOpts;
  }
}

async function populate(store: TriplestoreAdapter): Promise<void> {
  await store.putGraph(ALICE_USER_GRAPH, ALICE_TRIPLE, 'turtle');
  await store.putGraph(BOB_USER_GRAPH, BOB_TRIPLE, 'turtle');
  await store.putGraph(SESSION_GRAPH, SESSION_TRIPLE, 'turtle');
  await store.putGraph(AGENT_ABOX, ABOX_TRIPLE, 'turtle');
}

/**
 * Run a GRAPH-less SELECT and return all binding rows.
 * If the default graph is properly isolated (empty), this must return [].
 */
async function graphlessSelect(
  store: TriplestoreAdapter,
  sparql: string,
): Promise<Array<Record<string, { type: string; value: string }>>> {
  const res = await store.query(sparql);
  if (res.type !== 'bindings') return [];
  return (res.bindings ?? []) as Array<Record<string, { type: string; value: string }>>;
}

// ── Tests ─────────────────────────────────────────────────────────────

/** Register the isolation assertions against the store that `getStore` returns. */
function isolationAssertions(getStore: () => TriplestoreAdapter): void {
  let store: TriplestoreAdapter;
  beforeEach(() => {
    store = getStore();
  });

  // ── Core isolation: graph-less queries must see NOTHING ───────────

  it('graph-less SELECT returns NOTHING from user graphs', async () => {
    const rows = await graphlessSelect(store, `
      SELECT ?s ?p ?o WHERE { ?s ?p ?o }
    `);
    expect(rows).toHaveLength(0);
  });

  it('graph-less SELECT for Alice name returns NOTHING', async () => {
    const rows = await graphlessSelect(store, `
      PREFIX foaf: <http://xmlns.com/foaf/0.1/>
      SELECT ?name WHERE { ?s foaf:name ?name }
    `);
    expect(rows).toHaveLength(0);
  });

  it('graph-less ASK for any triple returns false', async () => {
    const result = await store.ask('ASK { ?s ?p ?o }');
    expect(result).toBe(false);
  });

  it('graph-less SELECT with FILTER returns NOTHING from session graph', async () => {
    const rows = await graphlessSelect(store, `
      SELECT ?payload WHERE {
        ?s <urn:shared:ontology#payload> ?payload
      }
    `);
    expect(rows).toHaveLength(0);
  });

  it('graph-less COUNT returns zero', async () => {
    const rows = await graphlessSelect(store, `
      SELECT (COUNT(*) AS ?count) WHERE { ?s ?p ?o }
    `);
    const count = parseInt(rows[0]?.count?.value ?? '0', 10);
    expect(count).toBe(0);
  });

  // ── Cross-user isolation: user A cannot see user B ────────────────

  it('querying Alice graph does NOT return Bob data', async () => {
    const rows = await graphlessSelect(store, `
      PREFIX foaf: <http://xmlns.com/foaf/0.1/>
      SELECT ?name WHERE {
        GRAPH <${ALICE_USER_GRAPH}> { ?s foaf:name ?name }
      }
    `);
    expect(rows).toHaveLength(1);
    expect(rows[0].name.value).toBe('Alice Nakamura');
    // Explicitly: Bob must NOT appear
    const names = rows.map((r) => r.name.value);
    expect(names).not.toContain('Bob Chen');
  });

  it('querying Bob graph does NOT return Alice data', async () => {
    const rows = await graphlessSelect(store, `
      PREFIX foaf: <http://xmlns.com/foaf/0.1/>
      SELECT ?name WHERE {
        GRAPH <${BOB_USER_GRAPH}> { ?s foaf:name ?name }
      }
    `);
    expect(rows).toHaveLength(1);
    expect(rows[0].name.value).toBe('Bob Chen');
    const names = rows.map((r) => r.name.value);
    expect(names).not.toContain('Alice Nakamura');
  });

  // ── Session-graph isolation ───────────────────────────────────────

  it('session data is only visible within its own GRAPH scope', async () => {
    // Session data visible via explicit GRAPH
    const scoped = await graphlessSelect(store, `
      SELECT ?payload WHERE {
        GRAPH <${SESSION_GRAPH}> { ?s <urn:shared:ontology#payload> ?payload }
      }
    `);
    expect(scoped).toHaveLength(1);
    expect(scoped[0].payload.value).toBe('private session data');

    // NOT visible via graph-less query
    const leaked = await graphlessSelect(store, `
      SELECT ?payload WHERE { ?s <urn:shared:ontology#payload> ?payload }
    `);
    expect(leaked).toHaveLength(0);
  });

  // ── Validity check: data IS actually present ──────────────────────

  it('data IS present when queried via GRAPH ?g (validity check)', async () => {
    const rows = await graphlessSelect(store, `
      PREFIX foaf: <http://xmlns.com/foaf/0.1/>
      SELECT ?g ?name WHERE {
        GRAPH ?g { ?s foaf:name ?name }
      }
      ORDER BY ?name
    `);
    // Alice + Bob = 2 results across their respective graphs
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const names = rows.map((r) => r.name.value).sort();
    expect(names).toContain('Alice Nakamura');
    expect(names).toContain('Bob Chen');
  });

  it('all four graphs contain data (validity check)', async () => {
    for (const graphUri of [ALICE_USER_GRAPH, BOB_USER_GRAPH, SESSION_GRAPH, AGENT_ABOX]) {
      const rows = await graphlessSelect(store, `
        SELECT (COUNT(*) AS ?count) WHERE {
          GRAPH <${graphUri}> { ?s ?p ?o }
        }
      `);
      const count = parseInt(rows[0]?.count?.value ?? '0', 10);
      expect(count).toBeGreaterThan(0);
    }
  });
}

describe('Privacy: Graph Isolation (REL-2 / TODO-001) [oxigraph]', () => {
  let current: TriplestoreAdapter;
  beforeEach(async () => {
    current = await makeOxigraphStore();
    await populate(current);
  });
  isolationAssertions(() => current);
});

describe.skipIf(!FUSEKI_AVAILABLE)(
  `Privacy: Graph Isolation (REL-2 / TODO-001) [fuseki, real Jena Fuseki]${FUSEKI_AVAILABLE ? '' : ` -- ${FUSEKI_SKIP_REASON}`}`,
  () => {
    let fuseki: RunningFuseki;
    beforeAll(async () => {
      fuseki = await startFuseki(false);
    }, FUSEKI_TIMEOUT_MS);
    afterAll(async () => {
      await fuseki?.stop();
    }, FUSEKI_TIMEOUT_MS);
    beforeEach(async () => {
      await fuseki.adapter.update('DROP ALL');
      await populate(fuseki.adapter);
    }, FUSEKI_TIMEOUT_MS);
    isolationAssertions(() => fuseki.adapter);
  },
);

describe.skipIf(!FUSEKI_AVAILABLE)(
  `Privacy: positive control, unionDefaultGraph true leaks [fuseki]${FUSEKI_AVAILABLE ? '' : ` -- ${FUSEKI_SKIP_REASON}`}`,
  () => {
    let fuseki: RunningFuseki;
    beforeAll(async () => {
      fuseki = await startFuseki(true);
      await populate(fuseki.adapter);
    }, FUSEKI_TIMEOUT_MS);
    afterAll(async () => {
      await fuseki?.stop();
    }, FUSEKI_TIMEOUT_MS);

    it('graph-less SELECT sees user-graph data when the default graph is unioned', async () => {
      const rows = await graphlessSelect(fuseki.adapter, 'SELECT ?s ?p ?o WHERE { ?s ?p ?o }');
      expect(rows.length).toBeGreaterThan(0);
      const names = (
        await graphlessSelect(
          fuseki.adapter,
          'PREFIX foaf: <http://xmlns.com/foaf/0.1/> SELECT ?name WHERE { ?s foaf:name ?name }',
        )
      ).map((r) => r.name.value);
      expect(names).toContain('Alice Nakamura');
      expect(names).toContain('Bob Chen');
      expect(await fuseki.adapter.ask('ASK { ?s ?p ?o }')).toBe(true);
    });
  },
);
