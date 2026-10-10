import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OxigraphAdapter } from '../adapters/OxigraphAdapter.js';
import { KnowledgeEngine } from '../KnowledgeEngine.js';
import type { FactContext, FactInput } from '../types.js';

/**
 * Real engine on an embedded Oxigraph store. Every payload tries to close a
 * literal, an IRI, a language tag or a number and to run an extra update that
 * writes into <urn:pwn>; the assertion is always that nothing reached it.
 *
 * Embedded Oxigraph refuses to STORE an IRI containing `>`/`"`/space or a
 * malformed language tag (its parser rejects them), so a "poisoned store" is
 * simulated one level up: a proxy over the real adapter that rewrites what
 * the engine's read queries return, exactly as a lenient backend (or an older
 * store file) could.
 */

const PWN = 'urn:pwn';
const CORE = 'urn:ontofelia:core#';
const OWL_FP = 'http://www.w3.org/2002/07/owl#FunctionalProperty';
const PWN_UPDATE = 'INSERT DATA { GRAPH <urn:pwn> { <urn:pwn:a> <urn:pwn:b> <urn:pwn:c> } }';
const ctx: FactContext = { agentId: 'ontofelia', sessionId: 't', isOwner: true };

// Each payload is shaped so that the SPARQL text around it stays valid after
// the break-out; a naive interpolation therefore really executes PWN_UPDATE.
const SUBJECT_PAYLOAD =
  `urn:a> <urn:b> <urn:c> . } } ; ${PWN_UPDATE} ; DELETE DATA { GRAPH <urn:g> { <urn:x`;
const PREDICATE_PAYLOAD =
  `urn:b> <urn:c> . } } ; ${PWN_UPDATE} ; DELETE DATA { GRAPH <urn:g> { <urn:s> <urn:x`;
const GRAPH_PAYLOAD =
  `urn:g> { <urn:s> <urn:p> <urn:o> . } } ; ${PWN_UPDATE} ; DELETE DATA { GRAPH <urn:g2`;
const OBJECT_PAYLOAD =
  `urn:o> . } } ; ${PWN_UPDATE} ; DELETE DATA { GRAPH <urn:g> { <urn:s> <urn:p> <urn:x`;
const LANG_PAYLOAD =
  `en . } } ; ${PWN_UPDATE} ; DELETE DATA { GRAPH <urn:g> { <urn:s> <urn:p> "x"@en`;
const LITERAL_PAYLOAD =
  `x" . } } ; ${PWN_UPDATE} ; INSERT DATA { GRAPH <urn:g> { <urn:s> <urn:p> "y`;
// > is `>` after SPARQL's pre-parse unicode substitution; it passes a
// plain `includes('>')` check.
const UNICODE_ESCAPED_IRI =
  `urn:a> . } } ; ${PWN_UPDATE} ; INSERT DATA { GRAPH <urn:g> { <urn:x`.replace(/>/g, '\\u003E');

async function makeStore(): Promise<OxigraphAdapter> {
  const store = new OxigraphAdapter();
  await store.initialize({
    backend: 'oxigraph',
    type: 'embedded',
    dataDir: mkdtempSync(join(tmpdir(), 'ke-sparql-safety-')),
    port: 0,
    endpoint: '',
  });
  return store;
}

async function pwnCount(store: OxigraphAdapter): Promise<number> {
  const res = await store.query(`SELECT ?s WHERE { GRAPH <${PWN}> { ?s ?p ?o } }`);
  return res.bindings?.length ?? 0;
}

async function ask(store: OxigraphAdapter, q: string): Promise<boolean> {
  return store.ask(q);
}

type Rewrite = (sparql: string, res: { bindings?: Array<Record<string, unknown>> }) => void;

/** Proxy over the real adapter that lets a test rewrite the engine's SELECT results. */
function poisoned(store: OxigraphAdapter, rewrite: () => Rewrite | undefined): OxigraphAdapter {
  return new Proxy(store, {
    get(target, key) {
      if (key === 'query') {
        return async (q: string, g?: string) => {
          const res = await target.query(q, g);
          const fn = rewrite();
          if (fn) fn(q, res as { bindings?: Array<Record<string, unknown>> });
          return res;
        };
      }
      const v = (target as unknown as Record<string | symbol, unknown>)[key];
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}

const isConflictQuery = (q: string) => q.includes('SELECT ?claim ?o ?g');
const isDetailsQuery = (q: string) => q.includes('SELECT ?s ?p ?o') && q.includes('core:claimSubject');

describe('KnowledgeEngine SPARQL safety', () => {
  let store: OxigraphAdapter;
  let engine: KnowledgeEngine;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    store = await makeStore();
    engine = new KnowledgeEngine(store);
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  // ── Supersession of a functional property ────────────────────────────

  describe('supersession with a poisoned store', () => {
    let mode: Rewrite | undefined;
    let poisonedEngine: KnowledgeEngine;
    let subjectUri: string;
    const fact = (object: string): FactInput => ({
      subject: 'Anna', predicate: 'livesIn', object, objectType: 'literal',
    });

    beforeEach(async () => {
      mode = undefined;
      await store.update(
        `INSERT DATA { GRAPH <urn:ontofelia:schema> { <${CORE}livesIn> a <${OWL_FP}> } }`,
      );
      const first = await engine.storeFact(fact('Hamburg'), ctx);
      subjectUri = first.subjectUri;
      poisonedEngine = new KnowledgeEngine(poisoned(store, () => mode));
    });

    const oldFactStillAccepted = async () => {
      const base = await ask(store,
        `ASK { GRAPH ?g { <${subjectUri}> <${CORE}livesIn> "Hamburg" } }`);
      const accepted = await ask(store, `ASK { GRAPH <urn:ontofelia:claims> {
        ?c <urn:shared:ontology#claimObject> "Hamburg" ; <urn:shared:ontology#status> "accepted" } }`);
      return { base, accepted };
    };

    const cases: Array<[string, Rewrite]> = [
      ['hostile subject IRI in the claim details', (q, r) => {
        if (isDetailsQuery(q) && r.bindings?.[0]) r.bindings[0].s = { type: 'uri', value: SUBJECT_PAYLOAD };
      }],
      ['hostile predicate IRI in the claim details', (q, r) => {
        if (isDetailsQuery(q) && r.bindings?.[0]) r.bindings[0].p = { type: 'uri', value: PREDICATE_PAYLOAD };
      }],
      ['hostile asserted-in graph IRI on the claim', (q, r) => {
        if (isConflictQuery(q) && r.bindings?.[0]) r.bindings[0].g = { type: 'uri', value: GRAPH_PAYLOAD };
      }],
      ['hostile object IRI on the claim', (q, r) => {
        if (isConflictQuery(q) && r.bindings?.[0]) r.bindings[0].o = { type: 'uri', value: OBJECT_PAYLOAD };
      }],
      ['hostile claim IRI', (q, r) => {
        if (isConflictQuery(q) && r.bindings?.[0]) {
          r.bindings[0].claim = { type: 'uri', value: `urn:claim:x> core:status "accepted" } } ; ${PWN_UPDATE} ; #` };
        }
      }],
    ];

    for (const [name, rewrite] of cases) {
      it(`${name}: no injection, the claim is not half-retired`, async () => {
        mode = rewrite;
        const res = await poisonedEngine.storeFact(fact('Koeln'), ctx);
        mode = undefined;

        expect(res.success).toBe(true);
        expect(await pwnCount(store)).toBe(0);
        // The unsafe claim was left alone: still accepted, base triple still there.
        expect(await oldFactStillAccepted()).toEqual({ base: true, accepted: true });
        // The new value was stored regardless.
        expect(await ask(store, `ASK { GRAPH ?g { <${subjectUri}> <${CORE}livesIn> "Koeln" } }`)).toBe(true);
      });
    }

    it('re-emits stale inferred triples through validators: hostile language tag and IRIs are skipped, valid ones removed', async () => {
      const inferred = 'urn:ontofelia:inferred';
      await store.update(`INSERT DATA { GRAPH <${inferred}> {
        <urn:ontofelia:entity:Anna> <${CORE}knows> <urn:valid:o> . } }`);
      let calls = 0;
      // The reasoner returns hostile terms only for the retirement call.
      (poisonedEngine as unknown as { reasoner: unknown }).reasoner = {
        materialize: async () => (calls++ === 0
          ? [
              { subject: 'urn:ontofelia:entity:Anna', predicate: `${CORE}knows`, object: 'urn:valid:o' },
              { subject: 'urn:s', predicate: 'urn:p', object: { value: 'x', language: LANG_PAYLOAD } },
              { subject: SUBJECT_PAYLOAD, predicate: 'urn:p', object: 'urn:o' },
              { subject: 'urn:s', predicate: PREDICATE_PAYLOAD, object: { value: 'v' } },
              { subject: 'urn:s', predicate: 'urn:p', object: { type: 'uri', value: OBJECT_PAYLOAD } },
            ]
          : []),
      };
      await poisonedEngine.storeFact(fact('Koeln'), ctx);

      expect(await pwnCount(store)).toBe(0);
      // Old base triple retired normally.
      expect(await ask(store, `ASK { GRAPH <urn:ontofelia:worldview> { <${subjectUri}> <${CORE}livesIn> "Hamburg" } }`)).toBe(false);
      // The valid stale entailment was still removed; the batch was not abandoned.
      expect(await ask(store, `ASK { GRAPH <${inferred}> { <urn:ontofelia:entity:Anna> <${CORE}knows> <urn:valid:o> } }`)).toBe(false);
      expect(warn).toHaveBeenCalled();
    });

    it('supersedes a legitimate value that contains literal-breaking text (round trip)', async () => {
      const escaped = LITERAL_PAYLOAD.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      const wv = 'GRAPH <urn:ontofelia:worldview>';
      await engine.storeFact(fact(LITERAL_PAYLOAD), ctx);
      // Positive control: the hostile text really is stored as an ordinary value first.
      expect(await ask(store, `ASK { ${wv} { <${subjectUri}> <${CORE}livesIn> "${escaped}" } }`)).toBe(true);
      await engine.storeFact(fact('Berlin'), ctx);
      expect(await pwnCount(store)).toBe(0);
      expect(await ask(store, `ASK { ${wv} { <${subjectUri}> <${CORE}livesIn> "${escaped}" } }`)).toBe(false);
      expect(await ask(store, `ASK { ${wv} { <${subjectUri}> <${CORE}livesIn> "Berlin" } }`)).toBe(true);
    });
  });

  // ── Other sites that model/user text reaches ─────────────────────────

  it('rejects IRIs that hide a ">" behind a unicode escape (toEntityUri / toPropertyUri)', () => {
    const e = engine as unknown as { toEntityUri(n: string): string; toPropertyUri(n: string): string };
    expect(() => e.toEntityUri(UNICODE_ESCAPED_IRI)).toThrow(/Invalid URI/);
    expect(() => e.toPropertyUri(UNICODE_ESCAPED_IRI)).toThrow(/Invalid URI/);
    expect(() => e.toEntityUri('urn:has space')).toThrow(/Invalid URI/);
    expect(e.toEntityUri('urn:ok:fine')).toBe('urn:ok:fine');
  });

  it('isDuplicate rejects a hostile absolute subject instead of querying with it', async () => {
    await expect(
      engine.isDuplicate({ subject: UNICODE_ESCAPED_IRI, predicate: 'knows', object: 'Bob' }, 'ontofelia', ctx),
    ).rejects.toThrow(/Invalid URI/);
    expect(await pwnCount(store)).toBe(0);
  });

  it('isDuplicate with a literal-closing object stays a plain lookup', async () => {
    const dup = await engine.isDuplicate(
      { subject: 'Anna', predicate: 'knows', object: LITERAL_PAYLOAD, objectType: 'literal' }, 'ontofelia', ctx);
    expect(dup).toBe(false);
    expect(await pwnCount(store)).toBe(0);
  });

  it('storeFact rejects hostile predicate and object IRIs and writes nothing', async () => {
    await expect(
      engine.storeFact({ subject: 'Anna', predicate: UNICODE_ESCAPED_IRI, object: 'x', objectType: 'literal' }, ctx),
    ).rejects.toThrow();
    await expect(
      engine.storeFact({ subject: 'Anna', predicate: 'knows', object: UNICODE_ESCAPED_IRI, objectType: 'Person' }, ctx),
    ).rejects.toThrow();
    expect(await pwnCount(store)).toBe(0);
    expect(await ask(store, `ASK { GRAPH <urn:ontofelia:claims> { ?c ?p ?o } }`)).toBe(false);
  });

  it('entity type text cannot break out of the class IRI (resolveEntity)', async () => {
    const classPayload =
      `Person> . } } ; ${PWN_UPDATE} ; INSERT DATA { GRAPH <urn:g> { <urn:s> a <urn:ontofelia:core#Y`;
    await expect(engine.resolveEntity('Anna', classPayload, 'urn:ontofelia:worldview')).rejects.toThrow();
    await expect(engine.resolveEntity('Anna2', classPayload)).rejects.toThrow();
    expect(await pwnCount(store)).toBe(0);
  });

  it('entity label lookup and write (findEntityByLabel / resolveEntity) keep a hostile name inert', async () => {
    const name = LITERAL_PAYLOAD;
    const first = await engine.resolveEntity(name, 'Person', 'urn:ontofelia:worldview');
    expect(first.isNew).toBe(true);
    const again = await engine.resolveEntity(name, 'Person', 'urn:ontofelia:worldview');
    expect(again.isNew).toBe(false);
    expect(again.uri).toBe(first.uri);
    expect(await pwnCount(store)).toBe(0);
    const res = await store.query(`SELECT ?l WHERE { GRAPH ?g { <${first.uri}> <http://www.w3.org/2000/01/rdf-schema#label> ?l } }`);
    expect(res.bindings?.[0]?.l?.value).toBe(name);
  });

  it('predicate label lookup and write (findPropertyByLabel / resolveProperty) keep a hostile name inert', async () => {
    const name = `${LITERAL_PAYLOAD} ") || true || ("`;
    const first = await engine.resolveProperty(name, 'ontofelia');
    const again = await engine.resolveProperty(name, 'ontofelia');
    expect(first.isNew).toBe(true);
    expect(again).toEqual({ uri: first.uri, isNew: false });
    expect(await pwnCount(store)).toBe(0);
  });

  it('recall limits are numbers or the query is not built', async () => {
    await engine.storeFact({ subject: 'Anna', predicate: 'knows', object: 'Bob', objectType: 'Person' }, ctx);
    await engine.storeFact({ subject: 'Anna', predicate: 'likes', object: 'Tea', objectType: 'literal' }, ctx);
    expect(await engine.getRecentFacts('ontofelia', 5)).not.toBe('');
    expect(await engine.getRecentFacts('ontofelia', '1 OFFSET 1' as unknown as number)).toBe('');
    expect(await engine.getFactsAbout(['Anna'], 'ontofelia', '5 OFFSET 0' as unknown as number)).toBe('');
    expect(await pwnCount(store)).toBe(0);
  });

  it('seedSetupGraph does not take a non-integer port into the query', async () => {
    await expect(
      engine.seedSetupGraph('ontofelia', {
        gatewayPort: `1"^^<http://www.w3.org/2001/XMLSchema#integer> . } } ; ${PWN_UPDATE} ; INSERT DATA { GRAPH <urn:ontofelia:setup> { <urn:x> <urn:y> "1` as unknown as number,
      }),
    ).rejects.toThrow(/Invalid integer/);
    expect(await pwnCount(store)).toBe(0);
    // A valid seed still works and carries the value.
    await engine.seedSetupGraph('ontofelia', { gatewayPort: 18780, workspace: LITERAL_PAYLOAD });
    expect(await pwnCount(store)).toBe(0);
    expect(await ask(store, `ASK { GRAPH <urn:ontofelia:setup> { ?s <${CORE}gatewayPort> "18780"^^<http://www.w3.org/2001/XMLSchema#integer> } }`)).toBe(true);
  });

  it('seedSkillsGraph and seedSessionGraph keep hostile names inert', async () => {
    await engine.seedSkillsGraph('ontofelia', [
      { name: LITERAL_PAYLOAD, description: LITERAL_PAYLOAD, category: LITERAL_PAYLOAD },
      { name: `t> . } } ; ${PWN_UPDATE} ; #` },
    ]);
    try {
      await engine.seedSessionGraph('ontofelia', SUBJECT_PAYLOAD, {
        userId: SUBJECT_PAYLOAD, channel: LITERAL_PAYLOAD, topic: LITERAL_PAYLOAD,
      });
    } catch { /* a rejected graph is acceptable; an injection is not */ }
    expect(await pwnCount(store)).toBe(0);
  });

  it('graph reads with a hostile user id stay inert', async () => {
    const hostileUser = `u> { ?s ?p ?o } . GRAPH <urn:ontofelia:self`;
    const out = await engine.getSystemPromptContext('ontofelia', hostileUser);
    expect(typeof out).toBe('string');
    const gaps = await engine.getOnboardingGaps('ontofelia', hostileUser);
    expect(Array.isArray(gaps)).toBe(true);
    expect(await pwnCount(store)).toBe(0);
  });
});
