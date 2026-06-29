/**
 * GoalStack — the explicit goal forest (docs/cognitive-architecture/07, Phase D).
 *
 * Goals are first-class `cogt:Goal` resources living in the session goal graph
 * `urn:<agent>:cog:goals:<sess>`; durable goals are promoted to the fixed
 * `urn:<agent>:cog:goals:longterm` graph at session close. The "stack" is really
 * a forest (every goal may have a `cogt:parentGoal`); the runtime selects the
 * *top active goal* by priority then recency.
 *
 * Implementation notes mirror {@link WorkingMemory}:
 *  - Writes are typed SPARQL `INSERT DATA` (not adapter.insertTriples) because
 *    adapters drop literal datatypes and `cogt:priority` must be a real
 *    `xsd:decimal` for SPARQL ordering.
 *  - Every mutating call routes through {@link GraphRegistry.assertWritable}, so
 *    a buggy cycle can never write outside the two registered goal graphs.
 *  - Ordering (`top`) is done in TypeScript: the embedded Oxigraph (WASM) build
 *    throws "unreachable" on some query shapes, and we already read the full
 *    active set, so sorting in-process is both safe and cheap.
 */

import type { TriplestoreAdapter } from '@ontofelia/core';
import { GraphRegistry, GraphUriResolver } from '@ontofelia/semantic-memory';

const COGT = 'urn:shared:ontology#cog/';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const XSD = 'http://www.w3.org/2001/XMLSchema#';

/** Goal lifecycle states (doc 07 §3). */
export type GoalStatus = 'proposed' | 'active' | 'blocked' | 'resolved' | 'abandoned';

/** The always-present safety-net goal type and its default priority (doc 07 §5.1). */
export const RESPOND_TO_USER = `${COGT}RespondToUser`;
const RESPOND_TO_USER_PRIORITY = 0.5;

/** Opaque identifier (an IRI) of a goal. */
export type GoalId = string;

export interface GoalInput {
  goalType: string; // URI
  goalLabel: string;
  priority: number; // [0,1]
  status?: GoalStatus; // defaults to 'active'
  successCriterion?: string;
  deadline?: Date;
  parentGoal?: GoalId;
  triggeredByEpisode?: string; // URI
  triggeredByUser?: string; // URI
  plannedSteps?: string;
  currentStep?: string;
  tags?: string[];
  /** Force promotion to the longterm graph at session close regardless of deadline. */
  longTerm?: boolean;
}

export interface Goal {
  uri: GoalId;
  goalId: string;
  goalType: string;
  goalLabel: string;
  status: GoalStatus;
  priority: number;
  createdAt: string;
  updatedAt: string;
  graph: string;
  successCriterion?: string;
  deadline?: string;
  resolvedAt?: string;
  abandonedAt?: string;
  blockedReason?: string;
  parentGoal?: string;
  triggeredByEpisode?: string;
  triggeredByUser?: string;
  plannedSteps?: string;
  currentStep?: string;
  stepProgress?: string;
  longTerm?: boolean;
  tags: string[];
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function escapeLiteral(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

export class GoalStack {
  constructor(
    private readonly triplestore: TriplestoreAdapter,
    private readonly registry: GraphRegistry,
    private readonly agentId: string,
    private readonly sessionId: string,
  ) {}

  sessionGraphUri(): string {
    return GraphUriResolver.getCogGoalsSessionGraph(this.agentId, this.sessionId);
  }

  longtermGraphUri(): string {
    return GraphUriResolver.getCogGoalsLongtermGraph(this.agentId);
  }

  /** Both graphs the runtime treats as the goal forest (doc 07 §4). */
  private goalGraphs(): string[] {
    return [this.sessionGraphUri(), this.longtermGraphUri()];
  }

  private newGoalUri(): GoalId {
    const rand =
      typeof globalThis.crypto?.randomUUID === 'function'
        ? globalThis.crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return `urn:${this.agentId}:cog:goal:${rand}`;
  }

  /** A sortable, human-legible goal id: `goal_<iso>_<rand4>`. */
  private newGoalId(now: Date): string {
    const iso = now.toISOString().replace(/[:.]/g, '-');
    const tail = Math.floor(Math.random() * 1e4)
      .toString()
      .padStart(4, '0');
    return `goal_${iso}_${tail}`;
  }

  /**
   * Push a new goal onto the session graph. Returns its IRI. Status defaults to
   * `active`; priority is clamped to [0,1].
   */
  async push(input: GoalInput, now: Date = new Date()): Promise<GoalId> {
    const graph = this.sessionGraphUri();
    this.registry.assertWritable(graph);

    const uri = this.newGoalUri();
    const goalId = this.newGoalId(now);
    const status: GoalStatus = input.status ?? 'active';
    const priority = clamp01(input.priority);
    const ts = now.toISOString();
    const dt = (s: string) => `"${s}"^^<${XSD}dateTime>`;

    const lines: string[] = [
      `<${uri}> <${RDF_TYPE}> <${COGT}Goal> .`,
      `<${uri}> <${COGT}goalId> "${escapeLiteral(goalId)}" .`,
      `<${uri}> <${COGT}goalType> <${input.goalType}> .`,
      `<${uri}> <${COGT}goalLabel> "${escapeLiteral(input.goalLabel)}" .`,
      `<${uri}> <${COGT}goalStatus> "${status}" .`,
      `<${uri}> <${COGT}priority> "${priority}"^^<${XSD}decimal> .`,
      `<${uri}> <${COGT}createdAt> ${dt(ts)} .`,
      `<${uri}> <${COGT}updatedAt> ${dt(ts)} .`,
    ];
    if (input.successCriterion)
      lines.push(`<${uri}> <${COGT}successCriterion> "${escapeLiteral(input.successCriterion)}" .`);
    if (input.deadline) lines.push(`<${uri}> <${COGT}dueAt> ${dt(input.deadline.toISOString())} .`);
    if (input.parentGoal) lines.push(`<${uri}> <${COGT}parentGoal> <${input.parentGoal}> .`);
    if (input.triggeredByEpisode)
      lines.push(`<${uri}> <${COGT}triggeredByEpisode> <${input.triggeredByEpisode}> .`);
    if (input.triggeredByUser)
      lines.push(`<${uri}> <${COGT}triggeredByUser> <${input.triggeredByUser}> .`);
    if (input.plannedSteps)
      lines.push(`<${uri}> <${COGT}plannedSteps> "${escapeLiteral(input.plannedSteps)}" .`);
    if (input.currentStep)
      lines.push(`<${uri}> <${COGT}currentStep> "${escapeLiteral(input.currentStep)}" .`);
    if (input.longTerm !== undefined)
      lines.push(`<${uri}> <${COGT}longTerm> "${input.longTerm}"^^<${XSD}boolean> .`);
    for (const t of input.tags ?? [])
      lines.push(`<${uri}> <${COGT}tags> "${escapeLiteral(t)}" .`);

    await this.triplestore.update(`INSERT DATA { GRAPH <${graph}> {\n${lines.join('\n')}\n} }`);
    return uri;
  }

  /**
   * Ensure the implicit `RespondToUser` safety-net goal exists and is active
   * (doc 07 §5.1). If any goal is already active this is a no-op; otherwise the
   * implicit goal is pushed at priority 0.5. Returns the top active goal.
   */
  async ensureImplicit(now: Date = new Date()): Promise<Goal> {
    const active = await this.active();
    if (active.length > 0) return active[0];
    const uri = await this.push(
      { goalType: RESPOND_TO_USER, goalLabel: 'Respond to the user', priority: RESPOND_TO_USER_PRIORITY },
      now,
    );
    const goal = await this.get(uri);
    // get() can't return undefined here (we just wrote it), but keep the type honest.
    return goal ?? (await this.active())[0];
  }

  /** Transition a goal's status, stamping the matching timestamp / reason. */
  async setStatus(goalId: GoalId, status: GoalStatus, reason?: string, now: Date = new Date()): Promise<void> {
    const graph = await this.graphOf(goalId);
    if (!graph) return;
    this.registry.assertWritable(graph);
    const ts = now.toISOString();
    const dt = (s: string) => `"${s}"^^<${XSD}dateTime>`;

    await this.replaceOne(graph, goalId, `${COGT}goalStatus`, `"${status}"`);
    await this.replaceOne(graph, goalId, `${COGT}updatedAt`, dt(ts));
    if (status === 'resolved') await this.replaceOne(graph, goalId, `${COGT}resolvedAt`, dt(ts));
    if (status === 'abandoned') await this.replaceOne(graph, goalId, `${COGT}abandonedAt`, dt(ts));
    if (status === 'blocked' && reason)
      await this.replaceOne(graph, goalId, `${COGT}blockedReason`, `"${escapeLiteral(reason)}"`);
  }

  /** Update the goal's current step (and optional progress marker). */
  async setStep(goalId: GoalId, currentStep: string, progress?: string, now: Date = new Date()): Promise<void> {
    const graph = await this.graphOf(goalId);
    if (!graph) return;
    this.registry.assertWritable(graph);
    await this.replaceOne(graph, goalId, `${COGT}currentStep`, `"${escapeLiteral(currentStep)}"`);
    await this.replaceOne(
      graph,
      goalId,
      `${COGT}updatedAt`,
      `"${now.toISOString()}"^^<${XSD}dateTime>`,
    );
    if (progress !== undefined)
      await this.replaceOne(graph, goalId, `${COGT}stepProgress`, `"${escapeLiteral(progress)}"`);
  }

  /** The single top active goal across both goal graphs, or null if none. */
  async top(): Promise<Goal | null> {
    const active = await this.active();
    return active[0] ?? null;
  }

  /** All active goals, ordered by descending priority then descending recency. */
  async active(): Promise<Goal[]> {
    const goals = await this.readWhere(`?goal <${COGT}goalStatus> "active" .`);
    return goals.sort(
      (a, b) =>
        b.priority - a.priority ||
        (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0),
    );
  }

  /** Every goal in both graphs, any status (read-only; for inspection/UI). */
  async list(): Promise<Goal[]> {
    const goals = await this.readWhere('');
    return goals.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  }

  /** Fetch a single goal by IRI (searches both graphs). */
  async get(uri: GoalId): Promise<Goal | undefined> {
    const goals = await this.readWhere(`VALUES ?goal { <${uri}> }`);
    return goals[0];
  }

  /**
   * Session-end migration (doc 07 §4.1): move every goal that is `resolved`,
   * marked `cogt:longTerm true`, or whose deadline exceeds `now` from the
   * session graph to the longterm graph, preserving URI and provenance. Returns
   * the count migrated.
   */
  async migrateLongterm(now: Date = new Date()): Promise<number> {
    const session = this.sessionGraphUri();
    const longterm = this.longtermGraphUri();
    this.registry.assertWritable(session);
    this.registry.assertWritable(longterm);

    const all = await this.readGraph(session);
    const eligible = all.filter(
      (g) =>
        g.status === 'resolved' ||
        g.longTerm === true ||
        (g.deadline !== undefined && Date.parse(g.deadline) > now.getTime()),
    );
    if (eligible.length === 0) return 0;

    for (const g of eligible) {
      // A graph move: copy every triple of the goal, then delete the originals.
      await this.triplestore.update(`
        INSERT { GRAPH <${longterm}> { <${g.uri}> ?p ?o } }
        WHERE  { GRAPH <${session}> { <${g.uri}> ?p ?o } }`);
      await this.triplestore.update(`
        DELETE { GRAPH <${session}> { <${g.uri}> ?p ?o } }
        WHERE  { GRAPH <${session}> { <${g.uri}> ?p ?o } }`);
    }
    return eligible.length;
  }

  /** Replace (delete-then-insert) a single-valued predicate on a goal. */
  private async replaceOne(
    graph: string,
    uri: GoalId,
    predicate: string,
    objectTerm: string,
  ): Promise<void> {
    await this.triplestore.update(`
      DELETE { GRAPH <${graph}> { <${uri}> <${predicate}> ?old } }
      WHERE  { GRAPH <${graph}> { <${uri}> <${predicate}> ?old } }`);
    await this.triplestore.update(`
      INSERT DATA { GRAPH <${graph}> { <${uri}> <${predicate}> ${objectTerm} . } }`);
  }

  /** Which goal graph holds `uri` (session preferred), or undefined if neither. */
  private async graphOf(uri: GoalId): Promise<string | undefined> {
    for (const graph of this.goalGraphs()) {
      const res = await this.triplestore.query(`
        SELECT ?p WHERE { GRAPH <${graph}> { <${uri}> <${COGT}goalId> ?p } } LIMIT 1`);
      if ((res.bindings?.length ?? 0) > 0) return graph;
    }
    return undefined;
  }

  private async readWhere(constraint: string): Promise<Goal[]> {
    const out: Goal[] = [];
    for (const graph of this.goalGraphs()) {
      out.push(...(await this.readGraph(graph, constraint)));
    }
    return out;
  }

  private async readGraph(graph: string, constraint = ''): Promise<Goal[]> {
    const sparql = `
      SELECT ?goal ?goalId ?goalType ?goalLabel ?status ?priority ?createdAt ?updatedAt
             ?successCriterion ?deadline ?resolvedAt ?abandonedAt ?blockedReason
             ?parentGoal ?triggeredByEpisode ?triggeredByUser ?plannedSteps
             ?currentStep ?stepProgress ?longTerm
      WHERE {
        GRAPH <${graph}> {
          ?goal a <${COGT}Goal> ;
                <${COGT}goalId>    ?goalId ;
                <${COGT}goalType>  ?goalType ;
                <${COGT}goalLabel> ?goalLabel ;
                <${COGT}goalStatus> ?status ;
                <${COGT}priority>  ?priority ;
                <${COGT}createdAt> ?createdAt ;
                <${COGT}updatedAt> ?updatedAt .
          ${constraint}
          OPTIONAL { ?goal <${COGT}successCriterion>   ?successCriterion . }
          OPTIONAL { ?goal <${COGT}dueAt>              ?deadline . }
          OPTIONAL { ?goal <${COGT}resolvedAt>         ?resolvedAt . }
          OPTIONAL { ?goal <${COGT}abandonedAt>        ?abandonedAt . }
          OPTIONAL { ?goal <${COGT}blockedReason>      ?blockedReason . }
          OPTIONAL { ?goal <${COGT}parentGoal>         ?parentGoal . }
          OPTIONAL { ?goal <${COGT}triggeredByEpisode> ?triggeredByEpisode . }
          OPTIONAL { ?goal <${COGT}triggeredByUser>    ?triggeredByUser . }
          OPTIONAL { ?goal <${COGT}plannedSteps>       ?plannedSteps . }
          OPTIONAL { ?goal <${COGT}currentStep>        ?currentStep . }
          OPTIONAL { ?goal <${COGT}stepProgress>       ?stepProgress . }
          OPTIONAL { ?goal <${COGT}longTerm>           ?longTerm . }
        }
      }`;
    const res = await this.triplestore.query(sparql);
    const tags = await this.tagsFor(graph);
    return (res.bindings ?? []).map((r) => {
      const uri = r.goal.value;
      const goal: Goal = {
        uri,
        goalId: r.goalId.value,
        goalType: r.goalType.value,
        goalLabel: r.goalLabel.value,
        status: r.status.value as GoalStatus,
        priority: Number(r.priority.value),
        createdAt: r.createdAt.value,
        updatedAt: r.updatedAt.value,
        graph,
        tags: tags.get(uri) ?? [],
      };
      if (r.successCriterion) goal.successCriterion = r.successCriterion.value;
      if (r.deadline) goal.deadline = r.deadline.value;
      if (r.resolvedAt) goal.resolvedAt = r.resolvedAt.value;
      if (r.abandonedAt) goal.abandonedAt = r.abandonedAt.value;
      if (r.blockedReason) goal.blockedReason = r.blockedReason.value;
      if (r.parentGoal) goal.parentGoal = r.parentGoal.value;
      if (r.triggeredByEpisode) goal.triggeredByEpisode = r.triggeredByEpisode.value;
      if (r.triggeredByUser) goal.triggeredByUser = r.triggeredByUser.value;
      if (r.plannedSteps) goal.plannedSteps = r.plannedSteps.value;
      if (r.currentStep) goal.currentStep = r.currentStep.value;
      if (r.stepProgress) goal.stepProgress = r.stepProgress.value;
      if (r.longTerm) goal.longTerm = r.longTerm.value === 'true';
      return goal;
    });
  }

  /** Multi-valued `cogt:tags`, grouped by goal IRI. */
  private async tagsFor(graph: string): Promise<Map<string, string[]>> {
    const res = await this.triplestore.query(`
      SELECT ?goal ?t WHERE {
        GRAPH <${graph}> { ?goal a <${COGT}Goal> ; <${COGT}tags> ?t }
      }`);
    const map = new Map<string, string[]>();
    for (const r of res.bindings ?? []) {
      const arr = map.get(r.goal.value) ?? [];
      arr.push(r.t.value);
      map.set(r.goal.value, arr);
    }
    return map;
  }
}
