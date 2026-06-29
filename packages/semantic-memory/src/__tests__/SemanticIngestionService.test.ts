import { describe, it, expect, vi } from 'vitest';
import { SemanticIngestionService } from '../ingestion/SemanticIngestionService.js';
import { KnowledgeEngine } from '../KnowledgeEngine.js';
import type { SemanticParseResult, ParsedFact } from '../ingestion/types.js';

/** Create a mock KnowledgeEngine */
function createMockEngine(options?: { duplicates?: boolean; errors?: boolean }) {
  return {
    // Mirrors the real KnowledgeEngine: a predicate not already in the shared
    // TBox is reported via newProperties and the fact becomes a proposal.
    // The seeded TBox here contains only the well-known core predicates.
    storeFact: vi.fn().mockImplementation(async (fact: { predicate?: string }) => {
      if (options?.errors) throw new Error('Fuseki unavailable');
      const knownPredicates = new Set(['livesIn', 'name', 'profession', 'knows']);
      const predicate = fact?.predicate ?? '';
      const isKnown = knownPredicates.has(predicate);
      return {
        success: true,
        subjectUri: 'urn:ontofelia:entity:User',
        predicateUri: `urn:ontofelia:core#${predicate}`,
        objectUri: 'urn:ontofelia:entity:Berlin',
        newEntities: [],
        newProperties: isKnown ? [] : [`urn:ontofelia:core#${predicate}`],
        tripleCount: options?.duplicates ? 0 : 1,
      };
    }),
  } as unknown as KnowledgeEngine;
}

function makeFact(overrides: Partial<ParsedFact> = {}): ParsedFact {
  return {
    subject: 'User',
    subjectType: 'Person',
    predicate: 'livesIn',
    object: 'Berlin',
    objectType: 'Place',
    confidence: 'high',
    sourceSpan: 'Ich lebe in Berlin',
    kind: 'fact',
    ...overrides,
  };
}

function makeParseResult(overrides: Partial<SemanticParseResult> = {}): SemanticParseResult {
  return {
    facts: [],
    proposals: [],
    confidence: 'high',
    meta: { parseTimeMs: 100, modelUsed: 'test', skipped: false },
    ...overrides,
  };
}

const TEST_CONTEXT = {
  agentId: 'test-agent',
  sessionId: 'test-session',
  isOwner: true,
};

describe('SemanticIngestionService', () => {
  describe('fact storage', () => {
    it('stores high-confidence facts', async () => {
      const engine = createMockEngine();
      const service = new SemanticIngestionService(engine);

      const result = await service.ingest(
        makeParseResult({ facts: [makeFact()] }),
        TEST_CONTEXT
      );

      expect(result.storedFacts).toHaveLength(1);
      expect(result.skippedFacts).toHaveLength(0);
      expect(engine.storeFact).toHaveBeenCalledOnce();
    });

    it('stores medium-confidence facts', async () => {
      const engine = createMockEngine();
      const service = new SemanticIngestionService(engine);

      const result = await service.ingest(
        makeParseResult({ facts: [makeFact({ confidence: 'medium' })] }),
        TEST_CONTEXT
      );

      expect(result.storedFacts).toHaveLength(1);
      expect(engine.storeFact).toHaveBeenCalledOnce();
    });

    it('stores multiple facts from one message', async () => {
      const engine = createMockEngine();
      const service = new SemanticIngestionService(engine);

      const result = await service.ingest(
        makeParseResult({
          facts: [
            makeFact({ predicate: 'name', object: 'Alex', objectType: 'literal' }),
            makeFact({ predicate: 'livesIn', object: 'London', objectType: 'Place' }),
            makeFact({ predicate: 'worksAt', object: 'Google', objectType: 'Organization' }),
          ],
        }),
        TEST_CONTEXT
      );

      expect(result.storedFacts).toHaveLength(3);
      expect(engine.storeFact).toHaveBeenCalledTimes(3);
    });
  });

  describe('fact filtering', () => {
    it('skips question facts', async () => {
      const engine = createMockEngine();
      const service = new SemanticIngestionService(engine);

      const result = await service.ingest(
        makeParseResult({ facts: [makeFact({ kind: 'question' })] }),
        TEST_CONTEXT
      );

      expect(result.storedFacts).toHaveLength(0);
      expect(result.skippedFacts).toHaveLength(1);
      expect(result.skippedFacts[0].reason).toBe('question');
      expect(engine.storeFact).not.toHaveBeenCalled();
    });

    it('accepts uncertain facts immediately (truth-maintenance model)', async () => {
      const engine = createMockEngine();
      const service = new SemanticIngestionService(engine);

      const result = await service.ingest(
        makeParseResult({ facts: [makeFact({ kind: 'uncertain', predicate: 'hasHobby' })] }),
        TEST_CONTEXT
      );

      // Uncertain facts are no longer staged — they are accepted on arrival.
      // The confidence is recorded on the claim, but does not gate acceptance.
      expect(result.storedFacts).toHaveLength(1);
      expect(engine.storeFact).toHaveBeenCalledOnce();
      expect(engine.storeFact).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'accepted' }),
        expect.anything()
      );
    });

    it('accepts low-confidence facts immediately', async () => {
      const engine = createMockEngine();
      const service = new SemanticIngestionService(engine);

      const result = await service.ingest(
        makeParseResult({ facts: [makeFact({ confidence: 'low' })] }),
        TEST_CONTEXT
      );

      expect(result.storedFacts).toHaveLength(1);
      expect(engine.storeFact).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'accepted', confidenceLabel: 'low' }),
        expect.anything()
      );
    });

    it('detects duplicates', async () => {
      const engine = createMockEngine({ duplicates: true });
      const service = new SemanticIngestionService(engine);

      const result = await service.ingest(
        makeParseResult({ facts: [makeFact()] }),
        TEST_CONTEXT
      );

      expect(result.storedFacts).toHaveLength(0);
      expect(result.skippedFacts).toHaveLength(1);
      expect(result.skippedFacts[0].reason).toBe('duplicate');
    });
  });

  describe('proposals', () => {
    it('passes parser proposals through unchanged', async () => {
      const engine = createMockEngine();
      const service = new SemanticIngestionService(engine);

      const result = await service.ingest(
        makeParseResult({
          facts: [makeFact({ kind: 'uncertain', predicate: 'hasTitle' })],
          proposals: [{
            kind: 'property',
            name: 'hasJobTitle',
            domain: 'Person',
            range: 'literal',
            reason: 'From parser',
            similarExistingTerms: [],
            recommendedAction: 'create',
          }],
        }),
        TEST_CONTEXT
      );

      // Facts no longer generate proposals — only parser proposals pass through.
      // The uncertain fact itself is accepted and stored.
      expect(result.proposals).toHaveLength(1);
      expect(result.proposals[0].name).toBe('hasJobTitle');
      expect(result.storedFacts).toHaveLength(1);
    });
  });

  describe('error handling', () => {
    it('skips facts on storage error', async () => {
      const engine = createMockEngine({ errors: true });
      const service = new SemanticIngestionService(engine);

      const result = await service.ingest(
        makeParseResult({ facts: [makeFact()] }),
        TEST_CONTEXT
      );

      expect(result.storedFacts).toHaveLength(0);
      expect(result.skippedFacts).toHaveLength(1);
      expect(result.skippedFacts[0].reason).toBe('error');
    });

    it('returns empty report for skipped (trivial) messages', async () => {
      const engine = createMockEngine();
      const service = new SemanticIngestionService(engine);

      const result = await service.ingest(
        makeParseResult({ meta: { parseTimeMs: 0, modelUsed: 'none', skipped: true } }),
        TEST_CONTEXT
      );

      expect(result.storedFacts).toHaveLength(0);
      expect(result.skippedFacts).toHaveLength(0);
      expect(result.proposals).toHaveLength(0);
      expect(engine.storeFact).not.toHaveBeenCalled();
    });
  });

  describe('mixed messages', () => {
    it('handles a message with facts, questions, and uncertain content', async () => {
      const engine = createMockEngine();
      const service = new SemanticIngestionService(engine);

      const result = await service.ingest(
        makeParseResult({
          facts: [
            makeFact({ predicate: 'name', object: 'Alex', objectType: 'literal', kind: 'fact', confidence: 'high' }),
            makeFact({ predicate: 'livesIn', object: '?', objectType: 'Place', kind: 'question' }),
            makeFact({ predicate: 'hasHobby', object: 'Cooking', objectType: 'literal', kind: 'uncertain' }),
            makeFact({ predicate: 'age', object: '35', objectType: 'literal', kind: 'fact', confidence: 'low' }),
          ],
        }),
        TEST_CONTEXT
      );

      // All three non-question facts are accepted and stored — the high-
      // confidence one, the uncertain one and the low-confidence one.
      expect(result.storedFacts).toHaveLength(3);
      expect(result.storedFacts.map(s => s.fact.predicate)).toContain('name');

      // Only the question is skipped — questions are never stored.
      expect(result.skippedFacts).toHaveLength(1);
      expect(result.skippedFacts[0].reason).toBe('question');

      // Facts no longer generate proposals; none were supplied by the parser.
      expect(result.proposals).toHaveLength(0);
    });
  });
});
