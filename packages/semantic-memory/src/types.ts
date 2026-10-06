/** Kind of source an Evidence object records. */
export type EvidenceType = 'message-span' | 'tool-result' | 'document' | 'web-source' | 'manual-review';

export interface FactInput {
  subject: string;
  subjectType?: string; // Person, Organization, Place, Concept, Event
  predicate: string;
  object: string;
  objectType?: string;  // Person, Organization, Place, Concept, Event, literal
  
  // Provenance & Claim fields
  confidenceNumeric?: number; // e.g. 0.95
  confidenceLabel?: 'high' | 'medium' | 'low';
  sourceKind?: 'user' | 'agent' | 'tool' | 'consolidation';
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
}

export interface StoreResult {
  success: boolean;
  subjectUri: string;
  predicateUri: string;
  objectUri: string;
  newEntities: string[];
  newProperties: string[];
  tripleCount: number;
}
