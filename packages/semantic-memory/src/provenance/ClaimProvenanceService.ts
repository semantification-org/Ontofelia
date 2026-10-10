import { TriplestoreAdapter } from '@ontofelia/core';
import { GraphUriResolver } from '../utils/GraphUriResolver.js';
import { GraphRegistry } from '../utils/GraphRegistry.js';
import { FactInput, FactContext, EvidenceType } from '../types.js';
import { sparqlIri, sparqlStringLiteral } from '../utils/SparqlSyntax.js';

export interface EvidenceInput {
  evidenceType: EvidenceType;
  sourceMessageId?: string;
  sessionId?: string;
  channel?: string;
  actorUri?: string;
  rawText?: string;
  sourceUri?: string;
  contentHash?: string;
}

/**
 * sourceUri is written as an IRI (<...>): reject anything that could close it
 * or inject triples. Throws before any write.
 */
export function assertValidEvidenceSourceUri(sourceUri: string): void {
  try {
    sparqlIri(sourceUri);
  } catch {
    throw new Error('Invalid sourceUri for evidence: contains characters not allowed in an IRI');
  }
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

    const subj = sparqlIri(uri);
    const ONT = 'urn:shared:ontology#';
    const XSD_DATETIME = '<http://www.w3.org/2001/XMLSchema#dateTime>';
    // Validate the graph IRI before anything is assembled.
    const graphIri = sparqlIri(evidenceGraph);

    let triples = `${subj} a <${ONT}Evidence> ;
      <${ONT}evidenceType> ${sparqlStringLiteral(input.evidenceType)} ;
      <${ONT}capturedAt> ${sparqlStringLiteral(new Date().toISOString())}^^${XSD_DATETIME} .`;

    if (input.sourceMessageId) {
      triples += `\n${subj} <${ONT}sourceMessageId> ${sparqlStringLiteral(input.sourceMessageId)} .`;
    }
    if (input.sessionId) {
      triples += `\n${subj} <${ONT}sessionId> ${sparqlStringLiteral(input.sessionId)} .`;
    }
    if (input.channel) {
      triples += `\n${subj} <${ONT}channel> ${sparqlStringLiteral(input.channel)} .`;
    }
    if (input.actorUri) {
      triples += `\n${subj} <${ONT}actor> ${sparqlIri(input.actorUri)} .`;
    }
    if (input.rawText) {
      triples += `\n${subj} <${ONT}rawText> ${sparqlStringLiteral(input.rawText)} .`;
    }
    if (input.sourceUri) {
      assertValidEvidenceSourceUri(input.sourceUri);
      triples += `\n${subj} <${ONT}sourceUri> ${sparqlIri(input.sourceUri)} .`;
    }
    if (input.contentHash) {
      triples += `\n${subj} <${ONT}contentHash> ${sparqlStringLiteral(input.contentHash)} .`;
    }

    const sparql = `
      INSERT DATA {
        GRAPH ${graphIri} {
          ${triples}
        }
      }
    `;

    await this.triplestore.update(sparql);
    return { uri, graph: evidenceGraph };
  }

  /** Mints a fresh claim URI, so a caller can reference a claim before it is stored. */
  mintClaimUri(): string {
    return `urn:claim:${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
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
    evidenceGraph?: string,
    claimUri?: string,
  ): Promise<string> {
    // The claim object lands in claimGraph; the asserted/target graph is
    // recorded as a property value. Both must be whitelisted.
    this.graphRegistry.assertWritable(claimGraph);
    this.graphRegistry.assertWritable(targetGraph);

    const uri = claimUri ?? this.mintClaimUri();

    // Fallback confidence mapping
    const confLabel = fact.confidenceLabel || 'medium';
    let confNum = fact.confidenceNumeric;
    if (confNum === undefined) {
      confNum = confLabel === 'high' ? 0.95 : confLabel === 'medium' ? 0.6 : 0.3;
    }

    const ingestionRunId = context.ingestionRunId || `ing_${Date.now()}`;

    const subj = sparqlIri(uri);
    const ONT = 'urn:shared:ontology#';
    const XSD = 'http://www.w3.org/2001/XMLSchema#';
    const graphIri = sparqlIri(claimGraph);
    const targetGraphIri = sparqlIri(targetGraph);

    // objectTripleStr is a pre-rendered RDF term supplied by KnowledgeEngine
    // (an IRI or a literal escaped there); it cannot be validated here.
    let triples = `${subj} a <${ONT}Claim> ;
      <${ONT}claimSubject> ${sparqlIri(subjectUri)} ;
      <${ONT}claimPredicate> ${sparqlIri(predicateUri)} ;
      <${ONT}claimObject> ${objectTripleStr} ;
      <${ONT}learnedAt> ${sparqlStringLiteral(new Date().toISOString())}^^<${XSD}dateTime> ;
      <${ONT}confidence> ${sparqlStringLiteral(String(confNum))}^^<${XSD}decimal> ;
      <${ONT}confidenceLabel> ${sparqlStringLiteral(confLabel)} ;
      <${ONT}sourceKind> ${sparqlStringLiteral(fact.sourceKind || 'user')} ;
      <${ONT}ingestionRunId> ${sparqlStringLiteral(ingestionRunId)} ;
      <${ONT}status> ${sparqlStringLiteral(status)} .`;

    // Target Graph vs Asserted In Graph
    if (status === 'accepted') {
      triples += `\n${subj} <${ONT}assertedInGraph> ${targetGraphIri} .`;
      triples += `\n${subj} <${ONT}acceptedAt> ${sparqlStringLiteral(new Date().toISOString())}^^<${XSD}dateTime> .`;
    } else {
      triples += `\n${subj} <${ONT}targetGraph> ${targetGraphIri} .`;
    }

    // Optional metadata
    if (fact.sourceMessageId) {
      triples += `\n${subj} <${ONT}sourceMessageId> ${sparqlStringLiteral(fact.sourceMessageId)} .`;
    }
    if (context.sessionId) {
      triples += `\n${subj} <${ONT}sessionId> ${sparqlStringLiteral(context.sessionId)} .`;
    }
    if (fact.sourceSpan) {
      triples += `\n${subj} <${ONT}sourceSpan> ${sparqlStringLiteral(fact.sourceSpan)} .`;
    }

    // Link evidence if provided
    if (evidenceUri) {
      triples += `\n${subj} <${ONT}hasEvidence> ${sparqlIri(evidenceUri)} .`;
      if (evidenceGraph) {
        triples += `\n${subj} <${ONT}evidenceGraph> ${sparqlIri(evidenceGraph)} .`;
      }
    }

    const sparql = `
      INSERT DATA {
        GRAPH ${graphIri} {
          ${triples}
        }
      }
    `;

    await this.triplestore.update(sparql);
    return uri;
  }
}
