import { describe, it, expect, beforeEach } from 'vitest';
import type { TriplestoreAdapter } from '@ontofelia/core';
import { OxigraphAdapter } from '../adapters/OxigraphAdapter.js';
import { SelfModel } from '../cognitive/SelfModel.js';

// SelfModel is a SPARQL projection over the self graph, so it runs against the
// embedded Oxigraph store.

const AGENT = 'ontofelia';
const COGT = 'urn:shared:ontology#cog/';
const WRITE_DOC = `${COGT}WriteConceptDoc`;
const ANSWER = `${COGT}AnswerQuestion`;

async function makeStore(): Promise<TriplestoreAdapter> {
  const store = new OxigraphAdapter();
  await store.initialize({
    backend: 'oxigraph',
    type: 'embedded',
    dataDir: `/tmp/self-test-${Math.random().toString(16).slice(2)}`,
    port: 0,
    endpoint: '',
  });
  return store;
}

describe('SelfModel', () => {
  let store: TriplestoreAdapter;
  let self: SelfModel;

  beforeEach(async () => {
    store = await makeStore();
    self = new SelfModel(store, AGENT);
    await self.seed({
      capabilities: [
        { id: 'doc_writing', label: 'Concept doc writing', requires: ['fs_read', 'fs_write'], relevantToGoalType: [WRITE_DOC] },
        { id: 'code_analysis', label: 'Code analysis', requires: ['fs_read'], relevantToGoalType: [`${COGT}CodeAnalysisGoal`] },
        { id: 'chat', label: 'Conversational chat' }, // unscoped → always relevant
      ],
      constraints: [
        { id: 'no_destructive', label: 'Destructive ops need owner approval', applies: ['exec', 'fs_write[overwrite]'], enforcedBy: 'GuardianPolicy' },
        { id: 'no_secret', label: 'Never persist secrets', applies: ['memory_store'], enforcedBy: 'MemorySkill' },
      ],
    });
  });

  it('returns the self graph uri and subject', () => {
    expect(self.graphUri()).toBe('urn:ontofelia:self');
    expect(self.selfSubject()).toBe('urn:ontofelia:self#ontofelia');
  });

  it('queryFor returns goal-scoped capabilities plus the unscoped ones', async () => {
    const view = await self.queryFor(WRITE_DOC);
    const labels = view.capabilities.map((c) => c.label).sort();
    expect(labels).toEqual(['Concept doc writing', 'Conversational chat']);
    const doc = view.capabilities.find((c) => c.label === 'Concept doc writing')!;
    expect(doc.requires.sort()).toEqual(['fs_read', 'fs_write']);
  });

  it('queryFor with a different goal type excludes unrelated capabilities', async () => {
    const view = await self.queryFor(ANSWER);
    const labels = view.capabilities.map((c) => c.label);
    expect(labels).toContain('Conversational chat');
    expect(labels).not.toContain('Concept doc writing');
    expect(labels).not.toContain('Code analysis');
  });

  it('queryFor always returns all constraints regardless of goal type', async () => {
    const view = await self.queryFor(ANSWER);
    expect(view.constraints.map((c) => c.label).sort()).toEqual([
      'Destructive ops need owner approval',
      'Never persist secrets',
    ]);
  });

  it('constraintsForTool matches plain and op-qualified applies tokens', async () => {
    const exec = await self.constraintsForTool('exec');
    expect(exec.map((c) => c.label)).toEqual(['Destructive ops need owner approval']);
    // fs_write matches the `fs_write[overwrite]` op-qualified token.
    const fsWrite = await self.constraintsForTool('fs_write');
    expect(fsWrite.map((c) => c.label)).toEqual(['Destructive ops need owner approval']);
    const none = await self.constraintsForTool('fs_read');
    expect(none).toEqual([]);
  });
});
