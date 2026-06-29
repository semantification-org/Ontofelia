/**
 * #986 — Recall macro-tools must read the graphs storeFact() actually writes.
 *
 * Regression for the bug where `getFactsAbout`, `getRecentFacts` and
 * `listKnownEntities` all queried `urn:ontofelia:agent:<agent>:abox` — a graph
 * NOTHING writes to — while `storeFact()`/`resolveTargetGraph()` write to
 * `urn:<agent>:worldview` and `urn:<agent>:user:<userId>`. In the live runtime
 * the recall functions therefore returned nothing.
 *
 * This test does a real round-trip on the embedded OxigraphAdapter (the store
 * the live runtime uses, whose default graph is empty — see
 * PrivacyGraphIsolation.test.ts): store facts, then read them back through the
 * three recall functions. It also pins the per-user isolation guarantee (#869):
 * one user's private user-graph facts must not leak into another user's recall.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { OxigraphAdapter } from '../adapters/OxigraphAdapter.js';
import { KnowledgeEngine } from '../KnowledgeEngine.js';

const AGENT = 'ontofelia';

async function makeEngine(): Promise<KnowledgeEngine> {
  const store = new OxigraphAdapter();
  await store.initialize({
    backend: 'oxigraph',
    type: 'embedded',
    dataDir: `/tmp/recall-986-${Math.random().toString(16).slice(2)}`,
    port: 0,
    endpoint: '',
  });
  return new KnowledgeEngine(store as never);
}

describe('#986 — recall reads the graphs storeFact writes (not the dead :abox)', () => {
  let engine: KnowledgeEngine;
  const aliceCtx = { agentId: AGENT, userId: 'alice', sessionId: 's1', isOwner: false };

  beforeEach(async () => {
    engine = await makeEngine();
    // A worldview fact (third-party subject → urn:ontofelia:worldview).
    await engine.storeFact(
      { subject: 'Anna', subjectType: 'Person', predicate: 'livesIn',
        object: 'Hamburg', objectType: 'Place', sourceKind: 'user' },
      aliceCtx,
    );
    // A user-graph fact (subject denotes the current user → urn:ontofelia:user:alice).
    await engine.storeFact(
      { subject: 'User', subjectType: 'Person', predicate: 'likes',
        object: 'Tea', objectType: 'literal', sourceKind: 'user' },
      aliceCtx,
    );
  });

  it('getRecentFacts surfaces stored facts (was always empty before the fix)', async () => {
    const facts = await engine.getRecentFacts(AGENT, 30, 'alice');
    expect(facts).not.toBe('');
    expect(facts).toContain('Hamburg'); // worldview fact
    expect(facts).toContain('Tea');     // user-graph fact
  });

  it('getFactsAbout returns entity-specific facts with a resolved predicate label', async () => {
    const facts = await engine.getFactsAbout(['Anna'], AGENT, 20, 'alice');
    expect(facts).toContain('Anna');
    expect(facts).toContain('Hamburg');
    // The predicate label resolves across named graphs (schema graph), so it is
    // not rendered as the '?' placeholder the old default-graph join produced.
    expect(facts.toLowerCase()).toContain('lives');
  });

  it('listKnownEntities returns labels written by storeFact (feeds NER)', async () => {
    const ents = await engine.listKnownEntities(AGENT, 'alice');
    expect(ents).toContain('Anna');
    expect(ents).toContain('Hamburg');
  });

  it('per-user isolation: another user does not see alice\'s private facts (#869)', async () => {
    const bobView = await engine.getRecentFacts(AGENT, 30, 'bob');
    // Worldview is shared across users → Hamburg is visible.
    expect(bobView).toContain('Hamburg');
    // Alice's user-graph fact must NOT leak into Bob's recall.
    expect(bobView).not.toContain('Tea');
  });

  it('without a userId, recall still returns shared worldview facts (back-compat)', async () => {
    const facts = await engine.getRecentFacts(AGENT, 30);
    expect(facts).toContain('Hamburg');
    // No user graph requested → no user-private fact.
    expect(facts).not.toContain('Tea');
  });
});
