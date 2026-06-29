/**
 * Constants for shared graphs across all agents.
 */
export const SHARED_GRAPHS = {
  ONTOLOGY: 'urn:shared:ontology',
  META: 'urn:shared:meta',
  SHAPES: 'urn:shared:shapes',
  WORLD: 'urn:shared:world',
  CLAIMS: 'urn:shared:claims',
  EVIDENCE: 'urn:shared:evidence',
};

/**
 * Utility class to resolve Named Graph URIs according to the Ontofelia Knowledge Graph Concept.
 */
export class GraphUriResolver {
  /**
   * Agent identity and persona.
   */
  static getSelfGraph(agentId: string): string {
    return `urn:${agentId}:self`;
  }

  /**
   * Available tools and MCP services for the agent.
   */
  static getSkillsGraph(agentId: string): string {
    return `urn:${agentId}:skills`;
  }

  /**
   * Technische Umgebung des Agenten
   */
  static getSetupGraph(agentId: string): string {
    return `urn:${agentId}:setup`;
  }

  /**
   * User-specific knowledge (strictly isolated per user).
   */
  static getUserGraph(agentId: string, userId: string): string {
    return `urn:${agentId}:user:${userId}`;
  }

  /**
   * Akzeptierte Claims des Agenten
   */
  static getClaimsGraph(agentId: string): string {
    return `urn:${agentId}:claims`;
  }

  /**
   * Evidence-Quellenmaterial des Agenten
   */
  static getEvidenceGraph(agentId: string): string {
    return `urn:${agentId}:evidence`;
  }

  /**
   * Individual world knowledge (validated).
   */
  static getWorldviewGraph(agentId: string): string {
    return `urn:${agentId}:worldview`;
  }

  /**
   * Agent-local schema extension.
   *
   * Predicates the agent learns at runtime (e.g. "workedAt", "hasPhone")
   * are registered here — NOT in the admin-only urn:shared:ontology. The
   * shared TBox stays protected while the agent can still use new predicates
   * immediately.
   */
  static getSchemaGraph(agentId: string): string {
    return `urn:${agentId}:schema`;
  }

  /**
   * Detected contradictions.
   */
  static getConflictsGraph(agentId: string): string {
    return `urn:${agentId}:conflicts`;
  }

  /**
   * Reasoner materialization target — holds triples inferred from the
   * agent's accepted knowledge graphs. Kept separate from those graphs so
   * inferences can be recomputed without disturbing asserted facts.
   */
  static getInferredGraph(agentId: string): string {
    return `urn:${agentId}:inferred`;
  }

  /**
   * Konversationskontext (kurzlebig)
   */
  static getSessionGraph(agentId: string, sessionId: string): string {
    return `urn:${agentId}:session:${sessionId}`;
  }

  // ──────────────────────────────────────────────────────────────────────
  // Cognitive architecture graphs (docs/cognitive-architecture/02). These are
  // additive: the `:cog:` infix carves out a sub-namespace that never collides
  // with the long-term-memory graphs above.
  // ──────────────────────────────────────────────────────────────────────

  /**
   * Episodic long-term memory: one episode per message / tool call / response.
   * Fixed per agent.
   */
  static getCogEpisodicGraph(agentId: string): string {
    return `urn:${agentId}:cog:episodic`;
  }

  /**
   * Procedural long-term memory: skill traces, skill summaries, sequence
   * skills. Fixed per agent.
   */
  static getCogProceduralGraph(agentId: string): string {
    return `urn:${agentId}:cog:procedural`;
  }

  /**
   * Metacognition store: reflective markers, impasses, cross-cycle findings.
   * Fixed per agent.
   */
  static getCogMetaGraph(agentId: string): string {
    return `urn:${agentId}:cog:meta`;
  }

  /**
   * Per-cycle working memory (the blackboard). Parameterised by session and
   * cycle so each cognitive cycle gets its own short-lived graph.
   */
  static getCogWorkingGraph(agentId: string, sessionId: string, cycleId: string): string {
    return `urn:${agentId}:cog:working:${sessionId}:${cycleId}`;
  }

  /**
   * Session-scoped goal stack. Parameterised by session.
   */
  static getCogGoalsSessionGraph(agentId: string, sessionId: string): string {
    return `urn:${agentId}:cog:goals:${sessionId}`;
  }

  /**
   * Durable, cross-session goals promoted at session close. Fixed per agent
   * (the reserved `longterm` scope of the goals sub-namespace).
   */
  static getCogGoalsLongtermGraph(agentId: string): string {
    return `urn:${agentId}:cog:goals:longterm`;
  }

  /**
   * Reified cognitive cycles + their phases for a session. Parameterised by
   * session.
   */
  static getCogCyclesGraph(agentId: string, sessionId: string): string {
    return `urn:${agentId}:cog:cycles:${sessionId}`;
  }
}
