import { describe, it, expect, afterEach } from 'vitest';
import { makeEnv, send, stream, seedSkillAndSelf, cleanup, GOLDEN_SECTIONS, type Env } from './promptHarness.js';

// Golden prompt: with every prompt flag off, the system prompt is byte-for-byte
// what the goal / skill / self strings have always produced. The expected text
// is the legacy-path prompt (cycle off) plus the literal blocks below, spliced
// the way the runtime has always spliced them (appended after the context).
// This file uses only long-standing APIs, so it also passes on the commit before
// the prompt assembler existed.

const CYCLE_FLAGS = ['flagCycleManager', 'flagEpisodicMemory', 'flagGoalStack', 'flagProceduralMemory', 'flagSelfModelQuery'];
const ASK = 'what is oxigraph?';

describe('golden system prompt with every prompt flag off', () => {
  const made: Env[] = [];
  afterEach(async () => { await cleanup(made); made.length = 0; });
  const seed = async ({ store }: Pick<Env, 'store'>) => seedSkillAndSelf(store);

  it('plain: legacy prompt + the literal goal / skills / self blocks, byte for byte', async () => {
    const legacy = await makeEnv({ seed }); made.push(legacy);
    await send(legacy, ASK);
    const on = await makeEnv({ flags: CYCLE_FLAGS, seed }); made.push(on);
    await send(on, ASK);
    expect(legacy.probe.answers).toHaveLength(1);
    expect(on.probe.answers).toHaveLength(1);
    expect(on.probe.answers[0].system).toBe(`${legacy.probe.answers[0].system}\n\n${GOLDEN_SECTIONS}`);
  });

  it('streamed: identical to the plain prompt', async () => {
    const legacy = await makeEnv({ seed }); made.push(legacy);
    await send(legacy, ASK);
    const on = await makeEnv({ flags: CYCLE_FLAGS, seed }); made.push(on);
    await stream(on, ASK);
    expect(on.probe.answers).toHaveLength(1);
    expect(on.probe.answers[0].system).toBe(`${legacy.probe.answers[0].system}\n\n${GOLDEN_SECTIONS}`);
  });
});
