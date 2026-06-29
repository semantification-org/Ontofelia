import { describe, it, expect } from 'vitest';
import { OntologyContextProvider } from '../ingestion/OntologyContextProvider.js';

/**
 * Regression cover: the provider used to point at `urn:ontofelia:tbox`,
 * which is not a registered Named Graph. Lookups silently returned empty
 * and the parser prompt advertised zero properties — so the parser invented
 * fresh, near-duplicate predicates on every turn. These tests pin the
 * provider to `urn:shared:ontology` and `urn:<agent>:schema`.
 */
describe('OntologyContextProvider', () => {
  function makeStoreCapturingQueries() {
    const queries: string[] = [];
    const store = {
      backend: 'inmemory',
      async query(sparql: string) {
        queries.push(sparql);
        return { type: 'bindings', bindings: [] };
      },
      async ask() { return false; },
      async update() { /* noop */ },
    } as unknown as ConstructorParameters<typeof OntologyContextProvider>[0];
    return { store, queries };
  }

  it('queries urn:shared:ontology for classes and properties', async () => {
    const { store, queries } = makeStoreCapturingQueries();
    const provider = new OntologyContextProvider(store, 'ontofelia');
    await provider.getCompact();

    const joined = queries.join('\n');
    expect(joined).toContain('<urn:shared:ontology>');
    // The historic broken graph must never reappear.
    expect(joined).not.toContain('<urn:ontofelia:tbox>');
  });

  it('also queries the agent-local schema graph for runtime predicates', async () => {
    const { store, queries } = makeStoreCapturingQueries();
    const provider = new OntologyContextProvider(store, 'ontofelia');
    await provider.getCompact();

    expect(queries.join('\n')).toContain('<urn:ontofelia:schema>');
  });

  it('honours a non-default agentId in the schema graph URI', async () => {
    const { store, queries } = makeStoreCapturingQueries();
    const provider = new OntologyContextProvider(store, 'john');
    await provider.getCompact();

    expect(queries.join('\n')).toContain('<urn:john:schema>');
  });

  it('falls back to default classes when the triplestore throws', async () => {
    const store = {
      backend: 'inmemory',
      async query() { throw new Error('boom'); },
      async ask() { return false; },
      async update() { /* noop */ },
    } as unknown as ConstructorParameters<typeof OntologyContextProvider>[0];
    const provider = new OntologyContextProvider(store, 'ontofelia');
    const ctx = await provider.getCompact();

    expect(ctx.classes).toEqual(
      expect.arrayContaining(['Person', 'Organization', 'Place', 'Concept', 'Event']),
    );
    expect(ctx.properties).toEqual([]);
  });
});
