import { describe, it, expect, vi, afterEach } from 'vitest';
import { KnowledgeEngine } from '../KnowledgeEngine.js';

type KEStore = ConstructorParameters<typeof KnowledgeEngine>[0];

/**
 * Build a fake triplestore along the lines of the one in
 * SupersessionMultiValue.test.ts: it tracks accepted claims well enough to
 * answer `findConflictingClaims` and the claim-detail lookup in
 * `retireSupersededClaim`, and lets a test's `updateOverride` make a
 * specific `update()` call throw without disturbing the others.
 */
function makeMockStore(options: {
  functionalPredicates?: Set<string>;
  updateOverride?: (sparql: string) => void; // throw to force a failure
} = {}) {
  const { functionalPredicates = new Set(), updateOverride } = options;
  const inserts: string[] = [];
  const deletes: string[] = [];
  const claims: Array<{
    claimUri: string;
    subject: string;
    predicate: string;
    object: string;
    graph: string;
  }> = [];

  const store = {
    backend: 'inmemory' as const,

    async query(sparql: string) {
      // findConflictingClaims — return matching accepted claims whose
      // object differs from the new one (the caller filters by object).
      if (sparql.includes('core:claimSubject') && sparql.includes('?claim')) {
        return {
          type: 'bindings',
          bindings: claims.map((c) => ({
            claim: { type: 'uri', value: c.claimUri },
            o: c.object.startsWith('<')
              ? { type: 'uri', value: c.object.slice(1, -1) }
              : { type: 'literal', value: c.object.replace(/^"|"$/g, '') },
            g: { type: 'uri', value: c.graph },
          })),
        };
      }

      // retireSupersededClaim's claim-detail lookup — answer with the real
      // subject/predicate/object so the truth-maintenance block is reached.
      if (sparql.includes('core:claimSubject') && sparql.includes('LIMIT 1')) {
        const match = claims.find((c) => sparql.includes(c.claimUri));
        if (!match) return { type: 'bindings', bindings: [] };
        return {
          type: 'bindings',
          bindings: [{
            s: { type: 'uri', value: match.subject },
            p: { type: 'uri', value: match.predicate },
            o: match.object.startsWith('<')
              ? { type: 'uri', value: match.object.slice(1, -1) }
              : { type: 'literal', value: match.object.replace(/^"|"$/g, '') },
          }],
        };
      }

      // findPropertyByLabel / findEntityByLabel — no match, mint fresh URIs.
      return { type: 'bindings', bindings: [] };
    },

    async ask(sparql: string) {
      if (sparql.includes('owl#FunctionalProperty')) {
        for (const fp of functionalPredicates) {
          if (sparql.includes(fp)) return true;
        }
        return false;
      }
      return false; // entity-exists / duplicate checks
    },

    async update(sparql: string) {
      updateOverride?.(sparql); // may throw

      if (sparql.trimStart().startsWith('INSERT')) inserts.push(sparql);
      if (sparql.trimStart().startsWith('DELETE')) deletes.push(sparql);

      // Track claim creation (mirrors ClaimProvenanceService.createClaim's
      // INSERT shape) for findConflictingClaims / claim-detail lookups above.
      if (
        sparql.includes('ontology#Claim') &&
        sparql.includes('ontology#status') &&
        sparql.includes('"accepted"')
      ) {
        const subjectMatch = sparql.match(/ontology#claimSubject>\s+<([^>]+)>/);
        const predicateMatch = sparql.match(/ontology#claimPredicate>\s+<([^>]+)>/);
        const objectMatch = sparql.match(/ontology#claimObject>\s+(<[^>]+>|"[^"]*")/);
        const graphMatch = sparql.match(/ontology#assertedInGraph>\s+<([^>]+)>/);
        const claimUriMatch = sparql.match(/<(urn:claim:[^>]+)>/);
        if (subjectMatch && predicateMatch && objectMatch && claimUriMatch) {
          claims.push({
            claimUri: claimUriMatch[1],
            subject: subjectMatch[1],
            predicate: predicateMatch[1],
            object: objectMatch[1],
            // The graph the claim was really asserted in: findConflictingClaims
            // only lets claims in the new fact's target graph compete.
            graph: graphMatch?.[1] ?? 'urn:ontofelia:worldview',
          });
        }
      }
    },

    async insertTriples() {},
  };

  return { store, inserts, deletes };
}

const baseContext = {
  agentId: 'ontofelia',
  userId: 'owner',
  sessionId: 's1',
  isOwner: true,
};

describe('KnowledgeEngine best-effort failure visibility', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('path 1 — truth maintenance: logs, counts, and records a pending repair without blocking the write', async () => {
    const { store } = makeMockStore({
      functionalPredicates: new Set(['urn:ontofelia:core#hasBirthday']),
    });
    const engine = new KnowledgeEngine(store as unknown as KEStore);
    // Force a reasoner onto the engine (no 'oxigraph' backend here) whose
    // materialize() always throws — this is what both the on-write
    // reasoning path and the post-supersession truth-maintenance sweep call.
    (engine as unknown as { reasoner: { materialize: () => Promise<unknown> } }).reasoner = {
      materialize: vi.fn().mockRejectedValue(new Error('reasoner exploded')),
    };
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await engine.storeFact(
      {
        subject: 'User', subjectType: 'Person', predicate: 'hasBirthday',
        object: '1990-01-01', objectType: 'literal', sourceKind: 'user',
      },
      baseContext,
    );

    // Second write with the same subject+predicate, different object —
    // hasBirthday is functional, so this supersedes the first claim and
    // triggers the truth-maintenance sweep, which the fake reasoner fails.
    const result = await engine.storeFact(
      {
        subject: 'User', subjectType: 'Person', predicate: 'hasBirthday',
        object: '1991-02-02', objectType: 'literal', sourceKind: 'user',
      },
      baseContext,
    );

    // The write itself was not blocked by the best-effort failure.
    expect(result.success).toBe(true);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[KnowledgeEngine] truth maintenance failed'),
      expect.any(String),
    );

    const stats = engine.getBestEffortStats();
    expect(stats.truthMaintenance.failures).toBe(1);
    expect(stats.truthMaintenance.lastError).toContain('reasoner exploded');

    const pending = engine.getPendingTruthMaintenance();
    expect(pending).toHaveLength(1);
    // "User" is the owner, so the fact lives in the owner's private graph.
    expect(pending[0].graph).toBe('urn:ontofelia:user:owner');
  });

  it('path 2 — on-write reasoning: logs and counts without blocking the write', async () => {
    const { store } = makeMockStore();
    const engine = new KnowledgeEngine(store as unknown as KEStore);
    (engine as unknown as { reasoner: { materialize: () => Promise<unknown> } }).reasoner = {
      materialize: vi.fn().mockRejectedValue(new Error('reasoner tripped')),
    };
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await engine.storeFact(
      {
        subject: 'Alice', subjectType: 'Person', predicate: 'worksAt',
        object: 'Acme', objectType: 'Organization', sourceKind: 'user',
      },
      baseContext,
    );

    expect(result.success).toBe(true);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[KnowledgeEngine] on-write reasoning failed'),
      expect.any(String),
    );

    const stats = engine.getBestEffortStats();
    expect(stats.reasoning.failures).toBe(1);
    expect(stats.reasoning.lastError).toContain('reasoner tripped');
  });

  it('path 3 — entity resolution: logs and counts without blocking the write', async () => {
    const { store } = makeMockStore({
      // Throw only for the owl:sameAs INSERT, not for any other update
      // (claim creation, base-triple insert, entity-type insert, …).
      updateOverride: (sparql: string) => {
        if (sparql.includes('owl:sameAs')) {
          throw new Error('sameAs insert failed');
        }
      },
    });
    const engine = new KnowledgeEngine(store as unknown as KEStore);
    // No reasoner on this engine (backend !== 'oxigraph'), so only the
    // entity-resolution path under test can fail here.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await engine.storeFact(
      {
        subject: 'I', subjectType: 'Person', predicate: 'name',
        object: 'Alice', objectType: 'literal', sourceKind: 'user',
      },
      baseContext,
    );

    expect(result.success).toBe(true);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[KnowledgeEngine] entity resolution failed'),
      expect.any(String),
    );

    const stats = engine.getBestEffortStats();
    expect(stats.entityResolution.failures).toBe(1);
    expect(stats.entityResolution.lastError).toContain('sameAs insert failed');
  });

  it('pending truth-maintenance list is capped and drops the oldest entry once full', async () => {
    const { store } = makeMockStore();
    const engine = new KnowledgeEngine(store as unknown as KEStore);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Push directly via the private helper — exercising the cap through
    // storeFact() end-to-end would need 1000+ real writes, which is both
    // slow and unnecessary: the cap logic itself only depends on the
    // push path, not on how an entry was produced.
    type EngineInternals = {
      pushPendingTruthMaintenance: (entry: {
        claimUri: string; graph: string; subject: string; predicate: string;
        failedAt: string; error: string;
      }) => void;
    };
    const internals = engine as unknown as EngineInternals;

    const total = 1005;
    for (let i = 0; i < total; i++) {
      internals.pushPendingTruthMaintenance({
        claimUri: `urn:claim:${i}`,
        graph: 'urn:ontofelia:worldview',
        subject: 'urn:ontofelia:entity:X',
        predicate: 'urn:ontofelia:core#p',
        failedAt: new Date().toISOString(),
        error: 'synthetic',
      });
    }

    const pending = engine.getPendingTruthMaintenance();
    expect(pending).toHaveLength(1000);
    // The oldest 5 entries (claim 0..4) were dropped; the list keeps the
    // most recent 1000.
    expect(pending[0].claimUri).toBe('urn:claim:5');
    expect(pending[pending.length - 1].claimUri).toBe(`urn:claim:${total - 1}`);

    const stats = engine.getBestEffortStats();
    expect(stats.droppedPendingTruthMaintenance).toBe(5);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('pending truth-maintenance list full'),
      expect.anything(),
      expect.anything(),
    );
  });

  it('listKnownEntities: a triplestore query error is logged and the fallback [] is returned unchanged', async () => {
    const store = {
      backend: 'inmemory' as const,
      query: vi.fn().mockRejectedValue(new Error('triplestore down')),
      ask: vi.fn().mockResolvedValue(false),
      update: vi.fn().mockResolvedValue(undefined),
      insertTriples: vi.fn().mockResolvedValue(undefined),
    };
    const engine = new KnowledgeEngine(store as unknown as KEStore);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await engine.listKnownEntities('ontofelia', 'owner');

    expect(result).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[KnowledgeEngine] listKnownEntities query failed'),
      expect.any(String),
    );
  });

  it('findEntityByLabel: a triplestore query error on the write path is logged and null is returned unchanged', async () => {
    const store = {
      backend: 'inmemory' as const,
      query: vi.fn().mockRejectedValue(new Error('label lookup exploded')),
      ask: vi.fn().mockResolvedValue(false),
      update: vi.fn().mockResolvedValue(undefined),
      insertTriples: vi.fn().mockResolvedValue(undefined),
    };
    const engine = new KnowledgeEngine(store as unknown as KEStore);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // findEntityByLabel is private — called through the write path it feeds
    // (resolveEntity) would also exercise mintDisambiguatedUri's own `ask`
    // call, so call it directly to isolate the catch under test.
    type EngineInternals = {
      findEntityByLabel: (name: string, type?: string) => Promise<unknown>;
    };
    const result = await (engine as unknown as EngineInternals).findEntityByLabel('Alice');

    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[KnowledgeEngine] findEntityByLabel query failed (label=Alice)'),
      expect.any(String),
    );
  });
});
