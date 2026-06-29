import { describe, it, expect } from 'vitest';
import { KnowledgeEngine } from '../KnowledgeEngine.js';

function makeMockStore() {
  const updates: string[] = [];
  return {
    store: {
      backend: 'inmemory' as const,
      async query(_sparql: string) {
        return { type: 'bindings', bindings: [] };
      },
      async ask() { return false; },
      async update(sparql: string) { updates.push(sparql); },
      async insertTriples() {},
    } as unknown as ConstructorParameters<typeof KnowledgeEngine>[0],
    updates,
  };
}

describe('Owner↔named-person entity resolution (#875)', () => {
  const ownerCtx = { agentId: 'ontofelia', userId: 'owner', sessionId: 's1', isOwner: true };

  it('materializes owl:sameAs when user declares their name', async () => {
    const { store, updates } = makeMockStore();
    const engine = new KnowledgeEngine(store);

    await engine.storeFact(
      { subject: 'User', subjectType: 'Person', predicate: 'name',
        object: 'Alice', objectType: 'literal', sourceKind: 'user' },
      ownerCtx,
    );

    // At least one update should contain owl:sameAs
    const sameAsUpdates = updates.filter(u => u.includes('sameAs'));
    expect(sameAsUpdates.length).toBeGreaterThan(0);

    // Both directions should be present
    const combined = sameAsUpdates.join(' ');
    expect(combined).toContain('entity:user:owner');
    expect(combined).toContain('entity:Alice');
  });

  it('does NOT materialize sameAs for third-party name facts', async () => {
    const { store, updates } = makeMockStore();
    const engine = new KnowledgeEngine(store);

    // "Anna's name is Anna" — Anna is NOT the user
    await engine.storeFact(
      { subject: 'Anna', subjectType: 'Person', predicate: 'name',
        object: 'Anna Schmidt', objectType: 'literal', sourceKind: 'user' },
      ownerCtx,
    );

    const sameAsUpdates = updates.filter(u => u.includes('sameAs'));
    expect(sameAsUpdates).toHaveLength(0);
  });

  it('does NOT materialize sameAs for non-name predicates', async () => {
    const { store, updates } = makeMockStore();
    const engine = new KnowledgeEngine(store);

    await engine.storeFact(
      { subject: 'User', subjectType: 'Person', predicate: 'livesIn',
        object: 'Berlin', objectType: 'Place', sourceKind: 'user' },
      ownerCtx,
    );

    const sameAsUpdates = updates.filter(u => u.includes('sameAs'));
    expect(sameAsUpdates).toHaveLength(0);
  });
});
