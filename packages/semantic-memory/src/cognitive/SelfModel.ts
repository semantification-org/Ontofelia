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
 * This is read-mostly: {@link seed} exists for the one-time persona migration
 * and for tests, but the live cycle never writes here.
 */

import type { TriplestoreAdapter } from '@ontofelia/core';
import { GraphUriResolver } from '../utils/GraphUriResolver.js';

const COGT = 'urn:shared:ontology#cog/';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';

export interface Capability {
  uri: string;
  label: string;
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
  return s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
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
  // Internals
  // ---------------------------------------------------------------------------

  private async readCapabilities(): Promise<Capability[]> {
    const graph = this.graphUri();
    const subj = this.selfSubject();
    const res = await this.triplestore.query(`
      SELECT ?cap ?label ?req ?goalType WHERE {
        GRAPH <${graph}> {
          <${subj}> <${COGT}hasCapability> ?cap .
          OPTIONAL { ?cap <${RDFS_LABEL}> ?label . }
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
      if (b.label?.value) cap.label = b.label.value;
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
      SELECT ?cons ?label ?applies ?enforcedBy WHERE {
        GRAPH <${graph}> {
          <${subj}> <${COGT}hasConstraint> ?cons .
          OPTIONAL { ?cons <${RDFS_LABEL}> ?label . }
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
      if (b.label?.value) cons.label = b.label.value;
      if (b.enforcedBy?.value) cons.enforcedBy = b.enforcedBy.value;
      if (b.applies?.value && !cons.applies.includes(b.applies.value))
        cons.applies.push(b.applies.value);
    }
    return [...byUri.values()];
  }
}
