/**
 * Semantic Parse Result — the structured output of the Semantic Parser.
 *
 * This is the central data contract between the Parser LLM and the
 * downstream validation/ingestion pipeline.
 */

// ── Fact Extraction ──

export type FactKind = 'fact' | 'question' | 'uncertain';
export type ConfidenceLevel = 'high' | 'medium' | 'low';
export type EntityType = 'Person' | 'Organization' | 'Place' | 'Concept' | 'Event';
export type ObjectType = EntityType | 'literal';

export interface ParsedFact {
  /** The subject entity name (e.g. "Alex", "Google", "Berlin") */
  subject: string;
  /** OWL class of the subject */
  subjectType: EntityType;
  /** The relation/property name (e.g. "worksAt", "livesIn") */
  predicate: string;
  /** The object entity name or literal value */
  object: string;
  /** OWL class of the object, or "literal" for plain values */
  objectType: ObjectType;
  /** How confident the parser is about this extraction */
  confidence: ConfidenceLevel;
  /** The original text span this fact was extracted from */
  sourceSpan: string;
  /**
   * Simplified fact taxonomy:
   * - `fact`      — will be stored (at sufficient confidence)
   * - `question`  — will NOT be stored, generates a QuestionIntent
   * - `uncertain` — treated as a proposal, not stored directly
   */
  kind: FactKind;
}

// ── Question Intent (replaces LLM-generated SPARQL) ──

export interface QuestionIntent {
  /** The question in natural language (e.g. "Where does the user live?") */
  naturalLanguage: string;
  /** The entity the question is about, if identifiable */
  targetEntity?: string;
  /** The property being asked about, if identifiable */
  targetProperty?: string;
  /** The expected answer type (e.g. "Place", "Person", "literal") */
  expectedAnswerType?: string;
}

// ── Ontology Proposals ──

export type ProposalKind = 'class' | 'property';
export type ProposalAction = 'create' | 'map_to_existing' | 'ignore';

export interface ParsedOntologyProposal {
  /** Whether this is a new class or property proposal */
  kind: ProposalKind;
  /** The proposed name (e.g. "hasJobTitle") */
  name: string;
  /** Domain class, for property proposals */
  domain?: string;
  /** Range class or "literal", for property proposals */
  range?: string;
  /** Why this proposal was generated */
  reason: string;
  /** Existing terms that are similar (for dedup/mapping) */
  similarExistingTerms: string[];
  /** What the parser recommends doing */
  recommendedAction: ProposalAction;
  /** If recommendedAction is 'map_to_existing', which term to map to */
  mapTo?: string;
}

// ── Parse Result Meta ──

export interface ParseMeta {
  /** Time taken for the parse in milliseconds */
  parseTimeMs: number;
  /** Which LLM model was used for parsing */
  modelUsed: string;
  /** True if the message was trivial and parsing was skipped */
  skipped: boolean;
  /** Reason for skipping, if skipped */
  skipReason?: string;
}

// ── Top-level Result ──

export interface SemanticParseResult {
  /** Extracted facts (assertions, questions, uncertain statements) */
  facts: ParsedFact[];
  /** Ontology extension proposals (new classes/properties) */
  proposals: ParsedOntologyProposal[];
  /** If the message contains a question, the structured intent */
  questionIntent?: QuestionIntent;
  /** Overall confidence of the parse */
  confidence: ConfidenceLevel;
  /** Metadata about the parse process */
  meta: ParseMeta;
}

// ── LLM Output Schema (what the parser LLM returns as JSON) ──
// This is a subset — meta is added by the SemanticParser itself.

export interface ParserLLMOutput {
  facts: ParsedFact[];
  proposals: ParsedOntologyProposal[];
  questionIntent?: QuestionIntent;
  confidence: ConfidenceLevel;
}
