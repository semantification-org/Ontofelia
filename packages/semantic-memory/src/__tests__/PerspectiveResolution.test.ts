import { describe, it, expect } from 'vitest';
import { KnowledgeEngine } from '../KnowledgeEngine.js';

type KEStore = ConstructorParameters<typeof KnowledgeEngine>[0];

/**
 * #1035 — deixis / conversational-perspective resolution.
 *
 * These tests pin the SYMBOLIC guarantee that user-message deixis is resolved
 * correctly regardless of what the parser LLM emits:
 *   - first-person facts ("ich/I/mein/my") stay on the user node,
 *   - descriptive/identity facts about the agent ("du/you/dein/your") stay on
 *     the AGENT entity and never collapse onto the owner,
 *   - the agent entity is NEVER owl:sameAs-linked to the owner.
 *
 * Mock-store pattern reused from OwnerEntityResolution.test.ts; the private
 * resolveTargetGraph / canonicalUserUri access pattern from
 * KnowledgeEngine.test.ts.
 */
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
    } as unknown as KEStore,
    updates,
  };
}

const ownerCtx = { agentId: 'ontofelia', userId: 'owner', sessionId: 's1', isOwner: true };

// Private-method accessors.
const resolveTargetGraph = (e: KnowledgeEngine, f: Record<string, unknown>, c: Record<string, unknown>) =>
  (e as unknown as { resolveTargetGraph(f: unknown, c: unknown): string }).resolveTargetGraph.bind(e)(f, c);
const canonicalUserUri = (e: KnowledgeEngine, n: string, f: Record<string, unknown>, c: Record<string, unknown>) =>
  (e as unknown as { canonicalUserUri(n: string, f: unknown, c: unknown): string | null })
    .canonicalUserUri.bind(e)(n, f, c);
const isAboutAgent = (e: KnowledgeEngine, f: Record<string, unknown>) =>
  (e as unknown as { isAboutAgent(f: unknown): boolean }).isAboutAgent.bind(e)(f);

describe('#1035 AC1 — first-person name stays on the user, not the agent', () => {
  const cases: Array<{ label: string; object: string }> = [
    { label: 'DE "Ich heiße Gökhan"', object: 'Gökhan' },
    { label: 'EN "My name is Gökhan"', object: 'Gökhan' },
  ];
  for (const { label, object } of cases) {
    it(`${label} → fact on user:owner, never "Ontofelia name …"`, async () => {
      const { store, updates } = makeMockStore();
      const engine = new KnowledgeEngine(store);
      await engine.storeFact(
        { subject: 'User', subjectType: 'Person', predicate: 'name',
          object, objectType: 'literal', sourceKind: 'user' },
        ownerCtx,
      );
      const combined = updates.join('\n');
      // The user fact lands on the canonical user node …
      expect(combined).toContain('entity:user:owner');
      // … and the agent entity is never the subject of the name fact.
      expect(combined).not.toContain('entity:Ontofelia');
    });
  }
});

describe('#1035 AC2 — "Du bist Ontofelia" / "You are Ontofelia"', () => {
  for (const label of ['DE "Du bist Ontofelia"', 'EN "You are Ontofelia"']) {
    it(`${label} → neither "user:owner name Ontofelia" nor sameAs`, async () => {
      const { store, updates } = makeMockStore();
      const engine = new KnowledgeEngine(store);
      await engine.storeFact(
        { subject: 'Ontofelia', subjectType: 'Agent', predicate: 'name',
          object: 'Ontofelia', objectType: 'literal', sourceKind: 'user' },
        ownerCtx,
      );
      const combined = updates.join('\n');
      // No sameAs at all, and the owner node is never touched.
      expect(combined).not.toContain('sameAs');
      expect(combined).not.toContain('user:owner');
      // The descriptive identity fact stays on the agent entity.
      expect(combined).toContain('entity:Ontofelia');
    });
  }
});

describe('#1035 AC3 — "Du sagst die ganze Zeit du" is ABOUT the agent', () => {
  const cases: Array<{ label: string; object: string }> = [
    { label: 'DE "Du sagst die ganze Zeit du"', object: 'sagt die ganze Zeit du' },
    { label: 'EN "You keep saying you"', object: 'keeps saying you' },
  ];
  for (const { label, object } of cases) {
    it(`${label} → subject is the agent entity, not the owner`, async () => {
      const { store, updates } = makeMockStore();
      const engine = new KnowledgeEngine(store);
      const fact = { subject: 'Ontofelia', subjectType: 'Agent', predicate: 'communicationHabit',
        object, objectType: 'literal', sourceKind: 'user' as const };

      // Symbolic layer: descriptive agent fact is NOT re-anchored to the user …
      expect(canonicalUserUri(engine, 'Ontofelia', fact, ownerCtx)).toBeNull();
      // … and routes to worldview, never the user graph and never :self.
      const graph = resolveTargetGraph(engine, fact, ownerCtx);
      expect(graph).toBe('urn:ontofelia:worldview');
      expect(graph).not.toContain(':self');
      expect(graph).not.toContain('user:owner');

      await engine.storeFact(fact, ownerCtx);
      const combined = updates.join('\n');
      expect(combined).toContain('entity:Ontofelia');
      expect(combined).not.toContain('user:owner');
    });
  }
});

describe('#1035 AC4 — agent↔owner sameAs is NEVER auto-created', () => {
  it('descriptive agent name fact produces no Ontofelia↔owner sameAs', async () => {
    const { store, updates } = makeMockStore();
    const engine = new KnowledgeEngine(store);
    await engine.storeFact(
      { subject: 'Ontofelia', subjectType: 'Agent', predicate: 'name',
        object: 'Ontofelia', objectType: 'literal', sourceKind: 'user' },
      ownerCtx,
    );
    expect(updates.filter(u => u.includes('sameAs'))).toHaveLength(0);
  });

  it('G1: even a user-alias subject is never sameAs-linked to a self-alias object', async () => {
    const { store, updates } = makeMockStore();
    const engine = new KnowledgeEngine(store);
    // Pathological: "my name is Ontofelia" — must not link the owner to the agent.
    await engine.storeFact(
      { subject: 'User', subjectType: 'Person', predicate: 'name',
        object: 'Ontofelia', objectType: 'literal', sourceKind: 'user' },
      ownerCtx,
    );
    const combined = updates.join('\n');
    expect(combined).not.toContain('sameAs');
  });
});

describe('#1035 H1 — descriptive agent predicates containing "expected"/"requested" are NOT re-anchored', () => {
  // A descriptive statement about the agent whose parser-emitted predicate
  // merely CONTAINS the root "expected" (e.g. "Dein erwartetes Verhalten ist
  // Hilfsbereitschaft" → expectedBehavior) must stay on the agent entity /
  // worldview and NEVER land on user:owner. Bare-root substring matching
  // re-anchored it onto the owner (the inverse-direction AC#3 regression).
  it('"expectedBehavior" descriptive agent fact stays on entity:Ontofelia/worldview, never user:owner', async () => {
    const { store, updates } = makeMockStore();
    const engine = new KnowledgeEngine(store);
    const fact = { subject: 'Ontofelia', subjectType: 'Agent', predicate: 'expectedBehavior',
      object: 'helpful', objectType: 'literal', sourceKind: 'user' as const };

    // Symbolic layer: NOT an expectation predicate → not re-anchored to the user …
    expect(canonicalUserUri(engine, 'Ontofelia', fact, ownerCtx)).toBeNull();
    // … and routes to worldview, never the user graph, never :self.
    const graph = resolveTargetGraph(engine, fact, ownerCtx);
    expect(graph).toBe('urn:ontofelia:worldview');
    expect(graph).not.toContain('user:owner');

    await engine.storeFact(fact, ownerCtx);
    const combined = updates.join('\n');
    expect(combined).toContain('entity:Ontofelia');
    expect(combined).not.toContain('user:owner');
  });

  it('the genuine request predicate "isRequestedToHelpWith" IS still re-anchored (control)', () => {
    const engine = new KnowledgeEngine({} as unknown as KEStore);
    const fact = { subject: 'Ontofelia', subjectType: 'Agent', predicate: 'isRequestedToHelpWith',
      object: 'project organization', objectType: 'literal', sourceKind: 'user' };
    expect(canonicalUserUri(engine, 'Ontofelia', fact, ownerCtx)).toBe('urn:ontofelia:entity:user:owner');
  });
});

describe('#1035 M1 — alternate agent-name spelling object never mints a sameAs', () => {
  it('object "Onto Felia" (slug entity:Onto_Felia) produces NO sameAs (G1 via denotesAgent)', async () => {
    const { store, updates } = makeMockStore();
    const engine = new KnowledgeEngine(store);
    // Pathological: "my name is Onto Felia" — a near-miss spelling of the agent.
    await engine.storeFact(
      { subject: 'User', subjectType: 'Person', predicate: 'name',
        object: 'Onto Felia', objectType: 'literal', sourceKind: 'user' },
      ownerCtx,
    );
    const combined = updates.join('\n');
    expect(combined).not.toContain('sameAs');
  });
});

describe('#1035 AC5 — owner name-resolution still works', () => {
  it('DE "Ich heiße Gökhan" still links user:owner owl:sameAs <Gökhan>', async () => {
    const { store, updates } = makeMockStore();
    const engine = new KnowledgeEngine(store);
    await engine.storeFact(
      { subject: 'User', subjectType: 'Person', predicate: 'name',
        object: 'Gökhan', objectType: 'literal', sourceKind: 'user' },
      ownerCtx,
    );
    const sameAs = updates.filter(u => u.includes('sameAs'));
    expect(sameAs.length).toBeGreaterThan(0);
    const combined = sameAs.join(' ');
    expect(combined).toContain('entity:user:owner');
    // toEntityUri('Gökhan') → percent-encoded named-person entity.
    expect(combined).toContain('entity:G%C3%B6khan');
  });
});

describe('#1035 AC6 — pronoun regression DE+EN', () => {
  // Each row: a parsed subject (post-deixis-resolution) and the expectation.
  const userGraph = 'urn:ontofelia:user:owner';
  const worldview = 'urn:ontofelia:worldview';

  it('first-person (ich/I) facts → user node + user graph', () => {
    const engine = new KnowledgeEngine({} as unknown as KEStore);
    for (const subject of ['User']) {
      const fact = { subject, subjectType: 'Person', predicate: 'livesIn',
        object: 'Berlin', objectType: 'Place', sourceKind: 'user' };
      expect(canonicalUserUri(engine, subject, fact, ownerCtx)).toBe('urn:ontofelia:entity:user:owner');
      expect(resolveTargetGraph(engine, fact, ownerCtx)).toBe(userGraph);
    }
  });

  it('"me" denotes the USER, never the agent (alias cleanup)', () => {
    const engine = new KnowledgeEngine({} as unknown as KEStore);
    const fact = { subject: 'me', subjectType: 'Person', predicate: 'likes',
      object: 'coffee', objectType: 'literal', sourceKind: 'user' };
    expect(isAboutAgent(engine, fact)).toBe(false);
    expect(canonicalUserUri(engine, 'me', fact, ownerCtx)).toBe('urn:ontofelia:entity:user:owner');
    expect(resolveTargetGraph(engine, fact, ownerCtx)).toBe(userGraph);
  });

  it('second-person descriptive (du/you, dein/your) facts → agent entity + worldview', () => {
    const engine = new KnowledgeEngine({} as unknown as KEStore);
    const fact = { subject: 'Ontofelia', subjectType: 'Agent', predicate: 'description',
      object: 'helpful', objectType: 'literal', sourceKind: 'user' };
    // Stays on the agent — not re-anchored to the owner.
    expect(canonicalUserUri(engine, 'Ontofelia', fact, ownerCtx)).toBeNull();
    const graph = resolveTargetGraph(engine, fact, ownerCtx);
    expect(graph).toBe(worldview);
    expect(graph).not.toContain(':self');
    expect(graph).not.toContain('user:owner');
  });

  it('first-person possessive (mein/my) introduces a third entity → worldview', () => {
    const engine = new KnowledgeEngine({} as unknown as KEStore);
    // "mein Auto ist rot" → subject is the possessed entity, not the user.
    const fact = { subject: 'Auto', subjectType: 'Concept', predicate: 'color',
      object: 'red', objectType: 'literal', sourceKind: 'user' };
    expect(canonicalUserUri(engine, 'Auto', fact, ownerCtx)).toBeNull();
    expect(resolveTargetGraph(engine, fact, ownerCtx)).toBe(worldview);
  });

  it('user expectation about the agent is STILL re-anchored to the user graph', () => {
    const engine = new KnowledgeEngine({} as unknown as KEStore);
    const fact = { subject: 'Ontofelia', subjectType: 'Agent', predicate: 'isRequestedToHelpWith',
      object: 'project organization', objectType: 'literal', sourceKind: 'user' };
    expect(canonicalUserUri(engine, 'Ontofelia', fact, ownerCtx)).toBe('urn:ontofelia:entity:user:owner');
    expect(resolveTargetGraph(engine, fact, ownerCtx)).toBe(userGraph);
  });
});
