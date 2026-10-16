import { describe, it, expect, afterEach } from 'vitest';
import { GraphUriResolver } from '@ontofelia/semantic-memory';
import { makeEnv, send, stream, cleanup, seedSkillAndSelf, rows, envelope, AGENT, COGT, ALICE, OWNER, type Env } from './promptHarness.js';
import { bootFreshInstall } from './freshInstall.js';
import { COGNITIVE_FLAGS } from '../cognitive/CognitiveConfig.js';

// End to end on a fresh install with the defaults and the mock provider: three
// turns by two users. Every cognitive layer writes its records, and the
// prompt of one user never carries the text of the other.

const E = 'urn:ontofelia:entity:custom-zoe-7';
const BOB = { id: 'bob', channelPrefix: 'webchat', isOwner: false } as typeof ALICE;
const ALICE_SAYS = 'Alice here: Zoe is my sister, remember that';
const BOB_SAYS = 'Bob here: Zoe owes me forty dollars';
const ASK = 'What do you know about Zoe?';

const count = async (e: Env, q: string) => (await rows(e.store, q)).length;

describe('fresh install, defaults on: three turns by two users', () => {
  const made: Env[] = [];
  afterEach(async () => { await cleanup(made); made.length = 0; });

  async function install(): Promise<Env> {
    const e = await makeEnv({
      tools: [{ name: 'searchKb' }],
      seed: async ({ store }) => {
        await bootFreshInstall(store);
        await seedSkillAndSelf(store);
        await store.update(`INSERT DATA { GRAPH <${GraphUriResolver.getWorldviewGraph(AGENT)}> {
          <${E}> a <urn:shared:ontology#Person> ; <http://www.w3.org/2000/01/rdf-schema#label> "Zoe" . } }`);
      },
    });
    made.push(e);
    return e;
  }

  it('all layers produce records and user B never sees user A (plain and streamed)', async () => {
    for (const how of [send, stream] as const) {
      const e = await install();
      // The boot step turned the layer on; no flag was set by hand.
      for (const f of COGNITIVE_FLAGS) {
        expect(await e.cfg.isEnabled(f), f.name).toBe(f.name !== 'flagRetention' && f.name !== 'flagInitiative');
      }
      await how(e, ALICE_SAYS, ALICE);
      await how(e, BOB_SAYS, BOB);
      await how(e, ASK, ALICE);
      const [pa1, pb, pa2] = e.probe.answers.map((a) => a.system);
      expect(e.probe.answers).toHaveLength(3);

      // two-user privacy, both directions
      expect(pb).not.toContain('Zoe is my sister');
      expect(pb).not.toContain('Alice here');
      expect(pa1).not.toContain('forty dollars');
      expect(pa2).not.toContain('forty dollars');
      expect(pa2).not.toContain('Bob here');
      // recall works for the same user
      expect(pa2).toContain('[Recalled]');
      expect(pa2).toContain('Zoe is my sister');

      // records of every layer
      expect(await count(e, `SELECT ?c WHERE { GRAPH ?g { ?c a <${COGT}Cycle> } }`)).toBe(3);
      expect(await count(e, `SELECT ?w WHERE { GRAPH ?g { ?w <${COGT}entryKind> "episode-ref" } }`)).toBeGreaterThan(0); // recall
      expect(await count(e, `SELECT ?g1 WHERE { GRAPH ?g { ?g1 a <${COGT}Goal> } }`)).toBeGreaterThan(0); // goals
      expect(await count(e, `SELECT ?x WHERE { GRAPH <${GraphUriResolver.getCogEpisodicGraph(AGENT)}> { ?x a <${COGT}Episode> } }`)).toBeGreaterThanOrEqual(3); // episodes
      expect(await count(e, `SELECT ?m WHERE { GRAPH <${GraphUriResolver.getCogMetaGraph(AGENT)}> { ?m a <${COGT}ReflectiveMarker> } }`)).toBe(3); // metacognition
      expect(await count(e, `SELECT ?s WHERE { GRAPH <${GraphUriResolver.getSelfGraph(AGENT)}> { ?s ?p ?o FILTER(CONTAINS(STR(?s), "self#derived/")) } }`)).toBeGreaterThan(0); // self-model
      expect(pa2).toContain('[Self]');
      // retention stays off: the sweep is a no-op and every episode keeps its text
      const swept = (await e.runtime.handleMessage(envelope('/cog retain', OWNER))).text;
      expect(swept).toContain('(disabled — no-op)');
      expect(await count(e, `SELECT ?x WHERE { GRAPH ?g { ?x a <${COGT}DailySummary> } }`)).toBe(0);
      expect(await count(e, `SELECT ?x WHERE { GRAPH <${GraphUriResolver.getCogEpisodicGraph(AGENT)}> { ?x a <${COGT}Episode> FILTER NOT EXISTS { ?x <${COGT}payload> ?p } } }`)).toBe(0);
    }
  }, 30_000);
});
