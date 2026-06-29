/**
 * OntologyContextProvider — Delivers a compact representation of the
 * current ontology (TBox) for the Semantic Parser prompt.
 *
 * Instead of sending the full TBox (which grows over time), this provider
 * queries Fuseki for the essential classes, properties, domains, ranges,
 * and aliases, and returns a compact JSON-serializable summary.
 */

import { TriplestoreAdapter } from '@ontofelia/core';
import { SHARED_GRAPHS, GraphUriResolver } from '../utils/GraphUriResolver.js';
import type { OntologyContext } from './SemanticParser.js';

/**
 * The TBox per knowledge-graph-concept §2 lives in `urn:shared:ontology`
 * (admin-only). Predicates the agent has learned at runtime are kept
 * separately in `urn:<agent>:schema`. The parser prompt must see BOTH so it
 * can reuse existing terms instead of inventing fresh, near-duplicate URIs.
 *
 * Historic note: this used to point at `urn:ontofelia:tbox`, which is not a
 * registered graph in the topology — the lookup silently returned empty and
 * every fact got a brand-new ad-hoc predicate.
 */
const SHARED_TBOX = SHARED_GRAPHS.ONTOLOGY;

/** Fallback context when the triplestore is unavailable or the TBox is empty */
const DEFAULT_CONTEXT: OntologyContext = {
  classes: ['Person', 'Organization', 'Place', 'Concept', 'Event', 'Animal', 'Agent'],
  properties: [],
};

export class OntologyContextProvider {
  constructor(
    private triplestore: TriplestoreAdapter,
    /**
     * Agent whose local schema graph to also include. Defaults to ontofelia
     * for backward compatibility; multi-agent callers should pass the real id.
     */
    private agentId: string = 'ontofelia',
  ) {}

  /**
   * Load a compact ontology context from the shared TBox AND the agent's
   * local schema graph. Falls back to defaults if the triplestore is down.
   */
  async getCompact(): Promise<OntologyContext> {
    try {
      const [classes, properties] = await Promise.all([
        this.loadClasses(),
        this.loadProperties(),
      ]);

      return {
        classes: classes.length > 0 ? classes : DEFAULT_CONTEXT.classes,
        properties,
      };
    } catch {
      // Triplestore not available — return default context
      return { ...DEFAULT_CONTEXT };
    }
  }

  /**
   * Load all OWL classes from the shared TBox.
   */
  private async loadClasses(): Promise<string[]> {
    const query = `
      PREFIX owl: <http://www.w3.org/2002/07/owl#>
      PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
      SELECT DISTINCT ?label WHERE {
        GRAPH <${SHARED_TBOX}> {
          ?class a owl:Class .
          ?class rdfs:label ?label .
        }
      }
      ORDER BY ?label
      LIMIT 100
    `;
    const result = await this.triplestore.query(query);
    if (result.type === 'bindings' && result.bindings) {
      const labels = result.bindings
        .map(b => b.label?.value)
        .filter(Boolean) as string[];
      // Always include core classes even if not in TBox
      const coreClasses = new Set(DEFAULT_CONTEXT.classes);
      for (const label of labels) {
        coreClasses.add(label);
      }
      return [...coreClasses].sort();
    }
    return [];
  }

  /**
   * Load all properties known to the agent.
   *
   * Two sources are unioned:
   *   1. `urn:shared:ontology` — TBox owl:ObjectProperty / owl:DatatypeProperty
   *      with their domain/range (the rich, admin-curated definitions).
   *   2. `urn:<agent>:schema` — runtime-learned rdf:Property entries (no
   *      domain/range yet) registered when the parser emitted a brand-new
   *      predicate. Including them prevents the parser from re-inventing the
   *      same predicate on every turn with slightly different spelling.
   */
  private async loadProperties(): Promise<OntologyContext['properties']> {
    const schemaGraph = GraphUriResolver.getSchemaGraph(this.agentId);
    const query = `
      PREFIX owl: <http://www.w3.org/2002/07/owl#>
      PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
      PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
      SELECT DISTINCT ?prop ?label ?domain ?range WHERE {
        {
          GRAPH <${SHARED_TBOX}> {
            { ?prop a owl:ObjectProperty } UNION { ?prop a owl:DatatypeProperty }
            OPTIONAL { ?prop rdfs:label ?label }
            OPTIONAL { ?prop rdfs:domain ?domainClass . ?domainClass rdfs:label ?domain }
            OPTIONAL { ?prop rdfs:range ?rangeClass . ?rangeClass rdfs:label ?range }
          }
        } UNION {
          GRAPH <${schemaGraph}> {
            ?prop a rdf:Property .
            OPTIONAL { ?prop rdfs:label ?label }
          }
        }
      }
      ORDER BY ?label
      LIMIT 400
    `;
    const result = await this.triplestore.query(query);
    if (result.type !== 'bindings' || !result.bindings) return [];

    // Deduplicate by predicate URI — a property defined in the TBox may also
    // exist in the schema graph if a label-based lookup added a mirror; we
    // keep the richer (domain/range-bearing) row.
    const byUri = new Map<string, OntologyContext['properties'][number]>();
    for (const b of result.bindings) {
      const propUri = b.prop?.value || '';
      if (!propUri) continue;
      const name = this.extractLocalName(propUri);
      const entry = {
        name,
        label: b.label?.value || name,
        domain: b.domain?.value || '',
        range: b.range?.value || '',
        aliases: [] as string[],
      };
      const prev = byUri.get(propUri);
      // Prefer the entry that actually carries domain/range info.
      if (!prev || (!prev.domain && entry.domain) || (!prev.range && entry.range)) {
        byUri.set(propUri, entry);
      }
    }
    return [...byUri.values()];
  }

  /**
   * Extract the local name from a URI (e.g. "urn:ontofelia:core#livesIn" → "livesIn")
   */
  private extractLocalName(uri: string): string {
    const hash = uri.lastIndexOf('#');
    const slash = uri.lastIndexOf('/');
    return uri.substring(Math.max(hash, slash) + 1);
  }
}
