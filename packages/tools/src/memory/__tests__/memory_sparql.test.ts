import { describe, it, expect, vi } from 'vitest';
import { MemorySparqlTool } from '../memory_sparql.js';
import { TriplestoreAdapter } from '@ontofelia/core';

describe('MemorySparqlTool Validation', () => {
  const mockAdapter = {
    ask: vi.fn().mockResolvedValue(true),
    query: vi.fn().mockResolvedValue({ type: 'bindings', bindings: [] }),
  } as unknown as TriplestoreAdapter;

  const tool = new MemorySparqlTool(mockAdapter);
  const ctx = {
    agentId: 'test',
    sessionId: 's1',
    workspacePath: '/',
    channelType: 'cli' as const,
    senderId: 'owner',
    isOwner: true
  };

  it('allows valid SELECT query', async () => {
    const query = 'SELECT ?s ?p ?o WHERE { GRAPH <urn:test:worldview> { ?s ?p ?o } }';
    const res = await tool.execute({ query }, ctx);
    expect(res.success).toBe(true);
    expect(mockAdapter.query).toHaveBeenCalled();
  });

  it('allows valid ASK query', async () => {
    const query = 'ASK { GRAPH <urn:test:worldview> { ?s ?p ?o } }';
    const res = await tool.execute({ query }, ctx);
    expect(res.success).toBe(true);
    expect(mockAdapter.ask).toHaveBeenCalled();
  });

  it('blocks INSERT query', async () => {
    const query = 'INSERT DATA { <urn:a> <urn:b> <urn:c> }';
    const res = await tool.execute({ query }, ctx);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/blocked/i);
  });

  it('blocks LOAD query', async () => {
    const query = 'LOAD <http://evil.com> INTO GRAPH <urn:g>';
    const res = await tool.execute({ query }, ctx);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/blocked/i);
  });

  it('blocks SERVICE clauses', async () => {
    const query = 'SELECT * WHERE { SERVICE <http://evil.com> { ?s ?p ?o } }';
    const res = await tool.execute({ query }, ctx);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/SERVICE clauses are not allowed/i);
  });

  it('blocks nested SERVICE clauses', async () => {
    const query = 'SELECT * WHERE { { SELECT * WHERE { SERVICE <http://evil.com> { ?s ?p ?o } } } }';
    const res = await tool.execute({ query }, ctx);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/SERVICE clauses are not allowed/i);
  });

  it('does not run a query it cannot parse', async () => {
    const query = 'SYNTAXERROR BUT WITH INSERT';
    const res = await tool.execute({ query }, ctx);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/blocked/i);
    const select = await tool.execute({ query: 'SELECT garbage { GRAPH <urn:test:user:bob> ' }, ctx);
    expect(select.success).toBe(false);
    expect(mockAdapter.query).toHaveBeenCalledTimes(1);
  });
});
