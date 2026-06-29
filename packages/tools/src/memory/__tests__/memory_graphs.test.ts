import { describe, it, expect, vi } from 'vitest';
import { TriplestoreAdapter } from '@ontofelia/core';
import { GraphRegistry } from '@ontofelia/semantic-memory';
import { MemoryAskTool } from '../memory_ask.js';
import { MemoryExplainTool } from '../memory_explain.js';
import { MemoryRetractTool } from '../memory_retract.js';

/**
 * These tests guard against the regression where the memory tools queried
 * non-existent Named Graphs (urn:ontofelia:agent:<id>:abox / :prov / :audit).
 * The tools must only touch concept-conformant graphs.
 */

const ctx = {
  agentId: 'ontofelia',
  sessionId: 's1',
  workspacePath: '/',
  channelType: 'cli' as const,
  senderId: 'owner',
  isOwner: true
};

/** A query/update string must not reference any of the phantom graphs. */
function expectNoPhantomGraphs(sparql: string) {
  expect(sparql).not.toMatch(/:abox/);
  expect(sparql).not.toMatch(/:prov\b/);
  expect(sparql).not.toMatch(/:audit/);
  expect(sparql).not.toMatch(/urn:ontofelia:agent:/);
}

describe('MemoryAskTool — concept-conformant graphs', () => {
  it('queries the claims graph for recent_facts, not a :prov graph', async () => {
    let captured = '';
    const adapter = {
      query: vi.fn().mockImplementation((q: string) => {
        captured = q;
        return Promise.resolve({ type: 'bindings', bindings: [] });
      })
    } as unknown as TriplestoreAdapter;

    const tool = new MemoryAskTool(adapter);
    const res = await tool.execute({ template: 'recent_facts' }, ctx);

    expect(res.success).toBe(true);
    expectNoPhantomGraphs(captured);
    expect(captured).toContain('urn:ontofelia:claims');
  });

  it('queries facts_by_confidence via the claim confidenceLabel', async () => {
    let captured = '';
    const adapter = {
      query: vi.fn().mockImplementation((q: string) => {
        captured = q;
        return Promise.resolve({ type: 'bindings', bindings: [] });
      })
    } as unknown as TriplestoreAdapter;

    const tool = new MemoryAskTool(adapter);
    const res = await tool.execute({ template: 'facts_by_confidence', confidence: 'high' }, ctx);

    expect(res.success).toBe(true);
    expectNoPhantomGraphs(captured);
    expect(captured).toContain('urn:ontofelia:claims');
  });

  it('scopes what_do_i_know_about to the agent and shared graphs', async () => {
    let captured = '';
    const adapter = {
      query: vi.fn().mockImplementation((q: string) => {
        captured = q;
        return Promise.resolve({ type: 'bindings', bindings: [] });
      })
    } as unknown as TriplestoreAdapter;

    const tool = new MemoryAskTool(adapter);
    await tool.execute({ template: 'what_do_i_know_about', entity: 'Alice' }, ctx);

    expectNoPhantomGraphs(captured);
    expect(captured).toContain('urn:ontofelia:');
  });
});

describe('MemoryExplainTool — claim-based provenance', () => {
  it('reads provenance from the claims graph, not a :prov graph', async () => {
    let captured = '';
    const adapter = {
      query: vi.fn().mockImplementation((q: string) => {
        captured = q;
        return Promise.resolve({ type: 'bindings', bindings: [] });
      })
    } as unknown as TriplestoreAdapter;

    const tool = new MemoryExplainTool(adapter);
    const res = await tool.execute({ entity: 'Alice' }, ctx);

    expect(res.success).toBe(true);
    expectNoPhantomGraphs(captured);
    expect(captured).toContain('urn:ontofelia:claims');
    expect(captured).toContain('claimSubject');
  });
});

describe('MemoryRetractTool — graph whitelist + hard delete', () => {
  it('hard-deletes the base triple, claim and evidence from conformant graphs', async () => {
    const updates: string[] = [];
    const adapter = {
      update: vi.fn().mockImplementation((q: string) => {
        updates.push(q);
        return Promise.resolve();
      })
    } as unknown as TriplestoreAdapter;

    const tool = new MemoryRetractTool(adapter, GraphRegistry.create(['ontofelia']));
    const res = await tool.execute(
      { subject: 'urn:ontofelia:entity:Alice', predicate: 'urn:ontofelia:core#livesIn',
        object: 'urn:ontofelia:entity:Essen', graph: 'urn:ontofelia:user:owner' },
      ctx
    );

    expect(res.success).toBe(true);
    expect(updates.length).toBe(2); // base triple + provenance
    for (const u of updates) expectNoPhantomGraphs(u);
    expect(updates.join('\n')).toContain('urn:ontofelia:user:owner');
    expect(updates.join('\n')).toContain('urn:ontofelia:claims');
    expect(updates.join('\n')).toContain('urn:ontofelia:evidence');
  });

  it('rejects a non-conformant target graph without writing', async () => {
    const adapter = {
      update: vi.fn().mockResolvedValue(undefined)
    } as unknown as TriplestoreAdapter;

    const tool = new MemoryRetractTool(adapter, GraphRegistry.create(['ontofelia']));
    const res = await tool.execute(
      { subject: 'urn:ontofelia:entity:X', predicate: 'urn:ontofelia:core#p',
        graph: 'urn:default:claims' },
      ctx
    );

    expect(res.success).toBe(false);
    expect(res.error).toContain('not a registered Named Graph');
    expect(adapter.update).not.toHaveBeenCalled();
  });

  it('defaults to the worldview graph when no graph is given', async () => {
    const updates: string[] = [];
    const adapter = {
      update: vi.fn().mockImplementation((q: string) => {
        updates.push(q);
        return Promise.resolve();
      })
    } as unknown as TriplestoreAdapter;

    const tool = new MemoryRetractTool(adapter, GraphRegistry.create(['ontofelia']));
    const res = await tool.execute(
      { subject: 'urn:ontofelia:entity:X', predicate: 'urn:ontofelia:core#p' },
      ctx
    );

    expect(res.success).toBe(true);
    expect(updates.join('\n')).toContain('urn:ontofelia:worldview');
  });
});
