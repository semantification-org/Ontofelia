import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TriplestoreAdapter } from '@ontofelia/core';
import { OxigraphAdapter, GraphUriResolver } from '@ontofelia/semantic-memory';
import { MemoryRetractTool } from '../memory_retract.js';
import { MemoryAskTool } from '../memory_ask.js';
import { MemoryExplainTool } from '../memory_explain.js';

const ctx = {
  agentId: 'ontofelia',
  sessionId: 's1',
  workspacePath: '/',
  channelType: 'cli' as const,
  senderId: 'owner',
  isOwner: true
};

const WORLD = GraphUriResolver.getWorldviewGraph('ontofelia');
const HOSTILE_IRI =
  'urn:a> <urn:p> ?o } } ; CLEAR ALL ; INSERT DATA { GRAPH <urn:pwn> { <urn:pwn:a> <urn:pwn:b> <urn:pwn:c> } } ; INSERT DATA { GRAPH <urn:g> { <urn:s> <urn:p> <urn:x';
const HOSTILE_LITERAL = 'x\\" } } ; CLEAR ALL ; INSERT DATA { GRAPH <urn:pwn> { <urn:pwn:a> <urn:pwn:b> <urn:pwn:c> } } #';

async function makeStore(): Promise<OxigraphAdapter> {
  const store = new OxigraphAdapter();
  await store.initialize({
    backend: 'oxigraph',
    type: 'embedded',
    dataDir: mkdtempSync(join(tmpdir(), 'retract-safety-')),
    port: 0,
    endpoint: ''
  });
  return store;
}

describe('MemoryRetractTool query safety', () => {
  let store: OxigraphAdapter;
  let tool: MemoryRetractTool;
  let updateSpy: MockInstance<OxigraphAdapter['update']>;
  let before: string;

  beforeEach(async () => {
    store = await makeStore();
    await store.insertTriples(WORLD, [
      { subject: 'urn:s', predicate: 'urn:p', object: 'keep' },
      { subject: 'urn:s', predicate: 'urn:q', object: 'urn:o' }
    ]);
    before = await store.exportDataset();
    updateSpy = vi.spyOn(store, 'update');
    tool = new MemoryRetractTool(store as unknown as TriplestoreAdapter);
  });

  async function expectRejectedUnchanged(args: Record<string, unknown>) {
    const res = await tool.execute(args, ctx);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Invalid IRI/);
    expect(updateSpy).not.toHaveBeenCalled();
    expect(await store.exportDataset()).toBe(before);
    const pwn = await store.query('SELECT * WHERE { GRAPH <urn:pwn> { ?s ?p ?o } }');
    expect(pwn.bindings ?? []).toHaveLength(0);
  }

  it('fails on a hostile subject', async () => {
    await expectRejectedUnchanged({ subject: HOSTILE_IRI, predicate: 'urn:p' });
  });

  it('fails on a hostile predicate', async () => {
    await expectRejectedUnchanged({ subject: 'urn:s', predicate: HOSTILE_IRI });
  });

  it('fails on a hostile IRI-shaped object', async () => {
    await expectRejectedUnchanged({ subject: 'urn:s', predicate: 'urn:q', object: HOSTILE_IRI });
  });

  it('treats a hostile literal object as data: nothing is injected, nothing matches', async () => {
    const res = await tool.execute({ subject: 'urn:s', predicate: 'urn:p', object: HOSTILE_LITERAL }, ctx);
    expect(res.success).toBe(true);
    expect(await store.exportDataset()).toBe(before);
    const pwn = await store.query('SELECT * WHERE { GRAPH <urn:pwn> { ?s ?p ?o } }');
    expect(pwn.bindings ?? []).toHaveLength(0);
  });

  it('still deletes the matching fact for ordinary arguments', async () => {
    const res = await tool.execute({ subject: 'urn:s', predicate: 'urn:p', object: 'keep' }, ctx);
    expect(res.success).toBe(true);
    const left = await store.query(`SELECT ?p WHERE { GRAPH <${WORLD}> { <urn:s> ?p ?o } }`);
    expect((left.bindings ?? []).map((b) => b.p.value)).toEqual(['urn:q']);
  });
});

describe('MemoryAskTool / MemoryExplainTool query safety', () => {
  function spyAdapter() {
    return { query: vi.fn().mockResolvedValue({ type: 'bindings', bindings: [] }) };
  }

  it('memory_ask rejects a hostile entity without querying', async () => {
    const a = spyAdapter();
    const res = await new MemoryAskTool(a as unknown as TriplestoreAdapter)
      .execute({ template: 'what_do_i_know_about', entity: HOSTILE_IRI }, ctx);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Invalid IRI/);
    expect(a.query).not.toHaveBeenCalled();
  });

  it('memory_ask escapes the confidence argument as a literal', async () => {
    const a = spyAdapter();
    const res = await new MemoryAskTool(a as unknown as TriplestoreAdapter)
      .execute({ template: 'facts_by_confidence', confidence: 'high\\' }, ctx);
    expect(res.success).toBe(true);
    const q = a.query.mock.calls[0][0] as string;
    expect(q).toContain('LCASE("high\\\\")');
  });

  it('memory_explain rejects a hostile entity without querying', async () => {
    const a = spyAdapter();
    const res = await new MemoryExplainTool(a as unknown as TriplestoreAdapter)
      .execute({ entity: HOSTILE_IRI }, ctx);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Invalid IRI/);
    expect(a.query).not.toHaveBeenCalled();
  });
});
