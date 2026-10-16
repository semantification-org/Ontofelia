import { TriplestoreAdapter } from '@ontofelia/core';
import { ConflictDetector } from '../reasoning/ConflictDetector.js';
import { OntologyManager } from '../ontology/OntologyManager.js';
import { reflectOnWorldview, type ReflectionResult } from './worldviewReflection.js';

export type { ReflectionResult };

/**
 * Compatibility shim. The reflection body moved to {@link reflectOnWorldview},
 * which the agent runtime's cross-cycle metacognitive scan
 * (`Metacognition.crossCycleScan`) runs as well. The public API (constructor
 * and `reflect`) is unchanged.
 */
export class ReflectionRunner {
  constructor(
    private triplestore: TriplestoreAdapter,
    private conflictDetector: ConflictDetector,
    // Kept for the constructor signature; the reflection does not use it.
    private ontologyManager: OntologyManager
  ) {}

  /** Run a reflection. */
  async reflect(agentId: string, _hoursBack: number = 24): Promise<ReflectionResult> {
    return reflectOnWorldview(
      { triplestore: this.triplestore, conflictDetector: this.conflictDetector },
      agentId,
    );
  }
}
