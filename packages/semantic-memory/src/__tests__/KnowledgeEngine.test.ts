import { describe, it, expect } from 'vitest';
import { KnowledgeEngine } from '../KnowledgeEngine.js';

type KEStore = ConstructorParameters<typeof KnowledgeEngine>[0];

describe('KnowledgeEngine URI generation', () => {
  const dummyTriplestore = {} as unknown as KEStore;
  const engine = new KnowledgeEngine(dummyTriplestore);

  it('escapes spaces and special characters in entity URIs safely', () => {
    // We access the private method for testing purposes
    const toEntityUri = (engine as unknown as { toEntityUri(name: string): string }).toEntityUri.bind(engine);

    expect(toEntityUri('Alice Smith')).toBe('urn:ontofelia:entity:Alice_Smith');
    expect(toEntityUri('Evil > Entity')).toBe('urn:ontofelia:entity:Evil_%3E_Entity');
  });

  it('preserves valid URIs but blocks injection', () => {
    const toEntityUri = (engine as unknown as { toEntityUri(name: string): string }).toEntityUri.bind(engine);

    expect(toEntityUri('http://example.com/foo')).toBe('http://example.com/foo');
    expect(() => toEntityUri('http://example.com/foo>')).toThrow(/Invalid URI/);
  });
});

describe('KnowledgeEngine predicate canonicalization', () => {
  const engine = new KnowledgeEngine({} as unknown as KEStore);
  const toPropertyUri = (n: string) => (engine as unknown as { toPropertyUri(n: string): string }).toPropertyUri.bind(engine)(n);

  it('preserves single-token camelCase predicates', () => {
    // Regression: the old impl lowercased `parts[0]` unconditionally and
    // produced `urn:ontofelia:core#hasname`, disconnected from the TBox.
    expect(toPropertyUri('hasName')).toBe('urn:ontofelia:core#hasName');
    expect(toPropertyUri('worksAt')).toBe('urn:ontofelia:core#worksAt');
    expect(toPropertyUri('isFlagshipProjectOf'))
      .toBe('urn:ontofelia:core#isFlagshipProjectOf');
  });

  it('camelCases whitespace- and underscore-separated predicates', () => {
    expect(toPropertyUri('has name')).toBe('urn:ontofelia:core#hasName');
    expect(toPropertyUri('works_at')).toBe('urn:ontofelia:core#worksAt');
    expect(toPropertyUri('  studied at  ')).toBe('urn:ontofelia:core#studiedAt');
  });

  it('forces leading character lowercase for Pascal-cased input', () => {
    // urn:shared:ontology convention is leading-lowercase camelCase.
    expect(toPropertyUri('HasName')).toBe('urn:ontofelia:core#hasName');
  });

  it('passes through absolute URIs verbatim', () => {
    expect(toPropertyUri('urn:ontofelia:core#worksAt'))
      .toBe('urn:ontofelia:core#worksAt');
    expect(() => toPropertyUri('urn:bad>')).toThrow(/Invalid URI/);
  });
});

describe('KnowledgeEngine.resolveProperty — label-based reuse', () => {
  /**
   * Build a fake triplestore that pretends `worksAt` already exists in the
   * shared TBox. The engine must reuse that URI even when the parser emits
   * the predicate as `worksat` or `works at`.
   */
  function makeStoreWithExistingProperty(existingUri: string, existingLabel: string) {
    const updates: string[] = [];
    const queries: string[] = [];
    const store = {
      backend: 'inmemory',
      async query(sparql: string) {
        queries.push(sparql);
        // findPropertyByLabel issues a SELECT with `LCASE(STR(?l)) = "<needle>"`.
        const m = /LCASE\(STR\(\?l\)\)\s*=\s*"([^"]+)"/.exec(sparql);
        if (m && m[1] === existingLabel.toLowerCase()) {
          return {
            type: 'bindings',
            bindings: [{ p: { type: 'uri', value: existingUri } }],
          };
        }
        return { type: 'bindings', bindings: [] };
      },
      async ask() { return false; },
      async update(sparql: string) { updates.push(sparql); },
    } as unknown as KEStore;
    return { store, updates, queries };
  }

  it('reuses an existing TBox property URI when labels match', async () => {
    const { store, updates } = makeStoreWithExistingProperty(
      'urn:ontofelia:core#worksAt',
      'worksAt',
    );
    const engine = new KnowledgeEngine(store);

    const res = await engine.resolveProperty('worksat', 'ontofelia');
    expect(res).toEqual({ uri: 'urn:ontofelia:core#worksAt', isNew: false });
    // No mutation when a match is reused.
    expect(updates).toHaveLength(0);
  });

  it('case-insensitive label match handles whitespace forms', async () => {
    const { store } = makeStoreWithExistingProperty(
      'urn:ontofelia:core#worksAt',
      'works at',
    );
    const engine = new KnowledgeEngine(store);

    const res = await engine.resolveProperty('works at', 'ontofelia');
    expect(res.uri).toBe('urn:ontofelia:core#worksAt');
    expect(res.isNew).toBe(false);
  });

  it('registers a fresh predicate when no label match exists', async () => {
    const updates: string[] = [];
    const store = {
      backend: 'inmemory',
      async query() { return { type: 'bindings', bindings: [] }; },
      async ask() { return false; },
      async update(sparql: string) { updates.push(sparql); },
    } as unknown as KEStore;
    const engine = new KnowledgeEngine(store);

    const res = await engine.resolveProperty('hasFavouriteColour', 'ontofelia');
    expect(res).toEqual({
      uri: 'urn:ontofelia:core#hasFavouriteColour',
      isNew: true,
    });
    // The new predicate is registered in the agent-local schema graph,
    // never in the admin-only shared TBox.
    expect(updates).toHaveLength(1);
    expect(updates[0]).toContain('urn:ontofelia:schema');
    expect(updates[0]).not.toContain('urn:shared:ontology');
  });
});

describe('KnowledgeEngine fact routing', () => {
  const engine = new KnowledgeEngine({} as unknown as KEStore);
  const resolveTargetGraph = (f: Record<string, unknown>, c: Record<string, unknown>) =>
    (engine as unknown as { resolveTargetGraph(f: unknown, c: unknown): string }).resolveTargetGraph.bind(engine)(f, c);

  const userContext = { agentId: 'ontofelia', userId: 'owner', sessionId: 's1', isOwner: true };

  it('routes a fact stated by the user into the per-user graph', () => {
    const fact = { subject: 'User', subjectType: 'Person', predicate: 'name',
      object: 'Alice', objectType: 'literal', sourceKind: 'user' };
    expect(resolveTargetGraph(fact, userContext)).toBe('urn:ontofelia:user:owner');
  });

  it('routes a user expectation about the agent into the user graph, not self', () => {
    // "you should help me organize my projects" — grammatically about the
    // agent, but it must NOT land in the write-protected self graph.
    const fact = { subject: 'Ontofelia', subjectType: 'Agent', predicate: 'isRequestedToHelpWith',
      object: 'project organization', objectType: 'literal', sourceKind: 'user' };
    const graph = resolveTargetGraph(fact, userContext);
    expect(graph).toBe('urn:ontofelia:user:owner');
    expect(graph).not.toContain(':self');
  });

  it('never routes a runtime fact into the write-protected self graph', () => {
    const agentFact = { subject: 'Ontofelia', subjectType: 'Agent', predicate: 'capability',
      object: 'reasoning', objectType: 'literal', sourceKind: 'agent' };
    expect(resolveTargetGraph(agentFact, userContext)).not.toContain(':self');
  });

  it('re-anchors a user expectation about the agent onto the user node', () => {
    const canonicalUserUri = (n: string, f: Record<string, unknown>, c: Record<string, unknown>) =>
      (engine as unknown as { canonicalUserUri(n: string, f: unknown, c: unknown): string }).canonicalUserUri.bind(engine)(n, f, c);
    const fact = { subject: 'Ontofelia', subjectType: 'Agent', predicate: 'isRequestedToHelpWith',
      object: 'project organization', objectType: 'literal', sourceKind: 'user' };
    expect(canonicalUserUri('Ontofelia', fact, userContext))
      .toBe('urn:ontofelia:entity:user:owner');
  });
});
