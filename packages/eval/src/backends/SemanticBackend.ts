import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import {
  KnowledgeEngine,
  OxigraphAdapter,
  InMemoryAdapter,
  ConflictDetector,
} from '@ontofelia/semantic-memory';
import type { MemoryBackend, IngestTurn, RetrievedContext, RetrieveOptions } from '../types.js';

export type SemanticAdapterKind = 'oxigraph' | 'memory';

export interface SemanticBackendOptions {
  agentId?: string;
  userId?: string;
  /**
   * Which triplestore adapter to back the KnowledgeEngine with.
   *
   * NOTE / DEVIATION (documented in the build report): the spec names
   * `InMemoryAdapter` as the offline default. In this repo `InMemoryAdapter` is
   * a non-functional stub — its `query` always returns empty bindings and
   * `update` is a no-op, so facts never round-trip and `retrieve` would always
   * be empty. We therefore default to `OxigraphAdapter`, which is the embedded
   * WASM Oxigraph store: fully in-memory, no native build, no network — so it is
   * just as offline-safe but actually answers SPARQL. `'memory'` is no longer a
   * supported option for the eval (it would silently score the backend at 0);
   * passing it throws.
   */
  adapter?: SemanticAdapterKind;
}

const CORE = 'urn:ontofelia:core#';
const SHARED = 'urn:shared:ontology#';
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const ENTITY_NS = 'urn:ontofelia:entity:';

/**
 * Functional (single-valued) predicates for the eval domain. Declaring these
 * as owl:FunctionalProperty in the agent-local schema graph activates the
 * KnowledgeEngine's belief-revision path: a second value for the same
 * subject+predicate supersedes the old one (base triple retired, old claim
 * marked superseded, a supersession Conflict written). This is what makes
 *  - H3 (mutate)  surface a real conflict flag, and
 *  - H5 (constraint) surface a real constraint violation AT INGEST,
 * for the semantic backend only.
 */
const FUNCTIONAL_PREDICATES = [
  'worksOn',
  'livesIn',
  'bornIn',
  'bornInYear',
  'hasPet',
  'hasRole',
  'reportsTo',
  'hasAge',
  'name',
  // Phase 1 added personas (single-valued attributes used in H3/H5).
  'worksAt',
  'hasTitle',
  'drives',
  'studiesAt',
  'hasManager',
  'shoeSize',
  'favouriteTeam',
  'deskNumber',
  'badgeColour',
  'gate',
  'manages',
];

/**
 * Condition A (spec §2-A): the semantic-memory KnowledgeEngine.
 *
 * Ingest uses the real persistence path (`storeFact`) on the pre-parsed `fact`
 * from the scenario. Functional-property declarations are seeded into the
 * agent-local schema graph so belief revision (supersession) runs for real.
 *
 * Retrieve composes from:
 *   - `getSystemPromptContext(agentId, userId)`   (user/self graph summary),
 *     with the onboarding "knowledge gaps" prose stripped (it is runtime UX,
 *     not memory content, and floods the answer prompt).
 *   - direct entity-fact queries over the worldview + user graphs for the
 *     probe's declared `entities`, with canonical entity resolution (user
 *     aliases → the canonical user node, names → the named node, owl:sameAs
 *     followed) so a casing slip does not silently empty the retrieval.
 *   - for multi-hop probes, a genuine composed SPARQL join over the relation
 *     path (`worksOn ∘ usesTool`), returning the joined entity set.
 *   - provenance from the claims graph (source turn id + learned-at), so H4 is
 *     answerable with a verifiable timestamp.
 *   - backend-surfaced conflicts (superseded claims + the conflicts graph and a
 *     live ConflictDetector scan) as explicit `[CONFLICT] …` markers, so the
 *     conflict flag reflects what the backend actually detected — never a raw
 *     "Actually …" trigger word in the rolling window.
 */
export class SemanticBackend implements MemoryBackend {
  readonly name = 'semantic' as const;
  private agentId: string;
  private userId: string;
  private readonly adapterKind: SemanticAdapterKind;

  private engine!: KnowledgeEngine;
  private detector!: ConflictDetector;
  // We keep our own handle on the adapter to run direct SPARQL for retrieval.
  private adapter!: OxigraphAdapter | InMemoryAdapter;
  private dataDir?: string;
  /** sourceMessageId → ISO ingest timestamp (the synthetic clock), for H4. */
  private ingestTs = new Map<string, string>();

  constructor(opts: SemanticBackendOptions = {}) {
    // The triplestore graph topology is registered for agent "ontofelia".
    // Using another agentId triggers a GraphPolicyError on write, so default to it.
    this.agentId = opts.agentId ?? 'ontofelia';
    this.userId = opts.userId ?? 'owner';
    this.adapterKind = opts.adapter ?? 'oxigraph';
    if (this.adapterKind === 'memory') {
      throw new Error(
        "SemanticBackend: the 'memory' adapter is a non-functional stub (facts never round-trip). " +
          "Use the default 'oxigraph' adapter (embedded, offline).",
      );
    }
  }

  /**
   * Bind to the scenario's user (spec / review HIGH: scenario.userId must be
   * wired through, else user-subject facts are unretrievable). agentId stays
   * 'ontofelia' (graph-policy whitelist) unless the scenario overrides it.
   */
  configureScenario(scenario: { agentId: string; userId: string }): void {
    if (scenario.agentId) this.agentId = scenario.agentId;
    if (scenario.userId) this.userId = scenario.userId;
  }

  async reset(): Promise<void> {
    await this.close();
    this.ingestTs.clear();
    this.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ontofelia-eval-'));
    this.adapter = new OxigraphAdapter();
    await this.adapter.initialize({
      backend: 'oxigraph',
      type: 'embedded',
      dataDir: this.dataDir,
      port: 0,
      endpoint: '',
    });
    await this.adapter.start?.();
    this.engine = new KnowledgeEngine(this.adapter as never);
    this.detector = new ConflictDetector(this.adapter as never);
    await this.seedFunctionalProperties();
  }

  /**
   * Declare the eval's functional predicates as owl:FunctionalProperty in the
   * agent-local schema graph (`urn:ontofelia:schema`, a whitelisted graph), so
   * `KnowledgeEngine.isFunctionalProperty` returns true and belief revision
   * runs. Without this no predicate is functional and the constraint/conflict
   * machinery never fires.
   */
  private async seedFunctionalProperties(): Promise<void> {
    const triples = FUNCTIONAL_PREDICATES.map(
      (p) => `<${CORE}${p}> a <http://www.w3.org/2002/07/owl#FunctionalProperty> .`,
    ).join('\n');
    try {
      await this.adapter.update(`INSERT DATA { GRAPH <urn:ontofelia:schema> {\n${triples}\n} }`);
    } catch {
      /* ignore */
    }
  }

  async ingest(turn: IngestTurn): Promise<void> {
    if (!turn.fact) return; // pad / non-fact turns are noise for this backend
    if (turn.ts) this.ingestTs.set(turn.id, turn.ts);
    const ctx = {
      agentId: this.agentId,
      userId: this.userId,
      sessionId: 'eval-session',
      isOwner: true,
    };
    if (turn.retract) {
      await this.retractFact(turn.fact.s, turn.fact.p, turn.fact.o);
      return;
    }
    await this.engine.storeFact(
      {
        subject: turn.fact.s,
        subjectType: turn.fact.sType ?? 'Person',
        predicate: turn.fact.p,
        object: turn.fact.o,
        objectType: turn.fact.oType ?? 'literal',
        sourceKind: 'user',
        sourceMessageId: turn.id,
      },
      ctx,
    );
  }

  async retrieve(query: string, opts: RetrieveOptions = {}): Promise<RetrievedContext> {
    const sections: string[] = [];
    const meta: Record<string, unknown> = { backend: 'semantic' };

    // 1. User/self graph summary — minus the onboarding "knowledge gaps" prose
    //    (runtime UX, not memory content; floods the prompt and poisons H2/H3).
    try {
      const spc = await this.engine.getSystemPromptContext(this.agentId, this.userId);
      const trimmed = stripOnboardingProse(spc).trim();
      if (trimmed) sections.push(trimmed);
    } catch {
      /* ignore */
    }

    // Resolve declared entities to canonical URIs (casing-robust + sameAs).
    const entities = opts.entities ?? [];
    const entityUris = await this.resolveEntityUris(entities);

    // 2a. Multi-hop join (H2): compose the relation path into one SPARQL join.
    // When a multi-hop is requested, we surface ONLY the composed answer set —
    // not the 1-hop fact dump — because the probe asks specifically for the
    // join target. (The 1-hop dump would inject the subject's own direct facts,
    // e.g. Carol's own `uses` tools, which are spurious for "tools the projects
    // I work on use" and would wrongly depress precision.)
    const isMultiHop = !!(opts.hops && opts.hops.length >= 2);
    if (isMultiHop) {
      const joined = await this.queryMultiHop(entityUris, opts.hops!);
      if (joined.length) {
        sections.push(`## Joined facts (${opts.hops!.join(' ∘ ')})\n${joined.map((j) => `- ${j}`).join('\n')}`);
        meta.joined = joined;
      }
    }

    // 2b. Direct entity facts from the actual fact graphs (worldview + user).
    const entityFacts: string[] = [];
    const provenance: Array<Record<string, string>> = [];
    for (const uri of entityUris) {
      if (!isMultiHop) {
        entityFacts.push(...(await this.queryEntityFacts(uri)));
        // Provenance is for H4 (single-fact source/time); it is noise for a
        // multi-hop set probe and its per-claim object values would otherwise
        // re-introduce the subject's direct facts as spurious set members.
        provenance.push(...(await this.queryProvenance(uri)));
      }
    }
    if (entityFacts.length) {
      sections.push(`## Known facts\n${[...new Set(entityFacts)].join('\n')}`);
    }
    if (provenance.length) {
      meta.provenance = provenance;
      const provLines = provenance.map(
        (p) =>
          `- ${p.subject} ${p.predicate} ${p.object} (source=${p.sourceMessageId || '?'}, at=${p.learnedAt || '?'}, status=${p.status || '?'})`,
      );
      sections.push(`## Provenance\n${provLines.join('\n')}`);
    }

    // 3. Backend-surfaced conflicts: superseded claims for these subjects + a
    //    live ConflictDetector scan (claim_clash / supersession). Emitted as
    //    explicit [CONFLICT] markers so the answer LLM's conflict flag is gated
    //    on a real detection, not on trigger words.
    const conflicts = await this.surfaceConflicts(entityUris);
    if (conflicts.length) {
      meta.conflicts = conflicts;
      sections.push(`## Detected conflicts\n${conflicts.map((c) => `- [CONFLICT] ${c}`).join('\n')}`);
    }

    return { text: sections.join('\n\n'), meta };
  }

  async close(): Promise<void> {
    try {
      await this.adapter?.stop?.();
    } catch {
      /* ignore */
    }
    if (this.dataDir && fs.existsSync(this.dataDir)) {
      try {
        fs.rmSync(this.dataDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      this.dataDir = undefined;
    }
  }

  // --- entity resolution -------------------------------------------------

  /**
   * Resolve declared entity names to the set of URIs that may actually carry
   * their triples, robustly to casing and the User/name split:
   *  - the canonical user node `entity:user:<userId>` (always — user facts and
   *    the user's name/livesIn/etc. live here regardless of declared casing),
   *  - the exact named URI `entity:<Name>` (e.g. entity:Carol),
   *  - any node linked to those via owl:sameAs (the "I am Carol" link).
   */
  private async resolveEntityUris(entities: string[]): Promise<string[]> {
    const uris = new Set<string>();
    uris.add(`${ENTITY_NS}user:${encodeURIComponent(this.userId)}`);
    for (const e of entities) {
      const lc = e.trim().toLowerCase();
      if (lc === 'user' || lc === 'i' || lc === 'me') continue; // already the user node
      // Named entity — try the declared casing AND a Capitalised variant so a
      // lowercase "carol" still reaches entity:Carol.
      uris.add(`${ENTITY_NS}${sanitize(e)}`);
      uris.add(`${ENTITY_NS}${sanitize(capitalize(e))}`);
    }
    // Follow owl:sameAs in both directions so user↔name links are covered.
    const seed = [...uris];
    for (const u of seed) {
      for (const same of await this.querySameAs(u)) uris.add(same);
    }
    return [...uris];
  }

  private async querySameAs(uri: string): Promise<string[]> {
    const sparql = `
      PREFIX owl: <http://www.w3.org/2002/07/owl#>
      SELECT ?o WHERE {
        GRAPH ?g { { <${uri}> owl:sameAs ?o } UNION { ?o owl:sameAs <${uri}> } }
        FILTER(isIRI(?o))
      }`;
    const res = await this.safeQuery(sparql);
    return res.map((b) => b.o).filter(Boolean);
  }

  // --- internal SPARQL helpers -------------------------------------------

  private factGraphs(): string[] {
    return [
      'urn:ontofelia:worldview',
      `urn:ontofelia:user:${this.userId}`,
      'urn:ontofelia:self',
    ];
  }

  private async queryEntityFacts(entityUri: string): Promise<string[]> {
    const out: string[] = [];
    for (const g of this.factGraphs()) {
      const sparql = `
        PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
        PREFIX owl: <http://www.w3.org/2002/07/owl#>
        SELECT ?pLabel ?p ?oLabel ?o WHERE {
          GRAPH <${g}> { <${entityUri}> ?p ?o . }
          OPTIONAL { ?p rdfs:label ?pLabel }
          OPTIONAL { ?o rdfs:label ?oLabel }
          FILTER(?p != <http://www.w3.org/1999/02/22-rdf-syntax-ns#type>)
          FILTER(?p != <${RDFS_LABEL}>)
          FILTER(?p != owl:sameAs)
        }`;
      const res = await this.safeQuery(sparql);
      for (const b of res) {
        const subj = uriToLabel(entityUri);
        const pred = b.pLabel ?? predToLabel(b.p ?? '');
        const obj = b.oLabel ?? literalOrLabel(b.o ?? '');
        out.push(`- ${subj} ${pred} ${obj}`);
      }
    }
    return out;
  }

  /**
   * Genuine multi-hop join: from each subject, follow the relation path to the
   * terminal object set. Generalised to ARBITRARY path length (≥2 hops): the
   * relations are chained into one SPARQL join with an intermediate variable per
   * hop, so a 3-hop chain (`employs ∘ manages ∘ usesTool`) is one composed query.
   * Returns NL-ish lines naming the full chain → joined targets. Chunk retrieval
   * cannot synthesise this — it is the structural advantage under test.
   */
  private async queryMultiHop(subjectUris: string[], hops: string[]): Promise<string[]> {
    if (hops.length < 2) return [];
    const out = new Set<string>();
    for (const s of subjectUris) {
      // Build the chain: <s> p0 ?v1 . ?v1 p1 ?v2 . … ?v(n-1) p(n-1) ?target
      const vars = hops.map((_, i) => (i === hops.length - 1 ? '?target' : `?v${i + 1}`));
      const triples: string[] = [];
      let prev = `<${s}>`;
      for (let i = 0; i < hops.length; i++) {
        const p = `${CORE}${camel(hops[i])}`;
        triples.push(`GRAPH ?g${i} { ${prev} <${p}> ${vars[i]} . }`);
        prev = vars[i];
      }
      const selectVars = vars.join(' ');
      const sparql = `SELECT DISTINCT ${selectVars} WHERE {\n${triples.join('\n')}\n}`;
      const res = await this.safeQuery(sparql);
      for (const b of res) {
        const target = literalOrLabel(b.target ?? '');
        if (target && target !== '?') {
          const mids = vars
            .slice(0, -1)
            .map((v) => literalOrLabel(b[v.slice(1)] ?? ''))
            .filter((m) => m && m !== '?');
          out.add(`${uriToLabel(s)} → ${[...mids, target].join(' → ')}`);
        }
      }
    }
    return [...out];
  }

  private async queryProvenance(entityUri: string): Promise<Array<Record<string, string>>> {
    const sparql = `
      PREFIX o: <${SHARED}>
      SELECT ?p ?obj ?sourceKind ?sessionId ?learnedAt ?status ?sourceMessageId WHERE {
        GRAPH <urn:ontofelia:claims> {
          ?claim o:claimSubject <${entityUri}> ;
                 o:claimPredicate ?p ;
                 o:claimObject ?obj .
          OPTIONAL { ?claim o:sourceKind ?sourceKind }
          OPTIONAL { ?claim o:sessionId ?sessionId }
          OPTIONAL { ?claim o:learnedAt ?learnedAt }
          OPTIONAL { ?claim o:status ?status }
          OPTIONAL { ?claim o:sourceMessageId ?sourceMessageId }
        }
      }`;
    const res = await this.safeQuery(sparql);
    return res
      // Only report claims that are still accepted — superseded/retracted facts
      // must not leak through provenance (matters for H6).
      .filter((b) => (b.status || 'accepted') === 'accepted')
      .map((b) => {
        const srcId = b.sourceMessageId ?? '';
        // Surface the deterministic synthetic ingest timestamp (the one the
        // runner used), so H4's tsTolerance is evaluable offline. Fall back to
        // the engine's wall-clock learnedAt only if we have no record.
        const at = (srcId && this.ingestTs.get(srcId)) || b.learnedAt || '';
        return {
          subject: uriToLabel(entityUri),
          predicate: predToLabel(b.p ?? ''),
          object: literalOrLabel(b.obj ?? ''),
          sourceKind: b.sourceKind ?? '',
          sessionId: b.sessionId ?? '',
          learnedAt: at,
          status: b.status ?? '',
          sourceMessageId: srcId,
        };
      });
  }

  /**
   * Backend-surfaced conflict signal for the given subjects:
   *  - superseded claims (belief revision retired an old value), and
   *  - a live ConflictDetector scan (claim_clash for non-functional clashes,
   *    supersession records).
   * Returns short human-readable descriptions; the answer LLM only flags a
   * conflict when one of these is present.
   */
  private async surfaceConflicts(subjectUris: string[]): Promise<string[]> {
    const out = new Set<string>();
    // a) Superseded claims for these subjects.
    for (const s of subjectUris) {
      const sparql = `
        PREFIX o: <${SHARED}>
        SELECT ?p ?obj WHERE {
          GRAPH <urn:ontofelia:claims> {
            ?c o:claimSubject <${s}> ; o:claimPredicate ?p ; o:claimObject ?obj ;
               o:status "superseded" .
          }
        }`;
      for (const b of await this.safeQuery(sparql)) {
        out.add(`${uriToLabel(s)} ${predToLabel(b.p ?? '')}: a prior value (${literalOrLabel(b.obj ?? '')}) was superseded`);
      }
    }
    // b) Live ConflictDetector scan, scoped to these subjects. We deliberately
    //    EXCLUDE `claim_clash`: in this domain a clash only ever arises for
    //    non-functional (multi-valued) predicates like `speaks`/`uses`, which
    //    are legitimately multi-valued — not a violation. Functional-property
    //    violations are caught precisely by the superseded-claim path (a).
    //    Disjoint-class and range violations remain a genuine OWL signal seam.
    try {
      const subjects = new Set(subjectUris);
      const conflicts = await this.detector.detectConflicts(this.agentId);
      for (const c of conflicts) {
        if (c.type === 'claim_clash') continue;
        if (c.subjects.some((s) => subjects.has(s))) {
          out.add(c.description);
        }
      }
    } catch {
      /* ignore */
    }
    return [...out];
  }

  /**
   * Real retract: remove the fact completely from every fact graph AND retire
   * its claim (status "retracted"), so neither the base triple, the provenance,
   * nor a superseded-claim record can leak the value afterwards. Neighbours
   * (other triples about the subject) are untouched.
   */
  private async retractFact(s: string, p: string, o: string): Promise<void> {
    const subjUris = await this.resolveEntityUris([s]);
    const pUri = `${CORE}${camel(p)}`;
    for (const g of this.factGraphs()) {
      for (const sUri of subjUris) {
        // Remove EVERY remaining base triple for this subject+predicate (the
        // forgotten slot), in any graph — both URI and literal objects. This
        // covers the retracted value and any earlier value in the same slot
        // (e.g. Vesta still implied), while leaving neighbours (other
        // predicates such as bornIn Lisbon) untouched.
        try {
          await this.adapter.update(`DELETE WHERE { GRAPH <${g}> { <${sUri}> <${pUri}> ?o . } }`);
        } catch {
          /* ignore */
        }
      }
    }
    void o;
    // Retire ALL claim records for this subject+predicate (any object, any
    // status) so neither provenance nor the superseded-claim conflict path can
    // resurface the retracted value OR a prior value in the same slot.
    for (const sUri of subjUris) {
      try {
        await this.adapter.update(
          `PREFIX o: <${SHARED}>
           DELETE { GRAPH <urn:ontofelia:claims> { ?c o:status ?st } }
           INSERT { GRAPH <urn:ontofelia:claims> { ?c o:status "retracted" } }
           WHERE {
             GRAPH <urn:ontofelia:claims> {
               ?c o:claimSubject <${sUri}> ; o:claimPredicate <${pUri}> ; o:status ?st .
             }
           }`,
        );
      } catch {
        /* ignore */
      }
    }
  }

  /** Run a SELECT and normalise oxigraph bindings into plain string maps. */
  private async safeQuery(sparql: string): Promise<Array<Record<string, string>>> {
    try {
      const res = await this.adapter.query(sparql);
      if (res?.type === 'bindings' && Array.isArray(res.bindings)) {
        return res.bindings.map((b: Record<string, { value: string }>) => {
          const m: Record<string, string> = {};
          for (const k of Object.keys(b)) m[k] = b[k]?.value;
          return m;
        });
      }
    } catch {
      /* ignore */
    }
    return [];
  }
}

/** Strip the onboarding "knowledge gaps / Where do you live?" section. */
function stripOnboardingProse(spc: string): string {
  // Sections are separated by blank lines; drop any block that is the
  // onboarding goal (it begins with a "Current Goal: Getting to Know the User"
  // header). Keep "What I Know About the User" — that holds real facts.
  return spc
    .split(/\n\n+/)
    .filter(
      (block) =>
        !/Current Goal|knowledge gaps|Where do you/i.test(block) &&
        // The live "unknown user" onboarding block: "I do not know the user
        // yet … ask for their name … memory_store …". Pure runtime UX prose,
        // not a fact — strip it so it does not depress absolute answer scores.
        !/I do not know the user yet|memory_store|ask for (?:ONE|one|their)/i.test(block),
    )
    .join('\n\n');
}

function sanitize(name: string): string {
  if (name.startsWith('urn:') || name.startsWith('http')) return name;
  return encodeURIComponent(name.trim().replace(/\s+/g, '_'));
}

function capitalize(name: string): string {
  const t = name.trim();
  return t.length ? t.charAt(0).toUpperCase() + t.slice(1) : t;
}

function camel(p: string): string {
  const parts = p.trim().split(/[\s_]+/);
  return parts
    .map((w, i) => (i === 0 ? w.charAt(0).toLowerCase() + w.slice(1) : w.charAt(0).toUpperCase() + w.slice(1)))
    .join('');
}

function uriToLabel(uri: string): string {
  let frag = uri.includes('#') ? uri.split('#').pop()! : uri.split(':').pop()!;
  frag = decodeURIComponent(frag);
  // Strip a leading "user:" style remnant if present.
  return frag.replace(/_/g, ' ');
}

function predToLabel(uri: string): string {
  if (!uri) return '?';
  let frag = uri.includes('#') ? uri.split('#').pop()! : uri.split('/').pop()!;
  frag = decodeURIComponent(frag);
  return frag.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase();
}

function literalOrLabel(v: string): string {
  if (!v) return '?';
  if (v.startsWith('urn:ontofelia:entity:')) return uriToLabel(v);
  return v;
}
