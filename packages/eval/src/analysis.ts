/**
 * Phase 1 analysis layer (eval-design §6) — turn scored rows into the paired
 * A-vs-B (and A-vs-C) statistics, Holm-adjusted across H1..H6, with bootstrap
 * CIs and the pre-registered verdict.
 *
 * Pairing: rows are paired across backends on the SAME item, keyed by
 * (scenarioId, probeId, paraphrase). Each category contributes its items; the
 * statistic chosen per category follows the gold's nature:
 *   - binary categories (exact/value+flag/constraint/leakage thresholded to 0/1)
 *     → McNemar + odds ratio,
 *   - graded categories (set-F1, provenance graded, f1) → Wilcoxon + rank-biserial.
 * We pick the test from the score distribution: if every paired score is 0/1 we
 * use McNemar, else Wilcoxon. Both are always computable; the report names which.
 */

import type { ProbeCategory, ScoredRow, MemoryBackend } from './types.js';
import {
  mcnemar,
  wilcoxon,
  bootstrapCI,
  bootstrapDiffCI,
  holmBonferroni,
  type CI,
} from './stats.js';

export type BackendName = MemoryBackend['name'];

/** All hypotheses under Holm correction (H0 is the control, excluded). */
export const FAMILY: ProbeCategory[] = ['H1', 'H2', 'H3', 'H4', 'H5', 'H6'];
/** The architecture-claim subset for the verdict. */
export const ARCH_SUBSET: ProbeCategory[] = ['H2', 'H3', 'H4', 'H5', 'H6'];

export interface PairedStat {
  category: ProbeCategory;
  /** 'A-vs-B' = semantic vs vector-rag; 'A-vs-C' = semantic vs no-memory. */
  comparison: string;
  aBackend: BackendName;
  bBackend: BackendName;
  n: number;
  meanA: number;
  meanB: number;
  test: 'mcnemar' | 'wilcoxon';
  /** Effect size: odds ratio (McNemar) or rank-biserial (Wilcoxon). */
  effectSize: number;
  effectKind: 'oddsRatio' | 'rankBiserial';
  pRaw: number;
  /** Holm-adjusted across the H1..H6 family for THIS comparison (filled later). */
  pAdjusted?: number;
  /** True iff the Holm-adjusted p rejects at alpha and A>B in mean. */
  rejected?: boolean;
  /** Bootstrap 95% CIs of each backend mean + the paired diff (A−B). */
  ciA: CI;
  ciB: CI;
  ciDiff: CI;
  /** Meaningful A-advantage: A mean > B mean by a margin AND effect size sizable. */
  meaningfulAAdvantage: boolean;
}

export interface VerdictResult {
  comparison: string;
  /**
   * Categories in ARCH_SUBSET where A beats B by a MEANINGFUL EFFECT SIZE (the
   * pre-registered, effect-size-based win criterion — NOT significance-gated).
   */
  archWins: ProbeCategory[];
  /** Whether H0 shows NO A-advantage (control passes). */
  h0NoAAdvantage: boolean;
  h0MeanA: number;
  h0MeanB: number;
  /** Pre-registered decision: supported iff ≥3 arch wins AND H0 control holds. */
  supported: boolean;
  line: string;
}

export interface AnalysisResult {
  /** Per (category × comparison) paired statistic. */
  stats: PairedStat[];
  /** One verdict per comparison (A-vs-B, A-vs-C). */
  verdicts: VerdictResult[];
}

export interface AnalysisOptions {
  /** Backend treated as A (default 'semantic'). */
  aBackend?: BackendName;
  /** Backends treated as B in each comparison (default vector-rag + no-memory). */
  bBackends?: BackendName[];
  bootstrapResamples?: number;
  seed?: number;
  alpha?: number;
  /** Minimum mean gap for a "meaningful" advantage. */
  minMeanGap?: number;
  /** Minimum |effect size| (rank-biserial) or odds ratio for "meaningful". */
  minRankBiserial?: number;
  minOddsRatio?: number;
}

// The unit of analysis is the PROBE (eval-design §3.3): a probe is scored as the
// MEAN over its paraphrases, so paraphrases of one probe never enter the paired
// test as independent items (that pseudo-replication inflates significance).
// The key therefore omits `paraphrase`. It still includes the model so the
// pooled (multi-model) analysis pairs A-vs-B WITHIN a model — model is a
// blocking factor, never averaged across.
const itemKey = (r: ScoredRow) =>
  `${r.model ?? 'default'}::${r.scenarioId}::${r.probeId}`;

/**
 * For value+flag categories the differentiator under test (H3) is the conflict
 * FLAG, which is the secondary score. We score the paired comparison on the
 * combined signal: an item counts as "correct" iff primary AND (when present)
 * secondary are both satisfied. This keeps closed categories binary and reflects
 * the real H3/H6 advantage (value right AND conflict flagged / no leak AND
 * neighbour retained).
 */
export function effectiveScore(r: ScoredRow): number {
  if (r.secondary == null) return r.score;
  // Combine: graded categories (set has no secondary) untouched; binary
  // categories with a secondary (value+flag, leakage) require both.
  // We multiply so 0/1 pairs stay 0/1 and graded stays graded.
  return r.score * r.secondary;
}

/**
 * Aggregate the per-paraphrase rows of one backend into ONE score per probe
 * (the mean of effectiveScore over a probe's paraphrases). This is the §3.3
 * "mean over paraphrases" unit-of-analysis: a probe contributes a single value
 * to the paired test, never one value per paraphrase.
 */
export function aggregatePerProbe(
  rows: ScoredRow[],
  category: ProbeCategory,
  backend: BackendName,
): Map<string, number> {
  const sums = new Map<string, { sum: number; count: number }>();
  for (const r of rows) {
    if (r.category !== category || r.backend !== backend) continue;
    const k = itemKey(r);
    const acc = sums.get(k) ?? { sum: 0, count: 0 };
    acc.sum += effectiveScore(r);
    acc.count += 1;
    sums.set(k, acc);
  }
  const out = new Map<string, number>();
  for (const [k, { sum, count }] of sums) out.set(k, count ? sum / count : 0);
  return out;
}

/**
 * The single source of truth for a (category × backend) headline number: the
 * mean over probes of the per-probe-aggregated {@link effectiveScore} — i.e. the
 * SAME quantity the paired statistic and the verdict use (`meanA`/`meanB`). The
 * display table renders this so the shown number always equals the verdict basis.
 */
export function decisionMean(
  rows: ScoredRow[],
  category: ProbeCategory,
  backend: BackendName,
): number {
  const vals = [...aggregatePerProbe(rows, category, backend).values()];
  return vals.length ? vals.reduce((s, x) => s + x, 0) / vals.length : NaN;
}

/** Pair A and B per-probe (paraphrase-aggregated) scores on the same probes. */
function pairScores(
  rows: ScoredRow[],
  category: ProbeCategory,
  aBackend: BackendName,
  bBackend: BackendName,
): { a: number[]; b: number[]; keys: string[] } {
  const aMap = aggregatePerProbe(rows, category, aBackend);
  const bMap = aggregatePerProbe(rows, category, bBackend);
  const keys = [...aMap.keys()].filter((k) => bMap.has(k)).sort();
  return { a: keys.map((k) => aMap.get(k)!), b: keys.map((k) => bMap.get(k)!), keys };
}

function isBinary(xs: number[]): boolean {
  return xs.every((x) => x === 0 || x === 1);
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN);

function pairedStat(
  rows: ScoredRow[],
  category: ProbeCategory,
  aBackend: BackendName,
  bBackend: BackendName,
  opts: AnalysisOptions,
): PairedStat | null {
  const { a, b, keys } = pairScores(rows, category, aBackend, bBackend);
  if (keys.length === 0) return null;

  const resamples = opts.bootstrapResamples ?? 10000;
  const seed = opts.seed ?? 12345;
  // Pre-registered "meaningful effect size" thresholds (defined just below).
  // A category is an architecture win iff A beats B by AT LEAST these:
  //   - graded categories  → rank-biserial |r| ≥ 0.30 (Cohen "medium") AND a
  //                           mean gap ≥ 0.20 in the right direction,
  //   - binary categories  → McNemar odds ratio ≥ 3 (≈ medium-large) AND a
  //                           mean gap ≥ 0.20.
  // These gate the VERDICT; Holm-adjusted significance is reported separately.
  const minMeanGap = opts.minMeanGap ?? 0.2;
  const minRankBiserial = opts.minRankBiserial ?? 0.3;
  const minOddsRatio = opts.minOddsRatio ?? 3;

  const meanA = mean(a);
  const meanB = mean(b);

  let test: 'mcnemar' | 'wilcoxon';
  let effectSize: number;
  let effectKind: 'oddsRatio' | 'rankBiserial';
  let pRaw: number;

  if (isBinary(a) && isBinary(b)) {
    const m = mcnemar(a, b);
    test = 'mcnemar';
    effectSize = m.oddsRatio;
    effectKind = 'oddsRatio';
    pRaw = m.p;
  } else {
    const w = wilcoxon(a, b);
    test = 'wilcoxon';
    effectSize = w.rankBiserial;
    effectKind = 'rankBiserial';
    pRaw = w.p;
  }

  const ciA = bootstrapCI(a, { resamples, seed });
  const ciB = bootstrapCI(b, { resamples, seed: seed + 1 });
  const ciDiff = bootstrapDiffCI(a, b, { resamples, seed: seed + 2 });

  // Meaningful A-advantage: A clearly higher in mean AND a sizable effect size.
  const effOk =
    effectKind === 'oddsRatio'
      ? effectSize === Number.POSITIVE_INFINITY || effectSize >= minOddsRatio
      : effectSize >= minRankBiserial;
  const meaningfulAAdvantage = meanA - meanB >= minMeanGap && effOk;

  return {
    category,
    comparison: `${aBackend}-vs-${bBackend}`,
    aBackend,
    bBackend,
    n: keys.length,
    meanA,
    meanB,
    test,
    effectSize,
    effectKind,
    pRaw,
    ciA,
    ciB,
    ciDiff,
    meaningfulAAdvantage,
  };
}

/**
 * Run the full Phase-1 analysis: per category × comparison paired statistics,
 * Holm-adjusted across {H1..H6} within each comparison, plus the pre-registered
 * verdict per comparison.
 */
export function analyze(rows: ScoredRow[], opts: AnalysisOptions = {}): AnalysisResult {
  const aBackend = opts.aBackend ?? 'semantic';
  const bBackends = opts.bBackends ?? (['vector-rag', 'no-memory'] as BackendName[]);
  const alpha = opts.alpha ?? 0.05;

  const stats: PairedStat[] = [];
  const verdicts: VerdictResult[] = [];

  const allCategories = [...new Set(rows.map((r) => r.category))] as ProbeCategory[];

  for (const bBackend of bBackends) {
    if (bBackend === aBackend) continue;
    const comparison = `${aBackend}-vs-${bBackend}`;

    // 1. Compute per-category stats for this comparison.
    const perCat = new Map<ProbeCategory, PairedStat>();
    for (const category of allCategories) {
      const st = pairedStat(rows, category, aBackend, bBackend, opts);
      if (st) perCat.set(category, st);
    }

    // 2. Holm correction across the PRE-REGISTERED H1..H6 family (m = 6 fixed;
    // H0 stays the uncorrected control). The family size is fixed at the six
    // registered hypotheses regardless of how many were actually tested: a
    // category missing from a run (n=0) contributes a non-rejectable p=1 slot,
    // so the correction never shrinks below the registered m=6 (which would make
    // it artificially weaker than pre-registered).
    const familyEntries = FAMILY.map((h) => ({
      key: h,
      p: perCat.has(h) ? perCat.get(h)!.pRaw : 1,
    }));
    const holm = holmBonferroni(familyEntries, alpha);
    const holmByKey = new Map(holm.map((h) => [h.key, h]));
    for (const [cat, st] of perCat) {
      const h = holmByKey.get(cat);
      if (h) {
        st.pAdjusted = h.pAdjusted;
        st.rejected = h.rejected && st.meanA > st.meanB;
      } else {
        st.pAdjusted = undefined; // H0 control — no correction
        st.rejected = undefined;
      }
      stats.push(st);
    }

    // 3. Verdict (pre-registered, eval-design §6 / spec §2).
    //
    // The registered rule is EFFECT-SIZE based, NOT significance-gated: a
    // category counts as an architecture win iff A beats B by a MEANINGFUL
    // EFFECT SIZE (see the pre-registered thresholds in meaningfulAAdvantage).
    // Holm-adjusted significance (st.rejected /
    // st.pAdjusted) is still computed and REPORTED per category, but it does
    // NOT gate the verdict (gating it would be a protocol deviation that can,
    // at pilot N, report a true large effect as NOT SUPPORTED).
    const archWins = ARCH_SUBSET.filter((cat) => {
      const st = perCat.get(cat);
      return !!st && st.meaningfulAAdvantage;
    });
    const h0 = perCat.get('H0');
    const h0MeanA = h0 ? h0.meanA : NaN;
    const h0MeanB = h0 ? h0.meanB : NaN;
    // Control passes if there is no H0 item OR A does not beat B on H0 (no
    // meaningful A-advantage on the in-window control).
    const h0NoAAdvantage = !h0 || !h0.meaningfulAAdvantage;
    const supported = archWins.length >= 3 && h0NoAAdvantage;

    const line = supported
      ? `VERDICT (${comparison}): SUPPORTED — A beats B with a meaningful effect on ${archWins.length}/5 of {H2..H6} (${archWins.join(', ')}) and H0 shows no A-advantage (H0 A=${fmt(h0MeanA)} vs B=${fmt(h0MeanB)}).`
      : `VERDICT (${comparison}): NOT SUPPORTED — arch wins ${archWins.length}/5 of {H2..H6} (${archWins.join(', ') || 'none'}); H0 control ${h0NoAAdvantage ? 'OK' : 'FAILED (A>B on in-window control)'} (H0 A=${fmt(h0MeanA)} vs B=${fmt(h0MeanB)}). Reported honestly as a null/negative result.`;

    verdicts.push({
      comparison,
      archWins,
      h0NoAAdvantage,
      h0MeanA,
      h0MeanB,
      supported,
      line,
    });
  }

  return { stats, verdicts };
}

function fmt(x: number): string {
  return Number.isNaN(x) ? 'n/a' : x.toFixed(2);
}

/** Render the analysis as markdown (per comparison: a stats table + verdict). */
export function renderAnalysisMarkdown(result: AnalysisResult): string {
  const lines: string[] = [];
  lines.push(`## Statistical analysis (Phase 1)`);
  lines.push('');
  const comparisons = [...new Set(result.stats.map((s) => s.comparison))];
  for (const comparison of comparisons) {
    lines.push(`### ${comparison}`);
    lines.push('');
    lines.push(
      `| Cat | n | mean A | mean B | test | effect | p (raw) | p (Holm) | 95% CI diff (A−B) | reject |`,
    );
    lines.push(`| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |`);
    const subset = result.stats
      .filter((s) => s.comparison === comparison)
      .sort((a, b) => a.category.localeCompare(b.category));
    for (const s of subset) {
      const eff =
        s.effectKind === 'oddsRatio'
          ? `OR=${s.effectSize === Infinity ? '∞' : s.effectSize.toFixed(2)}`
          : `rb=${s.effectSize.toFixed(2)}`;
      const padj = s.pAdjusted == null ? 'control' : s.pAdjusted.toFixed(4);
      const rej = s.rejected == null ? '—' : s.rejected ? 'YES' : 'no';
      lines.push(
        `| ${s.category} | ${s.n} | ${s.meanA.toFixed(2)} | ${s.meanB.toFixed(2)} | ${s.test} | ${eff} | ${s.pRaw.toFixed(4)} | ${padj} | [${s.ciDiff.lo.toFixed(2)}, ${s.ciDiff.hi.toFixed(2)}] | ${rej} |`,
      );
    }
    lines.push('');
    const v = result.verdicts.find((x) => x.comparison === comparison);
    if (v) {
      lines.push(`**${v.line}**`);
      lines.push('');
    }
  }
  return lines.join('\n');
}
