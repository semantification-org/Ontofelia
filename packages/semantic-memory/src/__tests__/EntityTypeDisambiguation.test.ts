import { describe, it, expect } from 'vitest';
import { KnowledgeEngine } from '../KnowledgeEngine.js';

type KEStore = ConstructorParameters<typeof KnowledgeEngine>[0];

const CORE = 'urn:ontofelia:core#';

/**
 * Build a fake triplestore that models a single pre-existing labelled entity.
 *
 * `findEntityByLabel` issues a `SELECT ?e ?t` with a
 * `LCASE(STR(?l)) = "<needle>"` filter; we answer it with the existing entity
 * and its declared type. `mintDisambiguatedUri` and the existence check both
 * issue `ASK { GRAPH ?g { <uri> a ?t } }`; we answer `true` only for URIs that
 * are actually "taken" by the modelled entity.
 */
function makeStore(existing?: { uri: string; label: string; type?: string }) {
  const updates: string[] = [];
  const asks: string[] = [];
  const store = {
    backend: 'inmemory',
    async query(sparql: string) {
      const m = /LCASE\(STR\(\?l\)\)\s*=\s*"([^"]+)"/.exec(sparql);
      if (existing && m && m[1] === existing.label.toLowerCase()) {
        const binding: Record<string, { type: string; value: string }> = {
          e: { type: 'uri', value: existing.uri },
        };
        if (existing.type) {
          binding.t = { type: 'uri', value: `${CORE}${existing.type}` };
        }
        return { type: 'bindings', bindings: [binding] };
      }
      return { type: 'bindings', bindings: [] };
    },
    async ask(sparql: string) {
      asks.push(sparql);
      // All ASKs here are `... { <uri> a ?type }`. A URI counts as "taken" /
      // "exists" only when the modelled entity has a declared type AND the
      // ASK references that exact URI (the trailing `>` keeps `Paris` from
      // matching `Paris_Person`).
      return !!(existing && existing.type && sparql.includes(`<${existing.uri}>`));
    },
    async update(sparql: string) { updates.push(sparql); },
  } as unknown as KEStore;
  return { store, updates, asks };
}

describe('resolveEntity — type-aware label matching (#label-merge)', () => {
  it('same name + same type → reuses the existing node', async () => {
    const { store, updates } = makeStore({
      uri: 'urn:ontofelia:entity:Paris', label: 'Paris', type: 'Person',
    });
    const engine = new KnowledgeEngine(store);

    const res = await engine.resolveEntity('Paris', 'Person');

    expect(res).toEqual({ uri: 'urn:ontofelia:entity:Paris', isNew: false });
    // Reuse must not mint or re-type anything.
    expect(updates).toHaveLength(0);
  });

  it('same name + different type → mints a separate, disambiguated node', async () => {
    // Existing "Paris" is a City; we now resolve a Person named "Paris".
    const { store, updates } = makeStore({
      uri: 'urn:ontofelia:entity:Paris', label: 'Paris', type: 'City',
    });
    const engine = new KnowledgeEngine(store);

    const res = await engine.resolveEntity('Paris', 'Person');

    // The slug URI is taken by the City, so a type-suffixed URI is minted.
    expect(res.uri).toBe('urn:ontofelia:entity:Paris_Person');
    expect(res.uri).not.toBe('urn:ontofelia:entity:Paris');
    expect(res.isNew).toBe(true);
    // The fresh node is typed as Person.
    expect(updates).toHaveLength(1);
    expect(updates[0]).toContain(`${CORE}Person`);
    expect(updates[0]).toContain('urn:ontofelia:entity:Paris_Person');
  });

  it('no type passed → keeps current behaviour (reuse first label match)', async () => {
    const { store, updates } = makeStore({
      uri: 'urn:ontofelia:entity:Berlin', label: 'berlin', type: 'City',
    });
    const engine = new KnowledgeEngine(store);

    // Case-insensitive match on the label, no type constraint.
    const res = await engine.resolveEntity('Berlin');

    expect(res).toEqual({ uri: 'urn:ontofelia:entity:Berlin', isNew: false });
    expect(updates).toHaveLength(0);
  });

  it('untyped existing match is reused even when a type is requested', async () => {
    // A previously-untyped labelled node carries no type conflict, so it is
    // safe to reuse and get typed on this pass.
    const { store, updates } = makeStore({
      uri: 'urn:ontofelia:entity:Acme', label: 'Acme',
    });
    const engine = new KnowledgeEngine(store);

    const res = await engine.resolveEntity('Acme', 'Organization');

    expect(res.uri).toBe('urn:ontofelia:entity:Acme');
    // exists-check is false (no `a ?type`), so the type is now asserted.
    expect(res.isNew).toBe(true);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toContain(`${CORE}Organization`);
  });

  it('no label match at all → mints the plain slug URI', async () => {
    const { store } = makeStore(); // nothing exists
    const engine = new KnowledgeEngine(store);

    const res = await engine.resolveEntity('Zaphod', 'Person');

    expect(res.uri).toBe('urn:ontofelia:entity:Zaphod');
    expect(res.isNew).toBe(true);
  });
});
