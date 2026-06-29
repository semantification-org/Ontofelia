/**
 * GraphCatalog — reads the graph registry from urn:shared:meta.
 *
 * urn:shared:meta is the single source of truth for what each Named Graph is
 * for (seeded from bootstrap/meta.ttl). This service queries it and renders a
 * description that is injected into the agent's system prompt, so the LLM
 * knows which graph a fact belongs in and cannot invent graphs by guessing.
 */

import { TriplestoreAdapter } from '@ontofelia/core';
import { SHARED_GRAPHS } from './GraphUriResolver.js';
import { GraphRegistry } from './GraphRegistry.js';

/** One graph's registry entry, as recorded in urn:shared:meta. */
export interface GraphCatalogEntry {
  /** The Named Graph URI. */
  uri: string;
  /** Logical type, e.g. "tbox", "user-knowledge", "proposal". */
  graphType?: string;
  /** Who may write: "admin", "pipeline", "consolidation", "reasoner", … */
  writableBy?: string;
  /** "public" or "agent-only". */
  visibility?: string;
  /** Human-readable purpose — the line the LLM most needs. */
  comment?: string;
}

const META_GRAPH = SHARED_GRAPHS.META;
const CORE_NS = 'urn:shared:ontology#';
const RDFS_COMMENT = 'http://www.w3.org/2000/01/rdf-schema#comment';

export class GraphCatalog {
  /**
   * @param triplestore  reads urn:shared:meta.
   * @param registry     the write whitelist — used as a fallback so the LLM
   *                     always receives at least the allowed graph URIs, even
   *                     if urn:shared:meta failed to seed. Routing guidance is
   *                     critical, so the prompt section must never be empty.
   */
  constructor(
    private triplestore: TriplestoreAdapter,
    private registry?: GraphRegistry,
  ) {}

  /**
   * Read every graph entry from urn:shared:meta.
   * Returns [] if the meta graph is empty or unreachable.
   */
  async describeAll(): Promise<GraphCatalogEntry[]> {
    const sparql = `
      SELECT ?g ?graphType ?writableBy ?visibility ?comment WHERE {
        GRAPH <${META_GRAPH}> {
          ?g a <${CORE_NS}NamedGraph> .
          OPTIONAL { ?g <${CORE_NS}graphType>  ?graphType . }
          OPTIONAL { ?g <${CORE_NS}writableBy> ?writableBy . }
          OPTIONAL { ?g <${CORE_NS}visibility> ?visibility . }
          OPTIONAL { ?g <${RDFS_COMMENT}>      ?comment . }
        }
      }
      ORDER BY ?g`;

    try {
      const res = await this.triplestore.query(sparql);
      if (res.type !== 'bindings' || !res.bindings) return [];
      return res.bindings.map(b => ({
        uri: b.g?.value ?? '',
        graphType: b.graphType?.value,
        writableBy: b.writableBy?.value,
        visibility: b.visibility?.value,
        comment: b.comment?.value,
      })).filter(e => e.uri.length > 0);
    } catch {
      return [];
    }
  }

  /**
   * Render the graph registry as a system-prompt section.
   *
   * The wording is deliberately directive: the LLM must route facts into the
   * graph whose purpose matches, must not invent graph URIs, and must respect
   * write-protection.
   *
   * Primary source is urn:shared:meta. If that graph is empty (a seeding
   * failure), it falls back to the GraphRegistry whitelist so the LLM still
   * gets the allowed graph URIs — routing guidance must never go missing.
   * Returns '' only when neither source yields anything.
   */
  async renderSystemPromptSection(): Promise<string> {
    const entries = await this.describeAll();

    const header = [
      '## Named Graph Registry — BINDING',
      '',
      'The knowledge graph is partitioned into fixed Named Graphs. The registry',
      'below is the single source of truth for what each graph is for. You MUST',
      'follow it:',
      '',
      '- Write every triple into the graph whose stated purpose matches the fact.',
      '- NEVER invent a Named Graph URI that is not in this list.',
      '- NEVER write to a graph marked "writable by: admin" — it is write-protected.',
      '- If no listed graph fits, do not guess: leave the fact for the',
      '  proposal/review pipeline instead of forcing it into the wrong graph.',
      '',
    ];

    if (entries.length > 0) {
      const lines = entries.map(e => {
        const parts = [`- <${e.uri}>`];
        if (e.graphType) parts.push(`[${e.graphType}]`);
        if (e.comment) parts.push(`— ${e.comment}`);
        const meta: string[] = [];
        if (e.writableBy) meta.push(`writable by: ${e.writableBy}`);
        if (e.visibility) meta.push(`visibility: ${e.visibility}`);
        const metaStr = meta.length > 0 ? ` (${meta.join('; ')})` : '';
        return parts.join(' ') + metaStr;
      });
      return [...header, ...lines].join('\n');
    }

    // Fallback: urn:shared:meta is empty. Use the whitelist so the LLM still
    // sees which graphs exist, even without per-graph purpose descriptions.
    if (this.registry) {
      const allowed = this.registry.listAllowed();
      if (allowed.length > 0) {
        return [
          ...header,
          '(Note: graph purpose descriptions are unavailable — only the list of',
          'permitted graphs is shown. Stay strictly within this list.)',
          '',
          ...allowed.map(uri => `- <${uri}>`),
        ].join('\n');
      }
    }

    return '';
  }
}
