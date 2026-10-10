import { describe, it, expect } from 'vitest';
import { checkSparqlScope, getQueryableGraphScope } from '../sparql/scopeGuard.js';

describe('getQueryableGraphScope / checkSparqlScope', () => {
  const scope = getQueryableGraphScope('maia', { userId: 'alice', sessionId: 's1', isOwner: true });

  it('derives every URI from the agent id', () => {
    expect(scope.allowedGraphs).toContain('urn:maia:user:alice');
    expect(scope.allowedGraphs).toContain('urn:maia:inferred:user:alice');
    expect(scope.allowedGraphs).toContain('urn:maia:inferred');
    expect(scope.allowedGraphs).toContain('urn:maia:worldview');
    expect(scope.allowedGraphs).toContain('urn:maia:session:s1');
    expect(scope.allowedGraphs).toContain('urn:shared:ontology');
    expect(scope.allowedGraphs).toContain('urn:maia:setup');
    expect(scope.allowedGraphs.some((g) => g.includes('ontofelia'))).toBe(false);
    expect(scope.allowedGraphs).not.toContain('urn:maia:user:bob');
  });

  it('without a user or session, no private graph is allowed', () => {
    const s = getQueryableGraphScope('maia', {});
    expect(s.allowedGraphs.some((g) => g.includes(':user:') || g.includes(':session:'))).toBe(false);
  });

  it('allows only this session\'s cog working graphs', () => {
    expect(checkSparqlScope('SELECT * WHERE { GRAPH <urn:maia:cog:working:s1:c9> { ?s ?p ?o } }', scope).ok).toBe(true);
    expect(checkSparqlScope('SELECT * WHERE { GRAPH <urn:maia:cog:working:s2:c9> { ?s ?p ?o } }', scope).ok).toBe(false);
    expect(checkSparqlScope('SELECT * WHERE { GRAPH <urn:maia:cog:goals:s2> { ?s ?p ?o } }', scope).ok).toBe(false);
  });

  it('another agent\'s graphs are not allowed', () => {
    expect(checkSparqlScope('SELECT * WHERE { GRAPH <urn:ontofelia:worldview> { ?s ?p ?o } }', scope).ok).toBe(false);
  });

  it('refuses updates and DESCRIBE without FROM', () => {
    expect(checkSparqlScope('INSERT DATA { GRAPH <urn:maia:worldview> { <urn:a> <urn:b> <urn:c> } }', scope).ok).toBe(false);
    expect(checkSparqlScope('DESCRIBE <urn:a>', scope).ok).toBe(false);
    expect(checkSparqlScope('DESCRIBE <urn:a> FROM <urn:maia:worldview>', scope).ok).toBe(true);
  });

  it('never allows agent-wide graphs that mix users, not even to the owner', () => {
    for (const g of ['urn:maia:claims', 'urn:maia:evidence', 'urn:maia:conflicts', 'urn:maia:cog:episodic',
      'urn:shared:claims', 'urn:shared:evidence']) {
      expect(scope.allowedGraphs).not.toContain(g);
      expect(checkSparqlScope(`SELECT * WHERE { GRAPH <${g}> { ?s ?p ?o } }`, scope).ok).toBe(false);
    }
  });

  it('non-owner gets no internal state graphs', () => {
    const s = getQueryableGraphScope('maia', { userId: 'alice', sessionId: 's1', isOwner: false });
    for (const g of ['urn:maia:self', 'urn:maia:setup', 'urn:maia:skills', 'urn:maia:cog:meta',
      'urn:maia:cog:procedural', 'urn:maia:cog:goals:longterm', 'urn:maia:cog:goals:s1', 'urn:maia:cog:cycles:s1']) {
      expect(s.allowedGraphs).not.toContain(g);
    }
    expect(s.allowedGraphPrefixes).toEqual([]);
    expect(s.allowedGraphs).toContain('urn:maia:worldview');
    expect(s.allowedGraphs).toContain('urn:maia:session:s1');
    expect(s.allowedGraphs).toContain('urn:shared:world');
  });
});
