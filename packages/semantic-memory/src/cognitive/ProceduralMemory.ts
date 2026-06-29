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

import type { TriplestoreAdapter } from '@ontofelia/core';
import { GraphUriResolver } from '../utils/GraphUriResolver.js';

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
  /** Whether the LLM picked a suggested tool; null when no suggestion existed. */
  proceduralAdherence?: boolean | null;
}

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
}

export interface SkillSuggestion {
  skillUri: SkillUri;
  toolName: string;
  forGoalType?: string;
  successRate: number;
  satisfactionRate: number;
  meanDurationMs: number;
  successCount: number;
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
  return s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
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

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

export class ProceduralMemory {
  constructor(
    private readonly triplestore: TriplestoreAdapter,
    private readonly agentId: string,
  ) {}

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

    await this.triplestore.update(`INSERT DATA { GRAPH <${graph}> {\n${lines.join('\n')}\n} }`);
    return uri;
  }

  /**
   * Back-fill the weak `userSatisfied` signal on a trace (doc 06 §3). `null`
   * clears it (ambiguous feedback); `true`/`false` set it.
   */
  async backfillSatisfaction(traceUri: TraceId, satisfied: boolean | null): Promise<void> {
    const graph = this.graphUri();
    await this.triplestore.update(`
      DELETE { GRAPH <${graph}> { <${traceUri}> <${COGT}userSatisfied> ?old } }
      WHERE  { GRAPH <${graph}> { <${traceUri}> <${COGT}userSatisfied> ?old } }`);
    if (satisfied === null) return;
    await this.triplestore.update(`
      INSERT DATA { GRAPH <${graph}> {
        <${traceUri}> <${COGT}userSatisfied> "${satisfied}"^^<${XSD}boolean> .
      } }`);
  }

  /**
   * Trace IRIs of the most recent cycle in `sessionId` other than
   * `excludeCycleId` (doc 06 §3 — the cycle a fresh inbound message is reacting
   * to). Returns `[]` when there is no prior cycle. Used by Phase 1 to back-fill
   * the weak `userSatisfied` signal one cycle late.
   */
  async findPriorCycleTraceUris(sessionId: string, excludeCycleId: string): Promise<string[]> {
    const graph = this.graphUri();
    const res = await this.triplestore.query(`
      SELECT ?t ?cycleId ?when WHERE {
        GRAPH <${graph}> {
          ?t a <${COGT}SkillTrace> ;
             <${COGT}sessionId>  "${escapeLiteral(sessionId)}" ;
             <${COGT}cycleId>    ?cycleId ;
             <${COGT}executedAt> ?when .
        }
      }`);
    let bestCycle: string | undefined;
    let bestWhen = -Infinity;
    const byCycle = new Map<string, string[]>();
    for (const r of res.bindings ?? []) {
      const cyc = r.cycleId.value;
      if (cyc === excludeCycleId) continue;
      const arr = byCycle.get(cyc) ?? [];
      arr.push(r.t.value);
      byCycle.set(cyc, arr);
      const ts = Date.parse(r.when.value);
      if (ts > bestWhen) { bestWhen = ts; bestCycle = cyc; }
    }
    return bestCycle ? byCycle.get(bestCycle) ?? [] : [];
  }

  /**
   * Top-K skills for a goal type, ranked by `satisfactionRate * successRate`
   * (doc 06 §4). Returns `[]` when none exist; never throws.
   */
  async suggestSkills(forGoalType: string, k = 5): Promise<SkillSuggestion[]> {
    const skills = await this.readSkills(forGoalType);
    const scored = skills.map((s) => ({ ...s, score: s.satisfactionRate * s.successRate }));
    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return b.successCount - a.successCount;
    });
    return scored.slice(0, Math.max(0, k));
  }

  /** Top-K learned sequence skills for a goal type, ranked by successRate. */
  async suggestSequenceSkills(forGoalType: string, k = 3): Promise<SequenceSkillSuggestion[]> {
    const seqs = await this.readSequenceSkills(forGoalType);
    seqs.sort((a, b) => {
      if (b.successRate !== a.successRate) return b.successRate - a.successRate;
      return b.successCount - a.successCount;
    });
    return seqs.slice(0, Math.max(0, k));
  }

  /**
   * Aggregate the traces in `[since, until]` into Skill summaries and detect
   * recurring tool sequences (doc 06 §5). Idempotent-ish: re-running over the
   * same window double-counts, so callers pass a fresh window each tick.
   */
  async consolidate(window: { since: Date; until: Date }): Promise<ConsolidationReport> {
    const traces = await this.readTraces(window);
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
    const newSatisfied = rows.filter((r) => r.userSatisfied === true).length;

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
    const p95DurationMs = percentile([...newDurations].sort((a, b) => a - b), 0.95);

    const successRate = total === 0 ? 0 : successCount / total;
    // Reconstruct cumulative satisfied count from the prior rate, add the new.
    const prevSatisfied = Math.round((prev?.satisfactionRate ?? 0) * (prev?.successCount ?? 0));
    const satisfiedCount = prevSatisfied + newSatisfied;
    const satisfactionRate = successCount === 0 ? 0 : clampRate(satisfiedCount / successCount);

    const lastTrace = rows.reduce((a, b) => (a.executedAt > b.executedAt ? a : b));
    const lastUsedAt =
      !prev?.lastUsedAt || lastTrace.executedAt > prev.lastUsedAt
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
      .sort((a, b) => (a.executedAt < b.executedAt ? 1 : -1))
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

  private async readTraces(window: { since: Date; until: Date }): Promise<TraceHit[]> {
    const graph = this.graphUri();
    const res = await this.triplestore.query(`
      SELECT ?t ?traceId ?toolName ?hash ?brief ?when ?dur ?outcome ?errorClass
             ?forGoal ?forGoalType ?cycleId ?sessionId ?seqPos ?sat
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
        }
      }`);
    const since = window.since.getTime();
    const until = window.until.getTime();
    const out: TraceHit[] = [];
    for (const r of res.bindings ?? []) {
      const when = r.when.value;
      const ts = Date.parse(when);
      if (ts < since || ts > until) continue;
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
      SELECT ?s ?toolName ?gt ?succ ?fail ?part ?mean ?sr ?sat ?pattern
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
      typicalArgPattern: r.pattern?.value,
      score: 0,
    }));
  }

  private async readOneSkill(uri: string): Promise<SkillRow | undefined> {
    const graph = this.graphUri();
    const res = await this.triplestore.query(`
      SELECT ?toolName ?gt ?succ ?fail ?part ?mean ?sr ?sat ?last
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
