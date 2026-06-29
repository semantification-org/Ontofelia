/**
 * Phase 1 real LLM judge (eval-design §4).
 *
 * {@link LlmJudge} implements the {@link Judge} interface using a
 * {@link ProviderAdapter} (the configured provider) at temperature 0, with a
 * strict rubric prompt. It is used ONLY for free-text categories (H0/H1) where
 * a strict lexical match is too brittle; closed categories (H2..H6) stay
 * programmatic.
 *
 * It is mockable: pass any ProviderAdapter, including the offline FakeProvider.
 * The offline smoke continues to use the deterministic OfflineLexicalJudge.
 *
 * κ-support: {@link JudgeSampler} records a random sample of judged free-text
 * items for export to a κ file (judge vs human agreement, computed by the
 * `score-kappa` script).
 */

import type { ProviderAdapter, ChatMessage } from '@ontofelia/core';
import type { Judge } from './scorer.js';
import { mulberry32 } from './stats.js';

const RUBRIC = [
  'You are a STRICT grader for a memory-evaluation benchmark.',
  'You are given a QUESTION, the GOLD answer (the single correct fact), and a',
  'candidate ANSWER produced by an assistant.',
  'Score the ANSWER 1 if and only if it clearly and correctly states the GOLD',
  'fact (paraphrase / synonym / different surface form is fine, as long as the',
  'fact is unambiguously correct). Score 0 if the answer is wrong, hedged into',
  'uselessness, says it does not know, contradicts the gold, or omits the fact.',
  'Be strict: partial or tangential mentions that do not actually answer the',
  'question score 0. Do NOT reward verbosity.',
  'Respond with ONLY a compact JSON object on a single line:',
  '{"score": 0 or 1, "rationale": "<=15 words"}',
].join(' ');

export interface LlmJudgeConfig {
  provider: ProviderAdapter;
  model: string;
  temperature?: number;
  maxTokens?: number;
  /** Optional sampler that captures judged items for the κ export. */
  sampler?: JudgeSampler;
}

export interface JudgedItem {
  question: string;
  gold: string;
  answer: string;
  judgeScore: number;
  rationale: string;
  /** Blank slot for a human grader to fill in for κ computation. */
  humanScore: number | null;
}

/**
 * Reservoir-free seeded sampler: each judged free-text item is recorded with a
 * fixed probability (default 0.2 ≈ ≥20% of items), deterministic for a seed.
 */
export class JudgeSampler {
  private items: JudgedItem[] = [];
  private rng: () => number;
  constructor(
    private rate = 0.2,
    seed = 20260613,
  ) {
    this.rng = mulberry32(seed);
  }
  consider(item: Omit<JudgedItem, 'humanScore'>): void {
    if (this.rng() < this.rate) this.items.push({ ...item, humanScore: null });
  }
  /** Force-record (used to guarantee ≥1 sample in tiny offline runs). */
  record(item: Omit<JudgedItem, 'humanScore'>): void {
    this.items.push({ ...item, humanScore: null });
  }
  get sample(): JudgedItem[] {
    return this.items;
  }
  toJsonl(): string {
    return this.items.map((i) => JSON.stringify(i)).join('\n') + (this.items.length ? '\n' : '');
  }
}

export class LlmJudge implements Judge {
  constructor(private cfg: LlmJudgeConfig) {}

  async judge(args: { question: string; gold: string; answer: string }): Promise<{
    score: number;
    rationale: string;
  }> {
    const messages: ChatMessage[] = [
      { role: 'system', content: RUBRIC },
      {
        role: 'user',
        content: [
          `QUESTION: ${args.question}`,
          `GOLD: ${args.gold}`,
          `ANSWER: ${args.answer}`,
          '',
          'Return ONLY the JSON object.',
        ].join('\n'),
      },
    ];
    const res = await this.cfg.provider.chat({
      model: this.cfg.model,
      messages,
      temperature: this.cfg.temperature ?? 0,
      maxTokens: this.cfg.maxTokens ?? 64,
    });
    const { score, rationale } = parseJudgeResponse(res.content ?? '');
    this.cfg.sampler?.consider({
      question: args.question,
      gold: args.gold,
      answer: args.answer,
      judgeScore: score,
      rationale,
    });
    return { score, rationale };
  }
}

/** Parse the strict-JSON judge reply; tolerate stray prose around the JSON. */
export function parseJudgeResponse(content: string): { score: number; rationale: string } {
  const match = content.match(/\{[^}]*\}/);
  if (match) {
    try {
      const obj = JSON.parse(match[0]) as { score?: unknown; rationale?: unknown };
      const raw = typeof obj.score === 'number' ? obj.score : Number(obj.score);
      const score = raw >= 0.5 ? 1 : 0;
      const rationale = typeof obj.rationale === 'string' ? obj.rationale : '';
      return { score, rationale };
    } catch {
      /* fall through */
    }
  }
  // Fallback: look for a leading 0/1.
  const m2 = content.match(/\b([01])\b/);
  return { score: m2 ? Number(m2[1]) : 0, rationale: 'unparsed judge reply' };
}

// ---------------------------------------------------------------------------
// Cohen's κ (judge vs human) — used by the score-kappa script.
// ---------------------------------------------------------------------------

export interface KappaResult {
  n: number;
  /** Observed agreement. */
  po: number;
  /** Expected (chance) agreement. */
  pe: number;
  kappa: number;
  /** Confusion: both-1, both-0, judge1-human0, judge0-human1. */
  confusion: { agree1: number; agree0: number; j1h0: number; j0h1: number };
  warn: boolean;
}

/**
 * Cohen's κ for two binary raters (judge vs human) over the items that have a
 * non-null humanScore. Warns when κ < 0.7 (rubric must be revised before trust).
 */
export function cohensKappa(items: JudgedItem[], threshold = 0.7): KappaResult {
  const rated = items.filter((i) => i.humanScore != null);
  const n = rated.length;
  let agree1 = 0;
  let agree0 = 0;
  let j1h0 = 0;
  let j0h1 = 0;
  for (const it of rated) {
    const j = it.judgeScore >= 0.5 ? 1 : 0;
    const h = (it.humanScore as number) >= 0.5 ? 1 : 0;
    if (j === 1 && h === 1) agree1++;
    else if (j === 0 && h === 0) agree0++;
    else if (j === 1 && h === 0) j1h0++;
    else j0h1++;
  }
  if (n === 0) {
    return { n, po: NaN, pe: NaN, kappa: NaN, confusion: { agree1, agree0, j1h0, j0h1 }, warn: true };
  }
  const po = (agree1 + agree0) / n;
  const j1 = (agree1 + j1h0) / n;
  const h1 = (agree1 + j0h1) / n;
  const j0 = 1 - j1;
  const h0 = 1 - h1;
  const pe = j1 * h1 + j0 * h0;
  const kappa = pe === 1 ? 1 : (po - pe) / (1 - pe);
  return { n, po, pe, kappa, confusion: { agree1, agree0, j1h0, j0h1 }, warn: kappa < threshold };
}
