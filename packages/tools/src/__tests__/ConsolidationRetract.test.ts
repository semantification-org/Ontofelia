/**
 * memory_retract also removes the retracting user's own episodic-consolidation
 * copy of the same triple (same hard-delete path), never another user's, and
 * the promotion ledger keeps the fact from coming back. Real Oxigraph store.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ToolContext } from '@ontofelia/core';
import { OxigraphAdapter, KnowledgeEngine, EpisodicMemory, EpisodicConsolidation } from '@ontofelia/semantic-memory';
import { MemoryRetractTool } from '../memory/memory_retract.js';

const AGENT = 'ontofelia';
const CORE = 'urn:shared:ontology#';
const CLAIMS = `urn:${AGENT}:claims`;
const EVIDENCE = `urn:${AGENT}:evidence`;
const WORLDVIEW = `urn:${AGENT}:worldview`;
const userGraph = (k: string) => `urn:${AGENT}:user:${k}`;
const S = 'urn:ontofelia:entity:Anna';
const P = 'urn:ontofelia:core#likes';
const O = 'urn:ontofelia:entity:Tea';
const DAY = 86_400_000;
const T0 = Date.parse('2026-09-01T10:00:00.000Z');

let store: OxigraphAdapter;
let engine: KnowledgeEngine;
let retract: MemoryRetractTool;
let em: EpisodicMemory;
let n = 0;
let shared: string | undefined;

const ctx = (senderId: string, isOwner = false): ToolContext =>
  ({ agentId: AGENT, sessionId: 's', workspacePath: '/tmp', channelType: 'cli', senderId, isOwner }) as unknown as ToolContext;

async function seedWorldviewClaim(): Promise<string> {
  const c = `urn:claim:rc_${++n}`;
  await store.update(`INSERT DATA { GRAPH <${CLAIMS}> { <${c}> a <${CORE}Claim> ;
    <${CORE}claimSubject> <${S}> ; <${CORE}claimPredicate> <${P}> ; <${CORE}claimObject> <${O}> ;
    <${CORE}status> "accepted" ; <${CORE}assertedInGraph> <${WORLDVIEW}> ; <${CORE}sourceKind> "user" } }`);
  await store.update(`INSERT DATA { GRAPH <${WORLDVIEW}> { <${S}> <${P}> <${O}> } }`);
  return c;
}

/**
 * Three episodes of `user` citing the one worldview claim of the triple (as the
 * ingestion links it when the fact is restated), then the consolidation run.
 */
async function promoteFor(user: string, fresh = false) {
  if (fresh || !shared) shared = await seedWorldviewClaim();
  for (let i = 0; i < 3; i++) {
    await em.append({ episodeType: 'message-received', forUser: user, sessionId: `${user}${i}`, occurredAt: new Date(T0 + i * DAY), hasClaim: [shared], factGraph: userGraph(user) });
  }
  return new EpisodicConsolidation(store, AGENT, engine).run();
}

const holds = (g: string) => store.ask(`ASK { GRAPH <${g}> { <${S}> <${P}> <${O}> } }`);
const consolidationClaims = async (g: string) =>
  ((await store.query(`SELECT ?c WHERE { GRAPH <${CLAIMS}> { ?c <${CORE}sourceKind> "consolidation-episodic" ; <${CORE}assertedInGraph> <${g}> } }`)).bindings ?? []).map((b) => b.c.value);

beforeEach(async () => {
  shared = undefined;
  store = new OxigraphAdapter();
  await store.initialize({ backend: 'oxigraph', type: 'embedded', dataDir: mkdtempSync(join(tmpdir(), 'consol-retract-')), port: 0, endpoint: '' } as never);
  engine = new KnowledgeEngine(store as never);
  retract = new MemoryRetractTool(store as never);
  em = new EpisodicMemory(store as never, AGENT);
});

async function promoteDirect(user: string, claims: string[]) {
  return engine.promoteToUserGraph({
    agentId: AGENT, userKey: user, subjectUri: S, predicateUri: P, object: { kind: 'iri', value: O },
    sourceEpisodes: ['urn:cog:episode:x'], supportClaims: claims, claimHash: `hash-${user}`,
  });
}

describe('memory_retract cascade into the consolidation copy', () => {
  it('retracting the worldview fact also hard-deletes the caller\'s own promoted copy: triple, claim, evidence', async () => {
    const report = await promoteFor('anna');
    expect(report.promoted).toBe(1);
    expect(await holds(userGraph('anna'))).toBe(true);
    const [copy] = await consolidationClaims(userGraph('anna'));
    expect(copy).toBeDefined();

    const res = await retract.execute({ subject: S, predicate: P, object: O }, ctx('anna'));
    expect(res.success).toBe(true);
    expect(await holds(WORLDVIEW)).toBe(false);
    expect(await holds(userGraph('anna'))).toBe(false);
    expect(await consolidationClaims(userGraph('anna'))).toEqual([]);
    const left = await store.query(`SELECT ?p WHERE { GRAPH <${CLAIMS}> { <${copy}> ?p ?o } }`);
    expect(left.bindings ?? []).toEqual([]);
    const ev = await store.query(`SELECT ?e WHERE { GRAPH <${EVIDENCE}> { ?e <${CORE}sourceEpisode> ?x } }`);
    expect(ev.bindings ?? []).toEqual([]);
  });

  it('only the caller\'s graph: another user\'s promoted copy survives', async () => {
    expect((await promoteFor('anna')).promoted).toBe(1);
    expect((await promoteFor('bob')).promoted).toBe(1);
    expect(await holds(userGraph('bob'))).toBe(true);

    await retract.execute({ subject: S, predicate: P, object: O }, ctx('anna'));
    expect(await holds(userGraph('anna'))).toBe(false);
    expect(await holds(userGraph('bob'))).toBe(true);
    expect((await consolidationClaims(userGraph('bob'))).length).toBe(1);
  });

  it('the ledger still prevents a re-promotion after the retraction', async () => {
    await promoteFor('anna');
    await retract.execute({ subject: S, predicate: P, object: O }, ctx('anna'));
    // The same evidence comes back (new claims, same triple): the ledger blocks it.
    const again = await promoteFor('anna', true);
    expect(again.promoted).toBe(0);
    expect(again.alreadyPromoted).toBe(1);
    expect(await holds(userGraph('anna'))).toBe(false);
  });

  it('a user-stated triple in the caller\'s graph is not removed by the cascade', async () => {
    await store.update(`INSERT DATA { GRAPH <${userGraph('anna')}> { <${S}> <${P}> <${O}> } }`);
    await seedWorldviewClaim();
    await retract.execute({ subject: S, predicate: P, object: O }, ctx('anna'));
    expect(await holds(WORLDVIEW)).toBe(false);
    expect(await holds(userGraph('anna'))).toBe(true);
  });

  it('an owner whose sender id is not "owner": copy and cascade use user:<id>, never user:owner', async () => {
    shared = await seedWorldviewClaim();
    for (let i = 0; i < 3; i++) {
      // forUser is the cognitive key; the fact graph is the ingestion routing by sender id.
      await em.append({ episodeType: 'message-received', forUser: 'owner', sessionId: `o${i}`, occurredAt: new Date(T0 + i * DAY), hasClaim: [shared], factGraph: userGraph('u-owner-7') });
    }
    expect((await new EpisodicConsolidation(store, AGENT, engine).run()).promoted).toBe(1);
    expect(await holds(userGraph('u-owner-7'))).toBe(true);
    expect(await holds(userGraph('owner'))).toBe(false);
    await retract.execute({ subject: S, predicate: P, object: O }, ctx('u-owner-7', true));
    expect(await holds(userGraph('u-owner-7'))).toBe(false);
    const inOwner = await store.query(`SELECT ?s WHERE { GRAPH <${userGraph('owner')}> { ?s ?p ?o } } LIMIT 1`);
    expect(inOwner.bindings ?? []).toEqual([]);
  });

  it('promoteToUserGraph reports already-known when the worldview holds an independent accepted claim', async () => {
    await seedWorldviewClaim();
    expect((await promoteDirect('carl', ['urn:claim:somewhere-else'])).outcome).toBe('already-known');
    expect(await holds(userGraph('carl'))).toBe(false);
  });
});
