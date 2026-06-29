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

export interface ConsistencyResult {
  consistent: boolean;
  conflicts: Array<{ type: string; description: string; subjects: string[] }>;
  newInferences: number;
}
