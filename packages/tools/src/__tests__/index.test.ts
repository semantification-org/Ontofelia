import { describe, it, expect } from 'vitest';
import { MemoryStoreTool } from '../index.js';
import { InMemoryAdapter, KnowledgeEngine } from '@ontofelia/semantic-memory';

describe('MemoryStoreTool', () => {
  it('should be instantiable', () => {
    const adapter = new InMemoryAdapter();
    const engine = new KnowledgeEngine(adapter);
    const tool = new MemoryStoreTool(engine);
    expect(tool.name).toBe('memory_store');
  });
});
