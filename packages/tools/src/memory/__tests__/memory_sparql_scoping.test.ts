/**
 * The agent SPARQL tools may only read graphs the current sender may read.
 * Real data in an embedded Oxigraph store, queried as Alice.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ToolContext } from '@ontofelia/core';
import { OxigraphAdapter, GraphUriResolver, GraphRegistry, KnowledgeEngine } from '@ontofelia/semantic-memory';
import { MemorySparqlTool } from '../memory_sparql.js';
import { MemoryQueryTool } from '../memory_query.js';

const ctx = (agentId: string, senderId: string, isOwner = false): ToolContext => ({
  agentId, sessionId: 'sess-a', workspacePath: '/tmp', channelType: 'cli', senderId, isOwner,
}) as unknown as ToolContext;

for (const AGENT of ['ontofelia', 'maia']) {
  describe(`agent SPARQL scoping (agent id ${AGENT})`, () => {
    const R = GraphUriResolver;
    const WORLD = R.getWorldviewGraph(AGENT);
    const ALICE = R.getUserGraph(AGENT, 'alice');
    const BOB = R.getUserGraph(AGENT, 'bob');
    const BOB_INF = R.getUserInferredGraph(AGENT, 'bob');
    const ALICE_INF = R.getUserInferredGraph(AGENT, 'alice');
    const BOB_SESSION = R.getSessionGraph(AGENT, 'sess-b');
    let store: OxigraphAdapter;
    let sparql: MemorySparqlTool;
    let query: MemoryQueryTool;
    const alice = ctx(AGENT, 'alice');

    const seed = (g: string, v: string) =>
      `GRAPH <${g}> { <urn:x:s> <urn:x:p> "${v}" }`;

    beforeEach(async () => {
      store = new OxigraphAdapter();
      await store.initialize({ backend: 'oxigraph', type: 'embedded',
        dataDir: mkdtempSync(join(tmpdir(), 'sparql-scope-')), port: 0, endpoint: '' } as never);
      await store.update(`INSERT DATA {
        ${seed(WORLD, 'WorldFact')} ${seed(ALICE, 'AliceSecret')} ${seed(BOB, 'BobSecret')}
        ${seed(BOB_INF, 'BobDerived')} ${seed(ALICE_INF, 'AliceDerived')} ${seed(BOB_SESSION, 'BobSession')} }`);
      sparql = new MemorySparqlTool(store as never);
      query = new MemoryQueryTool(store as never);
    });

    const run = (q: string) => sparql.execute({ query: q }, alice);
    const rows = (res: { output: unknown }) =>
      JSON.stringify((res.output as { bindings?: unknown[] })?.bindings ?? []);

    it('refuses another user\'s graph and returns none of its data', async () => {
      const res = await run(`SELECT ?o WHERE { GRAPH <${BOB}> { ?s ?p ?o } }`);
      expect(res.success).toBe(false);
      expect(res.error).toContain(BOB);
      expect(rows(res)).not.toContain('BobSecret');
    });

    it('refuses GRAPH ?g', async () => {
      const res = await run('SELECT ?g ?o WHERE { GRAPH ?g { ?s ?p ?o } }');
      expect(res.success).toBe(false);
      expect(res.error).toMatch(/variable/i);
    });

    it('refuses another user\'s inferred graph and session graph', async () => {
      for (const g of [BOB_INF, BOB_SESSION]) {
        const res = await run(`SELECT ?o WHERE { GRAPH <${g}> { ?s ?p ?o } }`);
        expect(res.success).toBe(false);
        expect(res.error).toContain(g);
      }
    });

    it('refuses an unknown graph IRI (allowlist)', async () => {
      const res = await run('SELECT ?o WHERE { GRAPH <urn:elsewhere:thing> { ?s ?p ?o } }');
      expect(res.success).toBe(false);
    });

    it('refuses graph-less patterns without FROM, allows them with an allowed FROM', async () => {
      const bare = await run('SELECT ?o WHERE { ?s ?p ?o }');
      expect(bare.success).toBe(false);
      expect(bare.error).toMatch(/GRAPH/);
      const from = await run(`SELECT ?o FROM <${WORLD}> WHERE { ?s ?p ?o }`);
      expect(from.success).toBe(true);
      expect(rows(from)).toContain('WorldFact');
      const badFrom = await run(`SELECT ?o FROM <${BOB}> WHERE { ?s ?p ?o }`);
      expect(badFrom.success).toBe(false);
    });

    it('lets Alice read her own graphs, the worldview and shared inferred', async () => {
      for (const [g, v] of [[ALICE, 'AliceSecret'], [WORLD, 'WorldFact'], [ALICE_INF, 'AliceDerived']]) {
        const res = await run(`SELECT ?o WHERE { GRAPH <${g}> { ?s ?p ?o } }`);
        expect(res.success).toBe(true);
        expect(rows(res)).toContain(v);
      }
      const ask = await run(`ASK { GRAPH <${R.getInferredGraph(AGENT)}> { ?s ?p ?o } }`);
      expect(ask.success).toBe(true);
    });

    it('refuses evasions nested in UNION, OPTIONAL, subquery and FILTER EXISTS', async () => {
      const inner = `GRAPH <${BOB}> { ?s ?p ?o }`;
      const queries = [
        `SELECT ?o WHERE { { GRAPH <${WORLD}> { ?s ?p ?o } } UNION { ${inner} } }`,
        `SELECT ?o WHERE { GRAPH <${WORLD}> { ?s ?p ?o } OPTIONAL { ${inner} } }`,
        `SELECT ?o WHERE { { SELECT ?o WHERE { ${inner} } } }`,
        `SELECT ?o WHERE { GRAPH <${WORLD}> { ?s ?p ?o } FILTER EXISTS { ${inner} } }`,
        `SELECT ?o WHERE { GRAPH <${WORLD}> { ?s ?p ?o } FILTER NOT EXISTS { ${inner} } }`,
        `SELECT ?o WHERE { GRAPH <${WORLD}> { ?s ?p ?o } MINUS { ${inner} } }`,
        `SELECT ?o WHERE { GRAPH <${WORLD}> { ?s ?p ?o . GRAPH <${BOB}> { ?s ?p ?o2 } } }`,
      ];
      for (const q of queries) {
        const res = await run(q);
        expect(res.success, q).toBe(false);
        expect(res.error, q).toContain(BOB);
      }
    });

    it('refuses FROM NAMED of another user and SERVICE', async () => {
      const named = await run(`SELECT ?o FROM NAMED <${BOB}> WHERE { GRAPH <${BOB}> { ?s ?p ?o } }`);
      expect(named.success).toBe(false);
      const named2 = await run(`SELECT ?o FROM NAMED <${BOB}> WHERE { GRAPH <${WORLD}> { ?s ?p ?o } }`);
      expect(named2.success).toBe(false);
      const svc = await run('SELECT * WHERE { SERVICE <http://example.org/sparql> { ?s ?p ?o } }');
      expect(svc.success).toBe(false);
    });

    it('memory_query is guarded the same way', async () => {
      const bad = await query.execute({ sparql: `SELECT ?o WHERE { GRAPH <${BOB}> { ?s ?p ?o } }` }, alice);
      expect(bad.success).toBe(false);
      expect(bad.error).toContain(BOB);
      const g = await query.execute({ sparql: 'SELECT ?o WHERE { GRAPH ?g { ?s ?p ?o } }' }, alice);
      expect(g.success).toBe(false);
      const ok = await query.execute({ sparql: `SELECT ?o WHERE { GRAPH <${ALICE}> { ?s ?p ?o } }` }, alice);
      expect(ok.success).toBe(true);
      expect(rows(ok)).toContain('AliceSecret');
    });

    it('refuses agent-wide graphs that hold other users\' data, written by a real storeFact', async () => {
      await new KnowledgeEngine(store as never, undefined, GraphRegistry.create([AGENT])).storeFact(
        { subject: 'User', subjectType: 'Person', predicate: 'likes', object: 'BobPrivateFact', objectType: 'literal', sourceKind: 'user', sourceSpan: 'BobPrivateSentence' } as never,
        { agentId: AGENT, userId: 'bob', sessionId: 'sess-b', isOwner: false },
      );
      await store.update(`INSERT DATA {
        ${seed(R.getCogEpisodicGraph(AGENT), 'BobPrivateMessage')} ${seed(R.getConflictsGraph(AGENT), 'BobPrivateFact')} }`);
      const graphs = [R.getClaimsGraph(AGENT), R.getEvidenceGraph(AGENT), R.getConflictsGraph(AGENT),
        R.getCogEpisodicGraph(AGENT), 'urn:shared:claims', 'urn:shared:evidence'];
      // Control: the secret really is in the graphs a plain read reaches.
      const all = await store.query(`SELECT ?g ?o WHERE { GRAPH ?g { ?s ?p ?o } }`);
      const holders = (all.bindings ?? []).filter(b => /BobPrivate/.test(b.o.value)).map(b => b.g.value);
      expect(holders).toContain(R.getClaimsGraph(AGENT));
      expect(holders).toContain(R.getEvidenceGraph(AGENT));
      for (const g of graphs) {
        for (const tool of [sparql, query]) {
          const q = `SELECT ?s ?p ?o WHERE { GRAPH <${g}> { ?s ?p ?o } }`;
          const res = await tool.execute(tool === sparql ? { query: q } : { sparql: q }, alice);
          expect(res.success, g).toBe(false);
          expect(res.error, g).toContain(g);
          expect(JSON.stringify(res.output)).not.toMatch(/BobPrivate/);
        }
        const owner = await sparql.execute({ query: `SELECT ?o WHERE { GRAPH <${g}> { ?s ?p ?o } }` }, ctx(AGENT, 'owner', true));
        expect(owner.success, `owner ${g}`).toBe(false);
      }
    });

    it('internal state graphs are owner-only', async () => {
      const goals = R.getCogGoalsLongtermGraph(AGENT);
      await store.update(`INSERT DATA { ${seed(goals, 'AGoal')} }`);
      const q = `SELECT ?o WHERE { GRAPH <${goals}> { ?s ?p ?o } }`;
      const nonOwner = await sparql.execute({ query: q }, alice);
      expect(nonOwner.success).toBe(false);
      expect(nonOwner.error).toContain(goals);
      const owner = await sparql.execute({ query: q }, ctx(AGENT, 'owner', true));
      expect(owner.success).toBe(true);
      expect(rows(owner)).toContain('AGoal');
      for (const g of [R.getSelfGraph(AGENT), R.getSetupGraph(AGENT), R.getCogMetaGraph(AGENT), R.getSkillsGraph(AGENT)]) {
        const r = await sparql.execute({ query: `ASK { GRAPH <${g}> { ?s ?p ?o } }` }, alice);
        expect(r.success, g).toBe(false);
      }
    });
  });
}
