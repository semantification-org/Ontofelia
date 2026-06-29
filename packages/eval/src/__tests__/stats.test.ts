import { describe, it, expect } from 'vitest';
import {
  mcnemar,
  wilcoxon,
  bootstrapCI,
  bootstrapDiffCI,
  holmBonferroni,
  logGamma,
  standardNormalCdf,
  chiSquarePValue1df,
  mulberry32,
} from '../stats.js';

describe('stats: numerical helpers', () => {
  it('logGamma matches known factorials: Γ(n)=(n-1)!', () => {
    expect(Math.exp(logGamma(1))).toBeCloseTo(1, 6); // 0!
    expect(Math.exp(logGamma(2))).toBeCloseTo(1, 6); // 1!
    expect(Math.exp(logGamma(5))).toBeCloseTo(24, 4); // 4!
    expect(Math.exp(logGamma(6))).toBeCloseTo(120, 3); // 5!
    // Γ(0.5) = √π
    expect(Math.exp(logGamma(0.5))).toBeCloseTo(Math.sqrt(Math.PI), 5);
  });

  it('standardNormalCdf matches reference values', () => {
    expect(standardNormalCdf(0)).toBeCloseTo(0.5, 6);
    expect(standardNormalCdf(1.96)).toBeCloseTo(0.975, 3);
    expect(standardNormalCdf(-1.96)).toBeCloseTo(0.025, 3);
    expect(standardNormalCdf(1)).toBeCloseTo(0.8413, 3);
  });

  it('chiSquarePValue1df matches a hand-checked value', () => {
    // χ²=3.841 at 1 df → p≈0.05 (the classic critical value).
    expect(chiSquarePValue1df(3.841)).toBeCloseTo(0.05, 2);
    // χ²=0 → p=1.
    expect(chiSquarePValue1df(0)).toBe(1);
  });
});

describe('stats: McNemar (paired binary)', () => {
  it('hand-checked discordant counts + odds ratio', () => {
    // Items: A=[1,1,1,0,1,1,0,1], B=[0,0,1,0,0,1,1,1]
    // Discordant A=1,B=0 (b): indices 0,1,4 → 3
    // Discordant A=0,B=1 (c): index 6 → 1
    const a = [1, 1, 1, 0, 1, 1, 0, 1];
    const b = [0, 0, 1, 0, 0, 1, 1, 1];
    const r = mcnemar(a, b);
    expect(r.b).toBe(3);
    expect(r.c).toBe(1);
    expect(r.oddsRatio).toBe(3); // 3/1
    expect(r.method).toBe('exact');
    // Exact two-sided binomial: 2 * P(X<=1 | n=4, p=0.5)
    // P(X<=1) = C(4,0)/16 + C(4,1)/16 = (1+4)/16 = 5/16 = 0.3125 → *2 = 0.625
    expect(r.p).toBeCloseTo(0.625, 6);
  });

  it('no discordant pairs → p=1, oddsRatio NaN', () => {
    const r = mcnemar([1, 1, 0, 0], [1, 1, 0, 0]);
    expect(r.b).toBe(0);
    expect(r.c).toBe(0);
    expect(r.p).toBe(1);
    expect(Number.isNaN(r.oddsRatio)).toBe(true);
  });

  it('all-discordant in A favour → small p, oddsRatio +Inf', () => {
    const a = [1, 1, 1, 1, 1];
    const b = [0, 0, 0, 0, 0];
    const r = mcnemar(a, b);
    expect(r.b).toBe(5);
    expect(r.c).toBe(0);
    expect(r.oddsRatio).toBe(Number.POSITIVE_INFINITY);
    // 2 * P(X<=0 | n=5, p=0.5) = 2 * (1/32) = 0.0625
    expect(r.p).toBeCloseTo(0.0625, 6);
  });

  it('exact two-sided p of a balanced split (b==c) is 1 (central-term guard)', () => {
    // b=2 (A-wins), c=2 (B-wins): a perfectly balanced discordant split → the
    // exact two-sided p must be 1.0. This exercises the k==n-k central-term
    // double-count guard in twoSidedBinomialP (no over-count past the cap).
    const a = [1, 1, 0, 0];
    const b = [0, 0, 1, 1];
    const r = mcnemar(a, b);
    expect(r.b).toBe(2);
    expect(r.c).toBe(2);
    expect(r.method).toBe('exact');
    expect(r.p).toBeCloseTo(1, 9);
  });

  it('χ² path p-value matches an independent reference (disc=26, all A-wins)', () => {
    // 26 discordant pairs, all A-wins → χ² method (>25). Independent reference:
    //   χ² = (|26-0|-1)^2 / 26 = 625/26 = 24.0385
    //   p  = 2·(1 − Φ(√24.0385)) = 2·(1 − Φ(4.9029)) ≈ 9.4566e-7
    const a: number[] = [];
    const b: number[] = [];
    for (let i = 0; i < 26; i++) {
      a.push(1);
      b.push(0);
    }
    const r = mcnemar(a, b);
    expect(r.method).toBe('chi2');
    expect(r.p).toBeCloseTo(9.4566e-7, 10);
  });

  it('uses χ² method when discordant count is large', () => {
    // 30 A-wins, 0 B-wins among 30 discordant pairs (>25 threshold).
    const a: number[] = [];
    const b: number[] = [];
    for (let i = 0; i < 30; i++) {
      a.push(1);
      b.push(0);
    }
    const r = mcnemar(a, b);
    expect(r.method).toBe('chi2');
    // χ² = (|30-0|-1)^2 / 30 = 29^2/30 = 28.03 → p very small
    expect(r.p).toBeLessThan(0.001);
  });
});

describe('stats: Wilcoxon signed-rank (paired graded)', () => {
  it('hand-checked ranks, W, and rank-biserial', () => {
    // Differences a-b = [+1, -2, +3, +4, -5] (n=5, no ties, no zeros).
    // |d| sorted: 1(+),2(-),3(+),4(+),5(-) → ranks 1,2,3,4,5
    // W+ = 1+3+4 = 8 ; W- = 2+5 = 7 ; W = min = 7
    const a = [1, 0, 3, 4, 0];
    const b = [0, 2, 0, 0, 5];
    const r = wilcoxon(a, b);
    expect(r.n).toBe(5);
    expect(r.wPlus).toBe(8);
    expect(r.wMinus).toBe(7);
    expect(r.w).toBe(7);
    // rank-biserial = (8-7)/(8+7) = 1/15
    expect(r.rankBiserial).toBeCloseTo(1 / 15, 6);
  });

  it('p-value matches an independent reference (all-A n=8, tie+continuity)', () => {
    // a=8 ones vs b=8 zeros → 8 positive diffs of equal magnitude (one tie group
    // of 8). Independent reference with the tie + continuity correction:
    //   W=min(W+,W−)=0, meanW=n(n+1)/4=18, varW=n(n+1)(2n+1)/24 − (8³−8)/48
    //               = 51 − 10.5 = 40.5
    //   z=(|0−18|−0.5)/√40.5 = 17.5/6.36396 = 2.7499
    //   p=2·(1−Φ(2.7499)) ≈ 0.005962
    const a = [1, 1, 1, 1, 1, 1, 1, 1];
    const b = [0, 0, 0, 0, 0, 0, 0, 0];
    const r = wilcoxon(a, b);
    expect(r.w).toBe(0);
    expect(r.rankBiserial).toBe(1);
    expect(r.p).toBeCloseTo(0.005962, 6);
  });

  it('drops zero differences', () => {
    // a-b = [0, +1, 0, +2] → only two non-zero diffs, both positive.
    const a = [5, 1, 9, 2];
    const b = [5, 0, 9, 0];
    const r = wilcoxon(a, b);
    expect(r.n).toBe(2);
    expect(r.wMinus).toBe(0);
    expect(r.rankBiserial).toBe(1); // A dominates every discordant pair
  });

  it('handles ties in absolute differences (averaged ranks)', () => {
    // diffs = [+1,+1,-1] → |d| all 1, ranks averaged = (1+2+3)/3 = 2 each.
    // W+ = 2+2 = 4 ; W- = 2 ; W = 2.
    const a = [1, 1, 0];
    const b = [0, 0, 1];
    const r = wilcoxon(a, b);
    expect(r.wPlus).toBe(4);
    expect(r.wMinus).toBe(2);
    expect(r.w).toBe(2);
  });

  it('identical inputs → n=0, p=1', () => {
    const r = wilcoxon([1, 2, 3], [1, 2, 3]);
    expect(r.n).toBe(0);
    expect(r.p).toBe(1);
  });
});

describe('stats: bootstrap CIs (seeded + deterministic)', () => {
  it('is deterministic for a fixed seed', () => {
    const sample = [1, 1, 0, 1, 0, 1, 1, 0, 1, 1];
    const a = bootstrapCI(sample, { resamples: 2000, seed: 42 });
    const b = bootstrapCI(sample, { resamples: 2000, seed: 42 });
    expect(a.lo).toBe(b.lo);
    expect(a.hi).toBe(b.hi);
    expect(a.mean).toBeCloseTo(0.7, 6);
  });

  it('CI brackets the sample mean and lo<=mean<=hi', () => {
    const sample = [0.2, 0.4, 0.6, 0.8, 1.0, 0.3, 0.5, 0.7];
    const ci = bootstrapCI(sample, { resamples: 5000, seed: 7 });
    expect(ci.lo).toBeLessThanOrEqual(ci.mean);
    expect(ci.hi).toBeGreaterThanOrEqual(ci.mean);
    expect(ci.mean).toBeCloseTo(0.5625, 6);
  });

  it('degenerate samples: n=0 → NaN, n=1 → point CI', () => {
    const z = bootstrapCI([], {});
    expect(Number.isNaN(z.mean)).toBe(true);
    const one = bootstrapCI([0.5], {});
    expect(one.lo).toBe(0.5);
    expect(one.hi).toBe(0.5);
  });

  it('paired diff CI of a clear A-advantage is positive', () => {
    const a = [1, 1, 1, 1, 1, 1, 1, 1];
    const b = [0, 0, 0, 1, 0, 0, 0, 0];
    const ci = bootstrapDiffCI(a, b, { resamples: 5000, seed: 99 });
    expect(ci.mean).toBeCloseTo(0.875, 6);
    expect(ci.lo).toBeGreaterThan(0);
  });
});

describe('stats: Holm–Bonferroni', () => {
  it('hand-checked adjustment + monotonicity', () => {
    // m=4 p-values; sorted: 0.005,0.01,0.03,0.04
    // step factors 4,3,2,1 → 0.02,0.03,0.06,0.04 → monotone: 0.02,0.03,0.06,0.06
    const res = holmBonferroni([
      { key: 'H1', p: 0.04 },
      { key: 'H2', p: 0.005 },
      { key: 'H3', p: 0.03 },
      { key: 'H4', p: 0.01 },
    ]);
    const byKey = Object.fromEntries(res.map((r) => [r.key, r]));
    expect(byKey.H2.pAdjusted).toBeCloseTo(0.02, 6);
    expect(byKey.H4.pAdjusted).toBeCloseTo(0.03, 6);
    expect(byKey.H3.pAdjusted).toBeCloseTo(0.06, 6);
    expect(byKey.H1.pAdjusted).toBeCloseTo(0.06, 6); // pulled up to monotone max
    // At alpha=0.05: H2 (0.02) and H4 (0.03) reject; H3/H1 (0.06) do not.
    expect(byKey.H2.rejected).toBe(true);
    expect(byKey.H4.rejected).toBe(true);
    expect(byKey.H3.rejected).toBe(false);
    expect(byKey.H1.rejected).toBe(false);
    // output order preserved as input order
    expect(res.map((r) => r.key)).toEqual(['H1', 'H2', 'H3', 'H4']);
  });

  it('preserves input order and handles a single hypothesis', () => {
    const res = holmBonferroni([{ key: 'H2', p: 0.01 }]);
    expect(res.length).toBe(1);
    expect(res[0].pAdjusted).toBeCloseTo(0.01, 6);
    expect(res[0].rejected).toBe(true);
  });
});

describe('stats: RNG determinism', () => {
  it('mulberry32 is reproducible and in [0,1)', () => {
    const r1 = mulberry32(123);
    const r2 = mulberry32(123);
    for (let i = 0; i < 100; i++) {
      const x = r1();
      expect(x).toBe(r2());
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });
});
