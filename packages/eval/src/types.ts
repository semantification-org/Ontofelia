/**
 * Phase 0 evaluation harness — shared types.
 *
 * Evaluation harness for the proof-point work (#922 / #979 / #977).
 *
 * The only thing that differs between conditions A/B/C is the {@link MemoryBackend}.
 * Everything else (prompt skeleton, answer LLM, scorer) is held fixed (the
 * fairness rule).
 */

/** A single ingestible conversation turn handed to a {@link MemoryBackend}. */
export interface IngestTurn {
  id: string;
  speaker: 'user' | 'agent';
  text: string;
  ts: string;
  /**
   * Optional pre-parsed fact. The SemanticBackend uses this to call
   * `KnowledgeEngine.storeFact` directly (the parser-in-the-loop variant is a
   * Phase-1 knob — see spec §2-A). Vector/no-memory backends ignore it.
   */
  fact?: ParsedFact;
  /** Declared entities for this turn (used by SemanticBackend retrieve). */
  entities?: string[];
  /** Marks a retraction turn (the fact should be removed/superseded). */
  retract?: boolean;
  /** Predicate slot that this turn supersedes (mutate turns). */
  supersedes?: string;
}

/** Pre-parsed subject/predicate/object fact, domain-agnostic. */
export interface ParsedFact {
  s: string;
  p: string;
  o: string;
  /** Optional RDF object type hint: Person | Organization | Place | Concept | Event | literal. */
  oType?: string;
  /** Optional RDF subject type hint. */
  sType?: string;
}

/** Context returned by a backend and injected into the answer prompt. */
export interface RetrievedContext {
  text: string;
  meta?: Record<string, unknown>;
}

/** The swap point. A/B/C differ ONLY here. */
export interface MemoryBackend {
  readonly name: 'semantic' | 'vector-rag' | 'no-memory';
  /**
   * Bind the backend to a scenario before `reset()`. The semantic backend uses
   * `userId` so its per-user graph (`urn:<agent>:user:<userId>`) and
   * `getSystemPromptContext(agentId, userId)` line up with the scenario's user;
   * otherwise all user-subject facts (name/livesIn/bornIn) are unretrievable.
   */
  configureScenario?(scenario: { agentId: string; userId: string }): void;
  /** Fresh store/index, empty state. */
  reset(): Promise<void>;
  /** Persist an asserted fact / message. */
  ingest(turn: IngestTurn): Promise<void>;
  /** Context injected into the answer prompt for a probe. */
  retrieve(query: string, opts?: RetrieveOptions): Promise<RetrievedContext>;
  close?(): Promise<void>;
}

export interface RetrieveOptions {
  /** Declared entities of the probe (§5), used by the semantic backend. */
  entities?: string[];
  /**
   * Optional relation path for a genuine multi-hop probe (H2), e.g.
   * `["worksOn", "usesTool"]` means: from each declared entity follow
   * `worksOn` to the intermediate node, then `usesTool` to the answer set.
   * The semantic backend issues the composed SPARQL join; chunk-retrieval
   * backends cannot synthesise the join (the structural advantage under test).
   */
  hops?: string[];
}

// ---------------------------------------------------------------------------
// Scenario format (§5)
// ---------------------------------------------------------------------------

export type ProbeCategory = 'H0' | 'H1' | 'H2' | 'H3' | 'H4' | 'H5' | 'H6';

export type GoldSpec =
  | { type: 'exact'; value: string }
  | { type: 'f1'; value: string }
  | {
      type: 'set';
      value: string[];
      /**
       * Closed candidate vocabulary for this probe (the gold members PLUS the
       * plausible distractors that could appear). Real precision is computed
       * against the candidates the answer actually asserts, so an over-general
       * "dump everything" answer is penalised. If omitted, precision falls back
       * to the gold set only (still real recall, lenient precision).
       */
      candidates?: string[];
    }
  | { type: 'value+flag'; value: string; expectConflictFlag: boolean }
  | { type: 'provenance'; value?: string; sourceTurnId: string; tsToleranceSec?: number }
  | { type: 'constraint'; expectRejectOrFlag: boolean; value?: string }
  | { type: 'leakage'; mustNotContain: string[]; neighborsMustStay?: string[] };

export interface AssertTurn {
  kind: 'assert' | 'mutate' | 'retract';
  id: string;
  text: string;
  fact?: ParsedFact;
  supersedes?: string;
  entities?: string[];
}

export interface PadTurn {
  kind: 'pad';
  count: number;
  /** Optional explicit distractor texts; otherwise synthesized. */
  texts?: string[];
}

export interface ProbeTurn {
  kind: 'probe';
  id: string;
  category: ProbeCategory;
  query: string;
  paraphrases?: string[];
  entities?: string[];
  /** Relation path for genuine multi-hop probes (H2). See {@link RetrieveOptions.hops}. */
  hops?: string[];
  gold: GoldSpec;
}

export type ScenarioTurn = AssertTurn | PadTurn | ProbeTurn;

export interface Scenario {
  id: string;
  agentId: string;
  userId: string;
  turns: ScenarioTurn[];
}

// ---------------------------------------------------------------------------
// Runner / scorer records
// ---------------------------------------------------------------------------

/** One row per (probe × paraphrase × backend). */
export interface TranscriptRow {
  scenarioId: string;
  probeId: string;
  category: ProbeCategory;
  backend: MemoryBackend['name'];
  /**
   * The answer-LLM model this row was produced with. Used as a blocking factor
   * in the multi-model sweep so paired A-vs-B comparisons stay WITHIN a model
   * (we never compare semantic@modelX vs vector-rag@modelY). Defaults to the
   * single configured model.
   */
  model?: string;
  paraphrase: string;
  answer: string;
  tokens: number;
  latencyMs: number;
  /**
   * Structured metadata the backend surfaced for this probe (e.g. provenance
   * records, detected conflicts). The scorer reads this for H4 (source-turn +
   * timestamp) and H3/H5 (backend-surfaced conflict) so scoring is driven by
   * what the backend actually structured, not by lexical artifacts in NL.
   */
  retrieveMeta?: Record<string, unknown>;
  /**
   * Ground-truth ingest timestamp of the probe's gold source turn (ISO), used
   * by the H4 scorer to evaluate `tsToleranceSec`. Filled by the runner from
   * the synthetic clock so scoring is deterministic and offline.
   */
  expectedTs?: string;
}

export interface ScoredRow extends TranscriptRow {
  /** Primary correctness score in [0,1]. */
  score: number;
  /** Secondary score in [0,1] when the gold type produces two (e.g. value+flag). */
  secondary?: number;
  /** Free-form per-row detail (e.g. precision/recall, judge rationale). */
  detail?: Record<string, unknown>;
}

export interface CategoryBackendCell {
  category: ProbeCategory;
  backend: MemoryBackend['name'];
  n: number;
  /** Mean of raw primary `score` over all rows (context only). */
  meanScore: number;
  meanSecondary?: number;
  /**
   * The decision score: per-probe-aggregated mean of `effectiveScore`
   * (= score × secondary for value+flag/leakage categories, score otherwise),
   * matching exactly what the paired statistic / verdict use. This is the
   * headline number in the rendered table (analysis.decisionMean).
   */
  meanDecision?: number;
  meanTokens: number;
  meanLatencyMs: number;
}

export interface PilotReport {
  generatedAt: string;
  backends: MemoryBackend['name'][];
  categories: ProbeCategory[];
  cells: CategoryBackendCell[];
  rows: ScoredRow[];
  /** Per-backend cost/latency summary. */
  costLatency: Array<{
    backend: MemoryBackend['name'];
    totalTokens: number;
    meanLatencyMs: number;
    n: number;
  }>;
}
