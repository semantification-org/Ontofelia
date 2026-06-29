import { ToolDefinition, ToolContext, ToolResult, TriplestoreAdapter, ToolPermission } from '@ontofelia/core';
import { GraphUriResolver } from '@ontofelia/semantic-memory';

/** Claim/Evidence vocabulary namespace (see knowledge-graph-concept.md §4). */
const CLAIM_NS = 'urn:shared:ontology#';

export class MemoryExplainTool implements ToolDefinition {
  name = 'memory_explain';
  description =
    'Returns claim provenance (source, confidence, timestamp, evidence) for facts involving an entity.';
  category = 'memory' as const;
  permissions: ToolPermission[] = ['memory:read'];

  inputSchema = {
    type: 'object',
    properties: {
      entity: { type: 'string', description: 'Entity name or URI to look up provenance for' }
    },
    required: ['entity']
  };

  private triplestore: TriplestoreAdapter;

  constructor(triplestore: TriplestoreAdapter) {
    this.triplestore = triplestore;
  }

  /** Convert a human name to entity URI */
  private toEntityUri(name: string): string {
    if (name.startsWith('urn:') || name.startsWith('http://') || name.startsWith('https://') || name.startsWith('<')) {
      return name.replace(/^<|>$/g, '');
    }
    return `urn:ontofelia:entity:${name.trim().replace(/\s+/g, '_')}`;
  }

  async execute(input: unknown, context: ToolContext): Promise<ToolResult> {
    const data = input as { entity: string };
    const start = Date.now();

    const entityUri = this.toEntityUri(data.entity);
    // Provenance is modelled as core:Claim objects in the claims graph; the
    // raw source text lives in the evidence graph (linked via hasEvidence).
    const claimsGraph = GraphUriResolver.getClaimsGraph(context.agentId);

    const sparql = `
      PREFIX claim: <${CLAIM_NS}>
      PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
      SELECT ?predicate ?predicateLabel ?object ?status ?confidence ?confidenceLabel
             ?sourceKind ?learnedAt ?sourceSpan ?evidence ?evidenceGraph
      WHERE {
        GRAPH <${claimsGraph}> {
          ?claim a claim:Claim ;
                 claim:claimSubject   <${entityUri}> ;
                 claim:claimPredicate ?predicate ;
                 claim:claimObject    ?object ;
                 claim:status         ?status .
          OPTIONAL { ?claim claim:confidence      ?confidence . }
          OPTIONAL { ?claim claim:confidenceLabel ?confidenceLabel . }
          OPTIONAL { ?claim claim:sourceKind      ?sourceKind . }
          OPTIONAL { ?claim claim:learnedAt       ?learnedAt . }
          OPTIONAL { ?claim claim:sourceSpan      ?sourceSpan . }
          OPTIONAL { ?claim claim:hasEvidence     ?evidence . }
          OPTIONAL { ?claim claim:evidenceGraph   ?evidenceGraph . }
        }
        OPTIONAL { GRAPH ?g { ?predicate rdfs:label ?predicateLabel } }
      }
      ORDER BY DESC(?learnedAt)`;

    try {
      const result = await this.triplestore.query(sparql);

      const provenanceEntries = [];
      if (result.type === 'bindings' && result.bindings) {
        for (const b of result.bindings) {
          provenanceEntries.push({
            predicate: b.predicateLabel?.value || b.predicate?.value,
            object: b.object?.value,
            status: b.status?.value,
            confidence: b.confidence?.value,
            confidenceLabel: b.confidenceLabel?.value,
            sourceKind: b.sourceKind?.value,
            learnedAt: b.learnedAt?.value,
            sourceSpan: b.sourceSpan?.value,
            evidence: b.evidence?.value,
            evidenceGraph: b.evidenceGraph?.value
          });
        }
      }

      return {
        success: true,
        output: { entity: entityUri, provenance: provenanceEntries },
        auditEntry: {
          toolName: this.name,
          timestamp: new Date().toISOString(),
          duration: Date.now() - start,
          input: data,
          output: { found: provenanceEntries.length > 0 },
          success: true,
          permissions: [...this.permissions]
        }
      };
    } catch (e: unknown) {
      return {
        success: false,
        output: null,
        error: (e as Error).message,
        auditEntry: {
          toolName: this.name,
          timestamp: new Date().toISOString(),
          duration: Date.now() - start,
          input: data,
          output: null,
          success: false,
          error: (e as Error).message,
          permissions: [...this.permissions]
        }
      };
    }
  }
}
