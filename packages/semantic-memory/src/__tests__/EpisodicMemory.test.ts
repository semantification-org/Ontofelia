import { describe, it, expect, beforeEach } from 'vitest';
import type { TriplestoreAdapter } from '@ontofelia/core';
import { OxigraphAdapter } from '../adapters/OxigraphAdapter.js';
import { EpisodicMemory } from '../cognitive/EpisodicMemory.js';

// As with WorkingMemory, episodic memory is a SPARQL projection; the only
// faithful in-process backend is the embedded Oxigraph store (the
// InMemoryAdapter has no SPARQL), so these unit tests run against Oxigraph.

const AGENT = 'ontofelia';
const SESS = 'sess_ep_1';

async function makeStore(): Promise<TriplestoreAdapter> {
  const store = new OxigraphAdapter();
  await store.initialize({
    backend: 'oxigraph',
    type: 'embedded',
    dataDir: `/tmp/ep-test-${Math.random().toString(16).slice(2)}`,
    port: 0,
    endpoint: '',
  });
  return store;
}

describe('EpisodicMemory', () => {
  let store: TriplestoreAdapter;
  let em: EpisodicMemory;

  beforeEach(async () => {
    store = await makeStore();
    em = new EpisodicMemory(store, AGENT);
  });

  it('targets the cog:episodic graph', () => {
    expect(em.graphUri()).toBe('urn:ontofelia:cog:episodic');
  });

  it('appends a well-formed episode with core fields', async () => {
    const uri = await em.append({
      episodeType: 'message-received',
      sessionId: SESS,
      channel: 'webchat',
      actor: 'urn:entity:Alice',
      about: ['urn:entity:OntofeliaProject'],
      payload: 'kennst du ontofelia',
      transcriptRef: 'sess.jsonl:offset_42',
    });
    const [hit] = await em.findInSession(SESS);
    expect(hit.uri).toBe(uri);
    expect(hit.episodeType).toBe('message-received');
    expect(hit.actor).toBe('urn:entity:Alice');
    expect(hit.about).toEqual(['urn:entity:OntofeliaProject']);
    expect(hit.payload).toBe('kennst du ontofelia');
    expect(hit.transcriptRef).toBe('sess.jsonl:offset_42');
    expect(hit.salience).toBeCloseTo(0.6); // default for message-received
    expect(hit.precededBy).toBeUndefined(); // first in session
  });

  it('chains precededBy to the previous episode of the session', async () => {
    const e1 = await em.append({ episodeType: 'message-received', sessionId: SESS, payload: 'one' });
    const e2 = await em.append({ episodeType: 'response-sent', sessionId: SESS, payload: 'two' });
    const e3 = await em.append({ episodeType: 'message-received', sessionId: SESS, payload: 'three' });

    const chain = await em.chainFrom(e3);
    expect(chain.map((h) => h.uri)).toEqual([e1, e2, e3]); // oldest-first
    expect(chain.map((h) => h.payload)).toEqual(['one', 'two', 'three']);
  });

  it('does not cross-link episodes of different sessions', async () => {
    await em.append({ episodeType: 'message-received', sessionId: 'sA', payload: 'a' });
    const b = await em.append({ episodeType: 'message-received', sessionId: 'sB', payload: 'b' });
    const [hitB] = await em.findInSession('sB');
    expect(hitB.precededBy).toBeUndefined();
    expect(hitB.uri).toBe(b);
  });

  it('retrieve ranks by relevance and caps at k', async () => {
    await em.append({ episodeType: 'message-received', sessionId: SESS, payload: 'the cat sat on the mat' });
    await em.append({ episodeType: 'message-received', sessionId: SESS, payload: 'oxigraph is a triplestore' });
    await em.append({ episodeType: 'message-received', sessionId: SESS, payload: 'completely unrelated text here' });

    const hits = await em.retrieve('tell me about oxigraph triplestore', 2);
    expect(hits).toHaveLength(2);
    expect(hits[0].payload).toContain('oxigraph');
    expect(hits[0].relevanceScore).toBeGreaterThan(hits[1].relevanceScore);
  });

  it('retrieve returns [] (not an error) when there are no episodes', async () => {
    expect(await em.retrieve('anything', 5)).toEqual([]);
  });

  it('findByEntity returns episodes about an entity, newest-first', async () => {
    await em.append({ episodeType: 'message-received', sessionId: SESS, about: ['urn:entity:X'], payload: 'first' });
    await em.append({ episodeType: 'response-sent', sessionId: SESS, about: ['urn:entity:X'], payload: 'second' });
    const hits = await em.findByEntity('urn:entity:X');
    expect(hits).toHaveLength(2);
    expect(hits.every((h) => h.about.includes('urn:entity:X'))).toBe(true);
  });

  it('retentionTick is a no-op by default and never deletes episodes (C5 stub)', async () => {
    await em.append({ episodeType: 'message-received', sessionId: SESS, payload: 'keep me' });
    await em.append({ episodeType: 'response-sent', sessionId: SESS, payload: 'keep me too' });

    const before = await em.findInSession(SESS);
    expect(before).toHaveLength(2);

    const report = await em.retentionTick();
    expect(report.scanned).toBe(2);
    expect(report.deleted).toBe(0);
    expect(report.demoted).toBe(0);
    expect(report.noop).toBe(true);

    // Even when "enabled", the seam performs no destructive work yet (Phase H).
    const enabled = await em.retentionTick(new Date(), { enabled: true });
    expect(enabled.noop).toBe(false);
    expect(enabled.deleted).toBe(0);

    const after = await em.findInSession(SESS);
    expect(after).toHaveLength(2);
  });
});
