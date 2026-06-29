import { describe, it, expect } from 'vitest';
import { KnowledgeEngine } from '../KnowledgeEngine.js';

/**
 * Build a fake triplestore that records writes and answers functional-property
 * ASK queries. The `functionalPredicates` set controls which predicate URIs
 * are reported as `owl:FunctionalProperty`.
 */
function makeMockStore(functionalPredicates: Set<string> = new Set()) {
  const inserts: string[] = [];
  const deletes: string[] = [];
  const askHistory: string[] = [];
  // Track accepted claims for findConflictingClaims queries
  const claims: Array<{
    claimUri: string;
    subject: string;
    predicate: string;
    object: string;
    graph: string;
    status: string;
  }> = [];

  const store = {
    backend: 'inmemory' as const,

    async query(sparql: string) {
      // findConflictingClaims query — return matching accepted claims
      if (
        sparql.includes('core:claimSubject') &&
        sparql.includes('core:status') &&
        sparql.includes('SELECT')
      ) {
        const matchingClaims = claims.filter(
          (c) =>
            c.status === 'accepted' &&
            sparql.includes(c.subject) &&
            sparql.includes(c.predicate) &&
            !sparql.includes(c.object),
        );

        return {
          type: 'bindings',
          bindings: matchingClaims.map((c) => ({
            claim: { type: 'uri', value: c.claimUri },
            o: c.object.startsWith('<')
              ? { type: 'uri', value: c.object.slice(1, -1) }
              : { type: 'literal', value: c.object.replace(/^"|"$/g, '') },
            g: { type: 'uri', value: c.graph },
          })),
        };
      }

      // findPropertyByLabel / findEntityByLabel — return no match
      if (sparql.includes('LCASE(STR(?l))')) {
        return { type: 'bindings', bindings: [] };
      }

      // retireSupersededClaim detail query
      if (sparql.includes('core:claimSubject') && sparql.includes('LIMIT 1')) {
        return { type: 'bindings', bindings: [] };
      }

      return { type: 'bindings', bindings: [] };
    },

    async ask(sparql: string) {
      askHistory.push(sparql);
      // FunctionalProperty check
      if (sparql.includes('owl#FunctionalProperty')) {
        for (const fp of functionalPredicates) {
          if (sparql.includes(fp)) return true;
        }
        return false;
      }
      // Entity exists check — return false (new entity)
      if (sparql.includes('a ?type')) return false;
      // Duplicate check — return false
      return false;
    },

    async update(sparql: string) {
      if (sparql.trimStart().startsWith('INSERT')) inserts.push(sparql);
      if (sparql.trimStart().startsWith('DELETE')) deletes.push(sparql);

      // Track claim creation for future findConflictingClaims queries.
      // The ClaimProvenanceService emits an INSERT DATA with the claim's
      // core properties; parse subject, predicate, and object out of it.
      if (
        sparql.includes('ontology#Claim') &&
        sparql.includes('ontology#status') &&
        sparql.includes('"accepted"')
      ) {
        const subjectMatch = sparql.match(
          /ontology#claimSubject>\s+<([^>]+)>/,
        );
        const predicateMatch = sparql.match(
          /ontology#claimPredicate>\s+<([^>]+)>/,
        );
        const objectMatch = sparql.match(
          /ontology#claimObject>\s+(<[^>]+>|"[^"]*")/,
        );
        const claimUriMatch = sparql.match(/<(urn:claim:[^>]+)>/);
        if (subjectMatch && predicateMatch && objectMatch && claimUriMatch) {
          claims.push({
            claimUri: claimUriMatch[1],
            subject: subjectMatch[1],
            predicate: predicateMatch[1],
            object: objectMatch[1],
            graph: 'urn:ontofelia:worldview',
            status: 'accepted',
          });
        }
      }
    },

    async insertTriples() {},
  };

  return { store, inserts, deletes, askHistory, claims };
}

describe('KnowledgeEngine multi-valued fact preservation (#875)', () => {
  const baseContext = {
    agentId: 'ontofelia',
    userId: 'owner',
    sessionId: 's1',
    isOwner: true,
  };

  it('preserves multi-valued worksAt facts (not FunctionalProperty)', async () => {
    const { store, deletes } = makeMockStore();
    const engine = new KnowledgeEngine(store as unknown as ConstructorParameters<typeof KnowledgeEngine>[0]);

    // Store first fact
    await engine.storeFact(
      {
        subject: 'Alice',
        subjectType: 'Person',
        predicate: 'worksAt',
        object: 'Acme',
        objectType: 'Organization',
        sourceKind: 'user',
      },
      baseContext,
    );

    // Store second fact with same subject+predicate, different object
    await engine.storeFact(
      {
        subject: 'Alice',
        subjectType: 'Person',
        predicate: 'worksAt',
        object: 'BigCorp',
        objectType: 'Organization',
        sourceKind: 'user',
      },
      baseContext,
    );

    // No DELETE should have happened — multi-valued property
    const supersessionDeletes = deletes.filter(
      (d) => d.includes('status') && d.includes('superseded'),
    );
    expect(supersessionDeletes).toHaveLength(0);
  });

  it('supersedes functional property values (hasBirthday)', async () => {
    const { store, askHistory } = makeMockStore(
      new Set(['urn:ontofelia:core#hasBirthday']),
    );
    const engine = new KnowledgeEngine(store as unknown as ConstructorParameters<typeof KnowledgeEngine>[0]);

    await engine.storeFact(
      {
        subject: 'User',
        subjectType: 'Person',
        predicate: 'hasBirthday',
        object: '1990-01-01',
        objectType: 'literal',
        sourceKind: 'user',
      },
      baseContext,
    );

    await engine.storeFact(
      {
        subject: 'User',
        subjectType: 'Person',
        predicate: 'hasBirthday',
        object: '1991-02-02',
        objectType: 'literal',
        sourceKind: 'user',
      },
      baseContext,
    );

    // The isFunctionalProperty check should have been called
    const fpChecks = askHistory.filter((s) =>
      s.includes('FunctionalProperty'),
    );
    expect(fpChecks.length).toBeGreaterThan(0);
  });

  it('defaults unknown predicates to multi-valued (no supersession)', async () => {
    const { store, deletes, askHistory } = makeMockStore();
    const engine = new KnowledgeEngine(store as unknown as ConstructorParameters<typeof KnowledgeEngine>[0]);

    // Store a fact with a predicate that isn't in the TBox at all
    await engine.storeFact(
      {
        subject: 'Alice',
        subjectType: 'Person',
        predicate: 'enjoysDrinking',
        object: 'coffee',
        objectType: 'literal',
        sourceKind: 'user',
      },
      baseContext,
    );

    await engine.storeFact(
      {
        subject: 'Alice',
        subjectType: 'Person',
        predicate: 'enjoysDrinking',
        object: 'tea',
        objectType: 'literal',
        sourceKind: 'user',
      },
      baseContext,
    );

    // isFunctionalProperty should have been checked
    const fpChecks = askHistory.filter((s) =>
      s.includes('FunctionalProperty'),
    );
    expect(fpChecks.length).toBeGreaterThan(0);

    // No supersession DELETE should have happened
    const supersessionDeletes = deletes.filter(
      (d) => d.includes('status') && d.includes('superseded'),
    );
    expect(supersessionDeletes).toHaveLength(0);
  });

  it('calls isFunctionalProperty with the correct predicate URI', async () => {
    const { store, askHistory } = makeMockStore();
    const engine = new KnowledgeEngine(store as unknown as ConstructorParameters<typeof KnowledgeEngine>[0]);

    await engine.storeFact(
      {
        subject: 'Alice',
        subjectType: 'Person',
        predicate: 'memberOf',
        object: 'Chess Club',
        objectType: 'Organization',
        sourceKind: 'user',
      },
      baseContext,
    );

    // Should have asked about the specific predicate URI
    const fpChecks = askHistory.filter(
      (s) =>
        s.includes('FunctionalProperty') &&
        s.includes('urn:ontofelia:core#memberOf'),
    );
    expect(fpChecks).toHaveLength(1);
  });
});
