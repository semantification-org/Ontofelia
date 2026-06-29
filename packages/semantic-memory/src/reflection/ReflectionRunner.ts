import { TriplestoreAdapter } from '@ontofelia/core';
import { ConflictDetector, ReasoningConflict } from '../reasoning/ConflictDetector.js';
import { OntologyManager } from '../ontology/OntologyManager.js';
import { GraphUriResolver } from '../utils/GraphUriResolver.js';
import * as crypto from 'crypto';

const CORE_NS = 'urn:shared:ontology#';

export interface ReflectionResult {
  id: string;
  agentId: string;
  timestamp: string;
  recentTriplesCount: number;
  conflicts: ReasoningConflict[];
  suggestions: string[];
}

export class ReflectionRunner {
  constructor(
    private triplestore: TriplestoreAdapter,
    private conflictDetector: ConflictDetector,
    private ontologyManager: OntologyManager
  ) {}

  /** Run a reflection. */
   
  async reflect(agentId: string, _hoursBack: number = 24): Promise<ReflectionResult> {
    const timestamp = new Date().toISOString();
    const id = `refl-${crypto.randomBytes(4).toString('hex')}`;

    // 1. Count recently stored triples.
    // In a real system, we'd look for onto:createdAt. Here we just count them conceptually or do a rough query.
    // For MVP, just return a dummy count if not tracking dates in triples yet.
    let recentTriplesCount = 0;
    try {
      const recentQuery = `
        PREFIX onto: <http://ontofelia.org/ontology/>
        SELECT (COUNT(*) AS ?count) WHERE {
          ?s ?p ?o .
        }
      `;
      const res = await this.triplestore.query(recentQuery);
      if (res && res.type === 'bindings' && res.bindings && res.bindings.length > 0) {
        recentTriplesCount = parseInt(res.bindings[0].count?.value || '0', 10);
      }
    } catch {
      // Ignoriert
    }

    // 2. Check conflicts.
    const conflicts = await this.conflictDetector.detectConflicts(agentId);
    if (conflicts.length > 0) {
      await this.conflictDetector.storeConflicts(agentId, conflicts);
    }

    // 3. Store reflection event in the agent's conflicts graph (a named
    // graph is required — concept §1; previously we wrote to the default
    // graph with a vendored namespace, which left the event invisible to
    // any concept-conformant query).
    const eventUri = `<urn:ontofelia:reflection:${agentId}:${id}>`;
    const targetGraph = GraphUriResolver.getConflictsGraph(agentId);
    const insertEvent = `
      PREFIX core: <${CORE_NS}>
      PREFIX xsd:  <http://www.w3.org/2001/XMLSchema#>
      INSERT DATA {
        GRAPH <${targetGraph}> {
          ${eventUri} a core:ReflectionEvent ;
            core:reflectedAt "${timestamp}"^^xsd:dateTime ;
            core:conflictsFound ${conflicts.length} .
        }
      }
    `;
    await this.triplestore.update(insertEvent);

    return {
      id,
      agentId,
      timestamp,
      recentTriplesCount,
      conflicts,
      suggestions: conflicts.map((c: ReasoningConflict) => `Fix conflict: ${c.description}`)
    };
  }
}
