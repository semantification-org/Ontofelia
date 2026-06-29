/**
 * SemanticIngestionService — Controlled ABox writing pipeline.
 *
 * Takes a SemanticParseResult and writes storable facts into the Knowledge Graph.
 * This replaces the previous model where the LLM spontaneously called `memory_store`.
 *
 * Pipeline:
 *   SemanticParseResult
 *   → filter storable facts (kind === 'fact' && confidence !== 'low')
 *   → store via KnowledgeEngine
 *   → collect uncertain facts as proposals
 *   → return ingestion report
 */

import { KnowledgeEngine } from '../KnowledgeEngine.js';
import { GraphPolicyError } from '../utils/GraphRegistry.js';
import { StoreResult } from '../types.js';
import type { FactInput, FactContext } from '../types.js';
import type { SemanticParseResult, ParsedFact, ParsedOntologyProposal } from './types.js';

// ── Ingestion Report ──

export interface IngestionReport {
  /** Facts that were successfully stored in the ABox */
  storedFacts: StoredFactReport[];
  /** Facts that were skipped (duplicates, low confidence, question, uncertain) */
  skippedFacts: SkippedFactReport[];
  /** Ontology proposals generated from uncertain facts + parser proposals */
  proposals: ParsedOntologyProposal[];
  /** Total storage time in milliseconds */
  totalTimeMs: number;
}

export interface StoredFactReport {
  fact: ParsedFact;
  result: StoreResult;
}

export interface SkippedFactReport {
  fact: ParsedFact;
  reason: 'question' | 'uncertain' | 'low_confidence' | 'duplicate' | 'error' | 'graph_policy';
  /** Human-readable detail — populated for 'graph_policy' and 'error'. */
  detail?: string;
}

export class SemanticIngestionService {
  constructor(private knowledgeEngine: KnowledgeEngine) {}

  /**
   * Ingest facts from a SemanticParseResult into the Knowledge Graph.
   *
   * Rules:
   * - `fact` with confidence `high` or `medium` → stored in ABox
   * - `fact` with confidence `low` → treated as uncertain, becomes proposal
   * - `question` → never stored
   * - `uncertain` → becomes proposal, not stored
   */
  async ingest(
    parseResult: SemanticParseResult,
    context: FactContext
  ): Promise<IngestionReport> {
    const start = Date.now();
    const storedFacts: StoredFactReport[] = [];
    const skippedFacts: SkippedFactReport[] = [];

    // Ontology proposals surfaced by the parser (class/property suggestions).
    // These are informational — facts themselves are no longer staged.
    const proposals: ParsedOntologyProposal[] = [...parseResult.proposals];

    // If parse was skipped (trivial message), return empty report
    if (parseResult.meta.skipped) {
      return { storedFacts, skippedFacts, proposals, totalTimeMs: Date.now() - start };
    }

    for (const fact of parseResult.facts) {
      // Skip questions — they're never stored
      if (fact.kind === 'question') {
        skippedFacts.push({ fact, reason: 'question' });
        continue;
      }

      // Truth-maintenance model: every non-question fact is accepted as true
      // on arrival. The fact's confidence is recorded on the claim, but it no
      // longer gates acceptance — contradictions are resolved later by belief
      // revision, not by a proposal stage.
      try {
        const factInput: FactInput = {
          subject: fact.subject,
          subjectType: fact.subjectType,
          predicate: fact.predicate,
          object: fact.object,
          objectType: fact.objectType,
          confidenceLabel: fact.confidence,
          sourceSpan: fact.sourceSpan,
          status: 'accepted',
        };

        const result = await this.knowledgeEngine.storeFact(factInput, context);

        if (result.tripleCount === 0) {
          // Duplicate
          skippedFacts.push({ fact, reason: 'duplicate' });
        } else {
          storedFacts.push({ fact, result });
        }
      } catch (e) {
        // A graph-policy violation means a fact was routed to a Named Graph
        // that is not in the whitelist. This is a topology bug, not a normal
        // skip — surface it loudly so it is never silently swallowed.
        if (e instanceof GraphPolicyError) {
          console.error(
            `[GraphPolicyViolation] Fact "${fact.subject} ${fact.predicate} ${fact.object}" ` +
              `was rejected: ${e.message}`,
          );
          skippedFacts.push({ fact, reason: 'graph_policy', detail: e.message });
        } else {
          skippedFacts.push({
            fact,
            reason: 'error',
            detail: e instanceof Error ? e.message : String(e),
          });
        }
      }
    }

    return {
      storedFacts,
      skippedFacts,
      proposals,
      totalTimeMs: Date.now() - start,
    };
  }
}
