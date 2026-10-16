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

import { compareIso, type TriplestoreAdapter } from '@ontofelia/core';
import { GraphUriResolver } from '@ontofelia/semantic-memory';
import { CognitiveConfig } from './CognitiveConfig.js';

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
  /** Every cognitive flag (short key -> on/off). */
  flags: Record<string, boolean>;
}

/** Upper bound of the cycle window of the soak metrics. */
export const SOAK_MAX_CYCLES = 500;
/** Default size of that window. */
export const SOAK_DEFAULT_CYCLES = 100;
/** A graph family is counted up to this many triples; beyond it the count is a floor (`capped`). */
export const SOAK_TRIPLE_CAP = 100_000;
/** Graphs of a family are counted up to this many. */
export const SOAK_GRAPH_CAP = 10_000;

export interface FamilySize {
  /** Triples counted, at most {@link SOAK_TRIPLE_CAP}. */
  triples: number;
  /** Graphs in the family (only for families of many graphs), at most {@link SOAK_GRAPH_CAP}. */
  graphs?: number;
  /** True when a cap was hit: the numbers are a lower bound. */
  capped: boolean;
}

/**
 * Soak metrics for the staged rollout: numbers only, no user text, every read
 * bounded (COUNT over a LIMITed subquery, the cycle window ORDER BY .. LIMIT).
 */
export interface SoakMetrics {
  /** The window actually used (1..{@link SOAK_MAX_CYCLES}). */
  windowCycles: number;
  /** Persist timing of the newest turns of this process; empty after a restart. */
  persistLatencyMs: { samples: number; p50: number | null; p95: number | null };
  /** Triples per cognitive graph family. */
  graphSizes: Record<'episodic' | 'procedural' | 'meta' | 'goalsLongterm' | 'goalsSession' | 'cycles' | 'working', FamilySize>;
  /** Cycles seen in the window, and impasse-flagged ones per 100 of them (null with no cycles). */
  impasses: { cyclesInWindow: number; flaggedInWindow: number; per100Cycles: number | null };
  /** Mean full-dataset dumps per turn over the persist samples; null when the adapter keeps no counter or no turn ran. */
  dumpsPerTurn: number | null;
}

/** Nearest-rank percentile of an ascending array; null when empty. */
export function nearestRank(sortedAsc: number[], p: number): number | null {
  if (sortedAsc.length === 0) return null;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil(p * sortedAsc.length) - 1));
  return sortedAsc[idx];
}

const sparqlStr = (v: string) => `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const safeIri = (v: string) => /^[^<>"{}|^`\\\s]+$/.test(v);

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

    const [epi, proc, skillCount, seqCount, goals, metaH, cycle, flags] = await Promise.all([
      this.graphHealth(episodic),
      this.graphHealth(procedural),
      this.countOfType(procedural, `${COGT}Skill`),
      this.countOfType(procedural, `${COGT}SequenceSkill`),
      this.goalsHealth(goalsLong),
      this.metaHealth(meta, now),
      this.cycleHealth(meta),
      new CognitiveConfig(this.triplestore, this.agentId).allFlags(),
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
      flags,
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
      .sort(compareIso)
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

  /**
   * Soak metrics (see {@link SoakMetrics}). `persist` is the timing window of the
   * running process (`CycleManager.recentPersists`); everything else is read from
   * the store with bounded queries.
   */
  async soak(opts: { cycles?: number; persist?: Array<{ ms: number; dumps?: number }> } = {}): Promise<SoakMetrics> {
    const n = Number.isInteger(opts.cycles) ? Math.max(1, Math.min(opts.cycles as number, SOAK_MAX_CYCLES)) : SOAK_DEFAULT_CYCLES;
    const persist = (opts.persist ?? []).slice(-n);
    const ms = persist.map((x) => x.ms).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
    const dumped = persist.filter((x) => typeof x.dumps === 'number' && x.dumps >= 0).map((x) => x.dumps as number);

    const a = this.agentId;
    const longterm = GraphUriResolver.getCogGoalsLongtermGraph(a);
    const [episodic, procedural, meta, goalsLongterm, goalsSession, cycles, working, impasses] = await Promise.all([
      this.fixedSize(GraphUriResolver.getCogEpisodicGraph(a)),
      this.fixedSize(GraphUriResolver.getCogProceduralGraph(a)),
      this.fixedSize(GraphUriResolver.getCogMetaGraph(a)),
      this.fixedSize(longterm),
      this.familySize(GraphUriResolver.getCogGoalsSessionGraph(a, ''), longterm),
      this.familySize(GraphUriResolver.getCogCyclesGraph(a, '')),
      this.familySize(GraphUriResolver.getCogWorkingGraph(a, 'x', 'y').slice(0, -'x:y'.length)),
      this.impasseWindow(n),
    ]);

    return {
      windowCycles: n,
      persistLatencyMs: { samples: ms.length, p50: nearestRank(ms, 0.5), p95: nearestRank(ms, 0.95) },
      graphSizes: { episodic, procedural, meta, goalsLongterm, goalsSession, cycles, working },
      impasses,
      dumpsPerTurn: dumped.length === 0 ? null : Number((dumped.reduce((s, d) => s + d, 0) / dumped.length).toFixed(3)),
    };
  }

  /** Bounded triple count of one named graph. */
  private async fixedSize(graph: string): Promise<FamilySize> {
    const res = await this.triplestore.query(`
      SELECT (COUNT(*) AS ?c) WHERE {
        SELECT ?s WHERE { GRAPH <${graph}> { ?s ?p ?o } } LIMIT ${SOAK_TRIPLE_CAP + 1}
      }`);
    const c = Number(res.bindings?.[0]?.c?.value ?? 0);
    return { triples: Math.min(c, SOAK_TRIPLE_CAP), capped: c > SOAK_TRIPLE_CAP };
  }

  /** Bounded triple and graph count of every graph whose IRI starts with `prefix` (minus `except`). */
  private async familySize(prefix: string, except?: string): Promise<FamilySize> {
    const filter = `STRSTARTS(STR(?g), ${sparqlStr(prefix)})${except ? ` && ?g != <${except}>` : ''}`;
    const triples = await this.triplestore.query(`
      SELECT (COUNT(*) AS ?c) WHERE {
        SELECT ?s WHERE { GRAPH ?g { ?s ?p ?o } FILTER(${filter}) } LIMIT ${SOAK_TRIPLE_CAP + 1}
      }`);
    const graphs = await this.triplestore.query(`
      SELECT (COUNT(*) AS ?c) WHERE {
        SELECT DISTINCT ?g WHERE { GRAPH ?g { ?s ?p ?o } FILTER(${filter}) } LIMIT ${SOAK_GRAPH_CAP + 1}
      }`);
    const t = Number(triples.bindings?.[0]?.c?.value ?? 0);
    const g = Number(graphs.bindings?.[0]?.c?.value ?? 0);
    return {
      triples: Math.min(t, SOAK_TRIPLE_CAP),
      graphs: Math.min(g, SOAK_GRAPH_CAP),
      capped: t > SOAK_TRIPLE_CAP || g > SOAK_GRAPH_CAP,
    };
  }

  /** Impasse-flagged cycles among the newest `n` cycles of any session. */
  private async impasseWindow(n: number): Promise<SoakMetrics['impasses']> {
    const res = await this.triplestore.query(`
      SELECT ?c ?s WHERE {
        GRAPH ?g { ?c a <${COGT}Cycle> ; <${COGT}startedAt> ?s }
      } ORDER BY DESC(?s) LIMIT ${n}`);
    const rows = (res.bindings ?? [])
      .map((b) => ({ uri: b.c.value, started: b.s.value }))
      .filter((r) => safeIri(r.uri))
      .sort((x, y) => compareIso(y.started, x.started))
      .slice(0, n);
    if (rows.length === 0) return { cyclesInWindow: 0, flaggedInWindow: 0, per100Cycles: null };
    const meta = GraphUriResolver.getCogMetaGraph(this.agentId);
    const flagged = await this.triplestore.query(`
      SELECT DISTINCT ?c WHERE {
        GRAPH <${meta}> {
          ?m a <${COGT}ReflectiveMarker> ; <${COGT}reflectsOn> ?c ; <${COGT}flaggedImpasse> ?fi .
          VALUES ?c { ${rows.map((r) => `<${r.uri}>`).join(' ')} }
        }
      }`);
    const hit = new Set((flagged.bindings ?? []).map((b) => b.c.value));
    const count = rows.filter((r) => hit.has(r.uri)).length;
    return {
      cyclesInWindow: rows.length,
      flaggedInWindow: count,
      per100Cycles: Number(((count / rows.length) * 100).toFixed(2)),
    };
  }
}
