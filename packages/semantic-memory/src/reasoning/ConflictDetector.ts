import { TriplestoreAdapter } from '@ontofelia/core';
import { GraphUriResolver } from '../utils/GraphUriResolver.js';

export interface ReasoningConflict {
  type: 'disjoint_violation' | 'inconsistency' | 'range_violation' | 'domain_violation' | 'claim_clash';
  description: string;
  subjects: string[];
  detectedAt: string;
}

const CORE_NS = 'urn:shared:ontology#';

export class ConflictDetector {
  constructor(private triplestore: TriplestoreAdapter) {}

  /**
   * Detect conflicts across all named graphs.
   *
   * Three classes of conflict are surfaced:
   *  - **disjoint_violation** — a single entity belongs to two OWL-disjoint
   *    classes (e.g. typed both Person and Animal).
   *  - **range_violation** — an object property points at a node that does
   *    not match the property's `rdfs:range`.
   *  - **claim_clash** — two or more accepted Claims share the same
   *    `claimSubject` + `claimPredicate` but disagree on `claimObject`.
   *    This is the most common conflict per concept §4 (belief revision)
   *    and is critical for the conflicts graph to ever populate during
   *    normal use. Before this method existed, the conflicts graph was dead.
   */
  async detectConflicts(agentId: string): Promise<ReasoningConflict[]> {
    const conflicts: ReasoningConflict[] = [];

    // 1. Disjoint-class violations
    try {
      const disjointQuery = `
        PREFIX owl: <http://www.w3.org/2002/07/owl#>
        SELECT DISTINCT ?s ?c1 ?c2 WHERE {
          GRAPH ?g { ?s a ?c1 ; a ?c2 . }
          GRAPH ?tbox { ?c1 owl:disjointWith ?c2 . }
          FILTER (?c1 != ?c2)
        } LIMIT 100
      `;
      const res = await this.triplestore.query(disjointQuery);
      if (res?.type === 'bindings' && res.bindings) {
        for (const b of res.bindings) {
          conflicts.push({
            type: 'disjoint_violation',
            description: `Subject belongs to disjoint classes ${b.c1?.value} and ${b.c2?.value}`,
            subjects: [b.s?.value || 'unknown'],
            detectedAt: new Date().toISOString(),
          });
        }
      }
    } catch (e) {
      console.error('Error detecting disjoint conflicts', e);
    }

    // 2. Range violations (only for object properties with declared ranges)
    try {
      const rangeQuery = `
        PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
        SELECT DISTINCT ?s ?p ?o ?r WHERE {
          GRAPH ?g  { ?s ?p ?o . }
          GRAPH ?tg { ?p rdfs:range ?r . }
          FILTER (isIRI(?o))
          FILTER NOT EXISTS { GRAPH ?og { ?o a ?r } }
        } LIMIT 100
      `;
      const res = await this.triplestore.query(rangeQuery);
      if (res?.type === 'bindings' && res.bindings) {
        for (const b of res.bindings) {
          conflicts.push({
            type: 'range_violation',
            description: `Object ${b.o?.value} does not match range ${b.r?.value} for property ${b.p?.value}`,
            subjects: [b.s?.value || 'unknown', b.o?.value || 'unknown'],
            detectedAt: new Date().toISOString(),
          });
        }
      }
    } catch (e) {
      console.error('Error detecting range conflicts', e);
    }

    // 3. Claim clashes — same S/P, different O, both accepted
    try {
      const claimsGraph = GraphUriResolver.getClaimsGraph(agentId);
      const clashQuery = `
        PREFIX core: <${CORE_NS}>
        SELECT DISTINCT ?s ?p ?o1 ?o2 WHERE {
          GRAPH <${claimsGraph}> {
            ?c1 a core:Claim ;
                core:claimSubject   ?s ;
                core:claimPredicate ?p ;
                core:claimObject    ?o1 ;
                core:status         "accepted" .
            ?c2 a core:Claim ;
                core:claimSubject   ?s ;
                core:claimPredicate ?p ;
                core:claimObject    ?o2 ;
                core:status         "accepted" .
            FILTER (STR(?o1) < STR(?o2))
          }
        } LIMIT 100
      `;
      const res = await this.triplestore.query(clashQuery);
      if (res?.type === 'bindings' && res.bindings) {
        for (const b of res.bindings) {
          const o1 = b.o1?.value;
          const o2 = b.o2?.value;
          conflicts.push({
            type: 'claim_clash',
            description: `Two accepted claims share the same subject+predicate but disagree on the object: ${o1} vs ${o2}`,
            subjects: [b.s?.value || 'unknown'],
            detectedAt: new Date().toISOString(),
          });
        }
      }
    } catch (e) {
      console.error('Error detecting claim clashes', e);
    }

    return conflicts;
  }

  /**
   * Persist detected conflicts into the agent's conflicts named graph.
   *
   * Per concept §2 the target URI is `urn:<agent>:conflicts` — the previous
   * code path used `urn:ontofelia:agent:<id>:conflicts` which the
   * GraphRegistry rightly rejects, so storeConflicts wrote nothing.
   * It also wrote with the wrong namespace (`http://ontofelia.org/...`),
   * making conflicts invisible to any SPARQL query using the documented
   * `urn:shared:ontology#` prefix.
   */
  async storeConflicts(agentId: string, conflicts: ReasoningConflict[]): Promise<void> {
    if (conflicts.length === 0) return;

    const graphUri = GraphUriResolver.getConflictsGraph(agentId);
    const blocks: string[] = [];

    for (const [index, conflict] of conflicts.entries()) {
      const conflictUri = `urn:ontofelia:conflict:${Date.now()}_${index}_${Math.random().toString(36).slice(2, 6)}`;
      const desc = conflict.description.replace(/"/g, '\\"');
      const lines = [
        `<${conflictUri}> a <${CORE_NS}Conflict> .`,
        `<${conflictUri}> <${CORE_NS}conflictType> "${conflict.type}" .`,
        `<${conflictUri}> <${CORE_NS}description> "${desc}" .`,
        `<${conflictUri}> <${CORE_NS}detectedAt> "${conflict.detectedAt}"^^<http://www.w3.org/2001/XMLSchema#dateTime> .`,
        `<${conflictUri}> <${CORE_NS}status> "unresolved" .`,
      ];
      for (const sub of conflict.subjects) {
        lines.push(`<${conflictUri}> <${CORE_NS}subject> <${sub}> .`);
      }
      blocks.push(lines.join('\n  '));
    }

    const update = `INSERT DATA { GRAPH <${graphUri}> {\n  ${blocks.join('\n  ')}\n} }`;
    await this.triplestore.update(update);
  }
}
