/** Kind of source an Evidence object records. */
export type EvidenceType = 'message-span' | 'tool-result' | 'document' | 'web-source' | 'manual-review' | 'consolidation';

export interface FactInput {
  subject: string;
  subjectType?: string; // Person, Organization, Place, Concept, Event
  predicate: string;
  object: string;
  objectType?: string;  // Person, Organization, Place, Concept, Event, literal
  
  // Provenance & Claim fields
  confidenceNumeric?: number; // e.g. 0.95
  confidenceLabel?: 'high' | 'medium' | 'low';
  sourceKind?: 'user' | 'agent' | 'tool' | 'consolidation' | 'consolidation-episodic';
  sourceMessageId?: string;
  sourceSpan?: string;
  sourceUri?: string;
  /** Kind of evidence to record; defaults to 'message-span' when omitted. */
  evidenceType?: EvidenceType;
  /** Content hash of the source (e.g. 'sha256:<hex>'), stored on the evidence. */
  contentHash?: string;
  channel?: string;
  status?: 'accepted' | 'rejected' | 'superseded';
}

export interface FactContext {
  agentId: string;
  userId?: string; // Target user, if applicable
  sessionId: string;
  isOwner: boolean;
  ingestionRunId?: string;
  /**
   * Record a user's re-assertion of an existing triple as evidence on the
   * existing accepted claim and return that claim's IRI (`reassertedClaimUri`).
   * Off unless set: without it a duplicate is skipped exactly as before. The
   * agent runtime sets it only while episodic memory is on.
   */
  recordReassertion?: boolean;
}

/** Result of `KnowledgeEngine.previewFacts` for one fact. */
export interface FactPreview {
  fact: FactInput;
  targetGraph: string;
  duplicate: boolean;
  /** Claim URIs of accepted claims this fact would supersede. */
  wouldSupersede: string[];
}

export interface StoreResult {
  success: boolean;
  subjectUri: string;
  predicateUri: string;
  objectUri: string;
  newEntities: string[];
  newProperties: string[];
  tripleCount: number;
  /** IRI of the claim minted for this fact; absent for a duplicate (nothing stored). */
  claimUri?: string;
  /**
   * Set on a duplicate when `FactContext.recordReassertion` is on and an
   * existing accepted claim of the same graph was found: that claim's IRI, to
   * which a re-assertion Evidence was added. `tripleCount` stays 0.
   */
  reassertedClaimUri?: string;
}
