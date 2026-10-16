import { describe, it, expect } from 'vitest';
import type { TriplestoreAdapter } from '@ontofelia/core';
import { OxigraphAdapter } from '../adapters/OxigraphAdapter.js';
import { EpisodicMemory, type EpisodeHit } from '../cognitive/EpisodicMemory.js';

// Golden comparison: the read paths return exactly what they returned before the
// query scoping change. The snapshot in __snapshots__ was written by the
// unscoped implementation; episode IRIs are random, so hits are normalised to
// episode ids before comparing.

async function makeStore(): Promise<TriplestoreAdapter> {
  const store = new OxigraphAdapter();
  await store.initialize({
    backend: 'oxigraph',
    type: 'embedded',
    dataDir: `/tmp/ep-golden-${Math.random().toString(16).slice(2)}`,
    port: 0,
    endpoint: '',
  });
  return store;
}

async function fixture() {
  const em = new EpisodicMemory(await makeStore(), 'ontofelia');
  const t = (m: number) => new Date(Date.UTC(2026, 9, 1, 10, m, 0));
  const alice = 'urn:ontofelia:user:alice';
  const bob = 'urn:ontofelia:user:bob';
  const uris: Record<string, string> = {};
  const add = async (name: string, ep: Parameters<EpisodicMemory['append']>[0]) => {
    uris[name] = await em.append(ep);
  };
  await add('a1', { episodeType: 'message-received', occurredAt: t(0), sessionId: 's1', forUser: alice,
    about: ['urn:entity:Ontofelia', 'urn:entity:Oxigraph'], tags: ['x', 'y'], payload: 'tell me about oxigraph "quoted"\nnewline', channel: 'webchat' });
  await add('a2', { episodeType: 'tool-called', occurredAt: t(1), sessionId: 's1', forUser: alice,
    about: ['urn:entity:Oxigraph'], outcome: 'success', durationMs: 42, errorClass: 'none' });
  await add('a3', { episodeType: 'response-sent', occurredAt: t(2), sessionId: 's1', forUser: alice, payload: 'oxigraph is a triplestore', salience: 0.9 });
  await add('b1', { episodeType: 'message-received', occurredAt: t(3), sessionId: 's2', forUser: bob,
    about: ['urn:entity:Ontofelia'], tags: ['z'], payload: 'something else entirely' });
  await add('b2', { episodeType: 'message-received', occurredAt: t(4), sessionId: 's2', forUser: bob, payload: 'ontofelia project', partOfGoal: 'urn:ontofelia:cog:goal:g1' });
  await add('legacy', { episodeType: 'message-received', occurredAt: t(5), sessionId: 's3', payload: 'legacy oxigraph note', about: ['urn:entity:Oxigraph'] });
  return { em, uris };
}

function norm(hits: EpisodeHit[], uris: Record<string, string>) {
  const byUri = new Map(Object.entries(uris).map(([k, v]) => [v, k]));
  const n = (u?: string) => (u === undefined ? undefined : byUri.get(u) ?? u);
  return hits.map((h) => ({
    ...h,
    uri: n(h.uri),
    precededBy: n(h.precededBy),
    about: [...h.about].sort(),
    tags: [...h.tags].sort(),
    relevanceScore: Math.round(h.relevanceScore * 1e6) / 1e6 > 0 ? 'positive' : 'zero',
  }));
}

describe('EpisodicMemory read golden', () => {
  it('findInSession / findByEntity / recent / chainFrom / retrieve are unchanged', async () => {
    const { em, uris } = await fixture();
    const out = {
      session1All: norm(await em.findInSession('s1', 'all'), uris),
      session2Bob: norm(await em.findInSession('s2', 'urn:ontofelia:user:bob'), uris),
      session2Alice: norm(await em.findInSession('s2', 'urn:ontofelia:user:alice'), uris),
      entityAll: norm(await em.findByEntity('urn:entity:Oxigraph', 'all'), uris),
      entityAlice: norm(await em.findByEntity('urn:entity:Oxigraph', 'urn:ontofelia:user:alice'), uris),
      recentAll: norm(await em.recent('all', 4), uris),
      recentAlice: norm(await em.recent('urn:ontofelia:user:alice'), uris),
      chain: norm(await em.chainFrom(uris.a3, 'all'), uris),
      retrieve: norm(await em.retrieve('oxigraph triplestore', 3, 'all'), uris).map((h) => h.episodeId),
    };
    expect(out).toMatchSnapshot();
  });

  it('append chains to the session tail and numbers episodes by session size', async () => {
    const { em, uris } = await fixture();
    const next = await em.append({ episodeType: 'tool-called', occurredAt: new Date(Date.UTC(2026, 9, 1, 11, 0, 0)), sessionId: 's1', forUser: 'urn:ontofelia:user:alice' });
    const [hit] = await em.findInSession('s1', 'all');
    expect(hit.uri).toBe(next);
    expect(hit.precededBy).toBe(uris.a3);
    expect(hit.episodeId.endsWith('_0004')).toBe(true);
  });
});
