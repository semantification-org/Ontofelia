import { describe, it, expect, vi } from 'vitest';
import { GraphCatalog } from '../utils/GraphCatalog.js';
import { GraphRegistry } from '../utils/GraphRegistry.js';
import { TriplestoreAdapter } from '@ontofelia/core';

/** A triplestore mock whose query() returns the given bindings. */
function mockStore(bindings: Array<Record<string, { value: string }>>): TriplestoreAdapter {
  return {
    query: vi.fn().mockResolvedValue({ type: 'bindings', bindings }),
  } as unknown as TriplestoreAdapter;
}

/** A triplestore mock whose query() throws. */
function failingStore(): TriplestoreAdapter {
  return {
    query: vi.fn().mockRejectedValue(new Error('store unavailable')),
  } as unknown as TriplestoreAdapter;
}

describe('GraphCatalog', () => {
  describe('describeAll — reads urn:shared:meta', () => {
    it('maps registry bindings into catalog entries', async () => {
      const store = mockStore([
        {
          g: { value: 'urn:ontofelia:self' },
          graphType: { value: 'self-model' },
          writableBy: { value: 'admin' },
          visibility: { value: 'agent-only' },
          comment: { value: 'The agent identity. Write-protected.' },
        },
        {
          g: { value: 'urn:ontofelia:user:owner' },
          graphType: { value: 'user-knowledge' },
          writableBy: { value: 'pipeline' },
          comment: { value: 'Facts about the user.' },
        },
      ]);
      const catalog = new GraphCatalog(store);
      const entries = await catalog.describeAll();

      expect(entries).toHaveLength(2);
      expect(entries[0].uri).toBe('urn:ontofelia:self');
      expect(entries[0].writableBy).toBe('admin');
      expect(entries[1].graphType).toBe('user-knowledge');
    });

    it('returns [] when the store fails', async () => {
      const catalog = new GraphCatalog(failingStore());
      expect(await catalog.describeAll()).toEqual([]);
    });
  });

  describe('renderSystemPromptSection — from urn:shared:meta', () => {
    it('renders binding instructions and one line per graph', async () => {
      const store = mockStore([
        {
          g: { value: 'urn:ontofelia:self' },
          graphType: { value: 'self-model' },
          writableBy: { value: 'admin' },
          comment: { value: 'The agent identity.' },
        },
      ]);
      const section = await new GraphCatalog(store).renderSystemPromptSection();

      expect(section).toContain('Named Graph Registry — BINDING');
      expect(section).toContain('NEVER invent a Named Graph URI');
      expect(section).toContain('write-protected');
      expect(section).toContain('<urn:ontofelia:self>');
      expect(section).toContain('The agent identity.');
      expect(section).toContain('writable by: admin');
    });
  });

  describe('renderSystemPromptSection — fallback to whitelist', () => {
    it('falls back to the GraphRegistry when urn:shared:meta is empty', async () => {
      const emptyStore = mockStore([]);
      const registry = GraphRegistry.create(['ontofelia']);
      const section = await new GraphCatalog(emptyStore, registry).renderSystemPromptSection();

      // Still a binding section, still lists the permitted graphs.
      expect(section).toContain('Named Graph Registry — BINDING');
      expect(section).toContain('graph purpose descriptions are unavailable');
      expect(section).toContain('<urn:ontofelia:claims>');
      expect(section).toContain('<urn:shared:ontology>');
    });

    it('returns an empty string when neither meta nor registry is available', async () => {
      const emptyStore = mockStore([]);
      const section = await new GraphCatalog(emptyStore).renderSystemPromptSection();
      expect(section).toBe('');
    });
  });
});
