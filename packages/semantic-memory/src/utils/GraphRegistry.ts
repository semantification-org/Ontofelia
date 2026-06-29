/**
 * GraphRegistry — the single source of truth for which Named Graphs may exist.
 *
 * Per docs/knowledge-graph-concept.md, the triplestore topology is fixed.
 * Neither the LLM nor a buggy code path may invent new Named Graphs: every
 * write must target a graph that this registry recognises.
 *
 * The registry is built from {@link GraphUriResolver}, so the canonical URI
 * patterns are defined in exactly one place. When a new agent is created,
 * call {@link registerAgent} — that is the *only* supported way to widen the
 * whitelist.
 *
 * Validation is intentionally strict: an unknown graph throws a
 * {@link GraphPolicyError} whose message is written to be read back by the
 * LLM, telling it which graphs are allowed.
 */

import { GraphUriResolver, SHARED_GRAPHS } from './GraphUriResolver.js';

/**
 * Thrown when a write targets a graph that is not in the whitelist.
 *
 * The message is deliberately LLM-facing: when surfaced as a tool error it
 * tells the model the write was rejected and which graphs it may use.
 */
export class GraphPolicyError extends Error {
  readonly code = 'GRAPH_POLICY_VIOLATION';
  /** The non-conformant graph URI that triggered the rejection. */
  readonly attemptedGraph: string;
  /** The whitelist that was in effect, for diagnostics and LLM guidance. */
  readonly allowedGraphs: string[];

  constructor(attemptedGraph: string, allowedGraphs: string[]) {
    super(
      `Rejected write to "${attemptedGraph}": this is not a registered Named Graph. ` +
        `Ontofelia's triplestore topology is fixed — inventing new Named Graphs is not allowed. ` +
        `You must write into one of the registered graphs:\n` +
        allowedGraphs.map((g) => `  - <${g}>`).join('\n') +
        `\nSee docs/knowledge-graph-concept.md for the meaning of each graph. ` +
        `Per-session and per-user graphs (urn:<agent>:session:<id>, urn:<agent>:user:<id>) ` +
        `are also valid for registered agents.`,
    );
    this.name = 'GraphPolicyError';
    this.attemptedGraph = attemptedGraph;
    this.allowedGraphs = allowedGraphs;
  }
}

/** Logical role of a graph — used by callers to reason about write policy. */
export type GraphRole =
  | 'shared' // urn:shared:* — agent-agnostic, admin/consolidation only
  | 'self' // urn:<agent>:self
  | 'skills' // urn:<agent>:skills
  | 'setup' // urn:<agent>:setup
  | 'claims' // urn:<agent>:claims
  | 'evidence' // urn:<agent>:evidence
  | 'worldview' // urn:<agent>:worldview
  | 'schema' // urn:<agent>:schema — agent-local predicate definitions
  | 'conflicts' // urn:<agent>:conflicts
  | 'inferred' // urn:<agent>:inferred — reasoner materialization target
  | 'user' // urn:<agent>:user:<userId> — parameterised
  | 'session' // urn:<agent>:session:<sessionId> — parameterised
  // ── Cognitive architecture graphs (docs/cognitive-architecture/02) ──
  | 'cog-episodic' // urn:<agent>:cog:episodic — fixed
  | 'cog-procedural' // urn:<agent>:cog:procedural — fixed
  | 'cog-meta' // urn:<agent>:cog:meta — fixed
  | 'cog-working' // urn:<agent>:cog:working:<sess>:<cycle> — parameterised
  | 'cog-goals' // urn:<agent>:cog:goals:<sess> | :longterm — parameterised
  | 'cog-cycles'; // urn:<agent>:cog:cycles:<sess> — parameterised

export interface GraphDescriptor {
  uri: string;
  role: GraphRole;
  /** The owning agent, or null for shared graphs. */
  agentId: string | null;
  /**
   * True for graphs whose URI carries a free identifier (user/session).
   * These are validated by URI *pattern* rather than exact membership.
   */
  parameterised: boolean;
}

/**
 * `urn:<agent>:` is the agent-scoped namespace. The `<agent>` segment must be
 * a lowercase identifier (see knowledge-graph-concept.md §1).
 */
const AGENT_ID_PATTERN = /^[a-z][a-z0-9_-]*$/;

/**
 * Parameterised cognitive graphs (docs/cognitive-architecture/02):
 *   urn:<agent>:cog:working:<sessionId>:<cycleId>
 *   urn:<agent>:cog:goals:<sessionId>     (sessionId may be the reserved "longterm")
 *   urn:<agent>:cog:cycles:<sessionId>
 * Group 1 = agent, 2 = kind, 3 = first scope, 4 = optional cycleId (working only).
 */
const COG_PARAM = /^urn:([a-z][a-z0-9_-]*):cog:(working|goals|cycles):([^:]+)(?::([^:]+))?$/;

export class GraphRegistry {
  /** Exact-match graphs, keyed by URI. */
  private readonly exact = new Map<string, GraphDescriptor>();
  /** Agents whose parameterised user:/session: graphs are accepted. */
  private readonly agents = new Set<string>();

  private constructor() {}

  /**
   * Build a registry seeded with the shared graphs and the given agents.
   * Pass every agent that currently exists in the installation.
   */
  static create(agentIds: string[] = ['ontofelia']): GraphRegistry {
    const registry = new GraphRegistry();

    // Shared layer — fixed, agent-agnostic.
    for (const uri of Object.values(SHARED_GRAPHS)) {
      registry.exact.set(uri, {
        uri,
        role: 'shared',
        agentId: null,
        parameterised: false,
      });
    }

    for (const agentId of agentIds) {
      registry.registerAgent(agentId);
    }
    return registry;
  }

  /**
   * Widen the whitelist for a newly created agent. This is the single
   * supported entry point for extending the registry — call it whenever a
   * new agent is provisioned.
   */
  registerAgent(agentId: string): void {
    if (!AGENT_ID_PATTERN.test(agentId)) {
      throw new GraphPolicyError(
        `urn:${agentId}:*`,
        this.listAllowed(),
      );
    }
    this.agents.add(agentId);

    const fixed: Array<[string, GraphRole]> = [
      [GraphUriResolver.getSelfGraph(agentId), 'self'],
      [GraphUriResolver.getSkillsGraph(agentId), 'skills'],
      [GraphUriResolver.getSetupGraph(agentId), 'setup'],
      [GraphUriResolver.getClaimsGraph(agentId), 'claims'],
      [GraphUriResolver.getEvidenceGraph(agentId), 'evidence'],
      [GraphUriResolver.getWorldviewGraph(agentId), 'worldview'],
      [GraphUriResolver.getSchemaGraph(agentId), 'schema'],
      [GraphUriResolver.getConflictsGraph(agentId), 'conflicts'],
      [GraphUriResolver.getInferredGraph(agentId), 'inferred'],
      // Cognitive architecture — fixed graphs.
      [GraphUriResolver.getCogEpisodicGraph(agentId), 'cog-episodic'],
      [GraphUriResolver.getCogProceduralGraph(agentId), 'cog-procedural'],
      [GraphUriResolver.getCogMetaGraph(agentId), 'cog-meta'],
    ];
    for (const [uri, role] of fixed) {
      this.exact.set(uri, { uri, role, agentId, parameterised: false });
    }
  }

  /** True if `agentId` has been registered. */
  hasAgent(agentId: string): boolean {
    return this.agents.has(agentId);
  }

  /** Every exact-match graph URI currently allowed. */
  listAllowed(): string[] {
    const exact = [...this.exact.keys()];
    // Add representative patterns for the parameterised graphs.
    const patterns: string[] = [];
    for (const agentId of this.agents) {
      patterns.push(`urn:${agentId}:user:<userId>`);
      patterns.push(`urn:${agentId}:session:<sessionId>`);
      patterns.push(`urn:${agentId}:cog:working:<sessionId>:<cycleId>`);
      patterns.push(`urn:${agentId}:cog:goals:<sessionId>`);
      patterns.push(`urn:${agentId}:cog:cycles:<sessionId>`);
    }
    return [...exact, ...patterns].sort();
  }

  /**
   * Classify a graph URI without throwing. Returns a descriptor when the URI
   * is conformant, or null when it is not.
   */
  describe(graphUri: string): GraphDescriptor | null {
    const exact = this.exact.get(graphUri);
    if (exact) return exact;

    // Parameterised cognitive graphs: cog:working:<sess>:<cycle>,
    // cog:goals:<sess>, cog:cycles:<sess>. Checked before the generic
    // user/session matcher because `cog:` is a distinct sub-namespace.
    const cog = COG_PARAM.exec(graphUri);
    if (cog) {
      const [, agentId, kind, scope, cycleId] = cog;
      // `working` graphs require both a session and a cycle scope; `goals`
      // and `cycles` take exactly one scope. Reject malformed shapes.
      const wellFormed = kind === 'working' ? cycleId !== undefined : cycleId === undefined;
      if (this.agents.has(agentId) && scope.length > 0 && wellFormed) {
        const role: GraphRole =
          kind === 'working' ? 'cog-working' : kind === 'goals' ? 'cog-goals' : 'cog-cycles';
        return { uri: graphUri, role, agentId, parameterised: true };
      }
      return null;
    }

    // Parameterised graphs: urn:<agent>:user:<id> / urn:<agent>:session:<id>.
    const m = /^urn:([a-z][a-z0-9_-]*):(user|session):(.+)$/.exec(graphUri);
    if (m) {
      const [, agentId, kind, ident] = m;
      if (this.agents.has(agentId) && ident.length > 0) {
        return {
          uri: graphUri,
          role: kind === 'user' ? 'user' : 'session',
          agentId,
          parameterised: true,
        };
      }
    }
    return null;
  }

  /** True if a write to `graphUri` is permitted. */
  isAllowed(graphUri: string): boolean {
    return this.describe(graphUri) !== null;
  }

  /**
   * Assert that `graphUri` may be written to. Throws {@link GraphPolicyError}
   * — whose message is LLM-readable — when it may not.
   *
   * This is the chokepoint: every write path must call it before touching
   * the triplestore.
   */
  assertWritable(graphUri: string): GraphDescriptor {
    const descriptor = this.describe(graphUri);
    if (!descriptor) {
      throw new GraphPolicyError(graphUri, this.listAllowed());
    }
    return descriptor;
  }
}
