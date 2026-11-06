/**
 * Retracting one fact must remove only the evidence that belongs to that
 * fact's own claims, never evidence nodes that belong to other claims. Real
 * Oxigraph store, same setup as the consolidation retract tests.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ToolContext } from '@ontofelia/core';
import { OxigraphAdapter } from '@ontofelia/semantic-memory';
import { MemoryRetractTool } from '../memory/memory_retract.js';

const AGENT = 'ontofelia';
const CORE = 'urn:shared:ontology#';
const CLAIMS = `urn:${AGENT}:claims`;
const EVIDENCE = `urn:${AGENT}:evidence`;
const WORLDVIEW = `urn:${AGENT}:worldview`;

const ALICE_S = 'urn:ontofelia:entity:Alice';
const BOB_S = 'urn:ontofelia:entity:Bob';
const P = 'urn:ontofelia:core#likes';
const ALICE_O = 'urn:ontofelia:entity:Tea';
const BOB_O = 'urn:ontofelia:entity:Coffee';

let store: OxigraphAdapter;
let retract: MemoryRetractTool;

const ctx = (senderId: string): ToolContext =>
  ({ agentId: AGENT, sessionId: 's', workspacePath: '/tmp', channelType: 'cli', senderId, isOwner: false }) as unknown as ToolContext;

async function seedClaim(claim: string, s: string, o: string, evidence?: string) {
  await store.update(`INSERT DATA { GRAPH <${CLAIMS}> { <${claim}> a <${CORE}Claim> ;
    <${CORE}claimSubject> <${s}> ; <${CORE}claimPredicate> <${P}> ; <${CORE}claimObject> <${o}> ;
    <${CORE}status> "accepted" ; <${CORE}assertedInGraph> <${WORLDVIEW}> ; <${CORE}sourceKind> "user"
    ${evidence ? `; <${CORE}hasEvidence> <${evidence}>` : ''} } }`);
  await store.update(`INSERT DATA { GRAPH <${WORLDVIEW}> { <${s}> <${P}> <${o}> } }`);
}

async function seedEvidence(evidence: string, tag: string) {
  await store.update(`INSERT DATA { GRAPH <${EVIDENCE}> { <${evidence}> a <${CORE}Evidence> ;
    <${CORE}sourceEpisode> "episode-${tag}" ; <${CORE}quote> "quote-${tag}" } }`);
}

const evidenceTriples = async (evidence: string) =>
  (await store.query(`SELECT ?p ?o WHERE { GRAPH <${EVIDENCE}> { <${evidence}> ?p ?o } }`)).bindings ?? [];

beforeEach(async () => {
  store = new OxigraphAdapter();
  await store.initialize({ backend: 'oxigraph', type: 'embedded', dataDir: mkdtempSync(join(tmpdir(), 'retract-evidence-')), port: 0, endpoint: '' } as never);
  retract = new MemoryRetractTool(store as never);
});

describe('memory_retract evidence isolation', () => {
  it('control: when the retracted claim links its evidence, only that evidence goes and the other claim keeps its own', async () => {
    await seedClaim('urn:claim:alice', ALICE_S, ALICE_O, 'urn:evidence:alice');
    await seedEvidence('urn:evidence:alice', 'alice');
    await seedClaim('urn:claim:bob', BOB_S, BOB_O, 'urn:evidence:bob');
    await seedEvidence('urn:evidence:bob', 'bob');
    expect((await evidenceTriples('urn:evidence:bob')).length).toBeGreaterThanOrEqual(2);

    const res = await retract.execute({ subject: ALICE_S, predicate: P, object: ALICE_O }, ctx('alice'));
    expect(res.success).toBe(true);

    expect(await evidenceTriples('urn:evidence:alice')).toEqual([]);
    expect((await evidenceTriples('urn:evidence:bob')).length).toBe(3);
    expect(await store.ask(`ASK { GRAPH <${WORLDVIEW}> { <${ALICE_S}> <${P}> <${ALICE_O}> } }`)).toBe(false);
    expect(await store.ask(`ASK { GRAPH <${WORLDVIEW}> { <${BOB_S}> <${P}> <${BOB_O}> } }`)).toBe(true);
  });

  it('keeps another claim\'s evidence when the retracted claim has no evidence link', async () => {
    await seedClaim('urn:claim:alice', ALICE_S, ALICE_O); // no hasEvidence
    await seedClaim('urn:claim:bob', BOB_S, BOB_O, 'urn:evidence:bob');
    await seedEvidence('urn:evidence:bob', 'bob');
    expect((await evidenceTriples('urn:evidence:bob')).length).toBe(3);

    const res = await retract.execute({ subject: ALICE_S, predicate: P, object: ALICE_O }, ctx('alice'));
    expect(res.success).toBe(true);

    expect((await evidenceTriples('urn:evidence:bob')).length).toBe(3);
  });
});
