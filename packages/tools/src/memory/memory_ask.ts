import { ToolDefinition, ToolContext, ToolResult, TriplestoreAdapter, ToolPermission } from '@ontofelia/core';
import { GraphUriResolver } from '@ontofelia/semantic-memory';

/**
 * Provenance metadata lives in core:Claim objects (urn:shared:ontology#…),
 * not in a separate "tracks*" provenance graph. These are the claim property
 * URIs the ClaimProvenanceService actually writes.
 */
const CLAIM_NS = 'urn:shared:ontology#';

export class MemoryAskTool implements ToolDefinition {
  name = 'memory_ask';
  description =
    'Query the knowledge graph using predefined templates. Returns real RDF triples and claim provenance stored about entities.';
  category = 'memory' as const;
  permissions: ToolPermission[] = ['memory:read'];

  inputSchema = {
    type: 'object',
    properties: {
      template: {
        type: 'string',
        enum: ['what_do_i_know_about', 'who_knows_whom', 'recent_facts', 'facts_by_confidence'],
        description: 'The SPARQL template to use'
      },
      entity: { type: 'string', description: 'Entity name or URI (for what_do_i_know_about)' },
      confidence: {
        type: 'string',
        description: 'Confidence label "high", "medium" or "low" (for facts_by_confidence)'
      }
    },
    required: ['template']
  };

  private triplestore: TriplestoreAdapter;

  constructor(triplestore: TriplestoreAdapter) {
    this.triplestore = triplestore;
  }

  /** Convert a human name to entity URI */
  private toEntityUri(name: string): string {
    if (name.startsWith('urn:') || name.startsWith('http://') || name.startsWith('https://')) {
      return name;
    }
    return `urn:ontofelia:entity:${name.trim().replace(/\s+/g, '_')}`;
  }

  async execute(input: unknown, context: ToolContext): Promise<ToolResult> {
    const data = input as { template: string; entity?: string; confidence?: string };
    const start = Date.now();

    // Knowledge is partitioned per the knowledge-graph concept. Facts about
    // entities live in the user, worldview and self graphs; claim provenance
    // lives in the claims graph. We query across all of them by graph URI.
    const agentId = context.agentId;
    const claimsGraph = GraphUriResolver.getClaimsGraph(agentId);

    let sparql = '';

    switch (data.template) {
      case 'what_do_i_know_about': {
        if (!data.entity) throw new Error('entity is required for what_do_i_know_about');
        const entityUri = this.toEntityUri(data.entity);
        // Find all triples where entity is subject OR object, in any of the
        // agent's own knowledge graphs (urn:<agent>:*) or the shared graphs.
        sparql = `
          PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
          SELECT ?direction ?property ?propertyLabel ?value ?valueLabel ?graph WHERE {
            {
              GRAPH ?graph {
                <${entityUri}> ?property ?value .
              }
              BIND("outgoing" AS ?direction)
            } UNION {
              GRAPH ?graph {
                ?value ?property <${entityUri}> .
              }
              BIND("incoming" AS ?direction)
            }
            FILTER(STRSTARTS(STR(?graph), "urn:${agentId}:") || STRSTARTS(STR(?graph), "urn:shared:"))
            OPTIONAL { ?property rdfs:label ?propertyLabel }
            OPTIONAL { ?value rdfs:label ?valueLabel }
          }`;
        break;
      }
      case 'who_knows_whom':
        sparql = `
          PREFIX onto: <urn:ontofelia:core#>
          PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
          SELECT ?person1 ?person1Label ?person2 ?person2Label WHERE {
            GRAPH ?graph {
              ?person1 onto:knows ?person2 .
            }
            FILTER(STRSTARTS(STR(?graph), "urn:${agentId}:") || STRSTARTS(STR(?graph), "urn:shared:"))
            OPTIONAL { ?person1 rdfs:label ?person1Label }
            OPTIONAL { ?person2 rdfs:label ?person2Label }
          }`;
        break;
      case 'recent_facts':
        // Recency comes from the claim's learnedAt timestamp.
        sparql = `
          PREFIX claim: <${CLAIM_NS}>
          PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
          SELECT ?s ?sLabel ?p ?pLabel ?o ?learnedAt WHERE {
            GRAPH <${claimsGraph}> {
              ?claim a claim:Claim ;
                     claim:claimSubject   ?s ;
                     claim:claimPredicate ?p ;
                     claim:claimObject    ?o ;
                     claim:learnedAt      ?learnedAt ;
                     claim:status         "accepted" .
            }
            OPTIONAL { GRAPH ?g1 { ?s rdfs:label ?sLabel } }
            OPTIONAL { GRAPH ?g2 { ?p rdfs:label ?pLabel } }
          }
          ORDER BY DESC(?learnedAt)
          LIMIT 10`;
        break;
      case 'facts_by_confidence':
        if (!data.confidence) throw new Error('confidence is required for facts_by_confidence');
        sparql = `
          PREFIX claim: <${CLAIM_NS}>
          PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
          SELECT ?s ?sLabel ?p ?pLabel ?o ?confidence WHERE {
            GRAPH <${claimsGraph}> {
              ?claim a claim:Claim ;
                     claim:claimSubject    ?s ;
                     claim:claimPredicate  ?p ;
                     claim:claimObject     ?o ;
                     claim:confidenceLabel ?confidence ;
                     claim:status          "accepted" .
              FILTER(LCASE(STR(?confidence)) = LCASE("${data.confidence.replace(/"/g, '')}"))
            }
            OPTIONAL { GRAPH ?g1 { ?s rdfs:label ?sLabel } }
            OPTIONAL { GRAPH ?g2 { ?p rdfs:label ?pLabel } }
          }`;
        break;
      default:
        throw new Error('Unknown template');
    }

    try {
      const result = await this.triplestore.query(sparql);

      return {
        success: true,
        output: { results: result.type === 'bindings' ? result.bindings : result, sparql },
        auditEntry: {
          toolName: this.name,
          timestamp: new Date().toISOString(),
          duration: Date.now() - start,
          input: data,
          output: { success: true },
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
