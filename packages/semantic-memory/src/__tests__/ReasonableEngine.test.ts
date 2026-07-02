import { describe, it, expect } from 'vitest';
import type { Triple, TriplestoreAdapter } from '@ontofelia/core';
import { ReasonableEngine } from '../reasoning/ReasonableEngine.js';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const RDFS_SUBCLASS = 'http://www.w3.org/2000/01/rdf-schema#subClassOf';

/**
 * Minimal TriplestoreAdapter stub: serves a fixed TBox for the ontology graph
 * and an (optionally non-empty) ABox for any other graph. Only `getGraph` is
 * exercised by ReasonableEngine.materialize.
 */
function makeStore(tboxTtl: string, aboxTtl = ''): TriplestoreAdapter {
  return {
    async getGraph(graphUri: string) {
      return graphUri === 'urn:shared:ontology' ? tboxTtl : aboxTtl;
    },
  } as unknown as TriplestoreAdapter;
}

const objValue = (t: Triple): string =>
  typeof t.object === 'string' ? t.object : t.object.value;

describe('ReasonableEngine (async native reasoner)', () => {
  const tbox = `<http://ex/Dog> <${RDFS_SUBCLASS}> <http://ex/Animal> .`;

  it('materializes the subclass inference via the async reasoner', async () => {
    const engine = new ReasonableEngine(makeStore(tbox));
    const newTriple: Triple = {
      subject: 'http://ex/rex',
      predicate: RDF_TYPE,
      object: { type: 'uri', value: 'http://ex/Dog' },
    };

    // Must be awaited now that inferTriples returns a Promise.
    const inferred = await engine.materialize([newTriple], 'urn:agent:ctx');

    // rex a Dog ⟹ rex a Animal is the only genuinely new inference.
    expect(inferred.some(t => objValue(t) === 'http://ex/Animal')).toBe(true);
    // The input fact itself must not be echoed back.
    expect(inferred.some(t => objValue(t) === 'http://ex/Dog')).toBe(false);
  });

  it('handles concurrent materialize calls (native reasoner is re-entrant)', async () => {
    // Two independent engines reasoning in parallel — this would have raced on
    // the shared /tmp/{tbox,abox}_<pid>.ttl path in the old file-based impl.
    const engineA = new ReasonableEngine(makeStore(tbox));
    const engineB = new ReasonableEngine(
      makeStore(`<http://ex/Cat> <${RDFS_SUBCLASS}> <http://ex/Animal> .`),
    );

    const [a, b] = await Promise.all([
      engineA.materialize(
        [{ subject: 'http://ex/rex', predicate: RDF_TYPE, object: { type: 'uri', value: 'http://ex/Dog' } }],
        'urn:agent:a',
      ),
      engineB.materialize(
        [{ subject: 'http://ex/felix', predicate: RDF_TYPE, object: { type: 'uri', value: 'http://ex/Cat' } }],
        'urn:agent:b',
      ),
    ]);

    expect(a.some(t => objValue(t) === 'http://ex/Animal')).toBe(true);
    expect(b.some(t => objValue(t) === 'http://ex/Animal')).toBe(true);
  });
});
