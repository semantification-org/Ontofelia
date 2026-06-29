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

import type { TriplestoreAdapter } from '@ontofelia/core';
import {
  EpisodicMemory,
  GraphRegistry,
  GraphUriResolver,
  type EpisodeHit,
} from '@ontofelia/semantic-memory';
import { WorkingMemory, type WMEntry } from './WorkingMemory.js';
import { GoalStack, type Goal } from './GoalStack.js';

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
  ordinal: number;
  phaseKind: string;
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

export interface ExplainAction {
  entryId: string;
  payload: string;
  forGoal?: string;
  goal?: Goal;
  triggeringEpisode?: EpisodeHit;
}

export interface ExplainRetrieval {
  entryId: string;
  payload: string;
  refersTo?: string;
  sourceGraph?: string;
  episode?: EpisodeHit;
}

export interface ResponseExplanation {
  cycleId: string;
  cycleUri: string;
  found: boolean;
  actions: ExplainAction[];
  retrievals: ExplainRetrieval[];
}

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
  async listCycles(sessionId: string, limit = 50): Promise<CycleSummary[]> {
    const graph = GraphUriResolver.getCogCyclesGraph(this.agentId, sessionId);
    const res = await this.triplestore.query(`
      SELECT ?c ?st ?s ?e WHERE {
        GRAPH <${graph}> {
          ?c a <${COGT}Cycle> ;
             <${COGT}cycleStatus> ?st ;
             <${COGT}startedAt>   ?s ;
             <${COGT}endedAt>     ?e .
        }
      }`);
    return (res.bindings ?? [])
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
  async getCycle(sessionId: string, cycleId: string): Promise<CycleDetail | undefined> {
    const cyclesGraph = GraphUriResolver.getCogCyclesGraph(this.agentId, sessionId);
    const cycleUri = this.cycleUriFor(cycleId);
    const head = await this.triplestore.query(`
      SELECT ?st ?s ?e WHERE {
        GRAPH <${cyclesGraph}> {
          <${cycleUri}> a <${COGT}Cycle> ;
             <${COGT}cycleStatus> ?st ;
             <${COGT}startedAt>   ?s ;
             <${COGT}endedAt>     ?e .
        }
      }`);
    const h = (head.bindings ?? [])[0];
    if (!h) return undefined;
    const cycle = this.toCycleSummary(cycleUri, h.st.value, h.s.value, h.e.value);

    const [phases, buffer, episodes, marker] = await Promise.all([
      this.readPhases(cyclesGraph, cycleUri),
      this.readBuffer(sessionId, cycleId),
      this.episodesInCycle(cycleId),
      this.readMarker(cycleUri),
    ]);

    return { cycle, phases, buffer, episodes, marker };
  }

  private async readPhases(cyclesGraph: string, cycleUri: string): Promise<PhaseSummary[]> {
    const res = await this.triplestore.query(`
      SELECT ?p ?ord ?kind ?s ?e WHERE {
        GRAPH <${cyclesGraph}> {
          ?p a <${COGT}Phase> ;
             <${COGT}partOfCycle> <${cycleUri}> ;
             <${COGT}ordinal>     ?ord ;
             <${COGT}phaseKind>   ?kind ;
             <${COGT}startedAt>   ?s ;
             <${COGT}endedAt>     ?e .
        }
      }`);
    return (res.bindings ?? [])
      .map((b) => ({
        phaseUri: b.p.value,
        ordinal: Number(b.ord.value),
        phaseKind: b.kind.value,
        startedAt: b.s.value,
        endedAt: b.e.value,
      }))
      .sort((a, b) => a.ordinal - b.ordinal);
  }

  private async readBuffer(sessionId: string, cycleId: string): Promise<WMEntry[]> {
    const wm = new WorkingMemory(this.triplestore, this.registry, this.agentId, sessionId, cycleId);
    return wm.read();
  }

  /**
   * Episodes whose `cogt:cycleId` is this cycle, newest-first. `EpisodeHit`
   * does not surface `cycleId`, so the cycle's episode URIs are selected
   * directly and then resolved to full hits.
   */
  private async episodesInCycle(cycleId: string): Promise<EpisodeHit[]> {
    const graph = GraphUriResolver.getCogEpisodicGraph(this.agentId);
    const res = await this.triplestore.query(`
      SELECT ?ep WHERE {
        GRAPH <${graph}> {
          ?ep a <${COGT}Episode> ; <${COGT}cycleId> "${escapeLiteral(cycleId)}" .
        }
      }`);
    const uris = new Set((res.bindings ?? []).map((b) => b.ep.value));
    if (uris.size === 0) return [];
    const all = await this.episodicMemory().recent(5000);
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
  async listGoals(sessionId: string): Promise<Goal[]> {
    return this.goalStack(sessionId).list();
  }

  /** Most-recent episodes, optionally restricted to an entity IRI. */
  async listEpisodes(entity?: string, limit = 50): Promise<EpisodeHit[]> {
    return this.episodicMemory().recent(limit, entity);
  }

  /**
   * Reconstruct the WM→action→goal→episode chain behind a cycle's response.
   * For each action entry in the cycle's working memory, resolve the goal it
   * serves and the episode that triggered that goal; retrieval entries surface
   * the episodes they pulled into the workspace.
   */
  async explainResponse(sessionId: string, cycleId: string): Promise<ResponseExplanation> {
    const cycleUri = this.cycleUriFor(cycleId);
    const buffer = await this.readBuffer(sessionId, cycleId);
    if (buffer.length === 0) {
      return { cycleId, cycleUri, found: false, actions: [], retrievals: [] };
    }

    const gs = this.goalStack(sessionId);
    const actionEntries = buffer.filter(
      (e) => e.buffer === 'actionBuffer' || e.entryKind.startsWith('action'),
    );
    const actions: ExplainAction[] = [];
    for (const e of actionEntries) {
      const goal = e.forGoal ? await gs.get(e.forGoal) : undefined;
      const triggeringEpisode =
        goal?.triggeredByEpisode !== undefined
          ? await this.episodeByUri(goal.triggeredByEpisode)
          : undefined;
      actions.push({
        entryId: e.id,
        payload: e.payload,
        forGoal: e.forGoal,
        goal,
        triggeringEpisode,
      });
    }

    const retrievalEntries = buffer.filter(
      (e) => e.refersTo !== undefined || e.entryKind === 'episode-ref' || e.buffer === 'retrievalBuffer',
    );
    const retrievals: ExplainRetrieval[] = [];
    for (const e of retrievalEntries) {
      const episode = e.refersTo ? await this.episodeByUri(e.refersTo) : undefined;
      retrievals.push({
        entryId: e.id,
        payload: e.payload,
        refersTo: e.refersTo,
        sourceGraph: e.sourceGraph,
        episode,
      });
    }

    return { cycleId, cycleUri, found: true, actions, retrievals };
  }

  private async episodeByUri(uri: string): Promise<EpisodeHit | undefined> {
    const all = await this.episodicMemory().recent(5000);
    return all.find((e) => e.uri === uri);
  }

  private episodicMemory(): EpisodicMemory {
    return new EpisodicMemory(this.triplestore, this.agentId);
  }

  private goalStack(sessionId: string): GoalStack {
    return new GoalStack(this.triplestore, this.registry, this.agentId, sessionId);
  }
}
