import { describe, it, expect, beforeEach } from 'vitest';
import type { TriplestoreAdapter } from '@ontofelia/core';
import { OxigraphAdapter } from '../adapters/OxigraphAdapter.js';
import { EpisodicMemory } from '../cognitive/EpisodicMemory.js';

// Per-user privacy of the episodic graph: every read takes a user scope, legacy
// episodes (no cogt:forUser) are owner-only, deleteForUser removes exactly one
// user's episodes and keeps the precededBy chain intact, and hostile user ids
// and payloads cannot alter a query.

const AGENT = 'ontofelia';
const SESS = 'sess_priv_1';
const COGT = 'urn:shared:ontology#cog/';
const CORE = 'urn:shared:ontology#';

async function makeStore(): Promise<TriplestoreAdapter> {
  const store = new OxigraphAdapter();
  await store.initialize({
    backend: 'oxigraph',
    type: 'embedded',
    dataDir: `/tmp/ep-priv-test-${Math.random().toString(16).slice(2)}`,
    port: 0,
    endpoint: '',
  });
  return store;
}

describe('EpisodicMemory per-user privacy', () => {
  let store: TriplestoreAdapter;
  let em: EpisodicMemory;

  beforeEach(async () => {
    store = await makeStore();
    em = new EpisodicMemory(store, AGENT);
  });

  const texts = (hits: Array<{ payload?: string }>) => hits.map((h) => h.payload).sort();

  it('a scoped read never returns another user\'s episode on any read path', async () => {
    const a1 = await em.append({
      episodeType: 'message-received', sessionId: SESS, forUser: 'alice',
      about: ['urn:entity:Topic'], payload: 'alice private plan oxigraph',
    });
    const b1 = await em.append({
      episodeType: 'message-received', sessionId: SESS, forUser: 'bob',
      about: ['urn:entity:Topic'], payload: 'bob lunch plan',
    });
    await em.append({
      episodeType: 'response-sent', sessionId: SESS, forUser: 'bob',
      about: ['urn:entity:Topic'], payload: 'bob reply',
    });

    // retrieve (with and without a session), findInSession, findByEntity, recent
    expect(texts(await em.retrieve('plan oxigraph', 10, 'bob'))).toEqual(['bob lunch plan', 'bob reply']);
    expect(texts(await em.retrieve('plan oxigraph', 10, 'bob', { sessionId: SESS }))).toEqual(['bob lunch plan', 'bob reply']);
    expect(texts(await em.findInSession(SESS, 'bob'))).toEqual(['bob lunch plan', 'bob reply']);
    expect(texts(await em.findByEntity('urn:entity:Topic', 'bob'))).toEqual(['bob lunch plan', 'bob reply']);
    expect(texts(await em.recent('bob', 50))).toEqual(['bob lunch plan', 'bob reply']);
    expect(texts(await em.recent('bob', 50, 'urn:entity:Topic'))).toEqual(['bob lunch plan', 'bob reply']);
    expect(texts(await em.recent('alice'))).toEqual(['alice private plan oxigraph']);

    // chainFrom: bob's reply chains to bob's message, which chains to alice's
    // (same session). The scoped walk stops at the user boundary.
    const bobLast = (await em.findInSession(SESS, 'bob'))[0].uri;
    const chain = await em.chainFrom(bobLast, 'bob');
    expect(chain.map((h) => h.payload)).toEqual(['bob lunch plan', 'bob reply']);
    expect((await em.chainFrom(bobLast, 'all')).map((h) => h.uri)).toContain(a1);
    expect(await em.chainFrom(a1, 'bob')).toEqual([]);
    expect(b1).toBeDefined();

    // "all" sees everything; a user nobody wrote for sees nothing.
    expect(await em.recent('all')).toHaveLength(3);
    expect(await em.recent('carol')).toEqual([]);
    expect(await em.retrieve('plan', 5, 'carol')).toEqual([]);
  });

  it('episodes without forUser are owner-only', async () => {
    await em.append({ episodeType: 'message-received', sessionId: SESS, payload: 'legacy episode' });
    await em.append({ episodeType: 'message-received', sessionId: SESS, forUser: 'bob', payload: 'bob episode' });

    expect(texts(await em.recent('owner'))).toEqual(['legacy episode']);
    expect(texts(await em.recent('bob'))).toEqual(['bob episode']);
    expect(await em.findInSession(SESS, 'carol')).toEqual([]);
    expect(texts(await em.findInSession(SESS, 'all'))).toEqual(['bob episode', 'legacy episode']);
    expect(await em.retrieve('legacy', 5, 'bob')).toHaveLength(1);
    expect((await em.retrieve('legacy', 5, 'bob'))[0].payload).toBe('bob episode');
  });

  it('refuses a read without a scope', async () => {
    await expect(em.recent(undefined as unknown as string)).rejects.toThrow(/userScope/);
    await expect(em.recent('')).rejects.toThrow(/userScope/);
    await expect(em.retrieve('x', 1, undefined as unknown as string)).rejects.toThrow(/userScope/);
    await expect(em.findInSession(SESS, undefined as unknown as string)).rejects.toThrow(/userScope/);
  });

  it('deleteForUser removes exactly that user\'s episodes and keeps the chain consistent', async () => {
    const t = (n: number) => new Date(Date.UTC(2026, 9, 1, 10, n));
    const e1 = await em.append({ episodeType: 'message-received', sessionId: SESS, forUser: 'alice', payload: 'a1', occurredAt: t(1), about: ['urn:entity:T'] });
    const e2 = await em.append({ episodeType: 'message-received', sessionId: SESS, forUser: 'bob', payload: 'b1', occurredAt: t(2) });
    const e3 = await em.append({ episodeType: 'response-sent', sessionId: SESS, forUser: 'alice', payload: 'a2', occurredAt: t(3) });
    const e4 = await em.append({ episodeType: 'message-received', sessionId: SESS, forUser: 'bob', payload: 'b2', occurredAt: t(4) });
    const legacy = await em.append({ episodeType: 'message-received', sessionId: 'other', payload: 'legacy', occurredAt: t(5) });
    await em.append({ episodeType: 'tool-called', sessionId: SESS, forUser: 'alice', payload: 't', tags: ['call1'], occurredAt: t(6) });

    const res = await em.deleteForUser('alice');
    expect(res.deleted).toBe(3);

    const remaining = await em.recent('all');
    expect(remaining.map((h) => h.uri).sort()).toEqual([e2, e4, legacy].sort());
    expect(texts(await em.recent('bob'))).toEqual(['b1', 'b2']);
    expect(await em.recent('alice')).toEqual([]);

    // chain: e2 had alice's e1 before it (no survivor -> link removed); e4 had
    // alice's e3 before it -> re-linked to e2.
    const byUri = new Map(remaining.map((h) => [h.uri, h]));
    expect(byUri.get(e2)!.precededBy).toBeUndefined();
    expect(byUri.get(e4)!.precededBy).toBe(e2);
    expect((await em.chainFrom(e4, 'all')).map((h) => h.uri)).toEqual([e2, e4]);

    // nothing of alice's is left behind in the graph: not a triple of her
    // episodes, not a dangling precededBy, not her user key
    for (const gone of [e1, e3]) {
      const own = await store.query(`SELECT ?p WHERE { GRAPH <${em.graphUri()}> { <${gone}> ?p ?o } }`);
      expect(own.bindings ?? []).toHaveLength(0);
      const dangling = await store.query(`SELECT ?s WHERE { GRAPH <${em.graphUri()}> { ?s ?p <${gone}> } }`);
      expect(dangling.bindings ?? []).toHaveLength(0);
    }
    const key = await store.query(`SELECT ?s WHERE { GRAPH <${em.graphUri()}> { ?s <${COGT}forUser> "alice" } }`);
    expect(key.bindings ?? []).toHaveLength(0);

    // idempotent
    expect(await em.deleteForUser('alice')).toEqual({ deleted: 0, relinked: 0 });
  });

  it('deleteForUser refuses the owner\'s key and the all-users scope', async () => {
    await em.append({ episodeType: 'message-received', forUser: 'owner', payload: 'mine' });
    await expect(em.deleteForUser('owner')).rejects.toThrow(/owner/);
    await expect(em.deleteForUser('all')).rejects.toThrow(/concrete user key/);
    await expect(em.deleteForUser('')).rejects.toThrow(/concrete user key/);
    expect(await em.recent('owner')).toHaveLength(1);
  });

  it('survives hostile user ids and payloads: no SPARQL error, no cross-user leak', async () => {
    const evilId = 'x" . } } ; DROP ALL ; INSERT DATA { GRAPH <urn:evil> { <urn:a> <urn:b> "c\\\\\nd\' } } #';
    const evilText = 'He said "hi" \\ and \\" and \\\\n\nline2\r\n"} } DELETE WHERE { ?s ?p ?o } # \t end';

    await em.append({ episodeType: 'message-received', sessionId: SESS, forUser: evilId, payload: evilText });
    await em.append({ episodeType: 'message-received', sessionId: SESS, forUser: 'bob', payload: 'bob safe' });
    await em.append({ episodeType: 'message-received', sessionId: SESS, payload: 'legacy safe' });

    // The hostile user reads back exactly its own episode, verbatim.
    const mine = await em.recent(evilId);
    expect(mine).toHaveLength(1);
    expect(mine[0].payload).toBe(evilText);
    expect(mine[0].forUser).toBe(evilId);
    expect(texts(await em.retrieve('hi line2', 10, evilId, { sessionId: SESS }))).toEqual([evilText]);

    // No other user sees it, and it sees nothing of others' (legacy is owner-only).
    expect(texts(await em.recent('bob'))).toEqual(['bob safe']);
    expect(texts(await em.recent('owner'))).toEqual(['legacy safe']);
    for (const scope of ['bob', 'owner', 'carol', `${evilId} `]) {
      expect((await em.recent(scope)).some((h) => h.payload === evilText)).toBe(false);
    }

    // A hostile entity or episode IRI is refused as a value, never run as a query.
    expect(await em.chainFrom('urn:x> } } DROP ALL #', 'all')).toEqual([]);
    await expect(em.findByEntity('urn:x> } } DROP ALL #', 'all')).rejects.toThrow(/Invalid IRI/);

    // The store is intact: the injected graph does not exist, nothing was dropped.
    expect(await em.recent('all')).toHaveLength(3);
    const evilGraph = await store.query('SELECT ?s WHERE { GRAPH <urn:evil> { ?s ?p ?o } }');
    expect(evilGraph.bindings ?? []).toHaveLength(0);

    // Deleting by the hostile key removes only that user's episode.
    expect((await em.deleteForUser(evilId)).deleted).toBe(1);
    expect(texts(await em.recent('all'))).toEqual(['bob safe', 'legacy safe']);
  });

  it('writes core:privacyClass "secret" and the retention sweep acts on it', async () => {
    const now = new Date(Date.UTC(2026, 9, 20));
    const tenDaysAgo = new Date(now.getTime() - 10 * 86_400_000);
    const secret = await em.append({
      episodeType: 'message-received', sessionId: SESS, forUser: 'alice',
      payload: 'password: hunter2hunter2', privacyClass: 'secret', occurredAt: tenDaysAgo,
    });
    const plain = await em.append({
      episodeType: 'message-received', sessionId: 'other', forUser: 'alice',
      payload: 'hello', occurredAt: tenDaysAgo,
    });

    const klass = await store.query(`SELECT ?c WHERE { GRAPH <${em.graphUri()}> { <${secret}> <${CORE}privacyClass> ?c } }`);
    expect(klass.bindings?.map((b) => b.c.value)).toEqual(['secret']);
    const none = await store.query(`SELECT ?c WHERE { GRAPH <${em.graphUri()}> { <${plain}> <${CORE}privacyClass> ?c } }`);
    expect(none.bindings ?? []).toHaveLength(0);

    const report = await em.retentionTick(now, { enabled: true });
    expect(report.summarized).toBe(1); // only the secret one is cold at 10 days
    const left = await em.recent('all');
    expect(left.map((h) => h.uri)).toEqual([plain]);
  });
});
