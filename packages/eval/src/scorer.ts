import type {
  GoldSpec,
  TranscriptRow,
  ScoredRow,
  CategoryBackendCell,
  ProbeCategory,
  MemoryBackend,
  PilotReport,
} from './types.js';
import { renderAnalysisMarkdown, decisionMean, type AnalysisResult } from './analysis.js';

/**
 * LLM-judge interface (spec §7). Returns a score in [0,1] + rationale.
 * Mockable for offline tests; the default offline judge is lexical-overlap based.
 */
export interface Judge {
  judge(args: { question: string; gold: string; answer: string }): Promise<{ score: number; rationale: string }>;
}

/** Deterministic offline judge: normalized token-overlap recall of the gold. */
export class OfflineLexicalJudge implements Judge {
  async judge(args: { question: string; gold: string; answer: string }) {
    const gold = tokens(args.gold);
    if (gold.size === 0) return { score: 1, rationale: 'empty gold' };
    const ans = tokens(args.answer);
    let hit = 0;
    for (const g of gold) if (ans.has(g)) hit++;
    const score = hit / gold.size;
    return { score, rationale: `lexical recall ${hit}/${gold.size}` };
  }
}

export interface ScorerOptions {
  /** Use the LLM-judge for free-text exact/f1 instead of strict string match. */
  judge?: Judge;
  /**
   * κ-representativeness (review fix). To make judge–human agreement (κ)
   * measured over the REAL free-text distribution — not only the lexical-failure
   * subpopulation — the judge is ALSO run on a seeded ≥20% sample of free-text
   * (H0/H1) items that lexical match already PASSED, so judge false-positives are
   * catchable. On a lexical-pass item the lexical score stays authoritative; the
   * judge call exists purely to feed the κ sampler. Default rate 0.2. Set to 0 to
   * restore the old failure-only behaviour.
   */
  judgeSampleRate?: number;
  /** Seed for the deterministic κ sampling decision (reproducible). */
  judgeSampleSeed?: number;
}

/**
 * Deterministic per-item κ-sampling decision: a stable hash of the item's
 * identity mapped into [0,1), compared against `rate`. Reproducible across runs
 * (no global RNG state) and independent of row ordering, so the judged κ sample
 * is a representative ≥`rate` slice of ALL free-text items.
 */
function shouldKappaSample(row: TranscriptRow, rate: number, seed: number): boolean {
  if (rate <= 0) return false;
  if (rate >= 1) return true;
  const key = `${seed}::${row.model ?? 'default'}::${row.scenarioId}::${row.probeId}::${row.paraphrase}`;
  let h = 2166136261 >>> 0;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h / 4294967296 < rate;
}

/** Score one transcript row against its gold spec. */
export async function scoreRow(
  row: TranscriptRow,
  gold: GoldSpec,
  opts: ScorerOptions = {},
): Promise<ScoredRow> {
  const a = row.answer ?? '';
  const norm = normalize(a);

  switch (gold.type) {
    case 'exact': {
      const exact = norm.includes(normalize(gold.value)) ? 1 : 0;
      if (!opts.judge) return { ...row, score: exact, detail: { kind: 'exact' } };
      const rate = opts.judgeSampleRate ?? 0.2;
      const seed = opts.judgeSampleSeed ?? 20260613;
      if (exact === 1) {
        // Lexical TRUE-POSITIVE: keep the lexical score authoritative. Run the
        // judge ONLY on a seeded ≥rate sample, purely so this item enters the κ
        // sample (judge false-positives become catchable). Judge does NOT flip
        // a lexical pass.
        if (shouldKappaSample(row, rate, seed)) {
          const j = await opts.judge.judge({ question: row.paraphrase, gold: gold.value, answer: a });
          return { ...row, score: 1, detail: { kind: 'exact', lexical: 1, judgeScore: j.score, kappaSampled: true } };
        }
        return { ...row, score: exact, detail: { kind: 'exact' } };
      }
      // Lexical failure: the judge decides the score (and is always κ-sampled).
      const j = await opts.judge.judge({ question: row.paraphrase, gold: gold.value, answer: a });
      return { ...row, score: j.score >= 0.5 ? 1 : 0, detail: { kind: 'exact-judge', rationale: j.rationale, judgeScore: j.score } };
    }
    case 'f1': {
      const f1 = tokenF1(a, gold.value);
      if (!opts.judge) return { ...row, score: f1, detail: { kind: 'f1' } };
      const rate = opts.judgeSampleRate ?? 0.2;
      const seed = opts.judgeSampleSeed ?? 20260613;
      // High-F1 (lexically strong) items: only call the judge on a seeded sample
      // for κ representativeness; the lexical F1 stays authoritative there.
      const lexicallyStrong = f1 >= 0.999;
      if (lexicallyStrong && !shouldKappaSample(row, rate, seed)) {
        return { ...row, score: f1, detail: { kind: 'f1' } };
      }
      const j = await opts.judge.judge({ question: row.paraphrase, gold: gold.value, answer: a });
      const score = lexicallyStrong ? f1 : Math.max(f1, j.score);
      return { ...row, score, detail: { kind: 'f1-judge', f1, judgeScore: j.score, rationale: j.rationale, kappaSampled: lexicallyStrong || undefined } };
    }
    case 'set': {
      const { precision, recall, f1, found, spurious } = setPRF(a, gold.value, gold.candidates);
      return { ...row, score: f1, detail: { kind: 'set', precision, recall, found, spurious } };
    }
    case 'value+flag': {
      // Two INDEPENDENT scores:
      //   primary  = correct-value rate (did the answer surface the new value?)
      //   secondary= conflict-flag rate.
      // FAIRNESS (review fix): the flag is credited from EITHER signal —
      //   (i)  the BACKEND surfaced a structural conflict (retrieveMeta.conflicts,
      //        the semantic backend's belief-revision signal), OR
      //   (ii) the ANSWER itself explicitly flags the change/conflict (robust
      //        free-text detection, not a single stray "conflict" token).
      // This is the intended capability comparison: a baseline that genuinely
      // states the contradiction in prose CAN score the flag; the semantic
      // backend additionally gets its structural signal for free.
      const valueOk = norm.includes(normalize(gold.value)) ? 1 : 0;
      const backendConflicts = conflictCount(row);
      const answerFlags = answerFlagsConflict(a) ? 1 : 0;
      const flagged = backendConflicts > 0 || answerFlags === 1 ? 1 : 0;
      const flagScore = gold.expectConflictFlag ? flagged : 1 - flagged;
      return {
        ...row,
        score: valueOk,
        secondary: flagScore,
        detail: {
          kind: 'value+flag',
          valueOk,
          flagged: flagged === 1,
          backendConflicts,
          answerFlags: answerFlags === 1,
        },
      };
    }
    case 'provenance': {
      // Real provenance: the answer must reference the SOURCE TURN id AND a
      // timestamp within tsToleranceSec of the gold source turn's ingest time.
      // Value mention alone is NOT sufficient (review fix); kept only as a
      // partial-credit secondary signal.
      const idOk = gold.sourceTurnId && norm.includes(normalize(gold.sourceTurnId)) ? 1 : 0;
      const tol = gold.tsToleranceSec ?? 0;
      const tsOk = timestampWithinTolerance(a, row.expectedTs, tol) ? 1 : 0;
      const valOk = gold.value && norm.includes(normalize(gold.value)) ? 1 : 0;
      // Full credit requires BOTH the source turn id and a correct timestamp.
      const score = idOk === 1 && tsOk === 1 ? 1 : 0;
      return {
        ...row,
        score,
        secondary: valOk,
        detail: { kind: 'provenance', idOk, tsOk, valOk, expectedTs: row.expectedTs ?? null },
      };
    }
    case 'constraint': {
      // H5 violation-catch, scored FAIRLY from EITHER signal (review fix):
      //   (i)  the BACKEND flagged the constraint violation at ingest
      //        (functional-property supersession / claim clash) via
      //        retrieveMeta.conflicts (the semantic backend's structural signal),
      //   OR
      //   (ii) the ANSWER itself explicitly flags the violation/inconsistency
      //        (robust free-text detection).
      // A baseline whose answer genuinely calls out the inconsistency CAN score;
      // the semantic backend additionally earns it structurally. This is the
      // intended capability comparison, not a structural pin-to-zero.
      const backendConflicts = conflictCount(row);
      const answerFlags = answerFlagsConflict(a) ? 1 : 0;
      const caught = backendConflicts > 0 || answerFlags === 1 ? 1 : 0;
      const score = gold.expectRejectOrFlag ? caught : 1 - caught;
      return {
        ...row,
        score,
        detail: {
          kind: 'constraint',
          caught: caught === 1,
          backendConflicts,
          answerFlags: answerFlags === 1,
        },
      };
    }
    case 'leakage': {
      const leaked = gold.mustNotContain.filter((t) => norm.includes(normalize(t)));
      // Lower leakage is better → score = 1 when nothing leaked.
      const leakScore = leaked.length === 0 ? 1 : 0;
      const neighbors = gold.neighborsMustStay ?? [];
      const retained = neighbors.filter((t) => norm.includes(normalize(t)));
      const retentionScore = neighbors.length === 0 ? 1 : retained.length / neighbors.length;
      return {
        ...row,
        score: leakScore,
        secondary: retentionScore,
        detail: { kind: 'leakage', leaked, retained, neighbors },
      };
    }
    default: {
      const _exhaustive: never = gold;
      return { ...row, score: 0, detail: { kind: 'unknown', _exhaustive } as Record<string, unknown> };
    }
  }
}

/** Aggregate scored rows into a (category × backend) table + cost/latency. */
export function aggregate(
  rows: ScoredRow[],
  backends: MemoryBackend['name'][],
): PilotReport {
  const categories = [...new Set(rows.map((r) => r.category))].sort() as ProbeCategory[];
  const cells: CategoryBackendCell[] = [];

  for (const category of categories) {
    for (const backend of backends) {
      const subset = rows.filter((r) => r.category === category && r.backend === backend);
      if (subset.length === 0) {
        cells.push({ category, backend, n: 0, meanScore: NaN, meanTokens: NaN, meanLatencyMs: NaN });
        continue;
      }
      cells.push({
        category,
        backend,
        n: subset.length,
        meanScore: mean(subset.map((r) => r.score)),
        meanSecondary: subset.some((r) => r.secondary != null)
          ? mean(subset.filter((r) => r.secondary != null).map((r) => r.secondary!))
          : undefined,
        // The headline/decision number — identical quantity to the stats' meanA/B.
        meanDecision: decisionMean(rows, category, backend),
        meanTokens: mean(subset.map((r) => r.tokens)),
        meanLatencyMs: mean(subset.map((r) => r.latencyMs)),
      });
    }
  }

  const costLatency = backends.map((backend) => {
    const subset = rows.filter((r) => r.backend === backend);
    return {
      backend,
      totalTokens: subset.reduce((s, r) => s + r.tokens, 0),
      meanLatencyMs: subset.length ? mean(subset.map((r) => r.latencyMs)) : 0,
      n: subset.length,
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    backends,
    categories,
    cells,
    rows,
    costLatency,
  };
}

/** Render the per-category A/B/C table as markdown (ready for ontofelia.tex). */
export function renderMarkdown(report: PilotReport & { analysis?: AnalysisResult }): string {
  const { categories, backends, cells } = report;
  const lines: string[] = [];
  lines.push(`# Eval pilot report`);
  lines.push('');
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push('');
  lines.push(`## Decision score by category × backend`);
  lines.push('');
  lines.push(
    `Headline number = **decision score** (per-probe mean of value×flag for ` +
      `value+flag/leakage categories, value otherwise) — the SAME quantity the ` +
      `statistical verdict uses, so the table and the stats always reconcile. ` +
      `Parenthetical \`(val …, sec …)\` is the raw primary value / secondary for context.`,
  );
  lines.push('');
  lines.push(`| Category | ${backends.join(' | ')} |`);
  lines.push(`| --- | ${backends.map(() => '---').join(' | ')} |`);
  for (const cat of categories) {
    const row = backends.map((b) => {
      const c = cells.find((x) => x.category === cat && x.backend === b);
      if (!c || c.n === 0) return '—';
      const decision = c.meanDecision ?? c.meanScore;
      const ctx =
        c.meanSecondary != null
          ? ` (val ${c.meanScore.toFixed(2)}, sec ${c.meanSecondary.toFixed(2)})`
          : '';
      return `${decision.toFixed(2)}${ctx}`;
    });
    lines.push(`| ${cat} | ${row.join(' | ')} |`);
  }
  lines.push('');
  lines.push(`## Cost & latency by backend`);
  lines.push('');
  lines.push(`| Backend | n | total tokens | mean latency (ms) |`);
  lines.push(`| --- | --- | --- | --- |`);
  for (const cl of report.costLatency) {
    lines.push(`| ${cl.backend} | ${cl.n} | ${cl.totalTokens} | ${cl.meanLatencyMs.toFixed(1)} |`);
  }
  lines.push('');
  if (report.analysis) {
    lines.push(renderAnalysisMarkdown(report.analysis));
  }
  return lines.join('\n');
}

// --- helpers ---------------------------------------------------------------

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

function tokens(s: string): Set<string> {
  return new Set(normalize(s).split(' ').filter((t) => t.length > 1));
}

function tokenF1(answer: string, gold: string): number {
  const a = [...tokens(answer)];
  const g = [...tokens(gold)];
  if (g.length === 0) return a.length === 0 ? 1 : 0;
  const gset = new Set(g);
  const aset = new Set(a);
  const overlap = a.filter((t) => gset.has(t)).length;
  if (overlap === 0) return 0;
  const precision = overlap / a.length;
  const recall = [...gset].filter((t) => aset.has(t)).length / g.length;
  return (2 * precision * recall) / (precision + recall);
}

/**
 * REAL set precision/recall/F1 (review fix). Precision is computed against the
 * closed candidate vocabulary (gold members PLUS plausible distractors): every
 * candidate the answer asserts that is NOT in the gold set is a precision miss,
 * so an over-general "dump everything" answer is penalised. If no candidate
 * vocabulary is supplied, precision falls back to the gold set only (real
 * recall, lenient precision) — still not the old `found>0?1:0`.
 */
function setPRF(
  answer: string,
  gold: string[],
  candidates?: string[],
): { precision: number; recall: number; f1: number; found: string[]; spurious: string[] } {
  // Token-boundary membership: avoids substring false positives like the
  // candidate "Go" matching inside "Postgres"/"good".
  const ansTokens = new Set(normalize(answer).split(' ').filter(Boolean));
  const mentions = (term: string) => {
    const toks = normalize(term).split(' ').filter(Boolean);
    return toks.length > 0 && toks.every((t) => ansTokens.has(t));
  };
  const goldSet = new Set(gold.map((g) => normalize(g)));
  const found = gold.filter((g) => mentions(g));
  const recall = gold.length ? found.length / gold.length : 1;

  // The candidate vocabulary the precision is measured against.
  const vocab = candidates && candidates.length ? candidates : gold;
  const asserted = vocab.filter((c) => mentions(c));
  const correctAsserted = asserted.filter((c) => goldSet.has(normalize(c)));
  const spurious = asserted.filter((c) => !goldSet.has(normalize(c)));
  const precision = asserted.length ? correctAsserted.length / asserted.length : 0;

  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  return { precision, recall, f1, found, spurious };
}

/** Number of backend-surfaced conflicts attached to a transcript row's meta. */
function conflictCount(row: TranscriptRow): number {
  const c = row.retrieveMeta?.conflicts;
  return Array.isArray(c) ? c.length : 0;
}

/**
 * Robust free-text conflict/violation detector (H3/H5 fairness — review fix).
 *
 * Credits a backend whose ANSWER genuinely flags a contradiction / constraint
 * violation, so a strong baseline is not structurally pinned at 0. Robust, NOT a
 * single trigger word: we require an explicit conflict/contradiction/violation
 * phrase (multi-word or clearly violation-specific), so a bare stray "conflict"
 * token leaking from context does not over-credit. Hedges like "I'm not sure"
 * do not count.
 */
function answerFlagsConflict(answer: string): boolean {
  const n = normalize(answer);
  // Assertion-SHAPED phrases where the assistant itself states clashing facts /
  // a violated constraint — deliberately tight so that raw retrieved chunk text
  // merely CONTAINING a stray word like "conflict" (e.g. a scenario-id token or
  // a distractor) does NOT over-credit. No lone-word or loose-"the" patterns.
  const patterns: RegExp[] = [
    /\bthere (?:is|s) (?:a|an) (?:conflict|contradiction|inconsistency|violation)\b/,
    /\b(?:conflict|contradiction|inconsistency) between\b/,
    /\b(?:these|those|two|both) (?:facts|values|statements|ages|answers|claims) (?:are |conflict|contradict|do not match)/,
    /\b(?:they|the(?:se|y)? facts?|the values?|these statements) (?:conflict|contradict) (?:each other|one another)\b/,
    /\b(?:that|this|these|it) (?:is|are) (?:inconsistent|contradictory|conflicting|not consistent)\b/,
    /\bcannot (?:both )?be (?:true|correct|right|both)\b/,
    /\bcan ?not have (?:two|both|more than one)\b/,
    /\bviolat\w+ (?:a |the |an )?(?:constraint|cardinality|rule|uniqueness|max-?1)\b/,
    /\b(?:constraint|cardinality|uniqueness) (?:is |was )?violat\w+\b/,
    /\b(?:i )?prefer the (?:most )?(?:recent|latest|newer)\b/,
    /\bcontradict(?:s|ion|ory)? (?:the |my |an? )?(?:earlier|previous|prior)\b/,
  ];
  return patterns.some((re) => re.test(n));
}

/**
 * True when the answer contains an ISO-8601 timestamp within `tolSec` of the
 * expected ingest time. The answer surfaces `at=<iso>` from the provenance
 * block; we parse any ISO timestamp in the text and compare. With tol=0 it must
 * match to the second.
 */
function timestampWithinTolerance(answer: string, expectedTs: string | undefined, tolSec: number): boolean {
  if (!expectedTs) return false;
  const expected = Date.parse(expectedTs);
  if (Number.isNaN(expected)) return false;
  const isoRe = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;
  const matches = answer.match(isoRe) ?? [];
  for (const m of matches) {
    const t = Date.parse(m);
    if (!Number.isNaN(t) && Math.abs(t - expected) <= tolSec * 1000) return true;
  }
  return false;
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}
