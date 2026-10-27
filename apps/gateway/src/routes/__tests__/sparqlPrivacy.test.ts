import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { startGateway } from '../../index.js';
import { getDefaultConfig } from '@ontofelia/config';
import { AgentRuntime, GoalStack } from '@ontofelia/agent-runtime';
import {
  EpisodicMemory, GraphRegistry, GraphUriResolver, KnowledgeEngine, OxigraphAdapter, ProceduralMemory,
  SHARED_GRAPHS,
} from '@ontofelia/semantic-memory';
import type { SparqlResult, RdfTerm } from '@ontofelia/core';
import memoryRoutes from '../memory.js';
import type { GatewayContext } from '../../context.js';
import { httpReadableGraphs } from '../../sparqlGuard.js';

/**
 * Privacy of POST /api/knowledge/sparql.
 *
 * The caller is whoever holds the gateway bearer token; the token does not say
 * which user a query is for. So the endpoint serves only graphs that hold no
 * non-owner user content, and everything else is refused for every caller:
 *
 * 1. a refusal test per graph family (every family that exists on the branch),
 * 2. positive controls for the allowed families,
 * 3. a canary: a private fact, message and trace of user B are written with the
 *    real writers, and no query shape may return them.
 */

const AGENT = 'ontofelia';
const R = GraphUriResolver;
const EX = 'http://example.org/';

/** Every graph family on the branch that must be refused, with a concrete IRI. */
const REFUSED: Array<[string, string]> = [
  ['claims', R.getClaimsGraph(AGENT)],
  ['evidence', R.getEvidenceGraph(AGENT)],
  ['conflicts', R.getConflictsGraph(AGENT)],
  ['shared claims', SHARED_GRAPHS.CLAIMS],
  ['shared evidence', SHARED_GRAPHS.EVIDENCE],
  ['setup', R.getSetupGraph(AGENT)],
  ['approved ontology', R.getOntologyGraph(AGENT)],
  ['cog episodic', R.getCogEpisodicGraph(AGENT)],
  ['cog procedural', R.getCogProceduralGraph(AGENT)],
  ['cog meta', R.getCogMetaGraph(AGENT)],
  ['cog goals longterm', R.getCogGoalsLongtermGraph(AGENT)],
  ['cog goals session', R.getCogGoalsSessionGraph(AGENT, 'sess1')],
  ['cog cycles', R.getCogCyclesGraph(AGENT, 'sess1')],
  ['cog working', R.getCogWorkingGraph(AGENT, 'sess1', 'cycle1')],
  ['user', R.getUserGraph(AGENT, 'owner')],
  ['user (non-owner)', R.getUserGraph(AGENT, 'userb')],
  ['inferred user', R.getUserInferredGraph(AGENT, 'userb')],
  ['session', R.getSessionGraph(AGENT, 'sess1')],
  ['unknown graph', 'urn:ontofelia:not-a-registered-graph'],
  ['other agent claims', R.getClaimsGraph('other')],
  ['other agent user', R.getUserGraph('other', 'userb')],
  ['other agent episodic', R.getCogEpisodicGraph('other')],
];

/** Families the endpoint serves, with a concrete IRI each. */
const ALLOWED: Array<[string, string]> = [
  ['shared ontology', SHARED_GRAPHS.ONTOLOGY],
  ['shared meta', SHARED_GRAPHS.META],
  ['shared shapes', SHARED_GRAPHS.SHAPES],
  ['shared world', SHARED_GRAPHS.WORLD],
  ['worldview', R.getWorldviewGraph(AGENT)],
  ['schema', R.getSchemaGraph(AGENT)],
  ['inferred (shared)', R.getInferredGraph(AGENT)],
  ['self', R.getSelfGraph(AGENT)],
  ['skills', R.getSkillsGraph(AGENT)],
];

/** Query shapes that name one graph IRI in every way the endpoint accepts. */
function shapesFor(iri: string): Array<[string, string]> {
  const body = `?s ?p ?o`;
  return [
    ['GRAPH <iri>', `SELECT * WHERE { GRAPH <${iri}> { ${body} } }`],
    ['FROM <iri>', `SELECT * FROM <${iri}> WHERE { ${body} }`],
    ['FROM NAMED + GRAPH <iri>', `SELECT * FROM NAMED <${iri}> WHERE { GRAPH <${iri}> { ${body} } }`],
    ['ASK GRAPH <iri>', `ASK { GRAPH <${iri}> { ${body} } }`],
    ['nested SELECT', `SELECT * WHERE { { SELECT * WHERE { GRAPH <${iri}> { ${body} } } } }`],
    ['UNION', `SELECT * WHERE { { GRAPH <${EX}none> { ${body} } } UNION { GRAPH <${iri}> { ${body} } } }`],
    ['OPTIONAL', `SELECT * WHERE { GRAPH <${SHARED_GRAPHS.ONTOLOGY}> { ?a ?b ?c } OPTIONAL { GRAPH <${iri}> { ${body} } } }`],
    ['FILTER EXISTS', `SELECT * WHERE { GRAPH <${SHARED_GRAPHS.ONTOLOGY}> { ?s ?p ?o FILTER EXISTS { GRAPH <${iri}> { ?s ?x ?y } } } }`],
    ['MINUS', `SELECT * WHERE { GRAPH <${SHARED_GRAPHS.ONTOLOGY}> { ?s ?p ?o } MINUS { GRAPH <${iri}> { ?s ?x ?y } } }`],
  ];
}

describe('refusal per graph family (fastify + embedded oxigraph)', () => {
  let app: FastifyInstance;
  let store: OxigraphAdapter;
  let dataDir: string;
  const post = (query: string) =>
    app.inject({ method: 'POST', url: '/api/knowledge/sparql', payload: { query } });

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sparql-priv-'));
    store = new OxigraphAdapter();
    await store.initialize({ backend: 'oxigraph', type: 'embedded', dataDir, port: 0, endpoint: '' });
    for (const [, iri] of [...REFUSED, ...ALLOWED]) {
      await store.insertTriples(iri, [{ subject: EX + 'row', predicate: EX + 'in', object: { value: iri } }]);
    }
    app = Fastify();
    await app.register(memoryRoutes, { triplestore: store } as unknown as GatewayContext);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('positive control: the store really holds a row in every graph, refused or not', async () => {
    for (const [name, iri] of [...REFUSED, ...ALLOWED]) {
      const direct = await store.query(`SELECT ?o WHERE { GRAPH <${iri}> { <${EX}row> <${EX}in> ?o } }`);
      expect(direct.bindings?.map((b) => b.o.value), name).toEqual([iri]);
    }
  });

  for (const [name, iri] of REFUSED) {
    it(`refuses ${name} in every query shape with 403`, async () => {
      for (const [shape, query] of shapesFor(iri)) {
        const res = await post(query);
        expect(res.statusCode, `${name} / ${shape}`).toBe(403);
        expect(res.body, `${name} / ${shape}`).not.toContain(`"value":"${iri}"`);
      }
    });
  }

  for (const [name, iri] of ALLOWED) {
    it(`serves ${name}`, async () => {
      const res = await post(`SELECT ?o WHERE { GRAPH <${iri}> { <${EX}row> <${EX}in> ?o } }`);
      expect(res.statusCode).toBe(200);
      expect(res.json().bindings).toEqual([{ o: expect.objectContaining({ value: iri }) }]);
      const viaFrom = await post(`SELECT ?o FROM <${iri}> WHERE { <${EX}row> <${EX}in> ?o }`);
      expect(viaFrom.statusCode).toBe(200);
      expect(viaFrom.json().bindings).toHaveLength(1);
    });
  }

  it('names every family of the graph registry and of GraphUriResolver exactly once', () => {
    // The two lists above must cover what exists: a graph builder added later
    // without a decision fails here instead of silently being refused or served.
    const registry = GraphRegistry.create([AGENT]).listAllowed();
    const decided = new Set([...REFUSED, ...ALLOWED].map(([, iri]) => iri));
    const shape = (u: string) => u.replace(/<[a-zA-Z]+>/g, '*');
    const decidedShapes = new Set<string>();
    for (const iri of decided) {
      decidedShapes.add(iri);
      decidedShapes.add(iri.replace(/(user|session):[^:]+$/, '$1:*').replace(/working:[^:]+:[^:]+$/, 'working:*:*').replace(/(goals|cycles):sess1$/, '$1:*'));
    }
    for (const entry of registry) {
      const s = shape(entry);
      const hit = decidedShapes.has(entry) || [...decidedShapes].some((d) => shape(d) === s);
      expect(hit, `graph family ${entry} has no refuse/allow decision in this test`).toBe(true);
    }
  });

  it('the allowlist is exactly the ALLOWED list for the primary agent', () => {
    expect([...httpReadableGraphs([AGENT])].sort()).toEqual(ALLOWED.map(([, iri]) => iri).sort());
  });

  it('refuses graph spellings that resolve to a refused graph', async () => {
    const claims = R.getClaimsGraph(AGENT);
    const queries = [
      // prefixed name
      `PREFIX g: <urn:${AGENT}:> SELECT * WHERE { GRAPH g:claims { ?s ?p ?o } }`,
      // relative IRI against BASE
      `BASE <urn:${AGENT}:> SELECT * WHERE { GRAPH <claims> { ?s ?p ?o } }`,
      // numeric escape inside the IRI
      `SELECT * WHERE { GRAPH <urn:${AGENT}:\\u0063laims> { ?s ?p ?o } }`,
      // other case of the scheme
      `SELECT * WHERE { GRAPH <URN:${AGENT}:claims> { ?s ?p ?o } }`,
      `SELECT * WHERE { GRAPH <${claims}> { ?s ?p ?o } } `,
    ];
    for (const q of queries) {
      const res = await post(q);
      expect([400, 403], q).toContain(res.statusCode);
      expect(res.body, q).not.toContain(`"value":"${claims}"`);
    }
  });

  it('refuses variable graphs in all forms, including VALUES ?g', async () => {
    const claims = R.getClaimsGraph(AGENT);
    for (const q of [
      'SELECT * WHERE { GRAPH ?g { ?s ?p ?o } }',
      `SELECT * WHERE { VALUES ?g { <${claims}> } GRAPH ?g { ?s ?p ?o } }`,
      `SELECT * WHERE { GRAPH ?g { ?s ?p ?o } VALUES ?g { <${claims}> } }`,
      `SELECT * FROM NAMED <${SHARED_GRAPHS.ONTOLOGY}> WHERE { GRAPH ?g { ?s ?p ?o } }`,
      `SELECT * WHERE { { SELECT * WHERE { GRAPH ?g { ?s ?p ?o } } } }`,
      `SELECT ?g WHERE { GRAPH ?g { ?s ?p ?o } } GROUP BY ?g`,
    ]) {
      const res = await post(q);
      expect(res.statusCode, q).toBe(403);
    }
  });

  it('keeps the original refusals: SERVICE 400, updates 400, graph-less patterns 400', async () => {
    expect((await post(`SELECT * WHERE { SERVICE <http://example.org/s> { ?s ?p ?o } }`)).statusCode).toBe(400);
    expect((await post(`DROP GRAPH <${R.getClaimsGraph(AGENT)}>`)).statusCode).toBe(400);
    expect((await post(`SELECT * WHERE { ?s ?p ?o }`)).statusCode).toBe(400);
    // the refused data survived
    const direct = await store.query(`ASK { GRAPH <${R.getClaimsGraph(AGENT)}> { ?s ?p ?o } }`);
    expect(direct.boolean).toBe(true);
  });

  it('refuses another agent\'s graphs unless that agent exists on the gateway', async () => {
    const other = R.getWorldviewGraph('second');
    await store.insertTriples(other, [{ subject: EX + 'row', predicate: EX + 'in', object: { value: 'second' } }]);
    const q = `ASK { GRAPH <${other}> { ?s ?p ?o } }`;
    expect((await post(q)).statusCode).toBe(403);

    const app2 = Fastify();
    await app2.register(memoryRoutes, {
      triplestore: store,
      agents: new Map([['second', {}]]),
    } as unknown as GatewayContext);
    await app2.ready();
    const res = await app2.inject({ method: 'POST', url: '/api/knowledge/sparql', payload: { query: q } });
    expect(res.statusCode).toBe(200);
    // ...but never that agent's private graphs
    const priv = await app2.inject({
      method: 'POST', url: '/api/knowledge/sparql',
      payload: { query: `ASK { GRAPH <${R.getClaimsGraph('second')}> { ?s ?p ?o } }` },
    });
    expect(priv.statusCode).toBe(403);
    await app2.close();
  });
});

// ── Canary ───────────────────────────────────────────────────────────

const USER_B = 'telegram:222';
const CANARY_FACT = 'CANARY-FACT-b7f3c1';
const CANARY_SPAN = 'CANARY-SPAN-4e9a02 my diagnosis is secret';
const CANARY_EPISODE = 'CANARY-EPISODE-91d6aa';
const CANARY_CHAT = 'CANARY-CHAT-33c8be';
const CANARY_GOAL = 'CANARY-GOAL-5a17d4';
const CANARY_TRACE = 'CANARY-TRACE-c20f68';
const CANARIES = [CANARY_FACT, CANARY_SPAN.split(' ')[0], CANARY_EPISODE, CANARY_CHAT, CANARY_GOAL, CANARY_TRACE];

/** Every query shape that could return a stored canary, against every graph that holds one. */
function canaryQueries(graphs: string[]): Array<[string, string]> {
  const out: Array<[string, string]> = [
    ['GRAPH ?g', 'SELECT * WHERE { GRAPH ?g { ?s ?p ?o } }'],
    ['GRAPH ?g with filter', 'SELECT ?o WHERE { GRAPH ?g { ?s ?p ?o FILTER(CONTAINS(STR(?o), "CANARY")) } }'],
    ['default graph', 'SELECT * WHERE { ?s ?p ?o }'],
    ['default graph filter', 'SELECT ?o WHERE { ?s ?p ?o FILTER(CONTAINS(STR(?o), "CANARY")) }'],
    ['default graph ASK', 'ASK { ?s ?p ?o FILTER(CONTAINS(STR(?o), "CANARY")) }'],
    ['nested SELECT ?g', 'SELECT * WHERE { { SELECT * WHERE { GRAPH ?g { ?s ?p ?o } } } }'],
    ['FROM NAMED + GRAPH ?g', `SELECT * FROM NAMED <${SHARED_GRAPHS.ONTOLOGY}> WHERE { GRAPH ?g { ?s ?p ?o } }`],
    ['VALUES ?g', `SELECT * WHERE { VALUES ?g { ${graphs.map((g) => `<${g}>`).join(' ')} } GRAPH ?g { ?s ?p ?o } }`],
    ['graph listing', 'SELECT DISTINCT ?g WHERE { GRAPH ?g { ?s ?p ?o } }'],
  ];
  for (const g of graphs) out.push(...shapesFor(g).map(([n, q]) => [`${n} ${g}`, q] as [string, string]));
  return out;
}

/** N-Quads graph IRIs of every line that contains a canary token. */
function graphsHoldingCanary(nq: string): string[] {
  const graphs = new Set<string>();
  for (const line of nq.split('\n')) {
    if (!CANARIES.some((c) => line.includes(c))) continue;
    const m = /<([^>]+)>\s*\.\s*$/.exec(line);
    if (m) graphs.add(m[1]);
  }
  return [...graphs].sort();
}

describe('canary: a private fact of user B never leaves through any query shape (full gateway)', () => {
  let fastify: FastifyInstance;
  let agent: AgentRuntime | undefined;
  let heldGraphs: string[] = [];
  let allGraphs: string[] = [];
  const realHome = process.env.HOME;
  let tmpHome: string;
  const auth = { authorization: 'Bearer test-secret' };
  const sparql = (query: string) =>
    fastify.inject({ method: 'POST', url: '/api/knowledge/sparql', headers: auth, payload: { query } });

  beforeAll(async () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sparql-canary-'));
    process.env.HOME = tmpHome;
    delete (globalThis as Record<symbol, unknown>)[Symbol.for('ontofelia-gateway-started')];
    const original = AgentRuntime.prototype.getState;
    vi.spyOn(AgentRuntime.prototype, 'getState').mockImplementation(function (this: AgentRuntime) {
      // eslint-disable-next-line @typescript-eslint/no-this-alias -- capture the runtime instance for seeding
      agent = this;
      return original.call(this);
    });
    const config = getDefaultConfig();
    config.gateway.token = 'test-secret';
    config.gateway.port = 0;
    config.memory.backend = 'oxigraph';
    fastify = await startGateway(config);
    await fastify.inject({ method: 'GET', url: '/api/agents', headers: auth }); // hands the runtime to the spy

    const rt = agent!;
    const store = rt['knowledgeEngine']!['triplestore'];
    // 1. Private fact of user B through the real KnowledgeEngine: user graph, claim, evidence.
    const ke = new KnowledgeEngine(store);
    const stored = await ke.storeFact(
      { subject: 'user', predicate: 'hasDiagnosis', object: CANARY_FACT, objectType: 'literal',
        sourceKind: 'user', sourceSpan: CANARY_SPAN },
      { agentId: AGENT, userId: USER_B, sessionId: 'sess-b', isOwner: false },
    );
    expect(stored.success).toBe(true);
    // 2. Episode, goal and trace of user B through the real cognitive writers.
    await new EpisodicMemory(store, AGENT).append({
      episodeType: 'message-received', sessionId: 'sess-b', forUser: USER_B, payload: CANARY_EPISODE,
    });
    await new GoalStack(store, GraphRegistry.create([AGENT]), AGENT, 'sess-b').push({
      goalType: 'urn:shared:ontology#cog/AnswerQuestion', goalLabel: CANARY_GOAL, priority: 0.5, forUser: USER_B,
    });
    await new ProceduralMemory(store, AGENT).recordTrace({
      toolName: 'web_search', toolArgsHash: 'h1', toolArgsBrief: CANARY_TRACE, executedAt: new Date(),
      durationMs: 5, outcome: 'success', sequencePos: 1, forUser: USER_B, sessionId: 'sess-b',
    });
    // 3. A real turn of user B through the runtime (mock provider): episodes,
    //    working memory, cycle and the other cog graphs the cycle writes.
    const chat = await fastify.inject({
      method: 'POST', url: '/api/chat', headers: auth,
      payload: { message: `${CANARY_CHAT} please remember my secret`, senderId: USER_B, channel: 'telegram', sessionId: 'sess-b2' },
    });
    expect(chat.statusCode).toBe(200);

    // The cycle persists its graphs (cycles, working memory) after the reply; wait for them.
    const dataset = path.join(tmpHome, '.ontofelia', 'triplestore', 'oxigraph', 'dataset.nq');
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && !fs.readFileSync(dataset, 'utf-8').includes(`<urn:${AGENT}:cog:cycles:`)) {
      await new Promise((r) => setTimeout(r, 100));
    }
    heldGraphs = graphsHoldingCanary(fs.readFileSync(dataset, 'utf-8'));
    allGraphs = [...new Set(fs.readFileSync(dataset, 'utf-8').split('\n')
      .map((l) => /<([^>]+)>\s*\.\s*$/.exec(l)?.[1]).filter((g): g is string => !!g))].sort();
  }, 60000);

  afterAll(async () => {
    vi.restoreAllMocks();
    await fastify.close();
    process.env.HOME = realHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('positive control: the canaries really are stored, in graphs of the refused families', () => {
    // Printed so a reviewer can see which graphs the real writers put them in.
    console.log('graphs holding a canary:', heldGraphs.join(', '));
    console.log('all graphs in the store:', allGraphs.join(', '));
    const A = AGENT;
    for (const g of [
      R.getUserGraph(A, USER_B), R.getClaimsGraph(A), R.getEvidenceGraph(A),
      R.getCogEpisodicGraph(A), R.getCogGoalsSessionGraph(A, 'sess-b'), R.getCogProceduralGraph(A),
    ]) {
      expect(heldGraphs, g).toContain(g);
    }
    const allowed = httpReadableGraphs([A]);
    for (const g of heldGraphs) expect(allowed.has(g), `${g} must not be allowed`).toBe(false);
  });

  it('positive control: a query that leaks WOULD return the canary (store read, not the endpoint)', async () => {
    const store = agent!['knowledgeEngine']!['triplestore'];
    const direct = await store.query(`SELECT ?o WHERE { GRAPH <${R.getUserGraph(AGENT, USER_B)}> { ?s ?p ?o } }`);
    expect(JSON.stringify(direct)).toContain(CANARY_FACT);
  });

  it('no query shape returns any canary, and every one is refused with 4xx', async () => {
    const queries = canaryQueries(heldGraphs);
    expect(queries.length).toBeGreaterThan(50);
    for (const [shape, query] of queries) {
      const res = await sparql(query);
      expect(res.statusCode, shape).toBeGreaterThanOrEqual(400);
      expect(res.statusCode, shape).toBeLessThan(500);
      for (const c of CANARIES) expect(res.body, `${shape} leaked ${c}`).not.toContain(c);
    }
  });

  it('every graph the real boot and the real turn created is decided: allowed ones answer, all others are refused', async () => {
    const allowed = httpReadableGraphs([AGENT]);
    expect(allGraphs.length).toBeGreaterThan(12);
    const refused = allGraphs.filter((g) => !allowed.has(g));
    // The families a real turn creates, beyond the canary writers. cog:meta is
    // not listed: the cycle writes it only on some turns and after the reply.
    for (const prefix of ['cog:cycles:', 'cog:working:', 'setup', 'inferred:user:', 'session:']) {
      expect(refused.some((g) => g.startsWith(`urn:${AGENT}:${prefix}`)), prefix).toBe(true);
    }
    for (const g of allGraphs) {
      const res = await sparql(`ASK { GRAPH <${g}> { ?s ?p ?o } }`);
      expect(res.statusCode, g).toBe(allowed.has(g) ? 200 : 403);
    }
  });

  it('allowed graphs still answer, and their rows hold no canary', async () => {
    const wv = R.getWorldviewGraph(AGENT);
    for (const q of [
      `SELECT ?s ?p ?o WHERE { GRAPH <${wv}> { ?s ?p ?o } }`,
      `SELECT ?s ?p ?o FROM <${SHARED_GRAPHS.META}> WHERE { ?s ?p ?o }`,
      `SELECT ?s ?p ?o WHERE { GRAPH <${SHARED_GRAPHS.ONTOLOGY}> { ?s ?p ?o } }`,
      `SELECT ?s ?p ?o WHERE { GRAPH <${R.getSelfGraph(AGENT)}> { ?s ?p ?o } }`,
      `SELECT ?s ?p ?o WHERE { GRAPH <${R.getInferredGraph(AGENT)}> { ?s ?p ?o } }`,
    ]) {
      const res = await sparql(q);
      expect(res.statusCode, q).toBe(200);
      for (const c of CANARIES) expect(res.body, q).not.toContain(c);
    }
    const meta = await sparql(`SELECT ?s WHERE { GRAPH <${SHARED_GRAPHS.META}> { ?s ?p ?o } } LIMIT 1`);
    expect(meta.json().bindings.length).toBe(1);
  });

  it('the token is still required', async () => {
    const res = await fastify.inject({ method: 'POST', url: '/api/knowledge/sparql', payload: { query: 'ASK { GRAPH <urn:shared:meta> { ?s ?p ?o } }' } });
    expect(res.statusCode).toBe(401);
  });
});

// ── Backend whose default graph is the union of all graphs ────────────

class UnionDefaultGraphAdapter extends OxigraphAdapter {
  async query(sparql: string): Promise<SparqlResult> {
    const store = (this as unknown as { store: { query(q: string, o?: { use_default_graph_as_union?: boolean }): unknown } }).store;
    const result = store.query(sparql, { use_default_graph_as_union: true });
    if (typeof result === 'boolean') return { type: 'boolean', boolean: result };
    const rows = result as Map<string, { termType: string; value: string }>[];
    const bindings = rows.map((row) => {
      const out: Record<string, RdfTerm> = {};
      for (const [key, term] of row.entries()) {
        out[key] = { type: term.termType === 'NamedNode' ? 'uri' : term.termType === 'BlankNode' ? 'bnode' : 'literal', value: term.value };
      }
      return out;
    });
    return { type: 'bindings', variables: rows.length ? [...rows[0].keys()] : [], bindings };
  }
}

describe('canary on a backend whose default graph is the union (fuseki unionDefaultGraph-like)', () => {
  let app: FastifyInstance;
  let store: UnionDefaultGraphAdapter;
  let dataDir: string;
  const post = (query: string) =>
    app.inject({ method: 'POST', url: '/api/knowledge/sparql', payload: { query } });

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sparql-union-priv-'));
    store = new UnionDefaultGraphAdapter();
    await store.initialize({ backend: 'oxigraph', type: 'embedded', dataDir, port: 0, endpoint: '' });
    const ke = new KnowledgeEngine(store);
    await ke.storeFact(
      { subject: 'user', predicate: 'hasDiagnosis', object: CANARY_FACT, objectType: 'literal',
        sourceKind: 'user', sourceSpan: CANARY_SPAN },
      { agentId: AGENT, userId: USER_B, sessionId: 'sess-b', isOwner: false },
    );
    await new EpisodicMemory(store, AGENT).append({
      episodeType: 'message-received', sessionId: 'sess-b', forUser: USER_B, payload: CANARY_EPISODE,
    });
    app = Fastify();
    await app.register(memoryRoutes, { triplestore: store, sparqlExecutor: undefined } as unknown as GatewayContext);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('positive control: the union default graph really exposes the canary to a graph-less query', async () => {
    const direct = await store.query('SELECT ?o WHERE { ?s ?p ?o FILTER(CONTAINS(STR(?o), "CANARY-FACT")) }');
    expect(JSON.stringify(direct)).toContain(CANARY_FACT);
  });

  it('refuses every shape that would read it', async () => {
    const graphs = [R.getUserGraph(AGENT, USER_B), R.getClaimsGraph(AGENT), R.getEvidenceGraph(AGENT), R.getCogEpisodicGraph(AGENT)];
    for (const [shape, query] of canaryQueries(graphs)) {
      const res = await post(query);
      expect(res.statusCode, shape).toBeGreaterThanOrEqual(400);
      expect(res.statusCode, shape).toBeLessThan(500);
      for (const c of CANARIES) expect(res.body, `${shape} leaked ${c}`).not.toContain(c);
    }
  });
});
