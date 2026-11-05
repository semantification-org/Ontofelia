import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Triple, TriplestoreAdapter } from '@ontofelia/core';
import { inferTriples } from '@ontofelia/reasoner';
import { ReasonableEngine } from '../reasoning/ReasonableEngine.js';

/**
 * Correctness suite for incremental reasoning.
 *
 * Contract of `ReasonableEngine.materialize(N, ctx)` (read from the source):
 *   - the reasoner echoes its whole input, so `full(T, X)` contains T and X;
 *   - the engine computes baseline = full(T, A) and extended = full(T, A ∪ N)
 *     and returns extended − baseline − N. It therefore neither echoes N, nor
 *     returns A, nor returns TBox triples.
 *
 * Oracle, computed with the reasoner binding directly (never via the engine):
 *   expected(N) = full(T, A ∪ N) \ ( full(T, A) ∪ A ∪ N )
 * i.e. exactly the genuinely new inferences. Any optimisation of
 * `materialize` must keep returning this set.
 */

const here = dirname(fileURLToPath(import.meta.url));
const CORE_TTL = readFileSync(join(here, '..', 'ontologies', 'ontofelia-core.ttl'), 'utf8');

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const OWL_SAME_AS = 'http://www.w3.org/2002/07/owl#sameAs';
const OWL_NOTHING = 'http://www.w3.org/2002/07/owl#Nothing';
const O = 'urn:ontofelia:core#';
const ex = (s: string): string => `http://example.org/${s}`;

const uri = (s: string, p: string, o: string): Triple => ({
  subject: s,
  predicate: p,
  object: { type: 'uri', value: o },
});

function makeStore(tboxTtl: string, aboxTtl = ''): TriplestoreAdapter {
  return {
    async getGraph(graphUri: string) {
      return graphUri === 'urn:shared:ontology' ? tboxTtl : aboxTtl;
    },
  } as unknown as TriplestoreAdapter;
}

const objValue = (t: Triple): string => (typeof t.object === 'string' ? t.object : t.object.value);

/** Normalised string of an engine triple (IRI objects only in this suite). */
const engineKey = (t: Triple): string => `<${t.subject}> <${t.predicate}> <${objValue(t)}>`;
const toNt = (t: Triple): string => `${engineKey(t)} .`;
const toNtDoc = (ts: Triple[]): string => ts.map(toNt).join('\n');

/** Normalised string of a raw reasoner triple (terms already in N-Triples form). */
const rawKey = (t: { subject: string; predicate: string; object: string }): string =>
  `${t.subject.trim()} ${t.predicate.trim()} ${t.object.trim()}`;

/** The oracle: full(T, A ∪ N) \ (full(T, A) ∪ A ∪ N), as a sorted string list. */
async function oracle(tbox: string, abox: Triple[], delta: Triple[]): Promise<string[]> {
  const aTtl = toNtDoc(abox);
  const baseline = await inferTriples(tbox, aTtl);
  const extended = await inferTriples(tbox, `${aTtl}\n${toNtDoc(delta)}`);
  const exclude = new Set<string>([
    ...baseline.map(rawKey),
    ...abox.map(engineKey),
    ...delta.map(engineKey),
  ]);
  return [...new Set(extended.map(rawKey))].filter(k => !exclude.has(k)).sort();
}

async function viaEngine(tbox: string, abox: Triple[], delta: Triple[]): Promise<string[]> {
  const engine = new ReasonableEngine(makeStore(tbox, toNtDoc(abox)));
  const out = await engine.materialize(delta, 'urn:agent:ctx');
  return [...new Set(out.map(engineKey))].sort();
}

/** Assert engine == oracle, and that every named inference is present. */
async function check(
  tbox: string,
  abox: Triple[],
  delta: Triple[],
  named: Triple[],
): Promise<{ expected: string[]; actual: string[] }> {
  const expected = await oracle(tbox, abox, delta);
  const actual = await viaEngine(tbox, abox, delta);
  // Guard against a vacuous oracle: the explicit inferences must be in it.
  for (const n of named) expect(expected).toContain(engineKey(n));
  expect(actual).toEqual(expected);
  for (const n of named) expect(actual).toContain(engineKey(n));
  return { expected, actual };
}

describe('incremental reasoning correctness (oracle = full reasoner run)', () => {
  it('1. subClassOf + domain + range from one new fact', async () => {
    const delta = [uri(ex('alice'), `${O}worksAt`, ex('acme'))];
    await check(CORE_TTL, [], delta, [
      uri(ex('alice'), RDF_TYPE, `${O}Person`), // domain
      uri(ex('acme'), RDF_TYPE, `${O}Organization`), // range
      uri(ex('alice'), RDF_TYPE, `${O}Entity`), // Person subClassOf Entity
      uri(ex('acme'), RDF_TYPE, `${O}Entity`), // Organization subClassOf Entity
      uri(ex('alice'), `${O}relatedTo`, ex('acme')), // subPropertyOf
    ]);
  });

  it('2. symmetric property (knows)', async () => {
    const delta = [uri(ex('alice'), `${O}knows`, ex('bob'))];
    await check(CORE_TTL, [], delta, [
      uri(ex('bob'), `${O}knows`, ex('alice')),
      uri(ex('bob'), RDF_TYPE, `${O}Person`),
    ]);
  });

  it('3. transitive chain of length 3, new fact at the end', async () => {
    const abox = [
      uri(ex('a'), `${O}partOf`, ex('b')),
      uri(ex('b'), `${O}partOf`, ex('c')),
    ];
    const delta = [uri(ex('c'), `${O}partOf`, ex('d'))];
    await check(CORE_TTL, abox, delta, [
      uri(ex('a'), `${O}partOf`, ex('d')),
      uri(ex('b'), `${O}partOf`, ex('d')),
    ]);
  });

  it('4. transitive, new fact in the middle of an existing chain', async () => {
    const abox = [
      uri(ex('a'), `${O}partOf`, ex('b')),
      uri(ex('c'), `${O}partOf`, ex('d')),
    ];
    const delta = [uri(ex('b'), `${O}partOf`, ex('c'))];
    await check(CORE_TTL, abox, delta, [
      uri(ex('a'), `${O}partOf`, ex('c')),
      uri(ex('b'), `${O}partOf`, ex('d')),
      uri(ex('a'), `${O}partOf`, ex('d')),
    ]);
  });

  it('5. functional property yields owl:sameAs (and its eq-rep consequences)', async () => {
    const abox = [uri(ex('alice'), `${O}livesIn`, ex('paris'))];
    const delta = [uri(ex('alice'), `${O}livesIn`, ex('lyon'))];
    const { actual } = await check(CORE_TTL, abox, delta, [
      uri(ex('paris'), OWL_SAME_AS, ex('lyon')),
      uri(ex('lyon'), OWL_SAME_AS, ex('paris')),
    ]);
    // Measured with the bundled reasoner: eq-sym gives the reverse edge and
    // the closure also emits reflexive sameAs for the new object. Pin it so a
    // silent change in equality handling shows up.
    expect(actual).toContain(engineKey(uri(ex('lyon'), OWL_SAME_AS, ex('lyon'))));
    // The new object also receives its range type and is not a stale echo.
    expect(actual).toContain(engineKey(uri(ex('lyon'), RDF_TYPE, `${O}Place`)));
  });

  it('6. disjointness violation: diagnostics are dropped (characterisation)', async () => {
    const abox = [uri(ex('z'), RDF_TYPE, `${O}Person`)];
    const delta = [
      uri(ex('z'), RDF_TYPE, `${O}Place`), // clashes with Person (disjointWith)
      uri(ex('z'), `${O}knows`, ex('w')), // unrelated fact so the oracle is not empty
    ];
    const { actual } = await check(CORE_TTL, abox, delta, [uri(ex('w'), RDF_TYPE, `${O}Person`)]);
    // Known gap: reasoner diagnostics are not surfaced
    // Current behaviour: the clash is accepted silently and no inconsistency
    // marker of any kind is returned.
    expect(actual.some(k => k.includes(OWL_NOTHING))).toBe(false);
    expect(actual.some(k => /inconsisten|diagnostic|disjoint/i.test(k))).toBe(false);
  });

  it('7. duplicate delta: idempotent when N is already known', async () => {
    const abox = [uri(ex('a'), `${O}partOf`, ex('b'))];
    const delta = [uri(ex('b'), `${O}partOf`, ex('c'))];
    const named = uri(ex('a'), `${O}partOf`, ex('c'));

    // First application genuinely infers something.
    const first = await check(CORE_TTL, abox, delta, [named]);
    // Same N twice against the same A: stateless and deterministic.
    expect(await viaEngine(CORE_TTL, abox, delta)).toEqual(first.actual);

    // Once A holds N and everything inferred from it, N adds nothing.
    const inferredTriples: Triple[] = first.actual.map(k => {
      const [s, p, o] = k.split(' ').map(x => x.slice(1, -1));
      return uri(s, p, o);
    });
    const settled = [...abox, ...delta, ...inferredTriples];
    expect(await oracle(CORE_TTL, settled, delta)).toEqual([]);
    expect(await viaEngine(CORE_TTL, settled, delta)).toEqual([]);

    // N already in A (without the inferences): only the not-yet-derived
    // consequences may appear, and they match the oracle exactly.
    await check(CORE_TTL, [...abox, ...delta], delta, []);
    expect(await oracle(CORE_TTL, [...abox, ...delta], delta)).toEqual([]);
  });

  it('9. long transitive chain, new fact at the far end', async () => {
    // Defeats 2-hop scoping: a partOf b is three hops from the new fact's nodes,
    // so a view limited to two hops loses a partOf e.
    const abox = [
      uri(ex('a'), `${O}partOf`, ex('b')),
      uri(ex('b'), `${O}partOf`, ex('c')),
      uri(ex('c'), `${O}partOf`, ex('d')),
    ];
    const delta = [uri(ex('d'), `${O}partOf`, ex('e'))];
    await check(CORE_TTL, abox, delta, [
      uri(ex('a'), `${O}partOf`, ex('e')),
      uri(ex('b'), `${O}partOf`, ex('e')),
      uri(ex('c'), `${O}partOf`, ex('e')),
    ]);
  });

  it('10. sameAs from a functional property reaching a node three hops away', async () => {
    // Defeats 2-hop scoping: k locatedIn m is three hops from alice and lyon, and
    // k locatedIn lyon needs it together with paris = lyon and the transitive chain.
    const abox = [
      uri(ex('alice'), `${O}livesIn`, ex('paris')),
      uri(ex('m'), `${O}locatedIn`, ex('paris')),
      uri(ex('k'), `${O}locatedIn`, ex('m')),
    ];
    const delta = [uri(ex('alice'), `${O}livesIn`, ex('lyon'))];
    await check(CORE_TTL, abox, delta, [
      uri(ex('paris'), OWL_SAME_AS, ex('lyon')),
      uri(ex('m'), `${O}locatedIn`, ex('lyon')),
      uri(ex('k'), `${O}locatedIn`, ex('lyon')),
    ]);
  });

  // The engine exposes only `materialize`; there is no retract/remove entry point.
  it.todo('8. retraction: engine has no retraction API (materialize is add-only)');
});
