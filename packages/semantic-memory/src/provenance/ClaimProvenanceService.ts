import { TriplestoreAdapter } from '@ontofelia/core';
import { GraphUriResolver } from '../utils/GraphUriResolver.js';
import { GraphRegistry } from '../utils/GraphRegistry.js';
import { FactInput, FactContext } from '../types.js';

export interface EvidenceInput {
  evidenceType: 'message-span' | 'tool-result' | 'document' | 'web-source' | 'manual-review';
  sourceMessageId?: string;
  sessionId?: string;
  channel?: string;
  actorUri?: string;
  rawText?: string;
  sourceUri?: string;
  contentHash?: string;
}

export class ClaimProvenanceService {
  constructor(
    private triplestore: TriplestoreAdapter,
    private graphRegistry: GraphRegistry = GraphRegistry.create(['ontofelia']),
  ) {}

  /**
   * Creates a core:Evidence object and stores it in the evidence graph.
   * Returns the URI of the generated evidence object.
   */
  async createEvidence(agentId: string, input: EvidenceInput): Promise<{ uri: string; graph: string }> {
    const evidenceGraph = GraphUriResolver.getEvidenceGraph(agentId);
    // Reject before writing if the graph is not whitelisted.
    this.graphRegistry.assertWritable(evidenceGraph);
    // Generate a unique URI for the evidence.
    const id = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const uri = `urn:evidence:${id}`;

    let triples = `<${uri}> a <urn:shared:ontology#Evidence> ;
      <urn:shared:ontology#evidenceType> "${input.evidenceType}" ;
      <urn:shared:ontology#capturedAt> "${new Date().toISOString()}"^^<http://www.w3.org/2001/XMLSchema#dateTime> .`;

    if (input.sourceMessageId) {
      triples += `\n<${uri}> <urn:shared:ontology#sourceMessageId> "${input.sourceMessageId}" .`;
    }
    if (input.sessionId) {
      triples += `\n<${uri}> <urn:shared:ontology#sessionId> "${input.sessionId}" .`;
    }
    if (input.channel) {
      triples += `\n<${uri}> <urn:shared:ontology#channel> "${input.channel}" .`;
    }
    if (input.actorUri) {
      triples += `\n<${uri}> <urn:shared:ontology#actor> <${input.actorUri}> .`;
    }
    if (input.rawText) {
      const escapedText = input.rawText.replace(/\\\\/g, '\\\\\\\\').replace(/"/g, '\\\\"').replace(/\\n/g, '\\\\n');
      triples += `\n<${uri}> <urn:shared:ontology#rawText> "${escapedText}" .`;
    }
    if (input.sourceUri) {
      triples += `\n<${uri}> <urn:shared:ontology#sourceUri> <${input.sourceUri}> .`;
    }
    if (input.contentHash) {
      triples += `\n<${uri}> <urn:shared:ontology#contentHash> "${input.contentHash}" .`;
    }

    const sparql = `
      INSERT DATA {
        GRAPH <${evidenceGraph}> {
          ${triples}
        }
      }
    `;

    await this.triplestore.update(sparql);
    return { uri, graph: evidenceGraph };
  }

  /**
   * Creates a core:Claim and stores it in the provided claimsGraph.
   */
  async createClaim(
    context: FactContext,
    fact: FactInput,
    subjectUri: string,
    predicateUri: string,
    objectTripleStr: string,
    targetGraph: string,
    claimGraph: string,
    status: 'accepted' | 'rejected' | 'superseded',
    evidenceUri?: string,
    evidenceGraph?: string
  ): Promise<string> {
    // The claim object lands in claimGraph; the asserted/target graph is
    // recorded as a property value. Both must be whitelisted.
    this.graphRegistry.assertWritable(claimGraph);
    this.graphRegistry.assertWritable(targetGraph);

    const id = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const uri = `urn:claim:${id}`;
    
    // Fallback confidence mapping
    const confLabel = fact.confidenceLabel || 'medium';
    let confNum = fact.confidenceNumeric;
    if (confNum === undefined) {
      confNum = confLabel === 'high' ? 0.95 : confLabel === 'medium' ? 0.6 : 0.3;
    }

    const ingestionRunId = context.ingestionRunId || `ing_${Date.now()}`;

    let triples = `<${uri}> a <urn:shared:ontology#Claim> ;
      <urn:shared:ontology#claimSubject> <${subjectUri}> ;
      <urn:shared:ontology#claimPredicate> <${predicateUri}> ;
      <urn:shared:ontology#claimObject> ${objectTripleStr} ;
      <urn:shared:ontology#learnedAt> "${new Date().toISOString()}"^^<http://www.w3.org/2001/XMLSchema#dateTime> ;
      <urn:shared:ontology#confidence> "${confNum}"^^<http://www.w3.org/2001/XMLSchema#decimal> ;
      <urn:shared:ontology#confidenceLabel> "${confLabel}" ;
      <urn:shared:ontology#sourceKind> "${fact.sourceKind || 'user'}" ;
      <urn:shared:ontology#ingestionRunId> "${ingestionRunId}" ;
      <urn:shared:ontology#status> "${status}" .`;

    // Target Graph vs Asserted In Graph
    if (status === 'accepted') {
      triples += `\n<${uri}> <urn:shared:ontology#assertedInGraph> <${targetGraph}> .`;
      triples += `\n<${uri}> <urn:shared:ontology#acceptedAt> "${new Date().toISOString()}"^^<http://www.w3.org/2001/XMLSchema#dateTime> .`;
    } else {
      triples += `\n<${uri}> <urn:shared:ontology#targetGraph> <${targetGraph}> .`;
    }

    // Optional metadata
    if (fact.sourceMessageId) {
      triples += `\n<${uri}> <urn:shared:ontology#sourceMessageId> "${fact.sourceMessageId}" .`;
    }
    if (context.sessionId) {
      triples += `\n<${uri}> <urn:shared:ontology#sessionId> "${context.sessionId}" .`;
    }
    if (fact.sourceSpan) {
      const escapedText = fact.sourceSpan.replace(/\\\\/g, '\\\\\\\\').replace(/"/g, '\\\\"').replace(/\\n/g, '\\\\n');
      triples += `\n<${uri}> <urn:shared:ontology#sourceSpan> "${escapedText}" .`;
    }

    // Link evidence if provided
    if (evidenceUri) {
      triples += `\n<${uri}> <urn:shared:ontology#hasEvidence> <${evidenceUri}> .`;
      if (evidenceGraph) {
        triples += `\n<${uri}> <urn:shared:ontology#evidenceGraph> <${evidenceGraph}> .`;
      }
    }

    const sparql = `
      INSERT DATA {
        GRAPH <${claimGraph}> {
          ${triples}
        }
      }
    `;

    await this.triplestore.update(sparql);
    return uri;
  }
}
