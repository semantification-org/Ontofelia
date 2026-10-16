/**
 * ProceduralMemory — procedural long-term memory over the
 * `urn:<agent>:cog:procedural` graph
 * (docs/cognitive-architecture/06-procedural-memory.md).
 *
 * Three layers live here:
 *  - **Skill traces** (`cogt:SkillTrace`): one raw record per tool call,
 *    written regardless of outcome. Redacted: `toolArgsBrief` is keys-only and
 *    `toolArgsHash` is computed after secret-masking, so no credential reaches
 *    this long-lived store.
 *  - **Skill summaries** (`cogt:Skill`): aggregated stats per
 *    (toolName, forGoalType), produced by {@link consolidate}.
 *  - **Sequence skills** (`cogt:SequenceSkill`): learned ordered tool
 *    sequences, minted conservatively (a pattern must recur ≥ K cycles).
 *
 * Implementation mirrors {@link EpisodicMemory}: writes are typed SPARQL
 * `INSERT DATA` so literal datatypes survive, and all ranking/counting is done
 * in TypeScript because the embedded Oxigraph WASM build cannot evaluate
 * aggregates.
 */

import { compareIso, compareIsoDesc, type TriplestoreAdapter } from '@ontofelia/core';
import { GraphUriResolver } from '../utils/GraphUriResolver.js';
import type { GraphRegistry } from '../utils/GraphRegistry.js';
import { escapeSparqlStringContent } from '../utils/SparqlSyntax.js';

const COGT = 'urn:shared:ontology#cog/';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const XSD = 'http://www.w3.org/2001/XMLSchema#';

export type TraceId = string;
export type SkillUri = string;

export type Outcome = 'success' | 'error' | 'partial';

export interface TraceInput {
  toolName: string;
  toolArgsHash: string;
  /** Human-readable, already redacted (keys-only or masked). Never raw secrets. */
  toolArgsBrief: string;
  executedAt: Date;
  durationMs: number;
  outcome: Outcome;
  errorClass?: string;
  /** Goal URI this call served. */
  forGoal?: string;
  /** GoalType URI. */
  forGoalType?: string;
  cycleId?: string;
  sessionId?: string;
  sequencePos: number;
  /** Unknown until cycle end; may be back-filled later. */
  sequenceLen?: number;
  previousTrace?: string;
  /**
   * Whether the LLM picked a suggested tool; null (or absent) when no
   * suggestion was shown to it this turn.
   */
  proceduralAdherence?: boolean | null;
  /** The cognitive user key of the turn's sender. */
  forUser?: string;
  /**
   * Arguments the caller masked: a (sanitised) path and a digest of the raw
   * value (HMAC-SHA256 under the instance's key). The value itself never reaches
   * this class; only the digest is stored, so two calls can be compared for
   * equality without keeping the value.
   */
  maskedArgs?: MaskedArgHash[];
}

/**
 * One masked tool argument: where it was and the digest (hex) of its value. The
 * scheme names how the digest was made and is part of the stored text
 * (`<path>=<scheme>:<hex>`); two digests compare only within one scheme. An
 * absent scheme means the unkeyed `sha256` of older callers.
 */
export interface MaskedArgHash {
  path: string;
  digest: string;
  scheme?: 'hmac-sha256' | 'sha256';
}

/** One cycle's summary of whether the LLM used the suggestions shown to it. */
export interface AdherenceSummaryInput {
  cycleId: string;
  sessionId?: string;
  forUser: string;
  executedAt: Date;
  /** Distinct tools named by the suggestions that were shown. */
  suggestedTools: number;
  /** Traced calls of the cycle (every one carries its own adherence flag). */
  tracedCalls: number;
  /** Traced calls whose tool was one of the suggested tools. */
  adheredCalls: number;
}

/** Weight of the follow-up satisfaction signal (a weak, indirect cue). */
export const FOLLOWUP_SATISFACTION_WEIGHT = 0.3;

/**
 * Most recent durations kept per skill; the cumulative p95 is the exact
 * nearest-rank p95 of this bounded window (not of all history).
 */
export const DURATION_WINDOW = 200;

/** Suggestion filter defaults used by the cycle manager (see suggestSkills). */
export const SUGGESTION_MIN_SUCCESS_RATE = 0.7;
export const SUGGESTION_MIN_SAMPLES = 3;

/** A follow-up older than this no longer counts as a reaction to the turn. */
export const FOLLOWUP_MAX_GAP_MS = 6 * 3_600_000;

/** Procedural traces live this long. Skill aggregates are kept. */
export const TRACE_RETENTION_DAYS = 90;

export interface TraceHit {
  uri: TraceId;
  traceId: string;
  toolName: string;
  toolArgsHash?: string;
  toolArgsBrief?: string;
  executedAt: string;
  durationMs?: number;
  outcome?: Outcome;
  errorClass?: string;
  forGoal?: string;
  forGoalType?: string;
  cycleId?: string;
  sessionId?: string;
  sequencePos?: number;
  userSatisfied?: boolean;
  /** Weight of `userSatisfied`; absent on signals written before weights existed. */
  satisfactionWeight?: number;
  forUser?: string;
}

export interface SkillSuggestion {
  skillUri: SkillUri;
  toolName: string;
  forGoalType?: string;
  successRate: number;
  satisfactionRate: number;
  meanDurationMs: number;
  /** p95 over the bounded window of the latest {@link DURATION_WINDOW} calls. */
  p95DurationMs?: number;
  successCount: number;
  /** Successes + failures + partials seen by the aggregate. */
  sampleCount?: number;
  typicalArgPattern?: string;
  /** satRate * successRate — the surfacing score (doc 06 §4). */
  score: number;
}

export interface SequenceSkillSuggestion {
  seqUri: string;
  label: string;
  forGoalType?: string;
  steps: { stepIndex: number; toolName: string; notes?: string }[];
  successCount: number;
  successRate: number;
  satisfactionRate: number;
}

interface SkillRow extends SkillSuggestion {
  failureCount: number;
  partialCount: number;
  lastUsedAt?: string;
  /** Cumulative weighted satisfied / dissatisfied counts; absent on older rows. */
  satisfiedWeight?: number;
  dissatisfiedWeight?: number;
  /** Latest durations, oldest first. */
  durationWindow?: number[];
}

export interface SuggestOptions {
  /** Keep only skills whose successRate is at least this. */
  minSuccessRate?: number;
  /** Keep only skills with at least this many recorded calls. */
  minSamples?: number;
  /**
   * Keep only skills and sequences recorded without a goal type (the turns of
   * an agent whose goal stack was off). Used with an empty goal type.
   */
  untyped?: boolean;
}

export interface TraceRetentionReport {
  cutoff: string;
  tracesDropped: number;
  summariesDropped: number;
}

export interface ConsolidationReport {
  since: string;
  until: string;
  tracesScanned: number;
  skillsUpserted: number;
  sequenceSkillsCreated: number;
  sequenceSkillsReinforced: number;
}

function escapeLiteral(s: string): string {
  return escapeSparqlStringContent(s);
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/^.*[#/:]/, '') // keep the local part of an IRI
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'x';
}

function clampRate(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/** Generalise a redacted arg brief into a pattern (numbers/UUIDs/path-leaves → {*}). */
function generalisePattern(brief: string): string {
  return brief
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '{*}')
    .replace(/\/[^\s/]+(?=\s|$)/g, '/{*}')
    .replace(/\b\d+\b/g, '{*}');
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** A masked-arg path reduced to a safe, short identifier (no value can hide in it). */
function safePath(path: string): string {
  return path.replace(/[^A-Za-z0-9_.[\]-]/g, '_').slice(0, 64) || 'arg';
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

/**
 * Traces newer than this are left for the next incremental consolidation: a
 * cycle's traces are persisted after the reply, so a trace whose tool started
 * just before a run may not be written yet. Holding the window's upper edge back
 * keeps the watermark from stepping over it.
 */
export const CONSOLIDATION_LAG_MS = 120_000;

/** Window used by the first incremental run, when no watermark exists yet. */
export const DEFAULT_FIRST_WINDOW_MS = 24 * 3_600_000;

export interface IncrementalOptions {
  /** Upper edge of the window; defaults to now minus {@link CONSOLIDATION_LAG_MS}. */
  until?: Date;
  /** Look-back of the very first run (no watermark yet); default 24 h. */
  firstWindowMs?: number;
}

export class ProceduralMemory {
  constructor(
    private readonly triplestore: TriplestoreAdapter,
    private readonly agentId: string,
    /**
     * Needed only for the watermark: its write goes through
     * {@link GraphRegistry.assertWritable}. Without it, incremental consolidation
     * is unavailable and the plain `consolidate(window)` is unaffected.
     */
    private readonly registry?: GraphRegistry,
  ) {}

  /** Subject of the consolidation state in the agent's setup graph. */
  private stateSubject(): string {
    return `urn:${this.agentId}:setup:cognitive-procedural`;
  }

  /** The `lastConsolidatedAt` watermark, or undefined before the first run. */
  async getWatermark(): Promise<Date | undefined> {
    const graph = GraphUriResolver.getSetupGraph(this.agentId);
    const res = await this.triplestore.query(`
      SELECT ?v WHERE {
        GRAPH <${graph}> { <${this.stateSubject()}> <${COGT}lastConsolidatedAt> ?v }
      } LIMIT 1`);
    const v = res.bindings?.[0]?.v?.value;
    if (!v) return undefined;
    const t = Date.parse(v);
    return Number.isNaN(t) ? undefined : new Date(t);
  }

  private async setWatermark(at: Date): Promise<void> {
    const graph = GraphUriResolver.getSetupGraph(this.agentId);
    this.registry?.assertWritable(graph);
    const subject = this.stateSubject();
    await this.triplestore.update(`
      DELETE { GRAPH <${graph}> { <${subject}> <${COGT}lastConsolidatedAt> ?old } }
      WHERE  { GRAPH <${graph}> { <${subject}> <${COGT}lastConsolidatedAt> ?old } }`);
    await this.triplestore.update(`
      INSERT DATA { GRAPH <${graph}> {
        <${subject}> <${COGT}lastConsolidatedAt> "${at.toISOString()}"^^<${XSD}dateTime> .
      } }`);
  }

  /**
   * Idempotent consolidation: aggregate only the traces after the stored
   * `lastConsolidatedAt` watermark (exclusive) up to `until` (inclusive), then
   * advance the watermark to `until`. Running it again over the same period finds
   * nothing new, so counts are never added twice. The first run (no watermark)
   * looks back `firstWindowMs`, as the old fixed window did. The watermark never
   * moves backwards, and only moves after a successful consolidation.
   */
  async consolidateIncremental(opts: IncrementalOptions = {}): Promise<ConsolidationReport> {
    if (!this.registry) {
      throw new Error('ProceduralMemory.consolidateIncremental needs a GraphRegistry');
    }
    const until = opts.until ?? new Date(Date.now() - CONSOLIDATION_LAG_MS);
    const mark = await this.getWatermark();
    const since = mark ?? new Date(until.getTime() - (opts.firstWindowMs ?? DEFAULT_FIRST_WINDOW_MS));
    if (mark && until.getTime() <= mark.getTime()) {
      return {
        since: mark.toISOString(),
        until: until.toISOString(),
        tracesScanned: 0,
        skillsUpserted: 0,
        sequenceSkillsCreated: 0,
        sequenceSkillsReinforced: 0,
      };
    }
    const report = await this.consolidate({ since, until }, { sinceExclusive: mark !== undefined });
    await this.setWatermark(until);
    return report;
  }

  graphUri(): string {
    return GraphUriResolver.getCogProceduralGraph(this.agentId);
  }

  private skillUri(toolName: string, forGoalType?: string): SkillUri {
    return `urn:${this.agentId}:cog:skill:${slug(toolName)}:${slug(forGoalType ?? 'any')}`;
  }

  private seqUri(forGoalType: string | undefined, sig: string): string {
    return `urn:${this.agentId}:cog:seqskill:${slug(forGoalType ?? 'any')}:${slug(sig)}`;
  }

  private newTraceUri(executedAt: Date): { uri: string; traceId: string } {
    const rand =
      typeof globalThis.crypto?.randomUUID === 'function'
        ? globalThis.crypto.randomUUID().slice(0, 8)
        : Math.random().toString(16).slice(2, 10);
    const traceId = `tr_${executedAt.toISOString().replace(/[:.]/g, '-')}_${rand}`;
    return { uri: `urn:${this.agentId}:cog:trace:${rand}`, traceId };
  }

  /** Append one skill trace. Returns the trace IRI. */
  async recordTrace(t: TraceInput): Promise<TraceId> {
    const graph = this.graphUri();
    const { uri, lines } = this.traceLines(t);
    await this.triplestore.update(`INSERT DATA { GRAPH <${graph}> {\n${lines.join('\n')}\n} }`);
    return uri;
  }

  /**
   * Append the skill traces of one cycle (and, when given, its adherence summary)
   * in ONE update. The traces are chained exactly as writing them one by one
   * with `previousTrace` set to the IRI the earlier call returned: each trace
   * after the first links to its predecessor in the batch (an explicit
   * `previousTrace` on the input wins). Returns the trace IRIs in order.
   */
  async recordTraces(traces: TraceInput[], summary?: AdherenceSummaryInput): Promise<TraceId[]> {
    const graph = this.graphUri();
    const uris: TraceId[] = [];
    const lines: string[] = [];
    for (const t of traces) {
      const prev = uris[uris.length - 1];
      const built = this.traceLines(t.previousTrace === undefined && prev ? { ...t, previousTrace: prev } : t);
      uris.push(built.uri);
      lines.push(...built.lines);
    }
    if (summary) lines.push(...this.adherenceLines(summary).lines);
    if (lines.length === 0) return uris;
    await this.triplestore.update(`INSERT DATA { GRAPH <${graph}> {\n${lines.join('\n')}\n} }`);
    return uris;
  }

  private traceLines(t: TraceInput): { uri: TraceId; lines: string[] } {
    const { uri, traceId } = this.newTraceUri(t.executedAt);
    const lines: string[] = [
      `<${uri}> <${RDF_TYPE}> <${COGT}SkillTrace> .`,
      `<${uri}> <${COGT}traceId> "${escapeLiteral(traceId)}" .`,
      `<${uri}> <${COGT}toolName> "${escapeLiteral(t.toolName)}" .`,
      `<${uri}> <${COGT}toolArgsHash> "${escapeLiteral(t.toolArgsHash)}" .`,
      `<${uri}> <${COGT}toolArgsBrief> "${escapeLiteral(t.toolArgsBrief)}" .`,
      `<${uri}> <${COGT}executedAt> "${t.executedAt.toISOString()}"^^<${XSD}dateTime> .`,
      `<${uri}> <${COGT}durationMs> "${Math.trunc(t.durationMs)}"^^<${XSD}integer> .`,
      `<${uri}> <${COGT}outcome> "${escapeLiteral(t.outcome)}" .`,
      `<${uri}> <${COGT}sequencePos> "${Math.trunc(t.sequencePos)}"^^<${XSD}integer> .`,
      `<${uri}> <${COGT}agentId> "${escapeLiteral(this.agentId)}" .`,
    ];
    if (t.errorClass) lines.push(`<${uri}> <${COGT}errorClass> "${escapeLiteral(t.errorClass)}" .`);
    if (t.forGoal) lines.push(`<${uri}> <${COGT}forGoal> <${t.forGoal}> .`);
    if (t.forGoalType)
      lines.push(`<${uri}> <${COGT}forGoalType> "${escapeLiteral(t.forGoalType)}" .`);
    if (t.cycleId) lines.push(`<${uri}> <${COGT}cycleId> "${escapeLiteral(t.cycleId)}" .`);
    if (t.sessionId) lines.push(`<${uri}> <${COGT}sessionId> "${escapeLiteral(t.sessionId)}" .`);
    if (t.sequenceLen !== undefined)
      lines.push(`<${uri}> <${COGT}sequenceLen> "${Math.trunc(t.sequenceLen)}"^^<${XSD}integer> .`);
    if (t.previousTrace) lines.push(`<${uri}> <${COGT}previousTrace> <${t.previousTrace}> .`);
    if (t.proceduralAdherence !== undefined && t.proceduralAdherence !== null)
      lines.push(
        `<${uri}> <${COGT}proceduralAdherence> "${t.proceduralAdherence}"^^<${XSD}boolean> .`,
      );
    if (t.forUser) lines.push(`<${uri}> <${COGT}forUser> "${escapeLiteral(t.forUser)}" .`);
    for (const m of (t.maskedArgs ?? []).slice(0, 20)) {
      if (!SHA256_HEX.test(m.digest)) continue; // only a real digest is stored
      const scheme = m.scheme === 'hmac-sha256' ? 'hmac-sha256' : 'sha256';
      lines.push(
        `<${uri}> <${COGT}maskedArg> "${escapeLiteral(`${safePath(m.path)}=${scheme}:${m.digest}`)}" .`,
      );
    }
    return { uri, lines };
  }

  /**
   * Back-fill the weak `userSatisfied` signal on a trace (doc 06 §3). `null`
   * clears it (ambiguous feedback); `true`/`false` set it. `weight` (0..1) is
   * how much the signal counts in the skill aggregate; without it the signal
   * counts as before (satisfied = 1, dissatisfied = 0).
   */
  async backfillSatisfaction(
    traceUri: TraceId,
    satisfied: boolean | null,
    weight?: number,
  ): Promise<void> {
    const graph = this.graphUri();
    // One update, three operations in the order the three separate updates ran.
    const ops = [
      `DELETE { GRAPH <${graph}> { <${traceUri}> <${COGT}userSatisfied> ?old } }
      WHERE  { GRAPH <${graph}> { <${traceUri}> <${COGT}userSatisfied> ?old } }`,
      `DELETE { GRAPH <${graph}> { <${traceUri}> <${COGT}satisfactionWeight> ?old } }
      WHERE  { GRAPH <${graph}> { <${traceUri}> <${COGT}satisfactionWeight> ?old } }`,
    ];
    if (satisfied !== null) {
      const lines = [`<${traceUri}> <${COGT}userSatisfied> "${satisfied}"^^<${XSD}boolean> .`];
      if (weight !== undefined && Number.isFinite(weight)) {
        lines.push(
          `<${traceUri}> <${COGT}satisfactionWeight> "${clampRate(weight).toFixed(4)}"^^<${XSD}decimal> .`,
        );
      }
      ops.push(`INSERT DATA { GRAPH <${graph}> {\n${lines.join('\n')}\n} }`);
    }
    await this.triplestore.update(ops.join(' ;\n'));
  }

  /**
   * One record per cycle that showed suggestions: how many of its traced calls
   * used a suggested tool. Written only when suggestions were shown.
   */
  async recordAdherenceSummary(a: AdherenceSummaryInput): Promise<string> {
    const graph = this.graphUri();
    const { uri, lines } = this.adherenceLines(a);
    await this.triplestore.update(`INSERT DATA { GRAPH <${graph}> {\n${lines.join('\n')}\n} }`);
    return uri;
  }

  private adherenceLines(a: AdherenceSummaryInput): { uri: string; lines: string[] } {
    const uri = `urn:${this.agentId}:cog:adherence:${slug(a.cycleId)}`;
    const rate = a.tracedCalls === 0 ? 0 : clampRate(a.adheredCalls / a.tracedCalls);
    const lines = [
      `<${uri}> <${RDF_TYPE}> <${COGT}AdherenceSummary> .`,
      `<${uri}> <${COGT}cycleId> "${escapeLiteral(a.cycleId)}" .`,
      `<${uri}> <${COGT}forUser> "${escapeLiteral(a.forUser)}" .`,
      `<${uri}> <${COGT}executedAt> "${a.executedAt.toISOString()}"^^<${XSD}dateTime> .`,
      `<${uri}> <${COGT}suggestedTools> "${Math.trunc(a.suggestedTools)}"^^<${XSD}integer> .`,
      `<${uri}> <${COGT}tracedCalls> "${Math.trunc(a.tracedCalls)}"^^<${XSD}integer> .`,
      `<${uri}> <${COGT}adheredCalls> "${Math.trunc(a.adheredCalls)}"^^<${XSD}integer> .`,
      `<${uri}> <${COGT}adherenceRate> "${rate.toFixed(4)}"^^<${XSD}decimal> .`,
      `<${uri}> <${COGT}agentId> "${escapeLiteral(this.agentId)}" .`,
    ];
    if (a.sessionId) lines.push(`<${uri}> <${COGT}sessionId> "${escapeLiteral(a.sessionId)}" .`);
    return { uri, lines };
  }

  /**
   * Delete the procedural traces (and adherence summaries) whose `executedAt`
   * is older than `retentionDays` before `now`, at most `limit` records per
   * call. Skill and sequence-skill aggregates are never touched, except that
   * their ring-buffer link to a deleted trace is dropped. Safe to run daily.
   */
  async purgeOldTraces(
    now: Date = new Date(),
    retentionDays = TRACE_RETENTION_DAYS,
    limit = 5000,
  ): Promise<TraceRetentionReport> {
    const graph = this.graphUri();
    this.registry?.assertWritable(graph);
    const cutoff = new Date(now.getTime() - retentionDays * 86_400_000);
    const report: TraceRetentionReport = {
      cutoff: cutoff.toISOString(),
      tracesDropped: 0,
      summariesDropped: 0,
    };
    // The typed comparison is done by the store (instants, not strings); the
    // instant check below is a second guard before anything is deleted.
    const res = await this.triplestore.query(`
      SELECT ?t ?type ?when WHERE {
        GRAPH <${graph}> {
          ?t a ?type ; <${COGT}executedAt> ?when .
          FILTER(?type IN (<${COGT}SkillTrace>, <${COGT}AdherenceSummary>))
          FILTER(?when < "${cutoff.toISOString()}"^^<${XSD}dateTime>)
        }
      } LIMIT ${Math.max(1, Math.trunc(limit))}`);
    const cutoffIso = cutoff.toISOString();
    const doomed: { uri: string; trace: boolean }[] = [];
    for (const r of res.bindings ?? []) {
      if (compareIso(r.when.value, cutoffIso) >= 0) continue;
      doomed.push({ uri: r.t.value, trace: r.type.value === `${COGT}SkillTrace` });
    }
    for (let i = 0; i < doomed.length; i += 50) {
      const batch = doomed.slice(i, i + 50);
      const values = batch.map((d) => `<${d.uri}>`).join(' ');
      await this.triplestore.update(`
        DELETE { GRAPH <${graph}> { ?s <${COGT}hasTrace> ?t } }
        WHERE  { GRAPH <${graph}> { ?s <${COGT}hasTrace> ?t } VALUES ?t { ${values} } }`);
      await this.triplestore.update(`
        DELETE { GRAPH <${graph}> { ?t ?p ?o } }
        WHERE  { GRAPH <${graph}> { ?t ?p ?o } VALUES ?t { ${values} } }`);
    }
    report.tracesDropped = doomed.filter((d) => d.trace).length;
    report.summariesDropped = doomed.length - report.tracesDropped;
    return report;
  }

  /**
   * Trace IRIs of the most recent cycle in `sessionId` other than
   * `excludeCycleId` (doc 06 §3 — the cycle a fresh inbound message is reacting
   * to). Returns `[]` when there is no prior cycle. Used by Phase 1 to back-fill
   * the weak `userSatisfied` signal one cycle late.
   *
   * With `opts.forUser` only that user's traces are considered (a trace without
   * a `forUser` is never matched); `onlyUnjudged` drops traces that already
   * carry a follow-up signal, so only the *next* message judges a turn; and
   * `maxGapMs` returns `[]` when the prior cycle is older than that.
   * The read is bounded to the 5000 newest matching traces.
   */
  async findPriorCycleTraceUris(
    sessionId: string,
    excludeCycleId: string,
    opts: { forUser?: string; onlyUnjudged?: boolean; maxGapMs?: number; now?: Date } = {},
  ): Promise<string[]> {
    const graph = this.graphUri();
    const res = await this.triplestore.query(`
      SELECT ?t ?cycleId ?when ?user ?weight WHERE {
        GRAPH <${graph}> {
          ?t a <${COGT}SkillTrace> ;
             <${COGT}sessionId>  "${escapeLiteral(sessionId)}" ;
             <${COGT}cycleId>    ?cycleId ;
             <${COGT}executedAt> ?when .
          OPTIONAL { ?t <${COGT}forUser> ?user . }
          OPTIONAL { ?t <${COGT}satisfactionWeight> ?weight . }
        }
      } ORDER BY DESC(?when) LIMIT 5000`);
    let bestCycle: string | undefined;
    let bestWhen: string | undefined;
    const byCycle = new Map<string, { uri: string; judged: boolean }[]>();
    for (const r of res.bindings ?? []) {
      const cyc = r.cycleId.value;
      if (cyc === excludeCycleId) continue;
      if (opts.forUser !== undefined && r.user?.value !== opts.forUser) continue;
      const arr = byCycle.get(cyc) ?? [];
      arr.push({ uri: r.t.value, judged: r.weight !== undefined });
      byCycle.set(cyc, arr);
      if (bestWhen === undefined || compareIso(r.when.value, bestWhen) > 0) {
        bestWhen = r.when.value;
        bestCycle = cyc;
      }
    }
    if (!bestCycle || bestWhen === undefined) return [];
    if (opts.maxGapMs !== undefined) {
      const now = (opts.now ?? new Date()).getTime();
      if (now - Date.parse(bestWhen) > opts.maxGapMs) return [];
    }
    const rows = byCycle.get(bestCycle) ?? [];
    return rows.filter((x) => !opts.onlyUnjudged || !x.judged).map((x) => x.uri);
  }

  /**
   * Top-K skills for a goal type, ranked by `satisfactionRate * successRate`
   * (doc 06 §4). Returns `[]` when none exist; never throws.
   */
  async suggestSkills(
    forGoalType: string,
    k = 5,
    opts: SuggestOptions = {},
  ): Promise<SkillSuggestion[]> {
    const eps = 1e-9;
    const skills = (await this.readSkills(forGoalType)).filter(
      (s) =>
        (opts.untyped !== true || s.forGoalType === undefined) &&
        (opts.minSuccessRate === undefined || s.successRate >= opts.minSuccessRate - eps) &&
        (opts.minSamples === undefined || (s.sampleCount ?? s.successCount) >= opts.minSamples),
    );
    const scored = skills.map((s) => ({ ...s, score: s.satisfactionRate * s.successRate }));
    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return b.successCount - a.successCount;
    });
    return scored.slice(0, Math.max(0, k));
  }

  /** Top-K learned sequence skills for a goal type, ranked by successRate. */
  async suggestSequenceSkills(
    forGoalType: string,
    k = 3,
    opts: Pick<SuggestOptions, 'minSuccessRate' | 'untyped'> = {},
  ): Promise<SequenceSkillSuggestion[]> {
    const seqs = (await this.readSequenceSkills(forGoalType)).filter(
      (q) =>
        (opts.untyped !== true || q.forGoalType === undefined) &&
        (opts.minSuccessRate === undefined || q.successRate >= opts.minSuccessRate - 1e-9),
    );
    seqs.sort((a, b) => {
      if (b.successRate !== a.successRate) return b.successRate - a.successRate;
      return b.successCount - a.successCount;
    });
    return seqs.slice(0, Math.max(0, k));
  }

  /**
   * Aggregate the traces in `[since, until]` into Skill summaries and detect
   * recurring tool sequences (doc 06 §5). Not idempotent by itself: re-running
   * over the same window double-counts. Scheduled and triggered runs use
   * {@link consolidateIncremental}, which derives the window from a watermark.
   */
  async consolidate(
    window: { since: Date; until: Date },
    opts: { sinceExclusive?: boolean } = {},
  ): Promise<ConsolidationReport> {
    const traces = await this.readTraces(window, opts.sinceExclusive === true);
    const report: ConsolidationReport = {
      since: window.since.toISOString(),
      until: window.until.toISOString(),
      tracesScanned: traces.length,
      skillsUpserted: 0,
      sequenceSkillsCreated: 0,
      sequenceSkillsReinforced: 0,
    };
    if (traces.length === 0) return report;

    // --- Skill summaries, grouped by (toolName, forGoalType). ---
    const groups = new Map<string, TraceHit[]>();
    for (const tr of traces) {
      const key = `${tr.toolName} ${tr.forGoalType ?? ''}`;
      const arr = groups.get(key) ?? [];
      arr.push(tr);
      groups.set(key, arr);
    }
    for (const [, rows] of groups) {
      await this.upsertSkill(rows);
      report.skillsUpserted++;
    }

    // --- Sequence detection (conservative). ---
    const seq = await this.detectSequences(traces);
    report.sequenceSkillsCreated = seq.created;
    report.sequenceSkillsReinforced = seq.reinforced;
    return report;
  }

  // ---------------------------------------------------------------------------
  // Skill upsert
  // ---------------------------------------------------------------------------

  private async upsertSkill(rows: TraceHit[]): Promise<void> {
    const graph = this.graphUri();
    const toolName = rows[0].toolName;
    const forGoalType = rows[0].forGoalType;
    const uri = this.skillUri(toolName, forGoalType);
    const prev = await this.readOneSkill(uri);

    const newSuccess = rows.filter((r) => r.outcome === 'success').length;
    const newFailure = rows.filter((r) => r.outcome === 'error').length;
    const newPartial = rows.filter((r) => r.outcome === 'partial').length;
    // Weighted follow-up signal. A trace judged before weights existed counts 1
    // when satisfied and 0 when dissatisfied (the earlier arithmetic).
    let newSatW = 0;
    let newDisW = 0;
    for (const r of rows) {
      if (r.userSatisfied === true) newSatW += r.satisfactionWeight ?? 1;
      else if (r.userSatisfied === false) newDisW += r.satisfactionWeight ?? 0;
    }

    const successCount = (prev?.successCount ?? 0) + newSuccess;
    const failureCount = (prev?.failureCount ?? 0) + newFailure;
    const partialCount = (prev?.partialCount ?? 0) + newPartial;
    const total = successCount + failureCount + partialCount;

    // Running mean over previous total and the new window's durations.
    const prevTotal =
      (prev?.successCount ?? 0) + (prev?.failureCount ?? 0) + (prev?.partialCount ?? 0);
    const newDurations = rows.map((r) => r.durationMs ?? 0);
    const newSum = newDurations.reduce((a, b) => a + b, 0);
    const meanDurationMs =
      total === 0 ? 0 : ((prev?.meanDurationMs ?? 0) * prevTotal + newSum) / total;
    // Cumulative p95: exact nearest-rank p95 of a bounded window holding the
    // latest DURATION_WINDOW measured durations (partials were never measured).
    const measured = rows
      .filter((r) => r.outcome !== 'partial')
      .slice()
      .sort((a, b) => compareIso(a.executedAt, b.executedAt))
      .map((r) => Math.max(0, Math.trunc(r.durationMs ?? 0)));
    const durationWindow = [...(prev?.durationWindow ?? []), ...measured].slice(-DURATION_WINDOW);
    const p95DurationMs = percentile([...durationWindow].sort((a, b) => a - b), 0.95);

    const successRate = total === 0 ? 0 : successCount / total;
    // Cumulative weighted counts; rows from before the weights are rebuilt
    // from their rate. Dissatisfaction offsets satisfaction, never below zero.
    const prevSatW =
      prev?.satisfiedWeight ?? Math.round((prev?.satisfactionRate ?? 0) * (prev?.successCount ?? 0));
    const satisfiedWeight = prevSatW + newSatW;
    const dissatisfiedWeight = (prev?.dissatisfiedWeight ?? 0) + newDisW;
    const satisfactionRate =
      successCount === 0 ? 0 : clampRate((satisfiedWeight - dissatisfiedWeight) / successCount);

    const lastTrace = rows.reduce((a, b) => (compareIso(a.executedAt, b.executedAt) > 0 ? a : b));
    const lastUsedAt =
      !prev?.lastUsedAt || compareIso(lastTrace.executedAt, prev.lastUsedAt) > 0
        ? lastTrace.executedAt
        : prev.lastUsedAt;

    // Most common generalised arg brief in this window.
    const patternCounts = new Map<string, number>();
    for (const r of rows) {
      const p = generalisePattern(r.toolArgsBrief ?? '');
      patternCounts.set(p, (patternCounts.get(p) ?? 0) + 1);
    }
    let typicalArgPattern = '';
    let best = -1;
    for (const [p, c] of patternCounts) if (c > best) { best = c; typicalArgPattern = p; }

    // Ring buffer of the last 10 trace links.
    const keepTraces = rows
      .slice()
      .sort((a, b) => compareIsoDesc(a.executedAt, b.executedAt))
      .slice(0, 10);

    // Replace the whole skill row, then re-insert.
    await this.triplestore.update(`
      DELETE { GRAPH <${graph}> { <${uri}> ?p ?o } }
      WHERE  { GRAPH <${graph}> { <${uri}> ?p ?o } }`);

    const lines: string[] = [
      `<${uri}> <${RDF_TYPE}> <${COGT}Skill> .`,
      `<${uri}> <${COGT}toolName> "${escapeLiteral(toolName)}" .`,
      `<${uri}> <${COGT}successCount> "${successCount}"^^<${XSD}integer> .`,
      `<${uri}> <${COGT}failureCount> "${failureCount}"^^<${XSD}integer> .`,
      `<${uri}> <${COGT}partialCount> "${partialCount}"^^<${XSD}integer> .`,
      `<${uri}> <${COGT}meanDurationMs> "${meanDurationMs.toFixed(3)}"^^<${XSD}decimal> .`,
      `<${uri}> <${COGT}p95DurationMs> "${p95DurationMs.toFixed(3)}"^^<${XSD}decimal> .`,
      `<${uri}> <${COGT}successRate> "${successRate.toFixed(4)}"^^<${XSD}decimal> .`,
      `<${uri}> <${COGT}satisfactionRate> "${satisfactionRate.toFixed(4)}"^^<${XSD}decimal> .`,
      `<${uri}> <${COGT}lastUsedAt> "${lastUsedAt}"^^<${XSD}dateTime> .`,
      `<${uri}> <${COGT}agentId> "${escapeLiteral(this.agentId)}" .`,
      `<${uri}> <${COGT}satisfiedWeight> "${satisfiedWeight.toFixed(4)}"^^<${XSD}decimal> .`,
      `<${uri}> <${COGT}dissatisfiedWeight> "${dissatisfiedWeight.toFixed(4)}"^^<${XSD}decimal> .`,
      `<${uri}> <${COGT}durationWindow> "${durationWindow.join(',')}" .`,
    ];
    if (forGoalType) lines.push(`<${uri}> <${COGT}forGoalType> "${escapeLiteral(forGoalType)}" .`);
    if (typicalArgPattern)
      lines.push(`<${uri}> <${COGT}typicalArgPattern> "${escapeLiteral(typicalArgPattern)}" .`);
    for (const tr of keepTraces) lines.push(`<${uri}> <${COGT}hasTrace> <${tr.uri}> .`);

    await this.triplestore.update(`INSERT DATA { GRAPH <${graph}> {\n${lines.join('\n')}\n} }`);
  }

  // ---------------------------------------------------------------------------
  // Sequence detection
  // ---------------------------------------------------------------------------

  private readonly SEQ_MIN_CYCLES = 3;

  private async detectSequences(
    traces: TraceHit[],
  ): Promise<{ created: number; reinforced: number }> {
    // Group by cycle; build the ordered tool signature for cycles with ≥2 tools.
    const byCycle = new Map<string, TraceHit[]>();
    for (const tr of traces) {
      if (!tr.cycleId) continue;
      const arr = byCycle.get(tr.cycleId) ?? [];
      arr.push(tr);
      byCycle.set(tr.cycleId, arr);
    }

    // Count (forGoalType, signature) occurrences and gather per-pattern stats.
    interface PatternAgg {
      forGoalType?: string;
      tools: string[];
      cycles: number;
      satisfiedCycles: number;
      okCycles: number;
    }
    const patterns = new Map<string, PatternAgg>();
    for (const [, rows] of byCycle) {
      const ordered = rows
        .slice()
        .sort((a, b) => (a.sequencePos ?? 0) - (b.sequencePos ?? 0));
      const tools = ordered.map((r) => r.toolName);
      if (tools.length < 2) continue;
      const forGoalType = ordered[0].forGoalType;
      const sig = tools.join('>');
      const key = `${forGoalType ?? ''} ${sig}`;
      const agg =
        patterns.get(key) ??
        ({ forGoalType, tools, cycles: 0, satisfiedCycles: 0, okCycles: 0 } as PatternAgg);
      agg.cycles++;
      if (ordered.every((r) => r.outcome === 'success')) agg.okCycles++;
      if (ordered.some((r) => r.userSatisfied === true)) agg.satisfiedCycles++;
      patterns.set(key, agg);
    }

    let created = 0;
    let reinforced = 0;
    for (const [, agg] of patterns) {
      const sig = agg.tools.join('>');
      const uri = this.seqUri(agg.forGoalType, sig);
      const existing = await this.readOneSequenceSkill(uri);
      if (existing) {
        await this.reinforceSequenceSkill(uri, existing, agg.cycles, agg.okCycles, agg.satisfiedCycles);
        reinforced++;
      } else if (agg.cycles >= this.SEQ_MIN_CYCLES) {
        await this.mintSequenceSkill(uri, agg.forGoalType, agg.tools, agg.cycles, agg.okCycles, agg.satisfiedCycles);
        created++;
      }
    }
    return { created, reinforced };
  }

  private async mintSequenceSkill(
    uri: string,
    forGoalType: string | undefined,
    tools: string[],
    cycles: number,
    okCycles: number,
    satisfiedCycles: number,
  ): Promise<void> {
    const graph = this.graphUri();
    const label = tools.join('_');
    const successRate = cycles === 0 ? 0 : clampRate(okCycles / cycles);
    const satisfactionRate = cycles === 0 ? 0 : clampRate(satisfiedCycles / cycles);
    const lines: string[] = [
      `<${uri}> <${RDF_TYPE}> <${COGT}SequenceSkill> .`,
      `<${uri}> <${COGT}label> "${escapeLiteral(label)}" .`,
      `<${uri}> <${COGT}successCount> "${okCycles}"^^<${XSD}integer> .`,
      `<${uri}> <${COGT}failureCount> "${cycles - okCycles}"^^<${XSD}integer> .`,
      `<${uri}> <${COGT}successRate> "${successRate.toFixed(4)}"^^<${XSD}decimal> .`,
      `<${uri}> <${COGT}satisfactionRate> "${satisfactionRate.toFixed(4)}"^^<${XSD}decimal> .`,
      `<${uri}> <${COGT}agentId> "${escapeLiteral(this.agentId)}" .`,
    ];
    if (forGoalType) lines.push(`<${uri}> <${COGT}forGoalType> "${escapeLiteral(forGoalType)}" .`);
    tools.forEach((tool, i) => {
      const stepUri = `${uri}:step:${i + 1}`;
      lines.push(`<${uri}> <${COGT}hasStep> <${stepUri}> .`);
      lines.push(`<${stepUri}> <${COGT}stepIndex> "${i + 1}"^^<${XSD}integer> .`);
      lines.push(`<${stepUri}> <${COGT}toolName> "${escapeLiteral(tool)}" .`);
    });
    await this.triplestore.update(`INSERT DATA { GRAPH <${graph}> {\n${lines.join('\n')}\n} }`);
  }

  private async reinforceSequenceSkill(
    uri: string,
    existing: SequenceSkillSuggestion,
    cycles: number,
    okCycles: number,
    satisfiedCycles: number,
  ): Promise<void> {
    const graph = this.graphUri();
    const successCount = existing.successCount + okCycles;
    const prevTotal = Math.round(
      existing.successRate > 0 ? existing.successCount / existing.successRate : existing.successCount,
    );
    const total = prevTotal + cycles;
    const successRate = total === 0 ? 0 : clampRate(successCount / total);
    const prevSatisfied = Math.round(existing.satisfactionRate * prevTotal);
    const satisfactionRate = total === 0 ? 0 : clampRate((prevSatisfied + satisfiedCycles) / total);
    for (const [pred, val] of [
      ['successCount', `"${successCount}"^^<${XSD}integer>`],
      ['failureCount', `"${total - successCount}"^^<${XSD}integer>`],
      ['successRate', `"${successRate.toFixed(4)}"^^<${XSD}decimal>`],
      ['satisfactionRate', `"${satisfactionRate.toFixed(4)}"^^<${XSD}decimal>`],
    ] as const) {
      await this.triplestore.update(`
        DELETE { GRAPH <${graph}> { <${uri}> <${COGT}${pred}> ?o } }
        WHERE  { GRAPH <${graph}> { <${uri}> <${COGT}${pred}> ?o } }`);
      await this.triplestore.update(
        `INSERT DATA { GRAPH <${graph}> { <${uri}> <${COGT}${pred}> ${val} . } }`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  private async readTraces(
    window: { since: Date; until: Date },
    sinceExclusive = false,
  ): Promise<TraceHit[]> {
    const graph = this.graphUri();
    const res = await this.triplestore.query(`
      SELECT ?t ?traceId ?toolName ?hash ?brief ?when ?dur ?outcome ?errorClass
             ?forGoal ?forGoalType ?cycleId ?sessionId ?seqPos ?sat ?satW ?user
      WHERE {
        GRAPH <${graph}> {
          ?t a <${COGT}SkillTrace> ;
             <${COGT}traceId>    ?traceId ;
             <${COGT}toolName>   ?toolName ;
             <${COGT}executedAt> ?when .
          OPTIONAL { ?t <${COGT}toolArgsHash>  ?hash . }
          OPTIONAL { ?t <${COGT}toolArgsBrief> ?brief . }
          OPTIONAL { ?t <${COGT}durationMs>    ?dur . }
          OPTIONAL { ?t <${COGT}outcome>       ?outcome . }
          OPTIONAL { ?t <${COGT}errorClass>    ?errorClass . }
          OPTIONAL { ?t <${COGT}forGoal>       ?forGoal . }
          OPTIONAL { ?t <${COGT}forGoalType>   ?forGoalType . }
          OPTIONAL { ?t <${COGT}cycleId>       ?cycleId . }
          OPTIONAL { ?t <${COGT}sessionId>     ?sessionId . }
          OPTIONAL { ?t <${COGT}sequencePos>   ?seqPos . }
          OPTIONAL { ?t <${COGT}userSatisfied> ?sat . }
          OPTIONAL { ?t <${COGT}satisfactionWeight> ?satW . }
          OPTIONAL { ?t <${COGT}forUser>       ?user . }
        }
      }`);
    const since = window.since.getTime();
    const until = window.until.getTime();
    const out: TraceHit[] = [];
    for (const r of res.bindings ?? []) {
      const when = r.when.value;
      const ts = Date.parse(when);
      if (ts < since || ts > until || (sinceExclusive && ts === since)) continue;
      const hit: TraceHit = {
        uri: r.t.value,
        traceId: r.traceId.value,
        toolName: r.toolName.value,
        executedAt: when,
      };
      if (r.hash) hit.toolArgsHash = r.hash.value;
      if (r.brief) hit.toolArgsBrief = r.brief.value;
      if (r.dur) hit.durationMs = Number(r.dur.value);
      if (r.outcome) hit.outcome = r.outcome.value as Outcome;
      if (r.errorClass) hit.errorClass = r.errorClass.value;
      if (r.forGoal) hit.forGoal = r.forGoal.value;
      if (r.forGoalType) hit.forGoalType = r.forGoalType.value;
      if (r.cycleId) hit.cycleId = r.cycleId.value;
      if (r.sessionId) hit.sessionId = r.sessionId.value;
      if (r.seqPos) hit.sequencePos = Number(r.seqPos.value);
      if (r.sat) hit.userSatisfied = r.sat.value === 'true';
      if (r.satW && Number.isFinite(Number(r.satW.value))) hit.satisfactionWeight = Number(r.satW.value);
      if (r.user) hit.forUser = r.user.value;
      out.push(hit);
    }
    return out;
  }

  private async readSkills(forGoalType?: string): Promise<SkillSuggestion[]> {
    const graph = this.graphUri();
    const filter = forGoalType
      ? `?s <${COGT}forGoalType> "${escapeLiteral(forGoalType)}" .`
      : '';
    const res = await this.triplestore.query(`
      SELECT ?s ?toolName ?gt ?succ ?fail ?part ?mean ?p95 ?sr ?sat ?pattern
      WHERE {
        GRAPH <${graph}> {
          ?s a <${COGT}Skill> ;
             <${COGT}toolName>     ?toolName ;
             <${COGT}successCount> ?succ ;
             <${COGT}failureCount> ?fail ;
             <${COGT}partialCount> ?part ;
             <${COGT}successRate>  ?sr ;
             <${COGT}satisfactionRate> ?sat .
          ${filter}
          OPTIONAL { ?s <${COGT}forGoalType>      ?gt . }
          OPTIONAL { ?s <${COGT}meanDurationMs>   ?mean . }
          OPTIONAL { ?s <${COGT}p95DurationMs>    ?p95 . }
          OPTIONAL { ?s <${COGT}typicalArgPattern> ?pattern . }
        }
      }`);
    return (res.bindings ?? []).map((r) => ({
      skillUri: r.s.value,
      toolName: r.toolName.value,
      forGoalType: r.gt?.value,
      successCount: Number(r.succ.value),
      successRate: Number(r.sr.value),
      satisfactionRate: Number(r.sat.value),
      meanDurationMs: r.mean ? Number(r.mean.value) : 0,
      ...(r.p95 ? { p95DurationMs: Number(r.p95.value) } : {}),
      sampleCount: Number(r.succ.value) + Number(r.fail.value) + Number(r.part.value),
      typicalArgPattern: r.pattern?.value,
      score: 0,
    }));
  }

  private async readOneSkill(uri: string): Promise<SkillRow | undefined> {
    const graph = this.graphUri();
    const res = await this.triplestore.query(`
      SELECT ?toolName ?gt ?succ ?fail ?part ?mean ?sr ?sat ?last ?satW ?disW ?win
      WHERE {
        GRAPH <${graph}> {
          <${uri}> a <${COGT}Skill> ;
             <${COGT}toolName>     ?toolName ;
             <${COGT}successCount> ?succ ;
             <${COGT}failureCount> ?fail ;
             <${COGT}partialCount> ?part ;
             <${COGT}successRate>  ?sr ;
             <${COGT}satisfactionRate> ?sat .
          OPTIONAL { <${uri}> <${COGT}forGoalType>    ?gt . }
          OPTIONAL { <${uri}> <${COGT}meanDurationMs> ?mean . }
          OPTIONAL { <${uri}> <${COGT}lastUsedAt>     ?last . }
          OPTIONAL { <${uri}> <${COGT}satisfiedWeight>    ?satW . }
          OPTIONAL { <${uri}> <${COGT}dissatisfiedWeight> ?disW . }
          OPTIONAL { <${uri}> <${COGT}durationWindow>     ?win . }
        }
      } LIMIT 1`);
    const r = res.bindings?.[0];
    if (!r) return undefined;
    const hit: SkillRow = {
      skillUri: uri,
      toolName: r.toolName.value,
      forGoalType: r.gt?.value,
      successCount: Number(r.succ.value),
      failureCount: Number(r.fail.value),
      partialCount: Number(r.part.value),
      successRate: Number(r.sr.value),
      satisfactionRate: Number(r.sat.value),
      meanDurationMs: r.mean ? Number(r.mean.value) : 0,
      score: 0,
    };
    if (r.last) hit.lastUsedAt = r.last.value;
    if (r.satW) hit.satisfiedWeight = Number(r.satW.value);
    if (r.disW) hit.dissatisfiedWeight = Number(r.disW.value);
    if (r.win && r.win.value !== '') {
      hit.durationWindow = r.win.value
        .split(',')
        .map(Number)
        .filter((n) => Number.isFinite(n));
    }
    return hit;
  }

  private async readSequenceSkills(forGoalType?: string): Promise<SequenceSkillSuggestion[]> {
    const graph = this.graphUri();
    const filter = forGoalType
      ? `?s <${COGT}forGoalType> "${escapeLiteral(forGoalType)}" .`
      : '';
    const res = await this.triplestore.query(`
      SELECT ?s ?label ?gt ?succ ?sr ?sat
      WHERE {
        GRAPH <${graph}> {
          ?s a <${COGT}SequenceSkill> ;
             <${COGT}label>       ?label ;
             <${COGT}successCount> ?succ ;
             <${COGT}successRate>  ?sr ;
             <${COGT}satisfactionRate> ?sat .
          ${filter}
          OPTIONAL { ?s <${COGT}forGoalType> ?gt . }
        }
      }`);
    const out: SequenceSkillSuggestion[] = [];
    for (const r of res.bindings ?? []) {
      out.push({
        seqUri: r.s.value,
        label: r.label.value,
        forGoalType: r.gt?.value,
        successCount: Number(r.succ.value),
        successRate: Number(r.sr.value),
        satisfactionRate: Number(r.sat.value),
        steps: await this.readSteps(r.s.value),
      });
    }
    return out;
  }

  private async readOneSequenceSkill(uri: string): Promise<SequenceSkillSuggestion | undefined> {
    const graph = this.graphUri();
    const res = await this.triplestore.query(`
      SELECT ?label ?gt ?succ ?sr ?sat
      WHERE {
        GRAPH <${graph}> {
          <${uri}> a <${COGT}SequenceSkill> ;
             <${COGT}label>       ?label ;
             <${COGT}successCount> ?succ ;
             <${COGT}successRate>  ?sr ;
             <${COGT}satisfactionRate> ?sat .
          OPTIONAL { <${uri}> <${COGT}forGoalType> ?gt . }
        }
      } LIMIT 1`);
    const r = res.bindings?.[0];
    if (!r) return undefined;
    return {
      seqUri: uri,
      label: r.label.value,
      forGoalType: r.gt?.value,
      successCount: Number(r.succ.value),
      successRate: Number(r.sr.value),
      satisfactionRate: Number(r.sat.value),
      steps: await this.readSteps(uri),
    };
  }

  private async readSteps(
    seqUri: string,
  ): Promise<{ stepIndex: number; toolName: string; notes?: string }[]> {
    const graph = this.graphUri();
    const res = await this.triplestore.query(`
      SELECT ?step ?idx ?tool ?notes
      WHERE {
        GRAPH <${graph}> {
          <${seqUri}> <${COGT}hasStep> ?step .
          ?step <${COGT}stepIndex> ?idx ;
                <${COGT}toolName>  ?tool .
          OPTIONAL { ?step <${COGT}notes> ?notes . }
        }
      }`);
    return (res.bindings ?? [])
      .map((r) => ({
        stepIndex: Number(r.idx.value),
        toolName: r.tool.value,
        notes: r.notes?.value,
      }))
      .sort((a, b) => a.stepIndex - b.stepIndex);
  }
}
