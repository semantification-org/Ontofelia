/**
 * CogInspector — read-only projection over the cognitive named graphs for the
 * Phase I debug panel (doc 09 §10). It reconstructs cycles, their phase
 * timeline, the working-memory buffer dump, the episodes a cycle touched, and
 * the WM→action→goal→episode chain behind a response.
 *
 * Nothing here mutates the store: it composes the existing read paths of
 * {@link WorkingMemory}, {@link GoalStack} and {@link EpisodicMemory} plus a
 * few direct SELECTs against the cycles/meta graphs. As elsewhere in the
 * cognitive stack all counting/ranking happens in TypeScript because the
 * embedded Oxigraph WASM build cannot evaluate SPARQL aggregates.
 */

import { ALL_USERS_SCOPE, OWNER_USER_KEY, compareIso, type TriplestoreAdapter } from '@ontofelia/core';
import {
  EpisodicMemory,
  GraphRegistry,
  GraphUriResolver,
  type EpisodeHit,
  type UserScope,
} from '@ontofelia/semantic-memory';
import { WorkingMemory, type WMEntry } from './WorkingMemory.js';
import { GoalStack, goalBelongsTo, type Goal } from './GoalStack.js';
import { neutraliseLine } from './untrustedText.js';

const COGT = 'urn:shared:ontology#cog/';

function escapeLiteral(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

export interface CycleSummary {
  cycleId: string;
  cycleUri: string;
  status: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
}

export interface PhaseSummary {
  phaseUri: string;
  /** 1-based position in the cycle (`cogt:phaseIndex`; the old shape's `cogt:ordinal`). */
  phaseIndex: number;
  phaseKind: string;
  /** `cogt:phaseStatus`; absent on cycles stored before the status was written. */
  phaseStatus?: string;
  startedAt: string;
  endedAt: string;
}

export interface CycleMarker {
  markerUri: string;
  createdAt?: string;
  noted?: string;
  flaggedImpasse: string[];
}

export interface CycleDetail {
  cycle: CycleSummary;
  phases: PhaseSummary[];
  buffer: WMEntry[];
  episodes: EpisodeHit[];
  marker?: CycleMarker;
}

/** An episode as the explain chain shows it: neutralised text, no store internals. */
export interface EpisodeBrief {
  uri: string;
  episodeType: string;
  occurredAt: string;
  payload?: string;
  partOfGoal?: string;
  tags: string[];
}

/** A goal as the explain chain shows it. */
export interface GoalBrief {
  uri: string;
  goalLabel: string;
  goalType: string;
  goalStatus: string;
  priority: number;
}

export interface ExplainAction {
  /** The proposal's working-memory entry (or the only entry of an old-shape action). */
  entryId: string;
  payload: string;
  forGoal?: string;
  goal?: GoalBrief;
  triggeringEpisode?: EpisodeBrief;
  callId?: string;
  toolName?: string;
  /** Keys-only, masked summary of the arguments. */
  args?: string;
  resultEntryId?: string;
  /** Absent while no result was recorded for the call. */
  outcome?: 'success' | 'error';
  denialClass?: string;
  durationMs?: number;
  /** The tool-called / tool-completed episodes of the call (paired by call id). */
  episodes: EpisodeBrief[];
}

export interface ExplainRetrieval {
  entryId: string;
  payload: string;
  refersTo?: string;
  sourceGraph?: string;
  episode?: EpisodeBrief;
}

export interface ExplainBuffer {
  buffer: string;
  count: number;
  kinds: string[];
}

export interface ResponseExplanation {
  cycleId: string;
  cycleUri: string;
  found: boolean;
  status?: string;
  startedAt?: string;
  /** The reply the cycle sent (its `response-sent` episode), when one was recorded. */
  response?: EpisodeBrief;
  /** The goals the cycle served, in order of first mention. */
  goals: GoalBrief[];
  actions: ExplainAction[];
  retrievals: ExplainRetrieval[];
  /** Working-memory entries of the cycle, counted per buffer. */
  workingMemory: ExplainBuffer[];
  /** Every episode of the cycle, oldest first. */
  episodes: EpisodeBrief[];
}

const EXPLAIN_TEXT_MAX = 200;
const EXPLAIN_NAME_MAX = 120;
const EXPLAIN_MAX_GOALS = 10;
const EXPLAIN_MAX_EPISODES = 100;
const EXPLAIN_MAX_RETRIEVALS = 50;

function neat(text: string | undefined, max = EXPLAIN_TEXT_MAX): string {
  return neutraliseLine(text ?? '', max);
}

/**
 * The explanation as fixed-format text. Every stored string is passed through
 * {@link neutraliseLine} (one inert line, bounded), so a payload cannot start a
 * line of its own or pose as structure.
 */
export function renderExplanation(exp: ResponseExplanation): string {
  const id = neat(exp.cycleId, EXPLAIN_NAME_MAX);
  if (!exp.found) return `Explain cycle ${id}: no such cycle for this scope.`;
  const lines: string[] = [];
  lines.push(`Explain cycle ${id}: ${neat(exp.status, 20) || 'unknown'}${exp.startedAt ? ` at ${neat(exp.startedAt, 40)}` : ''}`);
  lines.push(
    exp.response
      ? `Response: ${neat(exp.response.occurredAt, 40)} "${neat(exp.response.payload)}"`
      : 'Response: none recorded',
  );
  lines.push(`Goals (${exp.goals.length}):`);
  for (const g of exp.goals) {
    lines.push(`  - ${neat(g.goalLabel)} [type=${neat(g.goalType.split('/').pop() ?? g.goalType, 60)}, status=${neat(g.goalStatus, 20)}]`);
  }
  lines.push(`Actions (${exp.actions.length}):`);
  exp.actions.forEach((a, i) => {
    const result =
      a.outcome === undefined
        ? 'no result'
        : `${a.outcome === 'success' ? 'ok' : 'error'}${a.denialClass ? ` (${neat(a.denialClass, 60)})` : ''}${a.durationMs !== undefined ? `, ${a.durationMs} ms` : ''}`;
    lines.push(`  ${i + 1}. ${neat(a.toolName ?? a.payload, EXPLAIN_NAME_MAX)} -> ${result}`);
    if (a.args !== undefined) lines.push(`     args: ${neat(a.args) || '(none)'}`);
    lines.push(`     goal: ${a.goal ? neat(a.goal.goalLabel) : 'none'}`);
    if (a.triggeringEpisode) {
      lines.push(`     triggered by: ${neat(a.triggeringEpisode.episodeType, 40)} "${neat(a.triggeringEpisode.payload, 80)}"`);
    }
    if (a.episodes.length > 0) {
      lines.push(`     episodes: ${a.episodes.map((e) => `${neat(e.episodeType, 40)}@${neat(e.occurredAt, 40)}`).join(', ')}`);
    }
  });
  lines.push(`Working memory: ${exp.workingMemory.length === 0 ? 'empty' : exp.workingMemory.map((b) => `${neat(b.buffer, 40)}=${b.count}`).join(', ')}`);
  lines.push(`Episodes (${exp.episodes.length}):`);
  for (const e of exp.episodes) {
    lines.push(`  - ${neat(e.episodeType, 40)} ${neat(e.occurredAt, 40)} "${neat(e.payload, 80)}"`);
  }
  return lines.join('\n');
}

/** A cycle id as the runtime mints it (`cyc-<uuid>`); anything else is never put into a query. */
function isSafeCycleId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,100}$/.test(id);
}

/** Fail closed on a missing scope: an inspection is never unscoped by accident. */
function assertScope(userScope: UserScope): void {
  if (typeof userScope !== 'string' || userScope === '') {
    throw new Error('CogInspector: a userScope (user key or "all") is required');
  }
}

/** Is a record keyed `forUser` inside the scope? Legacy (no key) is owner-only. */
function keyInScope(forUser: string | undefined, userScope: UserScope): boolean {
  if (userScope === ALL_USERS_SCOPE) return true;
  if (forUser === undefined) return userScope === OWNER_USER_KEY;
  return forUser === userScope;
}

/**
 * Every projection takes a mandatory `userScope`: a user key, or `"all"` for
 * the operator's unrestricted view. A scoped call returns only records written
 * for that user; records without a user key (written before it existed) belong
 * to the owner's scope. Cycle phases and markers carry no content and follow
 * their cycle.
 */
export class CogInspector {
  constructor(
    private readonly triplestore: TriplestoreAdapter,
    private readonly registry: GraphRegistry,
    private readonly agentId: string,
  ) {}

  private cycleUriFor(cycleId: string): string {
    return `urn:${this.agentId}:cog:cycle:${cycleId}`;
  }

  /** `urn:<agent>:cog:cycle:<cycleId>` → `<cycleId>`. */
  private cycleIdFromUri(uri: string): string {
    const marker = ':cog:cycle:';
    const i = uri.indexOf(marker);
    return i >= 0 ? uri.slice(i + marker.length) : uri;
  }

  /** Cycles in a session, newest-first, sliced to `limit`. */
  async listCycles(sessionId: string, userScope: UserScope, limit = 50): Promise<CycleSummary[]> {
    assertScope(userScope);
    const graph = GraphUriResolver.getCogCyclesGraph(this.agentId, sessionId);
    const res = await this.triplestore.query(`
      SELECT ?c ?st ?s ?e ?forUser WHERE {
        GRAPH <${graph}> {
          ?c a <${COGT}Cycle> ;
             <${COGT}cycleStatus> ?st ;
             <${COGT}startedAt>   ?s ;
             <${COGT}endedAt>     ?e .
          OPTIONAL { ?c <${COGT}forUser> ?forUser . }
        }
      }`);
    return (res.bindings ?? [])
      .filter((b) => keyInScope(b.forUser?.value, userScope))
      .map((b) => this.toCycleSummary(b.c.value, b.st.value, b.s.value, b.e.value))
      .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
      .slice(0, Math.max(0, limit));
  }

  private toCycleSummary(uri: string, status: string, s: string, e: string): CycleSummary {
    return {
      cycleId: this.cycleIdFromUri(uri),
      cycleUri: uri,
      status,
      startedAt: s,
      endedAt: e,
      durationMs: Date.parse(e) - Date.parse(s),
    };
  }

  /**
   * Full detail for one cycle: its phase timeline, the WM buffer dump for that
   * cycle, the episodes it wrote (by `cogt:cycleId`) and the reflective marker
   * that reflects on it. Returns `undefined` when the cycle is unknown.
   */
  async getCycle(
    sessionId: string,
    cycleId: string,
    userScope: UserScope,
  ): Promise<CycleDetail | undefined> {
    assertScope(userScope);
    if (!isSafeCycleId(cycleId)) return undefined;
    const cyclesGraph = GraphUriResolver.getCogCyclesGraph(this.agentId, sessionId);
    const cycleUri = this.cycleUriFor(cycleId);
    const head = await this.triplestore.query(`
      SELECT ?st ?s ?e ?forUser WHERE {
        GRAPH <${cyclesGraph}> {
          <${cycleUri}> a <${COGT}Cycle> ;
             <${COGT}cycleStatus> ?st ;
             <${COGT}startedAt>   ?s ;
             <${COGT}endedAt>     ?e .
          OPTIONAL { <${cycleUri}> <${COGT}forUser> ?forUser . }
        }
      }`);
    const h = (head.bindings ?? [])[0];
    if (!h || !keyInScope(h.forUser?.value, userScope)) return undefined;
    const cycle = this.toCycleSummary(cycleUri, h.st.value, h.s.value, h.e.value);

    const [phases, buffer, episodes, marker] = await Promise.all([
      this.readPhases(cyclesGraph, cycleUri),
      this.readBuffer(sessionId, cycleId, userScope),
      this.episodesInCycle(cycleId, userScope),
      this.readMarker(cycleUri),
    ]);

    return { cycle, phases, buffer, episodes, marker };
  }

  /**
   * The phases of a cycle. Reads both shapes: the doc's (`hasPhase` from the
   * cycle, `phaseIndex`, `phaseStatus`) and the one stored before (`partOfCycle`
   * back-link, `ordinal`, no status), so a cycle written either way displays.
   */
  private async readPhases(cyclesGraph: string, cycleUri: string): Promise<PhaseSummary[]> {
    const res = await this.triplestore.query(`
      SELECT ?p ?idx ?ord ?kind ?status ?s ?e WHERE {
        GRAPH <${cyclesGraph}> {
          { <${cycleUri}> <${COGT}hasPhase> ?p . } UNION { ?p <${COGT}partOfCycle> <${cycleUri}> . }
          ?p a <${COGT}Phase> ;
             <${COGT}phaseKind>   ?kind ;
             <${COGT}startedAt>   ?s ;
             <${COGT}endedAt>     ?e .
          OPTIONAL { ?p <${COGT}phaseIndex>  ?idx . }
          OPTIONAL { ?p <${COGT}ordinal>     ?ord . }
          OPTIONAL { ?p <${COGT}phaseStatus> ?status . }
        }
      }`);
    const byUri = new Map<string, PhaseSummary>();
    for (const b of res.bindings ?? []) {
      const index = Number((b.idx ?? b.ord)?.value);
      if (!Number.isFinite(index)) continue;
      byUri.set(b.p.value, {
        phaseUri: b.p.value,
        phaseIndex: index,
        phaseKind: b.kind.value,
        ...(b.status ? { phaseStatus: b.status.value } : {}),
        startedAt: b.s.value,
        endedAt: b.e.value,
      });
    }
    return [...byUri.values()].sort((a, b) => a.phaseIndex - b.phaseIndex);
  }

  private async readBuffer(
    sessionId: string,
    cycleId: string,
    userScope: UserScope,
  ): Promise<WMEntry[]> {
    const wm = new WorkingMemory(this.triplestore, this.registry, this.agentId, sessionId, cycleId);
    return (await wm.read()).filter((e) => keyInScope(e.forUser, userScope));
  }

  /**
   * Episodes whose `cogt:cycleId` is this cycle, newest-first. `EpisodeHit`
   * does not surface `cycleId`, so the cycle's episode URIs are selected
   * directly and then resolved to full hits.
   */
  private async episodesInCycle(cycleId: string, userScope: UserScope): Promise<EpisodeHit[]> {
    const uris = await this.episodeUrisInCycle(cycleId);
    if (uris.size === 0) return [];
    const all = await this.episodicMemory().recent(userScope, 5000);
    return all.filter((e) => uris.has(e.uri));
  }

  private async readMarker(cycleUri: string): Promise<CycleMarker | undefined> {
    const graph = GraphUriResolver.getCogMetaGraph(this.agentId);
    const res = await this.triplestore.query(`
      SELECT ?m ?createdAt ?noted ?fi WHERE {
        GRAPH <${graph}> {
          ?m a <${COGT}ReflectiveMarker> ;
             <${COGT}reflectsOn> <${cycleUri}> .
          OPTIONAL { ?m <${COGT}createdAt>      ?createdAt . }
          OPTIONAL { ?m <${COGT}noted>          ?noted . }
          OPTIONAL { ?m <${COGT}flaggedImpasse> ?fi . }
        }
      }`);
    const rows = res.bindings ?? [];
    if (rows.length === 0) return undefined;
    const first = rows[0];
    const flaggedImpasse = rows
      .map((r) => r.fi?.value)
      .filter((v): v is string => v !== undefined);
    return {
      markerUri: first.m.value,
      createdAt: first.createdAt?.value,
      noted: first.noted?.value,
      flaggedImpasse,
    };
  }

  /** Every goal in the session + long-term graphs (read-only). */
  async listGoals(sessionId: string, userScope: UserScope): Promise<Goal[]> {
    assertScope(userScope);
    const goals = await this.goalStack(sessionId).list();
    return userScope === ALL_USERS_SCOPE ? goals : goals.filter((g) => goalBelongsTo(g, userScope));
  }

  /** Most-recent episodes, optionally restricted to an entity IRI. */
  async listEpisodes(userScope: UserScope, entity?: string, limit = 50): Promise<EpisodeHit[]> {
    return this.episodicMemory().recent(userScope, limit, entity);
  }

  /** The newest cycle of a session inside the scope, or undefined. */
  async latestCycleId(sessionId: string, userScope: UserScope): Promise<string | undefined> {
    return (await this.listCycles(sessionId, userScope, 1))[0]?.cycleId;
  }

  /**
   * Reconstruct the chain behind a cycle's response: response → action(s) →
   * goal → working-memory entries → episode(s). Each tool call becomes one
   * action (its proposal and result entries, paired by call id, and its
   * tool-called / tool-completed episodes); the response is the cycle's
   * `response-sent` episode; the goals are the ones the response, the actions
   * and the goal buffer name. Retrieval entries surface the episodes they pulled
   * into the workspace.
   *
   * Scoped like every projection: a record of another user is never read into
   * the answer, and a cycle of another user is "not found". All stored text is
   * neutralised, so the JSON and the text form carry inert one-line strings.
   */
  async explainResponse(
    sessionId: string,
    cycleId: string,
    userScope: UserScope,
  ): Promise<ResponseExplanation> {
    assertScope(userScope);
    const cycleUri = this.cycleUriFor(cycleId);
    const empty: ResponseExplanation = {
      cycleId,
      cycleUri,
      found: false,
      goals: [],
      actions: [],
      retrievals: [],
      workingMemory: [],
      episodes: [],
    };
    if (!isSafeCycleId(cycleId)) return empty;
    // A cycle is "found" when the scope can see at least one working-memory entry
    // of it (every recorded cycle has some); a cycle of another user has none here.
    const buffer = await this.readBuffer(sessionId, cycleId, userScope);
    if (buffer.length === 0) return empty;
    const head = await this.readHead(sessionId, cycleId, userScope);

    // One read of the scope's episodes serves every lookup below.
    const all = await this.episodicMemory().recent(userScope, 5000);
    const byUri = new Map(all.map((e) => [e.uri, e]));
    const inCycle = await this.episodeUrisInCycle(cycleId);
    const cycleEpisodes = all
      .filter((e) => inCycle.has(e.uri))
      .sort((x, y) => compareIso(x.occurredAt, y.occurredAt));
    const brief = (e: EpisodeHit): EpisodeBrief => ({
      uri: e.uri,
      episodeType: neat(e.episodeType, 40),
      occurredAt: e.occurredAt,
      ...(e.payload !== undefined ? { payload: neat(e.payload) } : {}),
      ...(e.partOfGoal ? { partOfGoal: e.partOfGoal } : {}),
      tags: e.tags.map((t) => neat(t, 80)),
    });

    const gs = this.goalStack(sessionId);
    const goalCache = new Map<string, Goal | undefined>();
    const goalOf = async (uri: string | undefined): Promise<Goal | undefined> => {
      if (!uri) return undefined;
      if (!goalCache.has(uri)) {
        const found = await gs.get(uri);
        goalCache.set(
          uri,
          found && (userScope === ALL_USERS_SCOPE || goalBelongsTo(found, userScope)) ? found : undefined,
        );
      }
      return goalCache.get(uri);
    };
    const goalBrief = (g: Goal): GoalBrief => ({
      uri: g.uri,
      goalLabel: neat(g.goalLabel),
      goalType: neat(g.goalType, 160),
      goalStatus: neat(g.status, 20),
      priority: g.priority,
    });

    // Actions: one per tool call. Entries of the old shape (no call id) stand alone.
    const isResult = (e: WMEntry) => e.entryKind === 'action-result';
    const actionEntries = buffer.filter(
      (e) => e.buffer === 'actionBuffer' || e.entryKind.startsWith('action'),
    );
    const results = new Map<string, WMEntry>();
    for (const e of actionEntries) if (isResult(e) && e.callId) results.set(e.callId, e);
    const proposals = actionEntries.filter(
      (e) => !(isResult(e) && e.callId !== undefined && actionEntries.some((p) => !isResult(p) && p.callId === e.callId)),
    );
    const episodesOfCall = (callId: string | undefined) =>
      callId === undefined ? [] : cycleEpisodes.filter((e) => e.tags.includes(callId)).map(brief);
    const calledAt = (e: WMEntry): string => {
      const ep = e.callId ? cycleEpisodes.find((x) => x.tags.includes(e.callId!) && x.episodeType === 'tool-called') : undefined;
      return ep?.occurredAt ?? e.writtenAt;
    };
    const ordered = proposals
      .map((e, i) => ({ e, i }))
      .sort((x, y) => compareIso(calledAt(x.e), calledAt(y.e)) || x.i - y.i)
      .map((x) => x.e);

    const actions: ExplainAction[] = [];
    for (const e of ordered) {
      const goal = await goalOf(e.forGoal);
      const triggering = goal?.triggeredByEpisode !== undefined ? byUri.get(goal.triggeredByEpisode) : undefined;
      const result = isResult(e) ? e : e.callId ? results.get(e.callId) : undefined;
      actions.push({
        entryId: e.id,
        payload: neat(e.payload),
        ...(e.forGoal ? { forGoal: e.forGoal } : {}),
        ...(goal ? { goal: goalBrief(goal) } : {}),
        ...(triggering ? { triggeringEpisode: brief(triggering) } : {}),
        ...(e.callId ? { callId: neat(e.callId, 120) } : {}),
        ...(e.toolName ? { toolName: neat(e.toolName, EXPLAIN_NAME_MAX) } : {}),
        ...(e.toolArgs !== undefined ? { args: neat(e.toolArgs) } : {}),
        ...(result && result !== e ? { resultEntryId: result.id } : {}),
        ...(result?.outcome ? { outcome: result.outcome } : {}),
        ...(result?.denialClass ? { denialClass: neat(result.denialClass, 60) } : {}),
        ...(result?.durationMs !== undefined ? { durationMs: result.durationMs } : {}),
        episodes: episodesOfCall(e.callId),
      });
    }

    const retrievals: ExplainRetrieval[] = [];
    const retrievalEntries = buffer.filter(
      (e) => e.refersTo !== undefined || e.entryKind === 'episode-ref' || e.buffer === 'retrievalBuffer',
    );
    for (const e of retrievalEntries.slice(0, EXPLAIN_MAX_RETRIEVALS)) {
      const ep = e.refersTo ? byUri.get(e.refersTo) : undefined;
      retrievals.push({
        entryId: e.id,
        payload: neat(e.payload),
        ...(e.refersTo ? { refersTo: e.refersTo } : {}),
        ...(e.sourceGraph ? { sourceGraph: e.sourceGraph } : {}),
        ...(ep ? { episode: brief(ep) } : {}),
      });
    }

    const responseEp = [...cycleEpisodes].reverse().find((e) => e.episodeType === 'response-sent');

    // Goals in order of first mention: the response, the actions, the goal
    // buffer, then the remaining episodes of the cycle.
    const goalUris: string[] = [];
    const mention = (u: string | undefined) => {
      if (u && !goalUris.includes(u)) goalUris.push(u);
    };
    mention(responseEp?.partOfGoal);
    for (const a of actions) mention(a.forGoal);
    for (const e of buffer) if (e.buffer === 'goalBuffer') mention(e.forGoal);
    for (const e of cycleEpisodes) mention(e.partOfGoal);
    const goals: GoalBrief[] = [];
    for (const u of goalUris) {
      const g = await goalOf(u);
      if (g) goals.push(goalBrief(g));
      if (goals.length >= EXPLAIN_MAX_GOALS) break;
    }

    const perBuffer = new Map<string, { count: number; kinds: Set<string> }>();
    for (const e of buffer) {
      const slot = perBuffer.get(e.buffer) ?? { count: 0, kinds: new Set<string>() };
      slot.count++;
      slot.kinds.add(e.entryKind);
      perBuffer.set(e.buffer, slot);
    }
    const workingMemory: ExplainBuffer[] = [...perBuffer.entries()]
      .sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0))
      .map(([name, v]) => ({ buffer: neat(name, 40), count: v.count, kinds: [...v.kinds].sort().map((k) => neat(k, 40)) }));

    return {
      cycleId,
      cycleUri,
      found: true,
      ...(head ? { status: head.status, startedAt: head.startedAt } : {}),
      ...(responseEp ? { response: brief(responseEp) } : {}),
      goals,
      actions,
      retrievals,
      workingMemory,
      episodes: cycleEpisodes.slice(0, EXPLAIN_MAX_EPISODES).map(brief),
    };
  }

  /** The cycle resource inside the scope, or undefined (unknown, or another user's). */
  private async readHead(
    sessionId: string,
    cycleId: string,
    userScope: UserScope,
  ): Promise<CycleSummary | undefined> {
    const cyclesGraph = GraphUriResolver.getCogCyclesGraph(this.agentId, sessionId);
    const cycleUri = this.cycleUriFor(cycleId);
    const head = await this.triplestore.query(`
      SELECT ?st ?s ?e ?forUser WHERE {
        GRAPH <${cyclesGraph}> {
          <${cycleUri}> a <${COGT}Cycle> ;
             <${COGT}cycleStatus> ?st ;
             <${COGT}startedAt>   ?s ;
             <${COGT}endedAt>     ?e .
          OPTIONAL { <${cycleUri}> <${COGT}forUser> ?forUser . }
        }
      }`);
    const h = (head.bindings ?? [])[0];
    if (!h || !keyInScope(h.forUser?.value, userScope)) return undefined;
    return this.toCycleSummary(cycleUri, h.st.value, h.s.value, h.e.value);
  }

  /** URIs of the episodes carrying `cogt:cycleId` = this cycle (any user; the caller filters by scope). */
  private async episodeUrisInCycle(cycleId: string): Promise<Set<string>> {
    const graph = GraphUriResolver.getCogEpisodicGraph(this.agentId);
    const res = await this.triplestore.query(`
      SELECT ?ep WHERE {
        GRAPH <${graph}> {
          ?ep a <${COGT}Episode> ; <${COGT}cycleId> "${escapeLiteral(cycleId)}" .
        }
      }`);
    return new Set((res.bindings ?? []).map((b) => b.ep.value));
  }

  private episodicMemory(): EpisodicMemory {
    return new EpisodicMemory(this.triplestore, this.agentId);
  }

  private goalStack(sessionId: string): GoalStack {
    return new GoalStack(this.triplestore, this.registry, this.agentId, sessionId);
  }
}
