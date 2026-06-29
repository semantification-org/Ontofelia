/**
 * CogHealth — read-only observability projection over the cognitive named
 * graphs (doc 09 §9). Produces the `/cog/health` payload: per-graph counts and
 * cycle-latency statistics.
 *
 * As elsewhere in the cognitive stack, all counting and ranking is done in
 * TypeScript because the embedded Oxigraph WASM build cannot evaluate SPARQL
 * aggregates (COUNT/AVG throw "unreachable"). Cycles live in per-session graphs,
 * so cross-session scans use a `GRAPH ?g` pattern rather than a fixed graph.
 */

import type { TriplestoreAdapter } from '@ontofelia/core';
import { GraphUriResolver } from '@ontofelia/semantic-memory';

const COGT = 'urn:shared:ontology#cog/';
const XSD_DATETIME = 'http://www.w3.org/2001/XMLSchema#dateTime';

export interface GraphHealth {
  tripleCount: number;
  lastWrite?: string;
}

export interface ProceduralHealth extends GraphHealth {
  skillCount: number;
  sequenceSkillCount: number;
}

export interface GoalsHealth {
  active: number;
  blocked: number;
  resolved: number;
  abandoned: number;
}

export interface MetaHealth {
  markerCount: number;
  impassesLast24h: number;
}

export interface CycleHealth {
  lastCycleId?: string;
  meanLatencyMsLast100: number;
  p95LatencyMsLast100: number;
  impasseRateLast100: number;
}

export interface CogHealthReport {
  agent: string;
  graphs: {
    'cog:episodic': GraphHealth;
    'cog:procedural': ProceduralHealth;
    'cog:goals:long': GoalsHealth;
    'cog:meta': MetaHealth;
  };
  cycle: CycleHealth;
}

export class CogHealth {
  constructor(
    private readonly triplestore: TriplestoreAdapter,
    private readonly agentId: string,
  ) {}

  async report(now: Date = new Date()): Promise<CogHealthReport> {
    const episodic = GraphUriResolver.getCogEpisodicGraph(this.agentId);
    const procedural = GraphUriResolver.getCogProceduralGraph(this.agentId);
    const goalsLong = GraphUriResolver.getCogGoalsLongtermGraph(this.agentId);
    const meta = GraphUriResolver.getCogMetaGraph(this.agentId);

    const [epi, proc, skillCount, seqCount, goals, metaH, cycle] = await Promise.all([
      this.graphHealth(episodic),
      this.graphHealth(procedural),
      this.countOfType(procedural, `${COGT}Skill`),
      this.countOfType(procedural, `${COGT}SequenceSkill`),
      this.goalsHealth(goalsLong),
      this.metaHealth(meta, now),
      this.cycleHealth(meta),
    ]);

    return {
      agent: this.agentId,
      graphs: {
        'cog:episodic': epi,
        'cog:procedural': { ...proc, skillCount, sequenceSkillCount: seqCount },
        'cog:goals:long': goals,
        'cog:meta': metaH,
      },
      cycle,
    };
  }

  /** Triple count + most-recent xsd:dateTime literal in one named graph. */
  private async graphHealth(graph: string): Promise<GraphHealth> {
    const count = await this.triplestore.query(`
      SELECT ?s ?p ?o WHERE { GRAPH <${graph}> { ?s ?p ?o } }`);
    const stamps = await this.triplestore.query(`
      SELECT ?o WHERE {
        GRAPH <${graph}> { ?s ?p ?o . FILTER(datatype(?o) = <${XSD_DATETIME}>) }
      }`);
    const lastWrite = (stamps.bindings ?? [])
      .map((b) => b.o.value)
      .sort()
      .pop();
    return { tripleCount: count.bindings?.length ?? 0, lastWrite };
  }

  private async countOfType(graph: string, typeIri: string): Promise<number> {
    const res = await this.triplestore.query(`
      SELECT ?s WHERE { GRAPH <${graph}> { ?s a <${typeIri}> } }`);
    return res.bindings?.length ?? 0;
  }

  private async goalsHealth(graph: string): Promise<GoalsHealth> {
    const res = await this.triplestore.query(`
      SELECT ?status WHERE {
        GRAPH <${graph}> { ?g a <${COGT}Goal> ; <${COGT}goalStatus> ?status }
      }`);
    const out: GoalsHealth = { active: 0, blocked: 0, resolved: 0, abandoned: 0 };
    for (const b of res.bindings ?? []) {
      const s = b.status.value;
      if (s === 'active') out.active++;
      else if (s === 'blocked') out.blocked++;
      else if (s === 'resolved') out.resolved++;
      else if (s === 'abandoned') out.abandoned++;
    }
    return out;
  }

  private async metaHealth(graph: string, now: Date): Promise<MetaHealth> {
    const markers = await this.countOfType(graph, `${COGT}ReflectiveMarker`);
    // Impasses in the last 24h, by whichever timestamp the impasse carries.
    const res = await this.triplestore.query(`
      SELECT ?i ?t WHERE {
        GRAPH <${graph}> {
          ?i a <${COGT}Impasse> .
          OPTIONAL { ?i <${COGT}flaggedAt> ?fa . }
          OPTIONAL { ?i <${COGT}occurredAt> ?oa . }
          BIND(COALESCE(?fa, ?oa) AS ?t)
        }
      }`);
    const cutoff = now.getTime() - 24 * 3_600_000;
    let recent = 0;
    for (const b of res.bindings ?? []) {
      const t = b.t?.value;
      if (t && Date.parse(t) >= cutoff) recent++;
    }
    return { markerCount: markers, impassesLast24h: recent };
  }

  /**
   * Cycle latency over the most recent 100 cycles across every session graph.
   * `impasseRateLast100` is the fraction of those cycles that have a reflective
   * marker carrying a `cogt:flaggedImpasse`.
   */
  private async cycleHealth(metaGraph: string): Promise<CycleHealth> {
    const res = await this.triplestore.query(`
      SELECT ?c ?s ?e WHERE {
        GRAPH ?g {
          ?c a <${COGT}Cycle> ;
             <${COGT}startedAt> ?s ;
             <${COGT}endedAt>   ?e .
        }
      }`);
    const rows = (res.bindings ?? [])
      .map((b) => ({
        uri: b.c.value,
        started: Date.parse(b.s.value),
        durationMs: Date.parse(b.e.value) - Date.parse(b.s.value),
      }))
      .filter((r) => !Number.isNaN(r.started) && !Number.isNaN(r.durationMs))
      .sort((a, b) => b.started - a.started);

    const last = rows.slice(0, 100);
    if (last.length === 0) {
      return { meanLatencyMsLast100: 0, p95LatencyMsLast100: 0, impasseRateLast100: 0 };
    }

    const durations = last.map((r) => r.durationMs).sort((a, b) => a - b);
    const mean = Math.round(durations.reduce((s, d) => s + d, 0) / durations.length);
    // Nearest-rank percentile: the smallest value with ≥95% of samples at or
    // below it. For tiny samples this resolves toward the maximum.
    const p95Idx = Math.min(durations.length - 1, Math.ceil(0.95 * durations.length) - 1);
    const p95 = durations[Math.max(0, p95Idx)];

    const impasseCycles = await this.cyclesWithImpasse(metaGraph);
    const impasseHits = last.filter((r) => impasseCycles.has(r.uri)).length;

    return {
      lastCycleId: this.cycleIdFromUri(last[0].uri),
      meanLatencyMsLast100: mean,
      p95LatencyMsLast100: p95,
      impasseRateLast100: Number((impasseHits / last.length).toFixed(4)),
    };
  }

  private async cyclesWithImpasse(metaGraph: string): Promise<Set<string>> {
    const res = await this.triplestore.query(`
      SELECT ?c WHERE {
        GRAPH <${metaGraph}> {
          ?m a <${COGT}ReflectiveMarker> ;
             <${COGT}reflectsOn> ?c ;
             <${COGT}flaggedImpasse> ?fi .
        }
      }`);
    return new Set((res.bindings ?? []).map((b) => b.c.value));
  }

  /** `urn:<agent>:cog:cycle:<cycleId>` → `<cycleId>`. */
  private cycleIdFromUri(uri: string): string {
    const marker = ':cog:cycle:';
    const i = uri.indexOf(marker);
    return i >= 0 ? uri.slice(i + marker.length) : uri;
  }
}
