import { describe, it, expect, vi } from 'vitest';
import { SemanticParser } from '../ingestion/SemanticParser.js';
import type { ProviderAdapter, ChatResponse } from '@ontofelia/core';
import type { OntologyContext } from '../ingestion/SemanticParser.js';

/** Create a mock ProviderAdapter that returns a predefined JSON response */
function createMockProvider(jsonResponse: string): ProviderAdapter {
  return {
    name: 'mock',
    initialize: vi.fn(),
    healthCheck: vi.fn(),
    chat: vi.fn().mockResolvedValue({
      id: 'mock-id',
      content: jsonResponse,
      toolCalls: [],
      finishReason: 'stop',
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    } satisfies ChatResponse),
    chatStream: vi.fn(),
  } as unknown as ProviderAdapter;
}

const TEST_CONTEXT: OntologyContext = {
  classes: ['Person', 'Organization', 'Place', 'Concept', 'Event'],
  properties: [
    { name: 'worksAt', label: 'works at', domain: 'Person', range: 'Organization', aliases: ['works at'] },
    { name: 'livesIn', label: 'lives in', domain: 'Person', range: 'Place', aliases: ['lives in'] },
    { name: 'name', label: 'name', domain: 'Person', range: 'literal', aliases: ['is called', 'name'] },
  ],
};

describe('SemanticParser', () => {
  describe('trivial message bypass', () => {
    it('skips "Hello" without calling the LLM', async () => {
      const provider = createMockProvider('{}');
      const parser = new SemanticParser(provider);

      const result = await parser.parse('Hello', TEST_CONTEXT);

      expect(result.meta.skipped).toBe(true);
      expect(result.meta.skipReason).toBe('greeting');
      expect(result.meta.modelUsed).toBe('none');
      expect(result.facts).toEqual([]);
      expect(provider.chat).not.toHaveBeenCalled();
    });

    it('skips emoji-only messages', async () => {
      const provider = createMockProvider('{}');
      const parser = new SemanticParser(provider);

      const result = await parser.parse('👍', TEST_CONTEXT);

      expect(result.meta.skipped).toBe(true);
      expect(result.meta.skipReason).toBe('emoji_only');
      expect(provider.chat).not.toHaveBeenCalled();
    });
  });

  describe('LLM parsing', () => {
    it('parses a simple fact statement', async () => {
      const llmResponse = JSON.stringify({
        facts: [{
          subject: 'User',
          subjectType: 'Person',
          predicate: 'livesIn',
          object: 'London',
          objectType: 'Place',
          confidence: 'high',
          sourceSpan: 'I live in London',
          kind: 'fact',
        }],
        proposals: [],
        questionIntent: null,
        confidence: 'high',
      });

      const provider = createMockProvider(llmResponse);
      const parser = new SemanticParser(provider);

      const result = await parser.parse('I live in London', TEST_CONTEXT);

      expect(result.meta.skipped).toBe(false);
      expect(result.facts).toHaveLength(1);
      expect(result.facts[0].subject).toBe('User');
      expect(result.facts[0].predicate).toBe('livesIn');
      expect(result.facts[0].object).toBe('London');
      expect(result.facts[0].kind).toBe('fact');
      expect(result.confidence).toBe('high');
    });

    it('parses a question into a QuestionIntent', async () => {
      const llmResponse = JSON.stringify({
        facts: [],
        proposals: [],
        questionIntent: {
          naturalLanguage: 'Where does the user live?',
          targetEntity: 'User',
          targetProperty: 'livesIn',
          expectedAnswerType: 'Place',
        },
        confidence: 'high',
      });

      const provider = createMockProvider(llmResponse);
      const parser = new SemanticParser(provider);

      const result = await parser.parse('Where do I live?', TEST_CONTEXT);

      expect(result.questionIntent).toBeDefined();
      expect(result.questionIntent!.naturalLanguage).toBe('Where does the user live?');
      expect(result.questionIntent!.targetProperty).toBe('livesIn');
      expect(result.facts).toHaveLength(0);
    });

    it('parses multiple facts from a compound message', async () => {
      const llmResponse = JSON.stringify({
        facts: [
          {
            subject: 'User', subjectType: 'Person',
            predicate: 'name', object: 'Alex', objectType: 'literal',
            confidence: 'high', sourceSpan: 'I am Alex', kind: 'fact',
          },
          {
            subject: 'User', subjectType: 'Person',
            predicate: 'livesIn', object: 'London', objectType: 'Place',
            confidence: 'high', sourceSpan: 'live in London', kind: 'fact',
          },
          {
            subject: 'User', subjectType: 'Person',
            predicate: 'worksAt', object: 'Semantification', objectType: 'Organization',
            confidence: 'high', sourceSpan: 'work at Semantification', kind: 'fact',
          },
        ],
        proposals: [],
        confidence: 'high',
      });

      const provider = createMockProvider(llmResponse);
      const parser = new SemanticParser(provider);

      const result = await parser.parse(
        'I am Alex, live in London, and work at Semantification',
        TEST_CONTEXT
      );

      expect(result.facts).toHaveLength(3);
      expect(result.facts.map(f => f.predicate)).toEqual(['name', 'livesIn', 'worksAt']);
    });

    it('generates an ontology proposal for unknown properties', async () => {
      const llmResponse = JSON.stringify({
        facts: [{
          subject: 'User', subjectType: 'Person',
          predicate: 'hasJobTitle', object: 'CTO', objectType: 'literal',
          confidence: 'medium', sourceSpan: 'I am CTO', kind: 'uncertain',
        }],
        proposals: [{
          kind: 'property',
          name: 'hasJobTitle',
          domain: 'Person',
          range: 'literal',
          reason: 'User said: "I am CTO"',
          similarExistingTerms: ['worksAt'],
          recommendedAction: 'map_to_existing',
          mapTo: 'worksAt',
        }],
        confidence: 'medium',
      });

      const provider = createMockProvider(llmResponse);
      const parser = new SemanticParser(provider);

      const result = await parser.parse('I am CTO', TEST_CONTEXT);

      expect(result.proposals).toHaveLength(1);
      expect(result.proposals[0].name).toBe('hasJobTitle');
      expect(result.proposals[0].recommendedAction).toBe('map_to_existing');
      expect(result.facts[0].kind).toBe('uncertain');
    });
  });

  describe('error handling', () => {
    it('returns empty result on LLM error', async () => {
      const provider = {
        name: 'mock',
        initialize: vi.fn(),
        healthCheck: vi.fn(),
        chat: vi.fn().mockRejectedValue(new Error('Rate limited')),
        chatStream: vi.fn(),
      } as unknown as ProviderAdapter;

      const parser = new SemanticParser(provider);

      const result = await parser.parse('I live in Berlin', TEST_CONTEXT);

      expect(result.facts).toEqual([]);
      expect(result.confidence).toBe('low');
      expect(result.meta.skipReason).toContain('parser_error');
    });

    it('handles non-JSON LLM response gracefully', async () => {
      const provider = createMockProvider('Sorry, I cannot parse that message.');
      const parser = new SemanticParser(provider);

      const result = await parser.parse('I live in Berlin', TEST_CONTEXT);

      expect(result.facts).toEqual([]);
      expect(result.confidence).toBe('low');
    });

    it('handles JSON wrapped in markdown fences', async () => {
      const json = JSON.stringify({
        facts: [{
          subject: 'User', subjectType: 'Person',
          predicate: 'livesIn', object: 'Berlin', objectType: 'Place',
          confidence: 'high', sourceSpan: 'I live in Berlin', kind: 'fact',
        }],
        proposals: [],
        confidence: 'high',
      });
      const wrappedResponse = '```json\n' + json + '\n```';

      const provider = createMockProvider(wrappedResponse);
      const parser = new SemanticParser(provider);

      const result = await parser.parse('I live in Berlin', TEST_CONTEXT);

      expect(result.facts).toHaveLength(1);
      expect(result.facts[0].object).toBe('Berlin');
    });

    it('drops invalid facts from LLM output', async () => {
      const llmResponse = JSON.stringify({
        facts: [
          // Valid fact
          {
            subject: 'User', subjectType: 'Person',
            predicate: 'livesIn', object: 'Berlin', objectType: 'Place',
            confidence: 'high', sourceSpan: 'Berlin', kind: 'fact',
          },
          // Invalid: missing subject
          {
            subject: '', subjectType: 'Person',
            predicate: 'livesIn', object: 'London', objectType: 'Place',
            confidence: 'high', sourceSpan: 'London', kind: 'fact',
          },
          // Invalid: bad kind
          {
            subject: 'User', subjectType: 'Person',
            predicate: 'likes', object: 'Pizza', objectType: 'literal',
            confidence: 'high', sourceSpan: 'Pizza', kind: 'preference',
          },
        ],
        proposals: [],
        confidence: 'high',
      });

      const provider = createMockProvider(llmResponse);
      const parser = new SemanticParser(provider);

      const result = await parser.parse('Test', TEST_CONTEXT);

      // Only the first valid fact should survive validation
      expect(result.facts).toHaveLength(1);
      expect(result.facts[0].object).toBe('Berlin');
    });
  });
});
