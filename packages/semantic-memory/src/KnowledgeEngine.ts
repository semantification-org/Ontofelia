import { TriplestoreAdapter, TriplestoreConfig } from '@ontofelia/core';
import { promises as fs } from 'fs';
import * as path from 'path';
import { ReasonableEngine } from './reasoning/ReasonableEngine.js';
import { ClaimProvenanceService } from './provenance/ClaimProvenanceService.js';
import { GraphUriResolver, SHARED_GRAPHS } from './utils/GraphUriResolver.js';
import { GraphRegistry } from './utils/GraphRegistry.js';
import { FactInput, FactContext, StoreResult, ConsistencyResult } from './types.js';

const ENTITY_NS = 'urn:ontofelia:entity:';
const CORE_NS = 'urn:ontofelia:core#';
const TBOX_GRAPH = 'urn:shared:ontology';

// Standard RDF/RDFS/OWL vocabulary URIs.
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const RDFS_SUBCLASS_OF = 'http://www.w3.org/2000/01/rdf-schema#subClassOf';
const RDFS_SUBPROPERTY_OF = 'http://www.w3.org/2000/01/rdf-schema#subPropertyOf';
const OWL_SAME_AS = 'http://www.w3.org/2002/07/owl#sameAs';
const OWL_FUNCTIONAL_PROPERTY = 'http://www.w3.org/2002/07/owl#FunctionalProperty';

// Namespaces whose terms are reasoner builtins and must never be minted as
// ad-hoc agent predicates.
const BUILTIN_NAMESPACES = [
  'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  'http://www.w3.org/2000/01/rdf-schema#',
  'http://www.w3.org/2002/07/owl#',
];

// Relational predicates the parser/answer LLM emit as plain strings, mapped to
// canonical RDF/RDFS/OWL vocabulary. Keys are normalized (lowercased, with all
// spaces/underscores/hyphens stripped). Without this funnel, "subClassOf" and
// "type" were minted as urn:ontofelia:core# predicates, so the reasoner never
// saw rdfs:subClassOf / rdf:type edges and could not perform subsumption or
// type propagation — the inferred graph stayed empty for class-hierarchy facts.
const BUILTIN_PREDICATES: Record<string, string> = {
  subclassof: RDFS_SUBCLASS_OF,
  subclass: RDFS_SUBCLASS_OF,
  issubclassof: RDFS_SUBCLASS_OF,
  subtypeof: RDFS_SUBCLASS_OF,
  subtype: RDFS_SUBCLASS_OF,
  kindof: RDFS_SUBCLASS_OF,
  isakindof: RDFS_SUBCLASS_OF,
  issubtypeof: RDFS_SUBCLASS_OF,
  type: RDF_TYPE,
  rdftype: RDF_TYPE,
  isa: RDF_TYPE,
  isan: RDF_TYPE,
  instanceof: RDF_TYPE,
  isinstanceof: RDF_TYPE,
  subpropertyof: RDFS_SUBPROPERTY_OF,
  subproperty: RDFS_SUBPROPERTY_OF,
  issubpropertyof: RDFS_SUBPROPERTY_OF,
  sameas: OWL_SAME_AS,
};

/**
 * Required properties per Named Graph.
 * If any of these are missing, Ontofelia treats it as an information gap
 * and includes an onboarding goal in the system prompt.
 */
const REQUIRED_USER_PROPERTIES: Array<{ predicates: string[]; label: string; question: string }> = [
  { predicates: ['name'], label: 'Name', question: 'What is your name?' },
  { predicates: ['profession', 'occupation', 'job'], label: 'Profession', question: 'What do you do professionally or what are you working on?' },
  { predicates: ['livesin', 'city', 'location'], label: 'Location', question: 'Where do you live?' },
  { predicates: ['interests', 'interest', 'hobby', 'field'], label: 'Interests', question: 'What are your interests or fields of expertise?' },
  // NOTE: "expectations" / "main task" were intentionally removed as onboarding
  // gaps — repeatedly demanding "what do you expect from me / what should my
  // main task be?" came across as pushy. When the user gives a task, just do it.
];

const REQUIRED_IDENTITY_PROPERTIES: Array<{ predicates: string[]; label: string; question: string }> = [];

export class KnowledgeEngine {
  private reasoner?: ReasonableEngine;
  private claimService: ClaimProvenanceService;
  /** Whitelist of permitted Named Graphs — see GraphRegistry. */
  private readonly graphRegistry: GraphRegistry;

  constructor(
    private triplestore: TriplestoreAdapter,
    private config?: TriplestoreConfig,
    graphRegistry?: GraphRegistry,
  ) {
    // Only enable if Oxigraph backend is selected, as Fuseki has its own reasoner
    if (this.triplestore.backend === 'oxigraph') {
      this.reasoner = new ReasonableEngine(this.triplestore);
    }
    this.graphRegistry = graphRegistry ?? GraphRegistry.create(['ontofelia']);
    this.claimService = new ClaimProvenanceService(this.triplestore, this.graphRegistry);
  }

  /**
   * The graph whitelist in effect. Callers that mint graph URIs themselves
   * (e.g. multi-agent provisioning) can register new agents here.
   */
  get registry(): GraphRegistry {
    return this.graphRegistry;
  }

  /**
   * Validate a graph URI against the whitelist before any write.
   * Throws GraphPolicyError (LLM-readable) when the graph is not registered.
   */
  private assertGraph(graphUri: string): string {
    this.graphRegistry.assertWritable(graphUri);
    return graphUri;
  }

  /** Convert a human-readable name to an entity URI */
  private toEntityUri(name: string): string {
    if (name.startsWith('urn:') || name.startsWith('http://') || name.startsWith('https://')) {
      // Very basic validation to prevent > injection in absolute URIs
      if (name.includes('>')) throw new Error('Invalid URI: cannot contain ">"');
      return name;
    }
    const normalized = encodeURIComponent(name.trim().replace(/\s+/g, '_'));
    return `${ENTITY_NS}${normalized}`;
  }

  /**
   * Convert a property name to a camelCase property URI.
   *
   * Two cases the LLM emits, both must funnel to the same URI:
   *   - already camelCase (`hasName`, `worksAt`)   → preserved verbatim
   *   - whitespace or underscore separated         → camelCased
   *     (`has name` / `works_at` → `hasName` / `worksAt`)
   *
   * The old implementation lowercased `parts[0]` unconditionally, so a
   * single-token camelCase input lost its capitals (`hasName` → `hasname`).
   * That spawned ad-hoc predicates disconnected from the TBox and was the
   * main reason the reasoner had almost nothing to do.
   */
  private toPropertyUri(name: string): string {
    if (name.startsWith('urn:') || name.startsWith('http://') || name.startsWith('https://')) {
      if (name.includes('>')) throw new Error('Invalid URI: cannot contain ">"');
      return name;
    }
    // Funnel relational predicates onto canonical RDF/RDFS/OWL vocabulary so the
    // reasoner can act on subsumption / type / property-hierarchy assertions.
    const builtin = BUILTIN_PREDICATES[name.trim().toLowerCase().replace(/[\s_-]+/g, '')];
    if (builtin) return builtin;
    const trimmed = name.trim();
    const parts = trimmed.split(/[\s_]+/).filter(Boolean);
    let camel: string;
    if (parts.length <= 1) {
      // Single-token input: preserve casing. The leading character is forced
      // lowercase so a Pascal-cased "HasName" still becomes "hasName" — the
      // convention in `urn:shared:ontology` is leading-lowercase camelCase.
      const tok = parts[0] ?? '';
      camel = tok.length === 0 ? '' : tok.charAt(0).toLowerCase() + tok.slice(1);
    } else {
      camel = parts[0].toLowerCase() +
        parts.slice(1)
          .map(p => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
          .join('');
    }
    return `${CORE_NS}${encodeURIComponent(camel)}`;
  }

  /** Map a type name to its OWL class URI */
  private typeToClassUri(type: string): string {
    return `${CORE_NS}${type}`;
  }

  /** Escape a string for use in a SPARQL literal */
  private escapeLiteral(s: string): string {
    return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
  }

  /**
   * Find an existing entity whose rdfs:label matches `name` case-insensitively.
   * This prevents "Berlin"/"berlin" or "User"/"user" from becoming separate
   * nodes. Returns the existing URI, or null if none matches.
   */
  private async findEntityByLabel(name: string): Promise<string | null> {
    const needle = this.escapeLiteral(name.trim().toLowerCase());
    try {
      const res = await this.triplestore.query(`
        PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
        SELECT ?e WHERE {
          GRAPH ?g { ?e rdfs:label ?l }
          FILTER(LCASE(STR(?l)) = "${needle}")
        } LIMIT 1
      `);
      if (res.type === 'bindings' && res.bindings && res.bindings.length > 0) {
        const e = res.bindings[0]['e'];
        return e && e.type === 'uri' ? e.value : null;
      }
    } catch { /* fall through to slug-based URI */ }
    return null;
  }

  /**
   * Resolve an entity: find existing or create new Individual in the ABox.
   *
   * Resolution order:
   *   1. `canonicalUri` — caller already knows the identity (e.g. the user).
   *   2. label match    — an entity with the same label (case-insensitive)
   *      already exists; reuse it instead of minting a duplicate node.
   *   3. slug URI       — derive a fresh URI from the name.
   */
  async resolveEntity(
    name: string,
    type?: string,
    agentGraph?: string,
    canonicalUri?: string
  ): Promise<{ uri: string; isNew: boolean }> {
    const uri = canonicalUri
      ?? (await this.findEntityByLabel(name))
      ?? this.toEntityUri(name);

    // Check if entity already exists anywhere
    const exists = await this.triplestore.ask(`ASK { GRAPH ?g { <${uri}> a ?type } }`);

    if (!exists && type) {
      const classUri = this.typeToClassUri(type);
      const graph = this.assertGraph(agentGraph || TBOX_GRAPH);

      await this.triplestore.update(`
        PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
        INSERT DATA {
          GRAPH <${graph}> {
            <${uri}> a <${classUri}> .
            <${uri}> rdfs:label "${this.escapeLiteral(name)}" .
          }
        }
      `);
      return { uri, isNew: true };
    }

    return { uri, isNew: false };
  }

  /**
   * Locate an existing property whose `rdfs:label` matches `name`
   * case-insensitively, in either the shared TBox or the agent's local
   * schema graph. Returns the existing URI when one matches, else null.
   *
   * Without this, a single CV could spawn `worksAt` (admin TBox),
   * `worksat` (lowercased ad-hoc) and `works_at` as three separate
   * predicates that the reasoner cannot relate.
   */
  private async findPropertyByLabel(
    name: string,
    agentId: string,
  ): Promise<string | null> {
    const needle = this.escapeLiteral(name.trim().toLowerCase());
    const schemaGraph = GraphUriResolver.getSchemaGraph(agentId);
    try {
      const res = await this.triplestore.query(`
        PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
        PREFIX rdf:  <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
        PREFIX owl:  <http://www.w3.org/2002/07/owl#>
        SELECT ?p WHERE {
          {
            GRAPH <${TBOX_GRAPH}> {
              ?p rdfs:label ?l .
              { ?p a owl:ObjectProperty } UNION
              { ?p a owl:DatatypeProperty } UNION
              { ?p a rdf:Property }
            }
          } UNION {
            GRAPH <${schemaGraph}> {
              ?p a rdf:Property ; rdfs:label ?l .
            }
          }
          FILTER(LCASE(STR(?l)) = "${needle}")
        }
        LIMIT 1
      `);
      if (res.type === 'bindings' && res.bindings && res.bindings.length > 0) {
        const p = res.bindings[0]['p'];
        return p && p.type === 'uri' ? p.value : null;
      }
    } catch {
      // Triplestore error — fall through, caller will mint a fresh URI.
    }
    return null;
  }

  /**
   * Resolve a property to its URI, registering it if it is new.
   *
   * Resolution order (concept-conformant predicate hygiene):
   *   1. **Label lookup** — an existing property whose `rdfs:label` matches
   *      case-insensitively is reused, whether it lives in the shared TBox
   *      (`urn:shared:ontology`) or in `urn:<agent>:schema`. This funnels
   *      `hasName` / `hasname` / `has name` to one URI.
   *   2. **URI lookup** — the slugged URI is already known to the store.
   *   3. **Register** — otherwise the predicate is freshly minted in
   *      `urn:<agent>:schema`. The shared TBox stays admin-only and is
   *      NEVER mutated here.
   *
   * Returns `isNew: true` when the predicate was just registered.
   */
  async resolveProperty(
    name: string,
    agentId: string,
  ): Promise<{ uri: string; isNew: boolean }> {
    const uri = this.toPropertyUri(name);

    // 0. Builtin RDF/RDFS/OWL terms are understood by the reasoner natively and
    //    must never be re-declared as ad-hoc agent predicates. This check MUST
    //    precede the label lookup: a previous run may have minted an
    //    `urn:ontofelia:core#subClassOf` carrying rdfs:label "subClassOf", and
    //    a label match would otherwise short-circuit back to that broken
    //    predicate, defeating the canonicalization.
    if (BUILTIN_NAMESPACES.some(ns => uri.startsWith(ns))) {
      return { uri, isNew: false };
    }

    // 1. Reuse an existing property when a label match exists.
    const labelMatch = await this.findPropertyByLabel(name, agentId);
    if (labelMatch) return { uri: labelMatch, isNew: false };

    // 2. Known if defined in any graph — shared TBox or any agent schema graph.
    const isKnown = await this.triplestore.ask(`ASK { GRAPH ?g { <${uri}> a ?type } }`);
    if (isKnown) return { uri, isNew: false };

    // 3. Register the new predicate in the agent-local schema graph.
    const schemaGraph = this.assertGraph(GraphUriResolver.getSchemaGraph(agentId));
    await this.triplestore.update(`
      INSERT DATA {
        GRAPH <${schemaGraph}> {
          <${uri}> a <http://www.w3.org/1999/02/22-rdf-syntax-ns#Property> .
          <${uri}> <http://www.w3.org/2000/01/rdf-schema#label> "${this.escapeLiteral(name)}" .
        }
      }
    `);
    return { uri, isNew: true };
  }

  /**
   * List all known entity labels from the agent's knowledge graphs.
   * Used for entity matching (NER) against user messages.
   *
   * Reads the worldview graph (+ the current user's graph when `userId` is
   * given) — not the dead `:abox` graph (#986) — so the entity matcher sees
   * the labels that `storeFact()` actually wrote.
   */
  async listKnownEntities(agentId: string, userId?: string): Promise<string[]> {
    const valuesG = this.graphValuesClause(this.knowledgeGraphsFor(agentId, userId), '?g');
    try {
      const query = `
        PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
        SELECT DISTINCT ?label WHERE {
          ${valuesG}
          GRAPH ?g {
            ?entity rdfs:label ?label .
          }
        }
        LIMIT 500
      `;
      const res = await this.triplestore.query(query);
      if (res?.type === 'bindings' && res.bindings) {
        return res.bindings
          .map((b: Record<string, { value: string }>) => b.label?.value)
          .filter(Boolean) as string[];
      }
    } catch {
      // Triplestore not available
    }
    return [];
  }

  /**
   * The agent's readable long-term knowledge graphs for a given user.
   *
   * These are the graphs `storeFact()` / `resolveTargetGraph()` actually write
   * to — `urn:<agent>:worldview` (shared, general world facts), plus the
   * CURRENT user's graph (`urn:<agent>:user:<userId>`) when a `userId` is
   * known. The legacy `urn:ontofelia:agent:<agent>:abox` graph that the recall
   * functions used to query is NOT written by anything, which is why recall
   * returned nothing in the live runtime (#986).
   *
   * Only the current user's graph is ever included — never all users — so the
   * per-user isolation guarantee (#869) holds.
   *
   * Two graphs are deliberately EXCLUDED:
   *   - `:self` (identity) — surfaced separately by `getSystemPromptContext()`;
   *     including it here would duplicate the agent's identity into the
   *     "world knowledge" recall.
   *   - `:inferred` — a single, agent-global graph into which on-write
   *     materialisation writes every user's inferred triples. It is NOT
   *     user-scoped, so reading it inside a per-user recall would leak one
   *     user's (inferred) facts to another (#869). Surfacing multi-hop
   *     inferences in recall needs a per-user inferred graph first.
   */
  private knowledgeGraphsFor(agentId: string, userId?: string): string[] {
    const graphs = [GraphUriResolver.getWorldviewGraph(agentId)];
    if (userId) graphs.push(GraphUriResolver.getUserGraph(agentId, userId));
    return graphs;
  }

  /** Build a SPARQL `VALUES ?var { <g1> <g2> … }` clause over graph URIs. */
  private graphValuesClause(graphs: string[], varName = '?g'): string {
    return `VALUES ${varName} { ${graphs.map((g) => `<${g}>`).join(' ')} }`;
  }

  /**
   * Get human-readable facts about specified entities (max `limit`).
   * Returns a formatted string ready for system prompt injection.
   *
   * Reads across the agent's real knowledge graphs (see `knowledgeGraphsFor`),
   * not the dead `:abox` graph (#986). Labels are resolved across ANY named
   * graph (`GRAPH ?lg`) because predicate labels live in the schema/TBox graph
   * while entity labels live in the fact graph — and the embedded Oxigraph
   * store has an empty default graph, so an un-scoped label join matches
   * nothing.
   */
  async getFactsAbout(entities: string[], agentId: string, limit = 20, userId?: string): Promise<string> {
    const valuesG = this.graphValuesClause(this.knowledgeGraphsFor(agentId, userId), '?g');
    const facts: string[] = [];

    for (const entity of entities) {
      if (facts.length >= limit) break;
      const entityUri = this.toEntityUri(entity);

      try {
        const query = `
          PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
          SELECT ?pred ?predLabel ?other ?otherLabel ?direction WHERE {
            ${valuesG}
            {
              GRAPH ?g { <${entityUri}> ?pred ?other . }
              BIND("out" AS ?direction)
              FILTER(?pred != <http://www.w3.org/1999/02/22-rdf-syntax-ns#type>)
              FILTER(?pred != <http://www.w3.org/2000/01/rdf-schema#label>)
            } UNION {
              GRAPH ?g { ?other ?pred <${entityUri}> . }
              BIND("in" AS ?direction)
              FILTER(?pred != <http://www.w3.org/1999/02/22-rdf-syntax-ns#type>)
            }
            OPTIONAL { GRAPH ?plg { ?pred rdfs:label ?predLabel } }
            OPTIONAL { GRAPH ?olg { ?other rdfs:label ?otherLabel } }
          }
          LIMIT ${limit - facts.length}
        `;
        const res = await this.triplestore.query(query);
        if (res?.type === 'bindings' && res.bindings) {
          for (const b of res.bindings) {
            const pred = b.predLabel?.value || this.uriToLabel(b.pred?.value || '?');
            const other = b.otherLabel?.value
              || (b.other?.type === 'literal' ? b.other.value : this.uriToLabel(b.other?.value || '?'));
            const dir = b.direction?.value;
            if (dir === 'out') {
              facts.push(`- ${entity} ${pred} ${other}`);
            } else {
              facts.push(`- ${other} ${pred} ${entity}`);
            }
          }
        }
      } catch {
        // Skip entity on error
      }
    }

    if (facts.length === 0) return '';
    return facts.join('\n');
  }

  /**
   * Load the most recent facts from the agent's knowledge graphs regardless of
   * entity. This gives the agent persistent memory across all sessions.
   *
   * Reads the worldview graph (+ the current user's graph when `userId` is
   * given) — not the dead `:abox` graph (#986). Labels are resolved across any
   * named graph because the embedded Oxigraph store has an empty default graph.
   */
  async getRecentFacts(agentId: string, limit = 30, userId?: string): Promise<string> {
    const valuesG = this.graphValuesClause(this.knowledgeGraphsFor(agentId, userId), '?g');

    try {
      const query = `
        PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
        PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
        PREFIX owl: <http://www.w3.org/2002/07/owl#>

        SELECT ?s ?sLabel ?p ?pLabel ?o ?oLabel WHERE {
          ${valuesG}
          GRAPH ?g { ?s ?p ?o . }
          OPTIONAL { GRAPH ?slg { ?s rdfs:label ?sLabel } }
          OPTIONAL { GRAPH ?plg { ?p rdfs:label ?pLabel } }
          OPTIONAL { GRAPH ?olg { ?o rdfs:label ?oLabel } }
          FILTER(?p != rdf:type)
          FILTER(?p != rdfs:label)
          FILTER(?p != rdfs:domain)
          FILTER(?p != rdfs:range)
          FILTER(?p != owl:sameAs)
        }
        LIMIT ${limit}
      `;

      const res = await this.triplestore.query(query);
      if (res?.type === 'bindings' && res.bindings && res.bindings.length > 0) {
        const facts = res.bindings.map((b: Record<string, { value: string }>) => {
          const s = b.sLabel?.value || this.uriToLabel(b.s?.value || '?');
          const p = b.pLabel?.value || this.uriToLabel(b.p?.value || '?');
          const o = b.oLabel?.value || b.o?.value || '?';
          return `- ${s} → ${p} → ${o}`;
        });
        // Deduplicate
        return [...new Set(facts)].join('\n');
      }
    } catch {
      // Triplestore may not be available
    }
    return '';
  }

  /** Extract a human-readable label from a URI (e.g. urn:ontofelia:core#livesIn → lives in) */
  private uriToLabel(uri: string): string {
    const fragment = uri.includes('#') ? uri.split('#').pop()! : uri.split('/').pop()!;
    // camelCase → spaces: "livesIn" → "lives In" → "lives in"
    return fragment.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase();
  }

  /**
   * Check if a fact (subject-predicate-object triple) already exists in the ABox.
   *
   * The predicate URI is resolved via the same label-lookup path as
   * `resolveProperty` so the duplicate check targets the canonical URI a
   * subsequent write would use — not a fresh, lowercased ad-hoc URI.
   */
  async isDuplicate(fact: FactInput, agentId: string, context?: FactContext): Promise<boolean> {
    // Use the canonical subject URI when context is available, so the check
    // targets the SAME node storeFact() will actually write to (user node,
    // agent entity, or slug) — see canonicalSubjectUri (#1035 M3).
    const subjectUri = (context && this.canonicalSubjectUri(fact, context))
      || this.toEntityUri(fact.subject);
    const predicateUri =
      (await this.findPropertyByLabel(fact.predicate, agentId)) ??
      this.toPropertyUri(fact.predicate);

    let objectClause: string;
    if (fact.objectType === 'literal' || !fact.objectType) {
      objectClause = `"${this.escapeLiteral(fact.object)}"`;
    } else {
      objectClause = `<${this.toEntityUri(fact.object)}>`;
    }

    try {
      // Check the graph the fact would actually be written to; if no context
      // is available, fall back to a graph-agnostic match so duplicates are
      // still caught wherever the triple lives.
      if (context) {
        const targetGraph = this.resolveTargetGraph(fact, context);
        return await this.triplestore.ask(
          `ASK { GRAPH <${targetGraph}> { <${subjectUri}> <${predicateUri}> ${objectClause} } }`
        );
      }
      return await this.triplestore.ask(
        `ASK { GRAPH ?g { <${subjectUri}> <${predicateUri}> ${objectClause} } }`
      );
    } catch {
      return false;
    }
  }

  /**
   * Subject names that always denote the agent itself, regardless of NER type.
   *
   * NOTE: `'me'` was deliberately removed (#1035). In a USER message "me" always
   * denotes the speaker (the user), never the agent — keeping it here let an
   * agent-subject mis-resolution capture first-person user facts. `'me'` now
   * lives ONLY in USER_ALIASES.
   */
  private static readonly SELF_ALIASES = new Set(['ontofelia', 'self']);

  /** Subject names that denote the current user rather than a named person. */
  private static readonly USER_ALIASES = new Set([
    'user', 'me', 'i',
  ]);

  /**
   * Normalized predicates that flag a user-stated agent fact as an
   * EXPECTATION / REQUEST ("you should help me…", `isRequestedToHelpWith`)
   * rather than a DESCRIPTIVE / identity statement about the agent.
   *
   * This set is the discrimination mechanism for #1035: a user-stated fact
   * whose subject is the agent is re-anchored onto the user node ONLY when its
   * predicate is one of these. Everything else (name, description, label,
   * behavior, capability, "is", …) is descriptive and stays on the agent
   * entity. The default for an agent-subject fact is therefore *descriptive*;
   * re-anchoring is the narrow exception.
   *
   * IMPORTANT (#1035 H1): matching is EXACT against the normalized predicate
   * (lowercased, non-alphanumerics stripped), NOT a substring/`includes` test.
   * Bare-root substring matching ("requested"/"expected") wrongly captured
   * descriptive predicates that merely *contain* those roots — e.g.
   * `expectedBehavior`, `hasRequestedFeature`, `expectedResponseTime`,
   * `unexpectedBehavior` — and re-anchored them onto the owner (AC#3 regression).
   * The only must-pass request predicate is `isRequestedToHelpWith`; the entries
   * below are genuine whole-token request predicates, none of which is merely a
   * descriptive predicate containing "expected"/"requested".
   */
  private static readonly EXPECTATION_PREDICATES = new Set([
    'isrequestedtohelpwith',
    'requestedtohelpwith',
    'requestedhelp',
    'helprequest',
    'helprequested',
    'isaskedto',
    'isaskedtohelpwith',
    'askedtohelpwith',
    'shouldhelpwith',
    'wantshelpwith',
    'userexpectation',
    'userrequest',
  ]);

  /**
   * True when a predicate denotes a user expectation/request directed at the
   * agent (the re-anchor case). Matching is EXACT against the normalized
   * predicate (lowercased, non-alphanumerics stripped) so "isRequestedToHelpWith",
   * "is_requested_to_help_with" and "Is Requested To Help With" all collapse to
   * the single canonical token `isrequestedtohelpwith` and match, while
   * descriptive predicates that merely contain a request root (`expectedBehavior`,
   * `hasRequestedFeature`, `expectedResponseTime`) do NOT match. (#1035 H1)
   */
  private isExpectationPredicate(predicate: string): boolean {
    const norm = (predicate || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!norm) return false;
    return KnowledgeEngine.EXPECTATION_PREDICATES.has(norm);
  }

  /**
   * The canonical entity URI for a given user. All references to the user —
   * "User", "user", "I", and the user's actual name — must resolve to this
   * one node so their facts do not scatter across duplicate entities.
   */
  private userEntityUri(userId: string): string {
    return `${ENTITY_NS}user:${encodeURIComponent(userId)}`;
  }

  /**
   * The agent's human-readable DISPLAY name, derived from its id. SINGLE SOURCE
   * OF TRUTH (#1035 M2) for the agent's name — `agentEntityUri`, `denotesAgent`
   * and any future agent-name logic must go through here so they cannot drift.
   *
   * INVARIANT: `agentId` is the lowercased display name of the agent (the live
   * agent is `ontofelia` → display `Ontofelia`). The display name is therefore
   * the id with its leading character capitalized, matching the spec's
   * `urn:ontofelia:entity:Ontofelia` and the parser's emitted subject
   * `Ontofelia`. If a future agentId ever violates this invariant (multi-word,
   * non-leading-cap), this is the one place to extend (e.g. a config/self.ttl
   * label lookup); the worst case today is a duplicate agent-entity node, never
   * an owner collapse.
   */
  private agentDisplayName(agentId: string): string {
    return agentId.charAt(0).toUpperCase() + agentId.slice(1);
  }

  /**
   * The canonical entity URI for the AGENT itself (e.g.
   * `urn:ontofelia:entity:Ontofelia`). Descriptive / identity facts the user
   * states about the agent ("Du bist Ontofelia", "Du sagst dauernd du") are
   * pinned here so the agent's self-facts share one node and can NEVER collapse
   * onto the owner. Derived from the agentId (not the owner). (#1035)
   */
  private agentEntityUri(agentId: string): string {
    return `${ENTITY_NS}${encodeURIComponent(this.agentDisplayName(agentId))}`;
  }

  /**
   * Normalize a name to a comparison key: lowercase, non-alphanumerics stripped.
   * Shared by the agent-identity tests so "Ontofelia", "ontofelia",
   * "Onto Felia" and "onto-felia" all collapse to `ontofelia`.
   */
  private static normalizeName(name: string): string {
    return (name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  /**
   * True when `name` denotes THIS agent. ONE shared identity test (#1035 M1)
   * reused by BOTH the subject-side `isAboutAgent` and the object-side G1
   * sameAs guard, so the two can never drift onto different spellings.
   *
   * It normalizes the candidate (lowercase, strip non-alphanumerics) and
   * compares against the agent's display name plus the SELF_ALIASES set. This
   * catches alternate display spellings — e.g. the parser-slugged object
   * "Onto Felia" → `ontofelia` → blocked — that a raw slug-equality check on
   * `agentEntityUri` would miss.
   */
  private denotesAgent(name: string, agentId: string): boolean {
    const norm = KnowledgeEngine.normalizeName(name);
    if (!norm) return false;
    if (norm === KnowledgeEngine.normalizeName(this.agentDisplayName(agentId))) return true;
    for (const alias of KnowledgeEngine.SELF_ALIASES) {
      if (norm === KnowledgeEngine.normalizeName(alias)) return true;
    }
    return false;
  }

  /**
   * If a fact's subject denotes the current user, return the canonical user
   * URI. Otherwise null, so general entity resolution applies.
   *
   * Strict rule: only an explicit user alias ("User", "I", "me") collapses to
   * the user node. We must NEVER pull third-party people (Anna, Tom, …) onto
   * the user node just because they are typed as Person — that conflation
   * scatters Anna's facts onto Alice and was the root cause of the
   * "I am a doctor in Hamburg" hallucinations.
   *
   * Expectations the user voices about the agent ("you should help me…",
   * predicate `isRequestedToHelpWith`) are grammatically about the agent but
   * semantically about what the user wants from the agent. Re-anchor ONLY those
   * onto the user node so they land in the per-user graph instead of bouncing
   * off the write-protected self graph.
   *
   * A DESCRIPTIVE / identity fact about the agent ("Du bist Ontofelia", "Du
   * sagst die ganze Zeit du") is NOT re-anchored — it returns null here so the
   * subject stays the agent entity (storeFact pins it via agentEntityUri).
   * The split is decided by `isExpectationPredicate`; default = descriptive.
   * (#1035)
   */
  private canonicalUserUri(name: string, fact: FactInput, context: FactContext): string | null {
    if (!context.userId) return null;
    const lc = (name || '').trim().toLowerCase();
    if (KnowledgeEngine.USER_ALIASES.has(lc)) {
      return this.userEntityUri(context.userId);
    }
    const fromUser = fact.sourceKind === 'user' || context.isOwner;
    if (fromUser && this.isAboutAgent(fact, context.agentId) && this.isExpectationPredicate(fact.predicate)) {
      return this.userEntityUri(context.userId);
    }
    return null;
  }

  /**
   * SINGLE SOURCE OF TRUTH for the canonical subject pin of a stored fact
   * (#1035 M3): user-alias / re-anchored-expectation → canonical user node;
   * otherwise a descriptive/identity fact about the agent → canonical agent
   * entity; otherwise `undefined` to let `resolveEntity` apply its label-match /
   * slug resolution (so third-party subjects like "Anna" still reuse an existing
   * labelled node instead of always minting a fresh slug).
   *
   * Both the write path (`storeFact`) and the dedup path (`isDuplicate`) call
   * this so the duplicate key matches the write key — previously `isDuplicate`
   * ignored the agent-canonicalization and could under-match a `self`-alias
   * subject.
   */
  private canonicalSubjectUri(fact: FactInput, context: FactContext): string | undefined {
    const userCanonical = this.canonicalUserUri(fact.subject, fact, context);
    if (userCanonical) return userCanonical;
    if (this.isAboutAgent(fact, context.agentId)) {
      return this.agentEntityUri(context.agentId);
    }
    return undefined;
  }

  /**
   * Route a fact to its correct Named Graph per the knowledge-graph concept.
   *
   * Important: urn:<agent>:self is WRITE-PROTECTED (concept §2 — "nur durch
   * Administration"). The runtime ingestion pipeline must therefore NEVER
   * route a fact there, even when the fact is phrased about the agent.
   *
   * Routing rules:
   *   - Fact about the user themselves (subject is a user alias)
   *       → urn:<agent>:user:<userId>
   *   - Fact the user states about the agent (expectation/wish)
   *       → urn:<agent>:user:<userId>  (re-anchored to the user node)
   *   - Everything else stated by the user — third parties (Anna, Tom),
   *     pets (Felix), world knowledge ("Paris is the capital of France")
   *       → urn:<agent>:worldview
   *   - Agent/tool-derived facts
   *       → urn:<agent>:worldview
   *
   * Before this fix, every user-asserted fact landed in the user graph and
   * the worldview graph was dead. That violated the concept and made Anna
   * indistinguishable from Alice at the storage layer.
   */
  private resolveTargetGraph(fact: FactInput, context: FactContext): string {
    const fromUser = fact.sourceKind === 'user' || context.isOwner;
    if (fromUser && context.userId) {
      const subjectLc = (fact.subject || '').trim().toLowerCase();
      const isUserSubject = KnowledgeEngine.USER_ALIASES.has(subjectLc);
      // A user EXPECTATION/REQUEST about the agent is re-anchored to the user
      // node, so it belongs in the per-user graph. A DESCRIPTIVE / identity fact
      // about the agent must NOT go there — it stays on the agent entity and
      // routes to the (shared) worldview graph, never the write-protected self
      // graph and never the owner's user graph. (#1035)
      const isAgentExpectation = this.isAboutAgent(fact, context.agentId) && this.isExpectationPredicate(fact.predicate);
      if (isUserSubject || isAgentExpectation) {
        return GraphUriResolver.getUserGraph(context.agentId, context.userId);
      }
    }
    return GraphUriResolver.getWorldviewGraph(context.agentId);
  }

  /**
   * True when a fact is grammatically about the agent ("Ontofelia ...",
   * subjectType 'Agent', a SELF_ALIAS subject, or — when `agentId` is given —
   * the agent's own display name in any spelling).
   *
   * The subject-side identity test delegates to the SHARED `denotesAgent`
   * helper (#1035 M1) so it can never drift from the object-side G1 sameAs
   * guard. `agentId` is optional so callers that only need the structural
   * `subjectType`/SELF_ALIAS check (and the private-method tests) still work.
   *
   * NOTE: being "about the agent" does NOT by itself trigger a re-anchor onto
   * the user node. Only the subset whose predicate is an expectation/request
   * (see `isExpectationPredicate`) is re-anchored; descriptive/identity agent
   * facts stay on the agent entity. (#1035)
   */
  private isAboutAgent(fact: FactInput, agentId?: string): boolean {
    if (fact.subjectType === 'Agent') return true;
    const subjectLc = (fact.subject || '').trim().toLowerCase();
    if (KnowledgeEngine.SELF_ALIASES.has(subjectLc)) return true;
    return agentId ? this.denotesAgent(fact.subject, agentId) : false;
  }

  /**
   * Find existing accepted claims that contradict a new fact: same canonical
   * subject and predicate, but a different object. Used by belief revision.
   *
   * The query is scoped to this agent's claims graph and ignores claims that
   * are already superseded/retracted/rejected — only currently accepted
   * claims compete with the incoming fact.
   */
  private async findConflictingClaims(
    subjectUri: string,
    predicateUri: string,
    newObjectTriple: string,
    agentId: string,
  ): Promise<Array<{ claimUri: string; objectTriple: string; assertedInGraph: string }>> {
    const claimsGraph = GraphUriResolver.getClaimsGraph(agentId);
    const sparql = `
      PREFIX core: <urn:shared:ontology#>
      SELECT ?claim ?o ?g WHERE {
        GRAPH <${claimsGraph}> {
          ?claim a core:Claim ;
                 core:claimSubject    <${subjectUri}> ;
                 core:claimPredicate  <${predicateUri}> ;
                 core:claimObject     ?o ;
                 core:assertedInGraph ?g ;
                 core:status          "accepted" .
        }
      }
    `;
    try {
      const res = await this.triplestore.query(sparql);
      if (res.type !== 'bindings' || !res.bindings) return [];
      const out: Array<{ claimUri: string; objectTriple: string; assertedInGraph: string }> = [];
      for (const b of res.bindings) {
        const claimUri = b['claim']?.value;
        const oTerm = b['o'];
        const g = b['g']?.value;
        if (!claimUri || !oTerm || !g) continue;
        const oTriple = oTerm.type === 'uri' ? `<${oTerm.value}>`
          : `"${this.escapeLiteral(oTerm.value)}"`;
        if (oTriple === newObjectTriple) continue; // not a conflict — same fact
        out.push({ claimUri, objectTriple: oTriple, assertedInGraph: g });
      }
      return out;
    } catch {
      return [];
    }
  }

  /**
   * Check whether a predicate is declared as owl:FunctionalProperty in the
   * TBox or agent-local schema. Functional properties are single-valued:
   * a new value supersedes any existing value. Non-functional properties
   * (the default in OWL) are multi-valued: multiple values coexist.
   */
  private async isFunctionalProperty(predicateUri: string): Promise<boolean> {
    try {
      return await this.triplestore.ask(
        `ASK { GRAPH ?g { <${predicateUri}> a <${OWL_FUNCTIONAL_PROPERTY}> } }`
      );
    } catch {
      // Conservative default: treat as non-functional (multi-valued)
      return false;
    }
  }

  /**
   * Belief revision: retire a superseded claim and remove its base triple.
   * The claim object stays in the claims graph with status "superseded" so
   * the history is preserved (concept §4 — explainable change). A conflict
   * record is also written so the supersession is visible to monitoring.
   */
  private async retireSupersededClaim(
    claim: { claimUri: string; objectTriple: string; assertedInGraph: string },
    agentId: string,
  ): Promise<void> {
    const now = new Date().toISOString();
    const conflictsGraph = GraphUriResolver.getConflictsGraph(agentId);
    const conflictUri = `urn:ontofelia:conflict:${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    // Drop the obsolete claim's accepted status and flag it superseded.
    await this.triplestore.update(`
      PREFIX core: <urn:shared:ontology#>
      DELETE { GRAPH ?g { <${claim.claimUri}> core:status "accepted" . } }
      INSERT {
        GRAPH ?g {
          <${claim.claimUri}> core:status "superseded" .
          <${claim.claimUri}> core:supersededAt "${now}" .
        }
      }
      WHERE { GRAPH ?g { <${claim.claimUri}> core:status "accepted" . } }
    `);

    // Remove the base triple — it is no longer accepted as true.
    // We need the claim's subject/predicate/object for the DELETE; re-fetch them.
    const claimDetails = await this.triplestore.query(`
      PREFIX core: <urn:shared:ontology#>
      SELECT ?s ?p ?o WHERE {
        GRAPH ?g {
          <${claim.claimUri}> core:claimSubject ?s ;
                              core:claimPredicate ?p ;
                              core:claimObject ?o .
        }
      } LIMIT 1
    `);
    if (claimDetails.type === 'bindings' && claimDetails.bindings && claimDetails.bindings.length > 0) {
      const s = claimDetails.bindings[0]['s']?.value;
      const p = claimDetails.bindings[0]['p']?.value;
      const oTerm = claimDetails.bindings[0]['o'];
      if (s && p) {
        await this.triplestore.update(`
          DELETE DATA {
            GRAPH <${claim.assertedInGraph}> {
              <${s}> <${p}> ${claim.objectTriple} .
            }
          }
        `);

        // Truth maintenance: a retired base triple may have supported
        // entailments in the inferred graph. With the base triple already
        // removed from the live store, materialize() over the retired triple
        // yields exactly the inferences it (and nothing else) caused — any
        // entailment still independently derivable is excluded by the diff,
        // so we never over-retract. Without this step the inferred graph
        // accumulates stale conclusions after every belief revision.
        if (this.reasoner && oTerm) {
          const retired = {
            subject: s,
            predicate: p,
            object: oTerm.type === 'uri'
              ? { type: 'uri', value: oTerm.value }
              : { type: 'literal', value: oTerm.value, language: oTerm.language },
          };
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const stale = await this.reasoner.materialize([retired as any], claim.assertedInGraph);
            if (stale.length > 0) {
              const inferredGraph = GraphUriResolver.getInferredGraph(agentId);
              const lines = stale.map(t => {
                const subj = `<${t.subject}>`;
                const pred = `<${t.predicate}>`;
                let obj: string;
                if (typeof t.object === 'string') {
                  obj = (t.object.startsWith('http') || t.object.startsWith('urn:'))
                    ? `<${t.object}>` : `"${this.escapeLiteral(t.object)}"`;
                } else if (t.object.type === 'uri') {
                  obj = `<${t.object.value}>`;
                } else {
                  obj = `"${this.escapeLiteral(t.object.value)}"`
                    + (t.object.language ? `@${t.object.language}` : '');
                }
                return `${subj} ${pred} ${obj} .`;
              }).join('\n');
              await this.triplestore.update(
                `DELETE DATA { GRAPH <${inferredGraph}> {\n${lines}\n} }`,
              );
            }
          } catch {
            // Truth maintenance is best-effort — never block belief revision.
          }
        }
      }
    }

    // Materialize a Conflict object so the audit trail is queryable.
    await this.triplestore.update(`
      PREFIX core: <urn:shared:ontology#>
      INSERT DATA {
        GRAPH <${conflictsGraph}> {
          <${conflictUri}> a core:Conflict ;
            core:conflictType "supersession" ;
            core:supersededClaim <${claim.claimUri}> ;
            core:detectedAt "${now}" ;
            core:status "resolved" .
        }
      }
    `);
  }

  /**
   * Store a fact as real RDF triples in the ABox, with provenance.
   * Automatically resolves entities and properties (creating them if needed).
   * Skips storage if the exact triple already exists (duplicate detection).
   */
  async storeFact(fact: FactInput, context: FactContext): Promise<StoreResult> {
    // Duplicate check — skip if triple already exists
    if (await this.isDuplicate(fact, context.agentId, context)) {
      return {
        success: true,
        subjectUri: this.toEntityUri(fact.subject),
        predicateUri: this.toPropertyUri(fact.predicate),
        objectUri: fact.objectType === 'literal' || !fact.objectType
          ? fact.object
          : this.toEntityUri(fact.object),
        newEntities: [],
        newProperties: [],
        tripleCount: 0,  // 0 = duplicate, not stored
      };
    }

    // Determine target graph (see docs/knowledge-graph-concept.md §2):
    //   - facts about the user        → urn:<agent>:user:<userId>
    //   - facts about the agent self  → urn:<agent>:self
    //   - everything else (world)     → urn:<agent>:worldview
    // Validate up-front: a non-conformant graph is rejected before any write,
    // so a buggy agentId or a hallucinated target can never reach the store.
    const targetGraph = this.assertGraph(this.resolveTargetGraph(fact, context));

    const newEntities: string[] = [];
    const newProperties: string[] = [];

    // 1. Resolve subject entity.
    //    - If the subject denotes the current user (a user alias, or a user
    //      EXPECTATION/REQUEST re-anchored onto the user), pin it to the
    //      canonical user URI so all user facts share one node.
    //    - Otherwise, if it is a DESCRIPTIVE / identity fact about the agent,
    //      pin it to the canonical AGENT entity so agent self-facts share one
    //      node and never collapse onto the owner. (#1035)
    const userCanonical = this.canonicalUserUri(fact.subject, fact, context) ?? undefined;
    // canonicalSubjectUri is the single source of truth shared with isDuplicate
    // (#1035 M3): user node → agent entity → slug. It always returns a URI, so
    // we always pin the subject explicitly and the dedup key matches the write
    // key for every subject class (incl. a `self`-alias subject).
    const subjectCanonical = this.canonicalSubjectUri(fact, context);
    const subject = await this.resolveEntity(fact.subject, fact.subjectType, targetGraph, subjectCanonical);
    if (subject.isNew) newEntities.push(subject.uri);

    // 2. Resolve property. A predicate that is new is registered in the
    //    agent-local schema graph (the shared TBox stays admin-only). The
    //    fact is usable immediately — no proposal staging.
    const predicate = await this.resolveProperty(fact.predicate, context.agentId);
    if (predicate.isNew) newProperties.push(predicate.uri);

    // 3. Resolve object (entity or literal)
    let objectUri: string;
    let objectTriple: string;

    if (fact.objectType === 'literal' || !fact.objectType) {
      objectUri = fact.object;
      objectTriple = `"${this.escapeLiteral(fact.object)}"`;
    } else {
    const obj = await this.resolveEntity(fact.object, fact.objectType, targetGraph);
    if (obj.isNew) newEntities.push(obj.uri);
    objectUri = obj.uri;
    objectTriple = `<${obj.uri}>`;
  }

  // Truth-maintenance model: a new fact is accepted as true on arrival.
  // Contradictions are handled later by belief revision (status "superseded"),
  // not by a proposal gate. 'rejected' remains available for explicit removal.
  const status: 'accepted' | 'rejected' = fact.status === 'rejected'
    ? 'rejected'
    : 'accepted';

  // 3b. Belief revision: when a new accepted fact arrives with the same
  // subject+predicate but a different object, the old fact is superseded
  // (concept §4). We retire the old base triple AND mark the old claim
  // accordingly, then materialize a Conflict object so the supersession is
  // auditable. Without this step, "Anna wohnt in Köln, nicht Hamburg" would
  // leave both Köln and Hamburg in the graph forever.
  const supersededClaims: string[] = [];
  if (status === 'accepted') {
    // Only supersede when the predicate IS functional (owl:FunctionalProperty)
    // or there is a genuine logical contradiction. Multi-valued / time-
    // scopeable properties (worksAt, hasRole, memberOf, …) preserve all
    // values instead of collapsing to the last-ingested one. (#875)
    const functional = await this.isFunctionalProperty(predicate.uri);
    if (functional) {
      const conflicting = await this.findConflictingClaims(
        subject.uri, predicate.uri, objectTriple, context.agentId,
      );
      if (conflicting.length > 0) {
        for (const c of conflicting) {
          await this.retireSupersededClaim(c, context.agentId);
          supersededClaims.push(c.claimUri);
        }
      }
    }
  }

  // 4a. On-write materialization MUST run BEFORE the insert.
  // materialize() computes reason(TBox+ABox+newFact) - reason(TBox+ABox).
  // If the new fact were already in ABox both sides would be equal and the
  // diff (the genuine inferences caused by the new fact) would always be
  // empty. That is why the inferred graph stayed dead even though the
  // reasoner itself works.
  let inferredTriples: Array<{ subject: string; predicate: string; object: unknown }> = [];
  if (this.reasoner && status === 'accepted') {
    const inputTriple = {
      subject: subject.uri,
      predicate: predicate.uri,
      object: fact.objectType === 'literal' || !fact.objectType
        ? fact.object
        : { type: 'uri', value: objectUri },
    };
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      inferredTriples = await this.reasoner.materialize([inputTriple as any], targetGraph);
    } catch {
      // Reasoning is best-effort — never block ingestion if the reasoner trips.
    }
  }

  // 4b. Insert the actual triple into the target graph ONLY if accepted.
  if (status === 'accepted') {
    await this.triplestore.update(`
      INSERT DATA {
        GRAPH <${targetGraph}> {
          <${subject.uri}> <${predicate.uri}> ${objectTriple} .
        }
      }
    `);
  }

  // 4b-bis. Owner↔named-person entity resolution: when the user declares
  // their own name (e.g. "I am Alice", "my name is Alice"), materialize
  // an owl:sameAs link between the canonical user entity (entity:user:owner)
  // and the named person entity (entity:Alice). This ensures queries about
  // "the owner" reach the person's facts and vice versa. (#875 BUG 2)
  //
  // G2 (#1035): this fires ONLY when the subject genuinely denotes the OWNER
  // via a first-person/user alias — it MUST NOT fire on the agent re-anchor
  // path (a user expectation about the agent), so we gate on `userCanonical`
  // AND on the subject being a USER_ALIAS, not merely on a canonical subject.
  // G1 (#1035): never materialize owl:sameAs between the agent entity and the
  // owner in either direction — guarded by `objectDenotesAgent` below.
  const subjectIsUserAlias = KnowledgeEngine.USER_ALIASES.has((fact.subject || '').trim().toLowerCase());
  if (status === 'accepted' && userCanonical && subjectIsUserAlias) {
    const predLc = fact.predicate.replace(/[-_\s]/g, '').toLowerCase();
    const NAME_PREDICATES = new Set(['name', 'hasname', 'fullname', 'firstname', 'lastname', 'vorname', 'nachname']);
    if (NAME_PREDICATES.has(predLc) && (fact.objectType === 'literal' || !fact.objectType)) {
      const namedEntityUri = this.toEntityUri(fact.object);
      // G1 (#1035 M1): refuse to link the owner to the agent. Use the SHARED
      // `denotesAgent` helper — the same identity test the subject-side
      // `isAboutAgent` uses — so the two can never drift onto different name
      // spellings. Raw slug equality on `agentEntityUri` alone missed alternate
      // display spellings like "Onto Felia" (→ slug entity:Onto_Felia), which
      // would otherwise mint a spurious owner↔name sameAs.
      const objectDenotesAgent = this.denotesAgent(fact.object, context.agentId);
      // Only link if it's a different URI (not already the user entity) and the
      // object does not denote the agent.
      if (namedEntityUri !== userCanonical && !objectDenotesAgent) {
        try {
          // Symmetric sameAs: both directions
          await this.triplestore.update(`
            PREFIX owl: <http://www.w3.org/2002/07/owl#>
            INSERT DATA {
              GRAPH <${targetGraph}> {
                <${userCanonical}> owl:sameAs <${namedEntityUri}> .
                <${namedEntityUri}> owl:sameAs <${userCanonical}> .
              }
            }
          `);
        } catch {
          // Entity resolution is best-effort — never block ingestion.
        }
      }
    }
  }

  // 4c. Persist materialized inferences into urn:<agent>:inferred.
  if (status === 'accepted' && inferredTriples.length > 0) {
    const inferredGraph = this.assertGraph(
      GraphUriResolver.getInferredGraph(context.agentId),
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await this.triplestore.insertTriples(inferredGraph, inferredTriples as any);
  }

    // 5. Store provenance (Evidence and Claim)
    let evidenceUri: string | undefined;
    let evidenceGraph: string | undefined;

    // Create Evidence if we have source text or message ID
    if (fact.sourceSpan || fact.sourceMessageId) {
      const evidence = await this.claimService.createEvidence(context.agentId, {
        evidenceType: 'message-span',
        sourceMessageId: fact.sourceMessageId,
        sessionId: context.sessionId,
        channel: fact.channel,
        rawText: fact.sourceSpan
      });
      evidenceUri = evidence.uri;
      evidenceGraph = evidence.graph;
    }

    // All claims live in the agent claims graph — there is no proposal
    // staging graph in the truth-maintenance model.
    const claimsGraph = GraphUriResolver.getClaimsGraph(context.agentId);

    // Create the Claim
    await this.claimService.createClaim(
      context,
      fact,
      subject.uri,
      predicate.uri,
      objectTriple,
      targetGraph,
      claimsGraph,
      status,
      evidenceUri,
      evidenceGraph
    );

    return {
      success: true,
      subjectUri: subject.uri,
      predicateUri: predicate.uri,
      objectUri,
      newEntities,
      newProperties,
      tripleCount: 1
    };
  }

  /**
   * Run consistency checks against the knowledge graph.
   * Detects disjoint class violations and counts inferred triples.
   */
  async checkConsistency(_agentId: string): Promise<ConsistencyResult> {
    const conflicts: Array<{ type: string; description: string; subjects: string[] }> = [];

    // Check disjoint class violations
    try {
      const disjointQuery = `
        PREFIX owl: <http://www.w3.org/2002/07/owl#>
        SELECT DISTINCT ?s ?c1 ?c2 WHERE {
          ?s a ?c1 .
          ?s a ?c2 .
          ?c1 owl:disjointWith ?c2 .
          FILTER (?c1 != ?c2)
        } LIMIT 50
      `;
      const res = await this.triplestore.query(disjointQuery);
      if (res?.type === 'bindings' && res.bindings) {
        for (const b of res.bindings) {
          conflicts.push({
            type: 'disjoint_violation',
            description: `${b.s?.value} is both ${b.c1?.value} and ${b.c2?.value} which are disjoint`,
            subjects: [b.s?.value || '']
          });
        }
      }
    } catch {
      // Ignore query errors
    }

    // Count inferred triples (triples in default graph but not in any named graph)
    let newInferences = 0;
    try {
      const countQuery = `
        SELECT (COUNT(*) AS ?count) WHERE {
          ?s ?p ?o .
          FILTER NOT EXISTS { GRAPH ?g { ?s ?p ?o } }
        }
      `;
      const res = await this.triplestore.query(countQuery);
      if (res?.type === 'bindings' && res.bindings?.[0]) {
        newInferences = parseInt(res.bindings[0].count?.value || '0', 10);
      }
    } catch {
      // Ignore query errors
    }

    return {
      consistent: conflicts.length === 0,
      conflicts,
      newInferences
    };
  }

  // ── Core Named Graphs ──

  /** Query a named graph and return predicate→value pairs */
  private async queryGraphFacts(graphUri: string): Promise<Array<{ predicate: string; value: string }>> {
    const sparql = `
      SELECT ?p ?o WHERE {
        GRAPH <${graphUri}> { ?s ?p ?o }
      }
    `;
    const result = await this.triplestore.query(sparql);
    if (result.type !== 'bindings' || !result.bindings) return [];
    return result.bindings.map(b => ({
      predicate: b.p?.value || '',
      value: b.o?.value || ''
    }));
  }

  /** Convert a predicate URI to a human-readable label */
  private predicateToLabel(uri: string): string {
    // Extract local name from URI (e.g. urn:ontofelia:core#personality → personality)
    const hash = uri.lastIndexOf('#');
    const slash = uri.lastIndexOf('/');
    const local = uri.substring(Math.max(hash, slash) + 1);
    // CamelCase to spaces
    return local.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ');
  }

  /**
   * Read self, setup, and user Named Graphs and serialize them
   * to a natural-language system prompt section.
   */
  async getSystemPromptContext(agentId: string, userId: string): Promise<string> {
    const sections: string[] = [];

    const selfGraph = GraphUriResolver.getSelfGraph(agentId);
    const userGraph = GraphUriResolver.getUserGraph(agentId, userId);

    // Self graph → identity and personality
    try {
      const selfFacts = await this.queryGraphFacts(selfGraph);
      if (selfFacts.length > 0) {
        const greetingFact = selfFacts.find(f => f.predicate.includes('greetingTemplate') || f.predicate.includes('greeting'));
        const capabilities = selfFacts
          .filter(f => f.predicate.includes('capability'))
          .map(f => `- ${f.value}`);
        const personality = selfFacts
          .filter(f => !f.predicate.includes('greeting') && !f.predicate.includes('capability') && !f.predicate.includes('rdf-syntax-ns#type'))
          .map(f => `- ${this.predicateToLabel(f.predicate)}: ${f.value}`)
          .join('\n');
        
        sections.push(`## My Identity & Personality\n${personality}`);
        if (capabilities.length > 0) {
          sections.push(`### My Capabilities\n${capabilities.join('\n')}`);
        }
        if (greetingFact) {
          sections.push(`## Greeting Text for New Users\n${greetingFact.value}`);
        }
      }
    } catch { /* ignored */ }

    // User graph → who is the user
    try {
      const userFacts = await this.queryGraphFacts(userGraph);
      const meaningful = userFacts.filter(f => 
        !f.predicate.includes('rdf-syntax-ns#type') && 
        !f.predicate.includes('rdfs') &&
        !f.predicate.includes('comment')
      );
      if (meaningful.length > 0) {
        const userText = meaningful.map(f => `- ${this.predicateToLabel(f.predicate)}: ${f.value}`).join('\n');
        sections.push(`## IMPORTANT: What I Know About the User\nI already know this information. I must NOT ask for it again:\n${userText}`);
     } else {
        sections.push(`## User\nI do not know the user yet. On first contact, I introduce myself and ask for their name.`);
      }
    } catch { /* ignored */ }

    // Onboarding goal: check for information gaps
    try {
      const gaps = await this.getOnboardingGaps(agentId, userId);
      if (gaps.length > 0) {
        const gapLines = gaps.map(g => `- ${g.label} → Question: "${g.question}"`).join('\n');
        sections.push(
          `## Optional: getting to know the user (low priority)\n` +
          `A few profile details are still unknown:\n${gapLines}\n\n` +
          `These are OPTIONAL. The user's current request ALWAYS comes first — answer it fully; never make them work to give you a task. ` +
          `You MAY weave in AT MOST ONE of these questions, and only when it fits naturally and the user has NOT just given you a task or directive. ` +
          `Do NOT append a profiling question to every reply, do NOT ask more than one at a time, and NEVER re-ask something the user already answered, deferred, or ignored. ` +
          `When the user gives you a task, just do it — do not respond by asking what your role or main task should be. ` +
          `Store any details the user volunteers with memory_store.`
        );
      }
    } catch { /* ignored */ }

    return sections.join('\n\n');
  }

  /**
   * Check which required properties are still missing in the Named Graphs.
   * Returns a list of gaps with labels and suggested questions.
   */
  async getOnboardingGaps(agentId: string, userId: string): Promise<Array<{ graph: string; label: string; question: string }>> {
    const gaps: Array<{ graph: string; label: string; question: string }> = [];

    // Helper: extract local name from full predicate URI
    const localName = (uri: string) => {
      const hash = uri.lastIndexOf('#');
      const slash = uri.lastIndexOf('/');
      return uri.substring(Math.max(hash, slash) + 1).toLowerCase();
    };

    // Check user graph
    try {
      const userGraph = GraphUriResolver.getUserGraph(agentId, userId);
      const userFacts = await this.queryGraphFacts(userGraph);
      const userPredicates = new Set(userFacts.map(f => localName(f.predicate)));

      for (const req of REQUIRED_USER_PROPERTIES) {
        const found = req.predicates.some(alias => userPredicates.has(alias.toLowerCase()));
        if (!found) {
          gaps.push({ graph: 'user', label: req.label, question: req.question });
        }
      }
    } catch { /* ignored */ }

    // Check identity (self) graph
    try {
      const selfGraph = GraphUriResolver.getSelfGraph(agentId);
      const identityFacts = await this.queryGraphFacts(selfGraph);
      const identityPredicates = new Set(identityFacts.map(f => localName(f.predicate)));

      for (const req of REQUIRED_IDENTITY_PROPERTIES) {
        const found = req.predicates.some(alias => identityPredicates.has(alias.toLowerCase()));
        if (!found) {
          gaps.push({ graph: 'identity', label: req.label, question: req.question });
        }
      }
    } catch { /* ignored */ }

    return gaps;
  }

  /**
   * Populate `urn:<agent>:setup` with the agent's technical environment.
   * Per concept §2 setup is a static-ish snapshot of the runtime: backend,
   * reasoner, sandbox profile, working directories. Rewritten on every boot
   * so it stays consistent with the actual configuration.
   */
  async seedSetupGraph(
    agentId: string,
    env: {
      triplestoreBackend?: string;
      reasonerBackend?: string;
      reasonerProfile?: string;
      sandboxScope?: string;
      workspace?: string;
      gatewayPort?: number;
      gatewayHost?: string;
    },
  ): Promise<number> {
    const graphUri = this.assertGraph(GraphUriResolver.getSetupGraph(agentId));
    const setupUri = `urn:${agentId}:setup:Environment`;
    // Replace ONLY the Environment subject — never DROP the whole setup graph.
    // The setup graph also holds the cognitive feature flags
    // (urn:<agent>:setup:cognitive, written by CognitiveConfig); a graph-wide
    // DROP on every boot would silently wipe those flags, so we scope the reset
    // to the Environment resource we are about to re-seed.
    await this.triplestore.update(
      `DELETE WHERE { GRAPH <${graphUri}> { <${setupUri}> ?p ?o } }`,
    );
    const lines: string[] = [
      `<${setupUri}> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <${CORE_NS}Setup> .`,
      `<${setupUri}> <http://www.w3.org/2000/01/rdf-schema#label> "Runtime Environment" .`,
    ];
    const tag = (predLocal: string, value: string | undefined) => {
      if (!value) return;
      lines.push(`<${setupUri}> <${CORE_NS}${predLocal}> "${this.escapeLiteral(value)}" .`);
    };
    tag('triplestoreBackend', env.triplestoreBackend);
    tag('reasonerBackend', env.reasonerBackend);
    tag('reasonerProfile', env.reasonerProfile);
    tag('sandboxScope', env.sandboxScope);
    tag('workspace', env.workspace);
    tag('gatewayHost', env.gatewayHost);
    if (env.gatewayPort !== undefined) {
      lines.push(`<${setupUri}> <${CORE_NS}gatewayPort> "${env.gatewayPort}"^^<http://www.w3.org/2001/XMLSchema#integer> .`);
    }
    await this.triplestore.update(`INSERT DATA { GRAPH <${graphUri}> { ${lines.join(' ')} } }`);
    return lines.length;
  }

  /**
   * Populate `urn:<agent>:skills` from the agent's tool registry.
   *
   * Per concept §2 the skills graph is auto-generated from the MCP/tool
   * registry — it is documentation of what the agent can do, not a place for
   * the user or LLM to write. We overwrite the graph on every boot so it
   * always reflects the actual code.
   */
  async seedSkillsGraph(
    agentId: string,
    tools: Array<{ name: string; description?: string; category?: string }>,
  ): Promise<number> {
    const skillsGraph = this.assertGraph(GraphUriResolver.getSkillsGraph(agentId));

    // Drop whatever is in the graph so removed tools do not linger.
    await this.triplestore.update(`DROP SILENT GRAPH <${skillsGraph}>`);

    if (tools.length === 0) return 0;

    const lines: string[] = [];
    for (const tool of tools) {
      const skillUri = `urn:${agentId}:skill:${encodeURIComponent(tool.name)}`;
      lines.push(`<${skillUri}> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <${CORE_NS}Skill> .`);
      lines.push(`<${skillUri}> <http://www.w3.org/2000/01/rdf-schema#label> "${this.escapeLiteral(tool.name)}" .`);
      if (tool.description) {
        lines.push(`<${skillUri}> <${CORE_NS}description> "${this.escapeLiteral(tool.description)}" .`);
      }
      if (tool.category) {
        lines.push(`<${skillUri}> <${CORE_NS}category> "${this.escapeLiteral(tool.category)}" .`);
      }
      lines.push(`<${skillUri}> <${CORE_NS}toolKind> "internal" .`);
    }

    await this.triplestore.update(`INSERT DATA { GRAPH <${skillsGraph}> { ${lines.join(' ')} } }`);
    return tools.length;
  }

  /**
   * Materialize a per-session graph (`urn:<agent>:session:<sessionId>`) with
   * the conversational context concept §4 prescribes: the user URI, the
   * channel, the start timestamp, and an optional topic. Called by the
   * runtime when a session opens; the runtime decides when to retire it.
   */
  async seedSessionGraph(
    agentId: string,
    sessionId: string,
    info: { userId?: string; channel?: string; topic?: string },
  ): Promise<void> {
    const graphUri = this.assertGraph(GraphUriResolver.getSessionGraph(agentId, sessionId));
    const sessionUri = `urn:${agentId}:session:${encodeURIComponent(sessionId)}`;
    const now = new Date().toISOString();
    const lines: string[] = [
      `<${sessionUri}> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <${CORE_NS}Session> .`,
      `<${sessionUri}> <${CORE_NS}startedAt> "${now}"^^<http://www.w3.org/2001/XMLSchema#dateTime> .`,
    ];
    if (info.userId) {
      const userUri = this.userEntityUri(info.userId);
      lines.push(`<${sessionUri}> <${CORE_NS}userId> <${userUri}> .`);
    }
    if (info.channel) {
      lines.push(`<${sessionUri}> <${CORE_NS}channel> "${this.escapeLiteral(info.channel)}" .`);
    }
    if (info.topic) {
      lines.push(`<${sessionUri}> <${CORE_NS}topic> "${this.escapeLiteral(info.topic)}" .`);
    }
    // Idempotent: skip if the session is already materialised.
    const exists = await this.triplestore.ask(
      `ASK { GRAPH <${graphUri}> { <${sessionUri}> a <${CORE_NS}Session> } }`,
    );
    if (exists) return;
    await this.triplestore.update(`INSERT DATA { GRAPH <${graphUri}> { ${lines.join(' ')} } }`);
  }

  /**
   * Load TTL bootstrap files into empty Named Graphs.
   * Only seeds if the graph is empty (no triples) — safe to call on every start.
   *
   * The per-user graph is deliberately NOT seeded here: it is created lazily
   * with the real userId once a user actually interacts. Seeding it with a
   * placeholder id produced a second, orphaned user graph that contradicted
   * the runtime one.
   */
  async seedCoreGraphs(bootstrapDir: string, agentId: string = 'ontofelia'): Promise<{ seeded: string[] }> {
    // Seeded from bootstrap/: the agent self-model and the graph registry.
    // The shared TBox (urn:shared:ontology) is loaded separately from the
    // packaged core ontology; the shapes graph is provisioned by its own setup.
    const graphFiles: Array<{ graph: string; file: string }> = [
      { graph: GraphUriResolver.getSelfGraph(agentId), file: 'self.ttl' },
      { graph: SHARED_GRAPHS.META, file: 'meta.ttl' },
    ];

    const seeded: string[] = [];

    for (const { graph, file } of graphFiles) {
      try {
        // Reject any non-conformant graph before touching the store.
        this.assertGraph(graph);

        // Check if graph already has data
        const existing = await this.queryGraphFacts(graph);
        if (existing.length > 0) continue;

        // Load TTL file
        const ttlPath = path.join(bootstrapDir, file);
        const ttl = await fs.readFile(ttlPath, 'utf-8');
        if (!ttl.trim()) continue;

        // PUT into the named graph
        await this.triplestore.putGraph(graph, ttl, 'turtle');
        seeded.push(graph);
      } catch {
        // File doesn't exist or Fuseki error — skip silently
      }
    }

    return { seeded };
  }
}
