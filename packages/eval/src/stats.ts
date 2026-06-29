/**
 * Phase 1 statistical layer (eval-design §6) — implemented from scratch in TS,
 * no scipy. Every routine is seeded where randomness is involved and is unit
 * tested against a hand-checked fixture (see `__tests__/stats.test.ts`).
 *
 * Provided:
 *  - {@link mcnemar}        — exact/binomial McNemar for paired binary outcomes,
 *                            with odds-ratio effect size.
 *  - {@link wilcoxon}       — Wilcoxon signed-rank for paired graded scores, with
 *                            rank-biserial correlation effect size.
 *  - {@link bootstrapCI}    — seeded bootstrap 95 % CI of a sample mean.
 *  - {@link bootstrapDiffCI}— seeded bootstrap 95 % CI of the paired mean diff.
 *  - {@link holmBonferroni} — Holm–Bonferroni step-down adjustment of a p vector.
 *
 * All p-values are two-sided.
 */

// ---------------------------------------------------------------------------
// Seeded RNG (mulberry32) — deterministic, no deps.
// ---------------------------------------------------------------------------

/** mulberry32 PRNG: fast, deterministic, good enough for resampling. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// McNemar's test (paired binary).
// ---------------------------------------------------------------------------

export interface McNemarResult {
  /** Discordant pair: A correct, B wrong. */
  b: number;
  /** Discordant pair: A wrong, B correct. */
  c: number;
  n: number;
  /** Two-sided p-value (exact binomial when b+c is small, χ² with continuity otherwise). */
  p: number;
  /**
   * Odds ratio effect size = b / c (A-over-B advantage among discordant pairs).
   * +Infinity when c=0 and b>0; NaN when there are no discordant pairs.
   */
  oddsRatio: number;
  method: 'exact' | 'chi2';
}

/**
 * McNemar's test on paired binary outcomes. `a` and `b` are equal-length arrays
 * of 0/1 (correct/incorrect) for condition A and condition B on the SAME items.
 * Discordant pairs drive the test: nB = #(A=1,B=0), nC = #(A=0,B=1).
 *
 * Exact (binomial) p is used when nB+nC ≤ 25 (avoids the χ² approximation that
 * is unreliable for the small discordant counts a pilot produces); otherwise the
 * continuity-corrected χ² is used.
 */
export function mcnemar(a: number[], b: number[]): McNemarResult {
  if (a.length !== b.length) throw new Error('mcnemar: arrays must be equal length');
  let nB = 0; // A right, B wrong
  let nC = 0; // A wrong, B right
  for (let i = 0; i < a.length; i++) {
    const ai = a[i] >= 0.5 ? 1 : 0;
    const bi = b[i] >= 0.5 ? 1 : 0;
    if (ai === 1 && bi === 0) nB++;
    else if (ai === 0 && bi === 1) nC++;
  }
  const disc = nB + nC;
  const oddsRatio = disc === 0 ? NaN : nC === 0 ? Number.POSITIVE_INFINITY : nB / nC;

  if (disc === 0) {
    return { b: nB, c: nC, n: a.length, p: 1, oddsRatio, method: 'exact' };
  }

  if (disc <= 25) {
    // Exact two-sided binomial test of nB ~ Binom(disc, 0.5).
    const p = twoSidedBinomialP(Math.min(nB, nC), disc);
    return { b: nB, c: nC, n: a.length, p, oddsRatio, method: 'exact' };
  }

  // Continuity-corrected χ² (1 df).
  const chi2 = Math.pow(Math.abs(nB - nC) - 1, 2) / disc;
  const p = chiSquarePValue1df(chi2);
  return { b: nB, c: nC, n: a.length, p, oddsRatio, method: 'chi2' };
}

/** Two-sided exact binomial p-value of `k` successes in `n` trials at q=0.5. */
function twoSidedBinomialP(k: number, n: number): number {
  // Symmetric q=0.5 case: two-sided p = P(X<=k) + P(X>=n-k). By symmetry the two
  // tails are equal, so p = 2·P(X<=k) — EXCEPT when k == n-k (i.e. the discordant
  // split is even and k is the central value n/2): then both tails share the same
  // central term X=k and doubling double-counts it. Subtract it once in that case
  // so the exact two-sided p is correct at the centre, not just conservative.
  let cum = 0;
  for (let i = 0; i <= k; i++) cum += binomPmf(i, n, 0.5);
  let p = 2 * cum;
  if (k === n - k) p -= binomPmf(k, n, 0.5);
  return Math.min(1, p);
}

/** Binomial PMF C(n,k) p^k (1-p)^(n-k), via log-gamma for numerical stability. */
function binomPmf(k: number, n: number, p: number): number {
  if (k < 0 || k > n) return 0;
  const logC = logGamma(n + 1) - logGamma(k + 1) - logGamma(n - k + 1);
  const logP = logC + k * Math.log(p) + (n - k) * Math.log(1 - p);
  return Math.exp(logP);
}

// ---------------------------------------------------------------------------
// Wilcoxon signed-rank (paired graded).
// ---------------------------------------------------------------------------

export interface WilcoxonResult {
  /** Number of non-zero paired differences used. */
  n: number;
  /** Sum of positive ranks. */
  wPlus: number;
  /** Sum of negative ranks. */
  wMinus: number;
  /** Test statistic W = min(wPlus, wMinus). */
  w: number;
  /** Two-sided p-value (normal approximation with tie + continuity correction). */
  p: number;
  /** Rank-biserial correlation effect size = (wPlus - wMinus) / (wPlus + wMinus). */
  rankBiserial: number;
}

/**
 * Wilcoxon signed-rank test on paired graded scores `a`, `b` (same items). Zero
 * differences are dropped (Wilcoxon convention). p uses the normal approximation
 * with tie correction + continuity correction (adequate for n≥~10; for the tiny
 * pilot it is reported alongside the effect size, which carries the weight per
 * eval-design §6).
 *
 * Effect size = rank-biserial correlation r = (W+ − W−)/(W+ + W−) ∈ [−1, 1];
 * +1 means A dominates B on every discordant pair.
 */
export function wilcoxon(a: number[], b: number[]): WilcoxonResult {
  if (a.length !== b.length) throw new Error('wilcoxon: arrays must be equal length');
  const diffs: number[] = [];
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    if (d !== 0) diffs.push(d);
  }
  const n = diffs.length;
  if (n === 0) {
    return { n: 0, wPlus: 0, wMinus: 0, w: 0, p: 1, rankBiserial: 0 };
  }

  // Rank by absolute value, averaging ties.
  const abs = diffs.map((d, i) => ({ v: Math.abs(d), sign: Math.sign(d), i }));
  abs.sort((x, y) => x.v - y.v);
  const ranks = new Array<number>(n);
  let i = 0;
  const tieGroups: number[] = [];
  while (i < n) {
    let j = i;
    while (j + 1 < n && abs[j + 1].v === abs[i].v) j++;
    const avgRank = (i + 1 + (j + 1)) / 2; // average of ranks i+1..j+1
    const groupSize = j - i + 1;
    if (groupSize > 1) tieGroups.push(groupSize);
    for (let k = i; k <= j; k++) ranks[k] = avgRank;
    i = j + 1;
  }

  let wPlus = 0;
  let wMinus = 0;
  for (let k = 0; k < n; k++) {
    if (abs[k].sign > 0) wPlus += ranks[k];
    else wMinus += ranks[k];
  }
  const w = Math.min(wPlus, wMinus);
  const rankBiserial = wPlus + wMinus > 0 ? (wPlus - wMinus) / (wPlus + wMinus) : 0;

  // Normal approximation with tie + continuity correction.
  const meanW = (n * (n + 1)) / 4;
  let varW = (n * (n + 1) * (2 * n + 1)) / 24;
  for (const t of tieGroups) varW -= (t * t * t - t) / 48;
  let p: number;
  if (varW <= 0) {
    p = 1;
  } else {
    const z = (Math.abs(w - meanW) - 0.5) / Math.sqrt(varW);
    p = 2 * (1 - standardNormalCdf(Math.max(0, z)));
    p = Math.min(1, Math.max(0, p));
  }

  return { n, wPlus, wMinus, w, p, rankBiserial };
}

// ---------------------------------------------------------------------------
// Bootstrap CIs (seeded).
// ---------------------------------------------------------------------------

export interface CI {
  mean: number;
  lo: number;
  hi: number;
  resamples: number;
}

/** Seeded bootstrap 95 % percentile CI of a sample mean. */
export function bootstrapCI(
  sample: number[],
  opts: { resamples?: number; seed?: number; alpha?: number } = {},
): CI {
  const resamples = opts.resamples ?? 10000;
  const seed = opts.seed ?? 12345;
  const alpha = opts.alpha ?? 0.05;
  const n = sample.length;
  const mean = n ? sample.reduce((s, x) => s + x, 0) / n : NaN;
  if (n === 0) return { mean: NaN, lo: NaN, hi: NaN, resamples };
  if (n === 1) return { mean, lo: mean, hi: mean, resamples };

  const rng = mulberry32(seed);
  const means = new Array<number>(resamples);
  for (let r = 0; r < resamples; r++) {
    let acc = 0;
    for (let i = 0; i < n; i++) acc += sample[(rng() * n) | 0];
    means[r] = acc / n;
  }
  means.sort((x, y) => x - y);
  return {
    mean,
    lo: percentile(means, alpha / 2),
    hi: percentile(means, 1 - alpha / 2),
    resamples,
  };
}

/**
 * Seeded bootstrap 95 % CI of the paired mean difference (A−B), resampling the
 * paired items (preserves the pairing — the right thing for A-vs-B on the same
 * items).
 */
export function bootstrapDiffCI(
  a: number[],
  b: number[],
  opts: { resamples?: number; seed?: number; alpha?: number } = {},
): CI {
  if (a.length !== b.length) throw new Error('bootstrapDiffCI: arrays must be equal length');
  const diffs = a.map((x, i) => x - b[i]);
  return bootstrapCI(diffs, opts);
}

function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const idx = q * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const frac = idx - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}

// ---------------------------------------------------------------------------
// Holm–Bonferroni.
// ---------------------------------------------------------------------------

export interface HolmResult<K extends string = string> {
  key: K;
  pRaw: number;
  pAdjusted: number;
  /** Rejected at the family-wise alpha (default 0.05). */
  rejected: boolean;
}

/**
 * Holm–Bonferroni step-down correction across a family of hypotheses. Returns
 * one row per input key in the SAME order as the input, each with its raw p, the
 * Holm-adjusted p (monotone-enforced), and whether it is rejected at `alpha`.
 */
export function holmBonferroni<K extends string>(
  entries: Array<{ key: K; p: number }>,
  alpha = 0.05,
): Array<HolmResult<K>> {
  const m = entries.length;
  if (m === 0) return [];
  // Sort ascending by raw p, remembering original index.
  const order = entries
    .map((e, idx) => ({ ...e, idx }))
    .sort((x, y) => x.p - y.p);

  const adjusted = new Array<number>(m);
  let runningMax = 0;
  for (let i = 0; i < m; i++) {
    const factor = m - i; // (m), (m-1), … per Holm step-down
    let adj = Math.min(1, order[i].p * factor);
    adj = Math.max(adj, runningMax); // enforce monotone non-decreasing
    runningMax = adj;
    adjusted[i] = adj;
  }

  // Map back to original order; rejected iff adjusted p < alpha.
  const out: Array<HolmResult<K>> = new Array(m);
  for (let i = 0; i < m; i++) {
    const e = order[i];
    out[e.idx] = {
      key: e.key,
      pRaw: e.p,
      pAdjusted: adjusted[i],
      // Standard step-down Holm rejects at adjusted p ≤ alpha (textbook
      // boundary; only affects the measure-zero p == alpha case).
      rejected: adjusted[i] <= alpha,
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Numerical helpers: log-gamma, standard normal CDF, χ² (1 df) p-value.
// ---------------------------------------------------------------------------

/** Lanczos approximation of ln Γ(x). */
export function logGamma(x: number): number {
  const g = 7;
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) {
    // Reflection formula.
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  }
  x -= 1;
  let a = c[0];
  const t = x + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Standard normal CDF via the erf approximation (Abramowitz & Stegun 7.1.26). */
export function standardNormalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}

/**
 * Two-sided p-value for a χ² statistic with 1 degree of freedom. For 1 df,
 * P(χ² > x) = 2·(1 − Φ(√x)) = erfc(√(x/2)).
 */
export function chiSquarePValue1df(chi2: number): number {
  if (chi2 <= 0) return 1;
  return 2 * (1 - standardNormalCdf(Math.sqrt(chi2)));
}
