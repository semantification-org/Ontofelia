/**
 * Allowlist guard for SPARQL queries written by the model.
 *
 * The embedded store keeps all data in named graphs, and a query may name any
 * of them, so the graphs a query touches must be limited to the ones the
 * current sender may read. The guard parses the query (`sparqljs`) and walks
 * the whole AST, so nested groups, OPTIONAL, UNION, MINUS, subqueries and
 * FILTER (NOT) EXISTS are all visited.
 *
 * Refused:
 * - updates, unparsable queries (fail closed) and `SERVICE` anywhere,
 * - `GRAPH ?var` (it can enumerate every graph),
 * - any graph IRI (in `GRAPH`, `FROM`, `FROM NAMED`) that is not allowed,
 * - triple patterns outside any `GRAPH`, unless the query has a `FROM` clause
 *   whose graphs are all allowed (some backends expose the union of all graphs
 *   as the default graph); `DESCRIBE` needs the same cover.
 */
import { Parser } from 'sparqljs';
import { GraphUriResolver, SHARED_GRAPHS } from '../utils/GraphUriResolver.js';

export interface SparqlScope {
  /** Exact graph IRIs the query may name. */
  allowedGraphs: readonly string[];
  /** Graph IRI prefixes the query may name (for graphs with an open suffix). */
  allowedGraphPrefixes?: readonly string[];
  /** Agent id, used in messages only; the allowlist itself carries the URIs. */
  agentId?: string;
}

export type SparqlScopeResult =
  | { ok: true }
  | { ok: false; message: string; graph?: string };

type Node = Record<string, unknown>;

const isNode = (v: unknown): v is Node => typeof v === 'object' && v !== null;

const USE_GRAPH_HINT = 'Use an explicit GRAPH <iri> pattern with one of the allowed graphs.';

/**
 * The graphs one sender may read in a given session.
 *
 * Everyone: shared vocabulary (`urn:shared:{ontology,meta,shapes,world}`), the
 * agent's worldview and schema, the shared inferred graph, and the sender's own
 * user graph, own inferred graph and current session graph. Never another
 * user's.
 *
 * Owner only: the agent's internal state (`self`, `skills`, `setup`,
 * `cog:meta`, `cog:procedural`, `cog:goals:*`, `cog:cycles:<session>`,
 * `cog:working:<session>:*`).
 *
 * Never, for anyone: `urn:<agent>:claims`, `evidence`, `conflicts`,
 * `cog:episodic`, `urn:shared:claims`, `urn:shared:evidence`. They are
 * agent-wide and hold other users' private data (claims point at facts in any
 * user's graph, evidence holds the original sentences, episodes hold inbound
 * messages, conflicts reference superseded claims). The scoped tools
 * (memory_ask, memory_explain, recall) are the way to reach claims.
 */
export function getQueryableGraphScope(
  agentId: string,
  who: { userId?: string; sessionId?: string; isOwner?: boolean },
): Required<Pick<SparqlScope, 'allowedGraphs' | 'allowedGraphPrefixes'>> {
  const R = GraphUriResolver;
  const graphs = [
    SHARED_GRAPHS.ONTOLOGY,
    SHARED_GRAPHS.META,
    SHARED_GRAPHS.SHAPES,
    SHARED_GRAPHS.WORLD,
    R.getWorldviewGraph(agentId),
    R.getSchemaGraph(agentId),
    ...R.getReadableInferredGraphs(agentId, who.userId),
  ];
  const prefixes: string[] = [];
  if (who.userId) graphs.push(R.getUserGraph(agentId, who.userId));
  if (who.sessionId) graphs.push(R.getSessionGraph(agentId, who.sessionId));
  if (who.isOwner === true) {
    graphs.push(
      R.getSelfGraph(agentId),
      R.getSkillsGraph(agentId),
      R.getSetupGraph(agentId),
      R.getCogProceduralGraph(agentId),
      R.getCogMetaGraph(agentId),
      R.getCogGoalsLongtermGraph(agentId),
    );
    if (who.sessionId) {
      graphs.push(
        R.getCogGoalsSessionGraph(agentId, who.sessionId),
        R.getCogCyclesGraph(agentId, who.sessionId),
      );
      // cog:working:<session>:<cycle> — one graph per cycle of this session.
      prefixes.push(R.getCogWorkingGraph(agentId, who.sessionId, ''));
    }
  }
  return { allowedGraphs: graphs, allowedGraphPrefixes: prefixes };
}

function isAllowed(iri: string, scope: SparqlScope): boolean {
  if (scope.allowedGraphs.includes(iri)) return true;
  return (scope.allowedGraphPrefixes ?? []).some(
    (p) => p.length > 0 && iri.startsWith(p) && iri.length > p.length,
  );
}

function checkGraphTerm(term: unknown, where: string, scope: SparqlScope): SparqlScopeResult {
  if (!isNode(term) || term.termType !== 'NamedNode' || typeof term.value !== 'string') {
    return { ok: false, message: `${where} must be a plain IRI. ${USE_GRAPH_HINT}` };
  }
  if (!isAllowed(term.value, scope)) {
    return {
      ok: false,
      graph: term.value,
      message: `${where} <${term.value}> is not a graph you may read here. ${USE_GRAPH_HINT}`,
    };
  }
  return { ok: true };
}

function visit(node: unknown, covered: boolean, scope: SparqlScope): SparqlScopeResult {
  if (Array.isArray(node)) {
    for (const item of node) {
      const r = visit(item, covered, scope);
      if (!r.ok) return r;
    }
    return { ok: true };
  }
  if (!isNode(node)) return { ok: true };

  if (node.type === 'service') {
    return { ok: false, message: 'SERVICE clauses are not allowed' };
  }

  if (node.type === 'bgp' && !covered && Array.isArray(node.triples) && node.triples.length > 0) {
    return {
      ok: false,
      message: `Triple patterns outside a GRAPH pattern are not allowed. ${USE_GRAPH_HINT}`,
    };
  }

  if (node.type === 'graph') {
    if (isNode(node.name) && node.name.termType === 'Variable') {
      return { ok: false, message: `GRAPH with a variable graph name is not allowed. ${USE_GRAPH_HINT}` };
    }
    const r = checkGraphTerm(node.name, 'GRAPH', scope);
    if (!r.ok) return r;
    return visit(node.patterns, true, scope);
  }

  if (isNode(node.from)) {
    for (const key of ['default', 'named'] as const) {
      const graphs = (node.from as Node)[key];
      if (Array.isArray(graphs)) {
        for (const g of graphs) {
          const r = checkGraphTerm(g, key === 'named' ? 'FROM NAMED' : 'FROM', scope);
          if (!r.ok) return r;
        }
      }
    }
  }

  for (const value of Object.values(node)) {
    const r = visit(value, covered, scope);
    if (!r.ok) return r;
  }
  return { ok: true };
}

/** Check a SPARQL query string against the allowed graphs. Never throws. */
export function checkSparqlScope(query: string, scope: SparqlScope): SparqlScopeResult {
  let ast: unknown;
  try {
    ast = new Parser().parse(query);
  } catch {
    return { ok: false, message: 'Query could not be parsed, so its graphs cannot be checked' };
  }
  if (!isNode(ast) || ast.type !== 'query') {
    return { ok: false, message: 'Only SELECT, ASK, CONSTRUCT and DESCRIBE queries are allowed' };
  }
  try {
    const from = isNode(ast.from) ? (ast.from as Node).default : undefined;
    const covered = Array.isArray(from) && from.length > 0;
    if (ast.queryType === 'DESCRIBE' && !covered) {
      return { ok: false, message: `DESCRIBE needs a FROM clause naming an allowed graph. ${USE_GRAPH_HINT}` };
    }
    return visit(ast, covered, scope);
  } catch {
    return { ok: false, message: 'Query is too deeply nested to be checked' };
  }
}
