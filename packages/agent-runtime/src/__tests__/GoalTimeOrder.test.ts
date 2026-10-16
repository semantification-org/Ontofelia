import { describe, it, expect, beforeEach } from 'vitest';
import { OxigraphAdapter, GraphRegistry, GraphUriResolver } from '@ontofelia/semantic-memory';
import type { TriplestoreAdapter, MessageEnvelope } from '@ontofelia/core';
import { CycleManager } from '../cognitive/CycleManager.js';
import { GoalStack, GOAL_TYPES } from '../cognitive/GoalStack.js';
import { orderGoals } from '../cognitive/goalSummary.js';

// The store returns xsd:dateTime with the trailing zeros of the fraction cut
// ("...41.4Z" for .400), so timestamps must be compared as instants, never as
// strings: as strings "41.4Z" sorts after "41.431Z" because "Z" > "3".

const AGENT = 'ontofelia';
const COGT = 'urn:shared:ontology#cog/';
const ALICE = { id: 'alice', channelPrefix: 'webchat', isOwner: false };
const OLDER = new Date('2026-10-15T19:51:41.400Z'); // stored and read back as "...41.4Z"
const NEWER = new Date('2026-10-15T19:51:41.431Z');

async function makeStore(): Promise<TriplestoreAdapter> {
  const store = new OxigraphAdapter();
  await store.initialize({
    backend: 'oxigraph',
    type: 'embedded',
    dataDir: `/tmp/goal-time-test-${process.pid}-${Math.random().toString(16).slice(2)}`,
    port: 0,
    endpoint: '',
  });
  return store;
}

describe('goals are ordered by instant, not by timestamp string', () => {
  let store: TriplestoreAdapter;
  let registry: GraphRegistry;
  let gs: GoalStack;
  let older: string;
  let newer: string;
  const sess = 'sess_time_1';

  beforeEach(async () => {
    store = await makeStore();
    registry = GraphRegistry.create([AGENT]);
    gs = new GoalStack(store, registry, AGENT, sess);
    const base = { goalType: GOAL_TYPES.AnswerQuestion, priority: 0.7, forUser: 'alice' };
    older = await gs.push({ ...base, goalLabel: 'older' }, OLDER);
    newer = await gs.push({ ...base, goalLabel: 'newer' }, NEWER);
  });

  it('the fixture trips the lexical order (control)', async () => {
    const [o, n] = [await gs.get(older), await gs.get(newer)];
    expect(o!.createdAt < n!.createdAt).toBe(false); // lexical order is wrong here
    expect(Date.parse(o!.createdAt)).toBeLessThan(Date.parse(n!.createdAt));
  });

  it('active() and list() put the newer goal first', async () => {
    expect((await gs.active()).map((g) => g.uri)).toEqual([newer, older]);
    expect((await gs.list()).map((g) => g.uri)).toEqual([newer, older]);
  });

  it('orderGoals puts the newer goal first', async () => {
    const goals = await gs.list();
    expect(orderGoals([...goals].reverse()).map((g) => g.uri)).toEqual([newer, older]);
  });

  it('the newer goal wins the competition', async () => {
    const cm = new CycleManager(store, registry, AGENT, undefined, { awaitPersist: true });
    const env = {
      id: 'm1', channel: 'webchat', accountId: 'acc1', chatType: 'web', sender: ALICE,
      timestamp: new Date().toISOString(), text: 'ok', mentions: [], attachments: [],
    } as MessageEnvelope;
    await cm.runCycle(
      env,
      async (_rt, prepareGoals, recordInbound) => {
        await recordInbound(sess);
        await prepareGoals(sess);
        return { text: 'ok', sessionId: sess };
      },
      (r) => r.sessionId,
      (r) => r.text,
      { goalsEnabled: true, episodicEnabled: true },
    );
    const rows =
      (await store.query(`SELECT ?w WHERE { GRAPH <${GraphUriResolver.getCogCyclesGraph(AGENT, sess)}> {
        ?r a <${COGT}ChooseGoal> ; <${COGT}winner> ?w } }`)).bindings ?? [];
    expect(rows.map((r) => r.w.value)).toEqual([newer]);
  });
});
