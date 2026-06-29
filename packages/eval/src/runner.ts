import type {
  Scenario,
  ScenarioTurn,
  MemoryBackend,
  IngestTurn,
  TranscriptRow,
  ProbeTurn,
} from './types.js';
import { AnswerLlm } from './answerLlm.js';

export interface RunnerOptions {
  /** Size of the rolling window (most recent turns shown to the LLM). */
  windowSize?: number;
}

/**
 * Replay a scenario against one backend (spec §6).
 *
 * assert/mutate/retract → ingest; pad → push N distractor turns into the rolling
 * window AND (for A/B) ingest them as noise; probe → for each paraphrase, build
 * the prompt with retrieve(query) and call the answer LLM.
 */
export async function runScenario(
  backend: MemoryBackend,
  scenario: Scenario,
  llm: AnswerLlm,
  opts: RunnerOptions = {},
): Promise<TranscriptRow[]> {
  const windowSize = opts.windowSize ?? 12;
  const rows: TranscriptRow[] = [];
  const rolling: string[] = [];

  backend.configureScenario?.({ agentId: scenario.agentId, userId: scenario.userId });
  await backend.reset();

  let ts = Date.parse('2026-01-01T00:00:00Z');
  const nextTs = () => new Date((ts += 1000)).toISOString();
  // Ground-truth ingest timestamp per source turn id (for H4 tsTolerance).
  const turnTs = new Map<string, string>();

  for (const turn of scenario.turns) {
    switch (turn.kind) {
      case 'assert':
      case 'mutate':
      case 'retract': {
        const turnTimestamp = nextTs();
        turnTs.set(turn.id, turnTimestamp);
        const ingest: IngestTurn = {
          id: turn.id,
          speaker: 'user',
          text: turn.text,
          ts: turnTimestamp,
          fact: turn.fact,
          entities: turn.entities,
          retract: turn.kind === 'retract',
          supersedes: turn.kind === 'mutate' ? turn.supersedes : undefined,
        };
        await backend.ingest(ingest);
        pushWindow(rolling, turn.text, windowSize);
        break;
      }
      case 'pad': {
        const texts = padTexts(turn, scenario.id);
        for (let i = 0; i < texts.length; i++) {
          const text = texts[i];
          pushWindow(rolling, text, windowSize);
          // For A/B, ingest distractors as noise (no-memory ignores them anyway).
          if (backend.name !== 'no-memory') {
            await backend.ingest({
              id: `${scenario.id}-pad-${rows.length}-${i}`,
              speaker: 'user',
              text,
              ts: nextTs(),
            });
          }
        }
        break;
      }
      case 'probe': {
        await runProbe(backend, scenario, turn, llm, rolling, rows, turnTs);
        break;
      }
    }
  }

  await backend.close?.();
  return rows;
}

async function runProbe(
  backend: MemoryBackend,
  scenario: Scenario,
  probe: ProbeTurn,
  llm: AnswerLlm,
  rolling: string[],
  rows: TranscriptRow[],
  turnTs: Map<string, string>,
): Promise<void> {
  // Expected ingest ts of the probe's gold source turn (H4 tsTolerance).
  const expectedTs =
    probe.gold.type === 'provenance' ? turnTs.get(probe.gold.sourceTurnId) : undefined;
  const paraphrases = [probe.query, ...(probe.paraphrases ?? [])];
  for (const paraphrase of paraphrases) {
    const ctx = await backend.retrieve(paraphrase, {
      entities: probe.entities,
      hops: probe.hops,
    });
    const result = await llm.answer({
      retrievedContext: ctx.text,
      rollingWindow: rolling.slice(-rolling.length),
      probe: paraphrase,
    });
    rows.push({
      scenarioId: scenario.id,
      probeId: probe.id,
      category: probe.category,
      backend: backend.name,
      model: llm.model,
      paraphrase,
      answer: result.answer,
      tokens: result.tokens,
      latencyMs: result.latencyMs,
      retrieveMeta: ctx.meta,
      expectedTs,
    });
  }
}

function pushWindow(rolling: string[], text: string, size: number): void {
  rolling.push(text);
  while (rolling.length > size) rolling.shift();
}

function padTexts(turn: Extract<ScenarioTurn, { kind: 'pad' }>, scenarioId: string): string[] {
  if (turn.texts && turn.texts.length) return turn.texts;
  const out: string[] = [];
  for (let i = 0; i < turn.count; i++) {
    out.push(`Distractor note ${i + 1} for ${scenarioId}: the weather log and unrelated chatter continue.`);
  }
  return out;
}
