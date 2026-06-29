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
    const query = 'SELECT ?s ?p ?o WHERE { ?s ?p ?o }';
    const res = await tool.execute({ query }, ctx);
    expect(res.success).toBe(true);
    expect(mockAdapter.query).toHaveBeenCalled();
  });

  it('allows valid ASK query', async () => {
    const query = 'ASK { ?s ?p ?o }';
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

  it('falls back to regex and blocks modification when syntax is weird but modifying keyword is present', async () => {
    // Syntax error in sparqljs, fallback to regex
    const query = 'SYNTAXERROR BUT WITH INSERT';
    const res = await tool.execute({ query }, ctx);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/blocked/i);
  });
});
