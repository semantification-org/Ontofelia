import { describe, it, expect, beforeEach } from 'vitest';
import type { TriplestoreAdapter } from '@ontofelia/core';
import { OxigraphAdapter } from '../adapters/OxigraphAdapter.js';
import { EpisodicMemory } from '../cognitive/EpisodicMemory.js';

// Retention tiering (doc 05 §7) runs against the embedded Oxigraph store, like
// the rest of the episodic suite.

const AGENT = 'ontofelia';
const CORE = 'urn:shared:ontology#';
const COGT = 'urn:shared:ontology#cog/';
const EP_GRAPH = 'urn:ontofelia:cog:episodic';

async function makeStore(): Promise<TriplestoreAdapter> {
  const store = new OxigraphAdapter();
  await store.initialize({
    backend: 'oxigraph',
    type: 'embedded',
    dataDir: `/tmp/ep-ret-${Math.random().toString(16).slice(2)}`,
    port: 0,
    endpoint: '',
  });
  return store;
}

const NOW = new Date('2026-06-01T12:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

describe('EpisodicMemory retention', () => {
  let store: TriplestoreAdapter;
  let em: EpisodicMemory;

  beforeEach(async () => {
    store = await makeStore();
    em = new EpisodicMemory(store, AGENT);
  });

  async function markSecret(uri: string): Promise<void> {
    await store.update(`INSERT DATA { GRAPH <${EP_GRAPH}> {
      <${uri}> <${CORE}privacyClass> "secret" . } }`);
  }

  async function payloadOf(uri: string): Promise<string | undefined> {
    const res = await store.query(`SELECT ?o WHERE {
      GRAPH <${EP_GRAPH}> { <${uri}> <${COGT}payload> ?o } } LIMIT 1`);
    return res.bindings?.[0]?.o?.value;
  }

  async function existsAsEpisode(uri: string): Promise<boolean> {
    const res = await store.query(`SELECT ?w WHERE {
      GRAPH <${EP_GRAPH}> { <${uri}> <${COGT}occurredAt> ?w } } LIMIT 1`);
    return (res.bindings?.length ?? 0) > 0;
  }

  async function summaries(): Promise<{ uri: string; count: number }[]> {
    const res = await store.query(`SELECT ?s ?c WHERE {
      GRAPH <${EP_GRAPH}> { ?s a <${COGT}DailySummary> ; <${COGT}episodeCount> ?c } }`);
    return (res.bindings ?? []).map((b) => ({ uri: b.s.value, count: Number(b.c.value) }));
  }

  it('disabled tick is a no-op', async () => {
    await em.append({ episodeType: 'message-received', occurredAt: daysAgo(400), payload: 'old' });
    const report = await em.retentionTick(NOW); // enabled omitted → false
    expect(report.noop).toBe(true);
    expect(report.deleted + report.warmed + report.frozen).toBe(0);
  });

  it('leaves Hot episodes (< 30d) untouched', async () => {
    const uri = await em.append({ episodeType: 'message-received', occurredAt: daysAgo(5), payload: 'fresh' });
    const report = await em.retentionTick(NOW, { enabled: true });
    expect(report.warmed).toBe(0);
    expect(await payloadOf(uri)).toBe('fresh');
  });

  it('Warm tier (30–90d) drops payload but keeps the episode', async () => {
    const uri = await em.append({
      episodeType: 'message-received',
      occurredAt: daysAgo(45),
      payload: 'warm-secret-text',
      transcriptRef: 'jsonl:span-1',
    });
    const report = await em.retentionTick(NOW, { enabled: true });
    expect(report.warmed).toBe(1);
    expect(await payloadOf(uri)).toBeUndefined();
    expect(await existsAsEpisode(uri)).toBe(true);
  });

  it('Cold tier (90–365d) collapses a session-day into one DailySummary', async () => {
    const sessionId = 'sess_cold';
    const a = await em.append({ episodeType: 'message-received', sessionId, occurredAt: daysAgo(200), payload: 'a', about: ['urn:e:1'] });
    const b = await em.append({ episodeType: 'response-sent', sessionId, occurredAt: new Date(daysAgo(200).getTime() + 1000), payload: 'b', about: ['urn:e:2'] });
    const report = await em.retentionTick(NOW, { enabled: true });
    expect(report.summariesCreated).toBe(1);
    expect(report.summarized).toBe(2);
    expect(report.deleted).toBe(2);
    expect(await existsAsEpisode(a)).toBe(false);
    expect(await existsAsEpisode(b)).toBe(false);
    const sums = await summaries();
    expect(sums).toHaveLength(1);
    expect(sums[0].count).toBe(2);
  });

  it('Frozen tier (> 365d) reduces to an id-only tombstone', async () => {
    const uri = await em.append({ episodeType: 'message-received', occurredAt: daysAgo(400), payload: 'ancient' });
    const report = await em.retentionTick(NOW, { enabled: true });
    expect(report.frozen).toBe(1);
    expect(await existsAsEpisode(uri)).toBe(false); // no occurredAt anymore
    const res = await store.query(`SELECT ?id ?f WHERE {
      GRAPH <${EP_GRAPH}> { <${uri}> <${COGT}episodeId> ?id ; <${COGT}frozen> ?f } } LIMIT 1`);
    expect(res.bindings?.[0]?.f?.value).toBe('true');
  });

  it('secret-classed episodes go Cold after 7 days', async () => {
    const sessionId = 'sess_secret';
    const uri = await em.append({ episodeType: 'message-received', sessionId, occurredAt: daysAgo(10), payload: 'classified' });
    await markSecret(uri);
    const report = await em.retentionTick(NOW, { enabled: true });
    // 10d would normally be Hot, but secret → Cold collapse.
    expect(report.summarized).toBe(1);
    expect(await existsAsEpisode(uri)).toBe(false);
  });

  it('is idempotent — a second tick changes nothing', async () => {
    await em.append({ episodeType: 'message-received', occurredAt: daysAgo(45), payload: 'warm' });
    await em.append({ episodeType: 'message-received', sessionId: 's', occurredAt: daysAgo(200), payload: 'cold' });
    await em.append({ episodeType: 'message-received', occurredAt: daysAgo(400), payload: 'frozen' });
    await em.retentionTick(NOW, { enabled: true });
    const second = await em.retentionTick(NOW, { enabled: true });
    expect(second.warmed).toBe(0);
    expect(second.summariesCreated).toBe(0);
    expect(second.frozen).toBe(0);
    expect(second.deleted).toBe(0);
  });
});
