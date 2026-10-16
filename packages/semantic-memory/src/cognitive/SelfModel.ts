/**
 * SelfModel — a thin, queryable reader over the agent's self graph
 * (docs/cognitive-architecture/08-metacognition-and-self-model.md §2, Phase G).
 *
 * Phase G makes the agent's persona *interrogable* rather than a config blob:
 * capabilities and constraints become `cogt:Capability` / `cogt:Constraint`
 * resources in `urn:<agent>:self`, hung off the agent's self resource via
 * `cogt:hasCapability` / `cogt:hasConstraint`. Phase 4 of the cognitive cycle
 * seeds a `[Self]` prompt block from {@link queryFor}, and metacognition uses
 * {@link constraintsForTool} to attribute constraint pressure.
 *
 * The live cycle never writes here. Two things do: {@link seed} (hand-written
 * capabilities and constraints, the learned side) and {@link reseedDerived}
 * (capabilities and constraints derived from the real tool registry, tool
 * policy, guardian policy and behavior directives).
 *
 * The self graph holds two disjoint vocabularies, and this class only ever
 * touches one of them: the bootstrap persona (subject `urn:ontofelia:core#Ontofelia`,
 * `onto:` predicates, owned by `KnowledgeEngine.reseedSelf`) is read — the
 * behavior directives — and never written. Everything {@link reseedDerived}
 * writes hangs off the self-model subject, or off nodes under the derived
 * prefix `urn:<agent>:self#derived/`, so a re-seed can replace exactly its own
 * nodes and nothing else.
 */

import type { TriplestoreAdapter } from '@ontofelia/core';
import { GraphUriResolver } from '../utils/GraphUriResolver.js';
import { escapeSparqlStringContent, sparqlIri } from '../utils/SparqlSyntax.js';

const COGT = 'urn:shared:ontology#cog/';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const CORE = 'urn:ontofelia:core#';

const GT = (name: string) => `${COGT}${name}`;
const GOAL_TYPES_BY_TOOL_CATEGORY: Readonly<Record<string, string[]>> = {
  filesystem: [GT('ExecuteCommand'), GT('HandleRequest'), GT('OwnerRequestedWork')],
  shell: [GT('ExecuteCommand'), GT('HandleRequest'), GT('OwnerRequestedWork')],
  web: [GT('AnswerQuestion'), GT('HandleRequest')],
  memory: [GT('AnswerQuestion'), GT('AnswerInTopic'), GT('HandleRequest')],
  ontology: [GT('AnswerQuestion'), GT('AnswerInTopic'), GT('HandleRequest')],
};

/**
 * The two fixed constraint sentences of the derived self-model. The prompt
 * renders these exact strings (by `derivedFrom`), never the stored label.
 */
export const DERIVED_LABELS = {
  toolPolicy: "Some tools are denied or need the owner's approval (tool policy)",
  guardian: "Risky shell and scheduling commands need the owner's approval (guardian)",
} as const;

/**
 * Goal types a derived tool capability is scoped to, by tool category. Never
 * `RespondToUser` and never empty (an unscoped capability is relevant to every
 * goal): a plain chat turn is shown the constraints only. Categories not named
 * here (media, channel, utility, anything new) are scoped to `HandleRequest`
 * alone, the widest request goal, so an unknown tool is not advertised on
 * unrelated goals.
 */
export function goalTypesForCategory(category: string | undefined): string[] {
  return GOAL_TYPES_BY_TOOL_CATEGORY[category ?? ''] ?? [GT('HandleRequest')];
}

/** Percent-encode every character that is not safe inside an IRI path segment. */
function encodeIriPart(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function decodeToolIri(iri: string): string {
  const raw = iri.startsWith('urn:tool:') ? iri.slice('urn:tool:'.length) : iri;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

interface DerivedTriple {
  s: string;
  p: string;
  /** IRI object. */
  o?: string;
  /** Literal object (escaped when written). */
  lit?: string;
}

/** A registered tool as the derivation sees it. */
export interface DerivedToolSource {
  name: string;
  /** `ToolDefinition.category`. */
  category?: string;
  /** Short, already neutralised one-line description (stored as `rdfs:comment`, never rendered). */
  description?: string;
  /** Effective verdict: policy engine and guardian combined. */
  policy: DerivedPolicyStatus;
  /** The tool policy's verdict alone, before the guardian is applied. */
  policyBeforeGuardian?: DerivedPolicyStatus;
}

export interface DerivedDirectiveSource {
  iri: string;
  label: string;
  bindingness: string;
  scope: string;
}

export interface DerivedSelfSources {
  tools: DerivedToolSource[];
  /** Tools the guardian can gate behind an approval (`GuardianPolicy.guardedTools()`). */
  guardedTools: string[];
  /** Override for tests; by default read from the self graph. */
  directives?: DerivedDirectiveSource[];
}

export interface DerivedSeedReport {
  capabilities: number;
  constraints: number;
  triples: number;
}

/** The tool policy's verdict on one tool; `needs-approval` includes guardian-gated tools. */
export type DerivedPolicyStatus = 'allowed' | 'needs-approval' | 'denied';

export const POLICY_STATUSES: readonly DerivedPolicyStatus[] = ['allowed', 'needs-approval', 'denied'];

/** What a derived node was derived from (`cogt:derivedFrom`). Absent on learned nodes. */
export type DerivedFrom = 'tool-registry' | 'tool-policy' | 'guardian-policy' | 'behavior-directive';

export interface Capability {
  uri: string;
  label: string;
  /** Set on a derived tool capability: the tool's verdict under the policies. */
  policyStatus?: DerivedPolicyStatus;
  derivedFrom?: DerivedFrom;
  /** Tool names the capability needs (`cogt:requires`). */
  requires: string[];
  /** Goal types the capability is scoped to (empty = generally relevant). */
  relevantToGoalType: string[];
}

export interface Constraint {
  uri: string;
  label: string;
  /** Tool names (or tool[op] tokens) the constraint governs (`cogt:applies`). */
  applies: string[];
  /** The named policy that enforces it (`cogt:enforcedBy`), if any. */
  enforcedBy?: string;
  /** Set on a derived constraint. */
  derivedFrom?: DerivedFrom;
  /** For a directive-derived constraint: the directive's scope (`cogt:constraintScope`). */
  scope?: string;
}

export interface SelfView {
  /** Capabilities relevant to the queried goal type (plus the unscoped ones). */
  capabilities: Capability[];
  /** All of the agent's constraints — they are not goal-scoped. */
  constraints: Constraint[];
}

export interface SeedCapability {
  id: string;
  label: string;
  requires?: string[];
  relevantToGoalType?: string[];
}

export interface SeedConstraint {
  id: string;
  label: string;
  applies?: string[];
  enforcedBy?: string;
}

function escapeLiteral(s: string): string {
  return escapeSparqlStringContent(s);
}

export class SelfModel {
  constructor(
    private readonly triplestore: TriplestoreAdapter,
    private readonly agentId: string,
  ) {}

  graphUri(): string {
    return GraphUriResolver.getSelfGraph(this.agentId);
  }

  /** The agent's self resource, e.g. `urn:ontofelia:self#ontofelia`. */
  selfSubject(): string {
    return `urn:${this.agentId}:self#${this.agentId}`;
  }

  /**
   * The self-view used to seed Phase 4 (doc 08 §2.2): capabilities relevant to
   * `goalType` (a capability with *no* `relevantToGoalType` is treated as
   * generally relevant and always included) and every constraint the agent has.
   */
  async queryFor(goalType?: string): Promise<SelfView> {
    const [capabilities, constraints] = await Promise.all([
      this.readCapabilities(),
      this.readConstraints(),
    ]);
    const relevant = capabilities.filter(
      (c) =>
        c.relevantToGoalType.length === 0 ||
        (goalType !== undefined && c.relevantToGoalType.includes(goalType)),
    );
    return { capabilities: relevant, constraints };
  }

  /** Constraints whose `cogt:applies` names `toolName` (used for constraint pressure). */
  async constraintsForTool(toolName: string): Promise<Constraint[]> {
    const constraints = await this.readConstraints();
    return constraints.filter((c) =>
      c.applies.some((a) => a === toolName || a.startsWith(`${toolName}[`)),
    );
  }

  /**
   * One-time persona migration / test fixture: write capability and constraint
   * resources and hang them off the self subject. Idempotent at the triple
   * level (INSERT DATA), so re-seeding the same ids is harmless.
   */
  async seed(input: {
    capabilities?: SeedCapability[];
    constraints?: SeedConstraint[];
  }): Promise<void> {
    const graph = this.graphUri();
    const subj = this.selfSubject();
    const lines: string[] = [];
    for (const cap of input.capabilities ?? []) {
      const uri = `${COGT}cap_${cap.id}`;
      lines.push(`<${subj}> <${COGT}hasCapability> <${uri}> .`);
      lines.push(`<${uri}> <${RDF_TYPE}> <${COGT}Capability> .`);
      lines.push(`<${uri}> <${RDFS_LABEL}> "${escapeLiteral(cap.label)}" .`);
      for (const r of cap.requires ?? [])
        lines.push(`<${uri}> <${COGT}requires> "${escapeLiteral(r)}" .`);
      for (const g of cap.relevantToGoalType ?? [])
        lines.push(`<${uri}> <${COGT}relevantToGoalType> <${g}> .`);
    }
    for (const cons of input.constraints ?? []) {
      const uri = `${COGT}cons_${cons.id}`;
      lines.push(`<${subj}> <${COGT}hasConstraint> <${uri}> .`);
      lines.push(`<${uri}> <${RDF_TYPE}> <${COGT}Constraint> .`);
      lines.push(`<${uri}> <${RDFS_LABEL}> "${escapeLiteral(cons.label)}" .`);
      if (cons.enforcedBy)
        lines.push(`<${uri}> <${COGT}enforcedBy> "${escapeLiteral(cons.enforcedBy)}" .`);
      for (const a of cons.applies ?? [])
        lines.push(`<${uri}> <${COGT}applies> "${escapeLiteral(a)}" .`);
    }
    if (lines.length === 0) return;
    await this.triplestore.update(`INSERT DATA { GRAPH <${graph}> {\n${lines.join('\n')}\n} }`);
  }

  // ---------------------------------------------------------------------------
  // Derived self-model
  // ---------------------------------------------------------------------------

  /** Prefix of every node {@link reseedDerived} owns: `urn:<agent>:self#derived/`. */
  derivedPrefix(): string {
    return GraphUriResolver.getSelfDerivedPrefix(this.agentId);
  }

  /** IRI of the tool resource `urn:tool:<name>` used as the object of `requiresApproval` / `authorityOver`. */
  static toolIri(name: string): string {
    return `urn:tool:${encodeIriPart(name)}`;
  }

  /**
   * Replace the derived part of the self-model with what `sources` say now, in
   * one SPARQL update (atomic in the store): the previous derived nodes go, the
   * new ones come in. Same sources, same triple set; a tool that is gone from
   * `sources` loses its capability. Nothing else is touched: hand-seeded
   * capabilities and constraints, any other fact about the self-model subject,
   * and the whole bootstrap persona stay as they are.
   *
   * The behavior directives are read from the self graph unless `sources`
   * carries them (tests do). Only binding directives of scope `safety` become
   * constraints; the others are style rules the system prompt already carries.
   */
  async reseedDerived(sources: DerivedSelfSources): Promise<DerivedSeedReport> {
    const graph = this.graphUri();
    const subj = this.selfSubject();
    const dp = this.derivedPrefix();
    const directives = sources.directives ?? (await this.readBehaviorDirectives());
    const triples = this.deriveTriples(sources, directives);
    const t = (s: string, p: string, o: string) => `<${s}> <${p}> ${o} .`;
    const lit = (v: string) => `"${escapeLiteral(v)}"`;
    const lines: string[] = [];
    for (const tr of triples) {
      lines.push(t(tr.s, tr.p, tr.lit !== undefined ? lit(tr.lit) : `<${tr.o}>`));
    }
    const del = `
      OPTIONAL { GRAPH ${sparqlIri(graph)} { ?s ?p ?o .
        FILTER ( STRSTARTS(STR(?s), "${escapeLiteral(dp)}")
          || ( ?s = ${sparqlIri(subj)}
               && ?p IN ( <${COGT}hasCapability>, <${COGT}hasConstraint>, <${COGT}hasDerivedProfile> )
               && isIRI(?o) && STRSTARTS(STR(?o), "${escapeLiteral(dp)}") ) ) } }`;
    await this.triplestore.update(`
      DELETE { GRAPH ${sparqlIri(graph)} { ?s ?p ?o } }
      INSERT { GRAPH ${sparqlIri(graph)} {\n${lines.join('\n')}\n} }
      WHERE { ${del} }`);
    return {
      capabilities: sources.tools.length,
      constraints: triples.filter((x) => x.p === `${COGT}hasConstraint`).length,
      triples: triples.length,
    };
  }

  /** The SPARQL that answers "which tools need approval" over the self graph. */
  toolsNeedingApprovalQuery(): string {
    return `PREFIX cogt: <${COGT}>
SELECT DISTINCT ?tool WHERE {
  GRAPH ${sparqlIri(this.graphUri())} {
    ${sparqlIri(this.selfSubject())} cogt:hasDerivedProfile ?profile .
    ?profile cogt:requiresApproval ?tool .
  }
} ORDER BY ?tool`;
  }

  /** Tool names answered by {@link toolsNeedingApprovalQuery}. */
  async toolsNeedingApproval(): Promise<string[]> {
    const res = await this.triplestore.query(this.toolsNeedingApprovalQuery());
    return (res.bindings ?? []).map((b) => decodeToolIri(b.tool.value));
  }

  // Derivation -----------------------------------------------------------------

  private deriveTriples(
    sources: DerivedSelfSources,
    directives: DerivedDirectiveSource[],
  ): DerivedTriple[] {
    const subj = this.selfSubject();
    const dp = this.derivedPrefix();
    const out: DerivedTriple[] = [];
    const add = (s: string, p: string, o: string) => out.push({ s, p, o });
    const addLit = (s: string, p: string, value: string) => out.push({ s, p, lit: value });

    const tools = [...sources.tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const guarded = [...new Set(sources.guardedTools)].sort();
    const present = new Set(tools.map((x) => x.name));

    // Profile: autonomy level, owner relation, approval and authority sets.
    const profile = `${dp}profile`;
    const owner = `${dp}owner`;
    add(subj, `${COGT}hasDerivedProfile`, profile);
    add(profile, RDF_TYPE, `${COGT}DerivedSelfProfile`);
    add(profile, `${COGT}owner`, owner);
    add(owner, RDF_TYPE, `${COGT}Principal`);
    addLit(owner, `${COGT}derivedLabel`, 'owner');
    const needsApproval = tools.filter((x) => x.policy === 'needs-approval');
    const usable = tools.filter((x) => x.policy === 'allowed');
    addLit(profile, `${COGT}ownerRelation`, needsApproval.length > 0 ? 'approves-gated-tools' : 'no-approval-required');
    addLit(
      profile,
      `${COGT}autonomyLevel`,
      usable.length === 0 && needsApproval.length === 0 ? 'restricted' : needsApproval.length > 0 ? 'semi-autonomous' : 'autonomous',
    );
    for (const x of needsApproval) add(profile, `${COGT}requiresApproval`, SelfModel.toolIri(x.name));
    for (const x of usable) add(profile, `${COGT}authorityOver`, SelfModel.toolIri(x.name));

    // One capability per registered tool.
    for (const x of tools) {
      const cap = `${dp}cap/${encodeIriPart(x.name)}`;
      add(subj, `${COGT}hasCapability`, cap);
      add(cap, RDF_TYPE, `${COGT}Capability`);
      addLit(cap, `${COGT}derivedLabel`, `Tool ${x.name}`);
      addLit(cap, `${COGT}requires`, x.name);
      addLit(cap, `${COGT}policyStatus`, x.policy);
      addLit(cap, `${COGT}derivedFrom`, 'tool-registry');
      if (x.description) addLit(cap, `${COGT}derivedNote`, x.description);
      for (const g of goalTypesForCategory(x.category)) add(cap, `${COGT}relevantToGoalType`, g);
    }

    // Constraints: the policy layers, then the safety directives.
    const policyAll = tools.filter((x) => (x.policyBeforeGuardian ?? x.policy) !== 'allowed');
    if (policyAll.length > 0) {
      const k = `${dp}cons/tool-policy`;
      add(subj, `${COGT}hasConstraint`, k);
      add(k, RDF_TYPE, `${COGT}Constraint`);
      addLit(k, `${COGT}derivedLabel`, DERIVED_LABELS.toolPolicy);
      addLit(k, `${COGT}enforcedBy`, 'ToolPolicy');
      addLit(k, `${COGT}derivedFrom`, 'tool-policy');
      for (const x of policyAll) addLit(k, `${COGT}applies`, x.name);
    }
    const guardedPresent = guarded.filter((n) => present.has(n));
    if (guardedPresent.length > 0) {
      const k = `${dp}cons/guardian`;
      add(subj, `${COGT}hasConstraint`, k);
      add(k, RDF_TYPE, `${COGT}Constraint`);
      addLit(k, `${COGT}derivedLabel`, DERIVED_LABELS.guardian);
      addLit(k, `${COGT}enforcedBy`, 'GuardianPolicy');
      addLit(k, `${COGT}derivedFrom`, 'guardian-policy');
      for (const n of guardedPresent) addLit(k, `${COGT}applies`, n);
    }
    const safety = directives
      .filter((d) => d.bindingness === 'binding' && d.scope === 'safety')
      .sort((a, b) => (a.iri < b.iri ? -1 : a.iri > b.iri ? 1 : 0));
    for (const d of safety) {
      const k = `${dp}cons/directive/${encodeIriPart(d.iri)}`;
      add(subj, `${COGT}hasConstraint`, k);
      add(k, RDF_TYPE, `${COGT}Constraint`);
      addLit(k, `${COGT}derivedLabel`, d.label || 'Binding safety rule');
      addLit(k, `${COGT}enforcedBy`, 'BehaviorDirective');
      addLit(k, `${COGT}derivedFrom`, 'behavior-directive');
      addLit(k, `${COGT}constraintScope`, d.scope);
      add(k, `${COGT}basedOn`, d.iri);
    }
    return out;
  }

  /**
   * Read the bootstrap persona's `onto:BehaviorDirective` individuals from the
   * self graph. Read-only: the bootstrap vocabulary is never written from here.
   */
  async readBehaviorDirectives(): Promise<DerivedDirectiveSource[]> {
    const res = await this.triplestore.query(`
      SELECT ?d ?label ?bindingness ?scope WHERE {
        GRAPH ${sparqlIri(this.graphUri())} {
          ?d <${RDF_TYPE}> <${CORE}BehaviorDirective> .
          OPTIONAL { ?d <${RDFS_LABEL}> ?label . }
          OPTIONAL { ?d <${CORE}bindingness> ?bindingness . }
          OPTIONAL { ?d <${CORE}directiveScope> ?scope . }
        }
      } ORDER BY ?d`);
    const byIri = new Map<string, DerivedDirectiveSource>();
    for (const b of res.bindings ?? []) {
      const iri = b.d.value;
      if (!byIri.has(iri)) {
        byIri.set(iri, { iri, label: b.label?.value ?? '', bindingness: b.bindingness?.value ?? 'descriptive', scope: b.scope?.value ?? '' });
      }
    }
    return [...byIri.values()];
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private async readCapabilities(): Promise<Capability[]> {
    const graph = this.graphUri();
    const subj = this.selfSubject();
    const res = await this.triplestore.query(`
      SELECT ?cap ?label ?dlabel ?req ?goalType ?policyStatus ?derivedFrom WHERE {
        GRAPH <${graph}> {
          <${subj}> <${COGT}hasCapability> ?cap .
          OPTIONAL { ?cap <${COGT}policyStatus> ?policyStatus . }
          OPTIONAL { ?cap <${COGT}derivedFrom> ?derivedFrom . }
          OPTIONAL { ?cap <${RDFS_LABEL}> ?label . }
          OPTIONAL { ?cap <${COGT}derivedLabel> ?dlabel . }
          OPTIONAL { ?cap <${COGT}requires> ?req . }
          OPTIONAL { ?cap <${COGT}relevantToGoalType> ?goalType . }
        }
      }`);
    const byUri = new Map<string, Capability>();
    for (const b of res.bindings ?? []) {
      const uri = b.cap.value;
      let cap = byUri.get(uri);
      if (!cap) {
        cap = { uri, label: b.label?.value ?? uri, requires: [], relevantToGoalType: [] };
        byUri.set(uri, cap);
      }
      if (b.dlabel?.value) cap.label = b.dlabel.value;
      if (b.label?.value) cap.label = b.label.value;
      const ps = b.policyStatus?.value as DerivedPolicyStatus | undefined;
      if (ps && POLICY_STATUSES.includes(ps)) cap.policyStatus = ps;
      if (b.derivedFrom?.value) cap.derivedFrom = b.derivedFrom.value as DerivedFrom;
      if (b.req?.value && !cap.requires.includes(b.req.value)) cap.requires.push(b.req.value);
      if (b.goalType?.value && !cap.relevantToGoalType.includes(b.goalType.value))
        cap.relevantToGoalType.push(b.goalType.value);
    }
    return [...byUri.values()];
  }

  private async readConstraints(): Promise<Constraint[]> {
    const graph = this.graphUri();
    const subj = this.selfSubject();
    const res = await this.triplestore.query(`
      SELECT ?cons ?label ?dlabel ?applies ?enforcedBy ?derivedFrom ?scope WHERE {
        GRAPH <${graph}> {
          <${subj}> <${COGT}hasConstraint> ?cons .
          OPTIONAL { ?cons <${COGT}derivedFrom> ?derivedFrom . }
          OPTIONAL { ?cons <${COGT}constraintScope> ?scope . }
          OPTIONAL { ?cons <${RDFS_LABEL}> ?label . }
          OPTIONAL { ?cons <${COGT}derivedLabel> ?dlabel . }
          OPTIONAL { ?cons <${COGT}applies> ?applies . }
          OPTIONAL { ?cons <${COGT}enforcedBy> ?enforcedBy . }
        }
      }`);
    const byUri = new Map<string, Constraint>();
    for (const b of res.bindings ?? []) {
      const uri = b.cons.value;
      let cons = byUri.get(uri);
      if (!cons) {
        cons = { uri, label: b.label?.value ?? uri, applies: [] };
        byUri.set(uri, cons);
      }
      if (b.dlabel?.value) cons.label = b.dlabel.value;
      if (b.label?.value) cons.label = b.label.value;
      if (b.enforcedBy?.value) cons.enforcedBy = b.enforcedBy.value;
      if (b.derivedFrom?.value) cons.derivedFrom = b.derivedFrom.value as DerivedFrom;
      if (b.scope?.value) cons.scope = b.scope.value;
      if (b.applies?.value && !cons.applies.includes(b.applies.value))
        cons.applies.push(b.applies.value);
    }
    return [...byUri.values()];
  }
}
