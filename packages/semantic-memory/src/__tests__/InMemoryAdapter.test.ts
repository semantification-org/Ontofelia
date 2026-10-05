import { describe, it, expect } from 'vitest';
import { InMemoryAdapter } from '../adapters/InMemoryAdapter.js';

describe('InMemoryAdapter.exportDataset', () => {
  it('returns an empty string for an empty store', async () => {
    expect(await new InMemoryAdapter().exportDataset()).toBe('');
  });

  it('serialises the stored triples of all graphs as N-Quads', async () => {
    const a = new InMemoryAdapter();
    await a.insertTriples('urn:g:one', [
      { subject: 'urn:s:1', predicate: 'urn:p:name', object: { value: 'line "one"\nline two' } },
      { subject: 'urn:s:1', predicate: 'urn:p:knows', object: 'urn:s:2' },
    ]);
    await a.insertTriples('urn:g:two', [
      { subject: '_:b0', predicate: 'urn:p:label', object: { value: 'Hallo', language: 'de' } },
      { subject: 'urn:s:3', predicate: 'urn:p:age', object: { value: '7', type: 'http://www.w3.org/2001/XMLSchema#integer' } },
    ]);
    const out = await a.exportDataset('turtle');
    expect(out.trim().split('\n')).toHaveLength(4);
    expect(out).toContain('<urn:s:1> <urn:p:knows> <urn:s:2> <urn:g:one> .');
    expect(out).toContain('"line \\"one\\"\\nline two"');
    expect(out).toContain('"Hallo"@de <urn:g:two>');
    expect(out).toContain('"7"^^<http://www.w3.org/2001/XMLSchema#integer>');
  });

  it('round-trips through importDataset', async () => {
    const a = new InMemoryAdapter();
    await a.insertTriples('urn:g:one', [
      { subject: 'urn:s:1', predicate: 'urn:p:name', object: { value: 'quote " backslash \\ nl \n end' } },
      { subject: 'urn:s:1', predicate: 'urn:p:knows', object: 'urn:s:2' },
    ]);
    await a.insertTriples('urn:g:two', [
      { subject: '_:b0', predicate: 'urn:p:label', object: { value: 'Hallo', language: 'de' } },
      { subject: 'urn:s:3', predicate: 'urn:p:age', object: { value: '7', type: 'http://www.w3.org/2001/XMLSchema#integer' } },
    ]);
    const dump = await a.exportDataset();
    const b = new InMemoryAdapter();
    await b.importDataset(dump, 'ntriples');
    expect(await b.exportDataset()).toBe(dump);
  });

  it('counts triples and clears on DROP ALL', async () => {
    const a = new InMemoryAdapter();
    await a.insertTriples('urn:g:one', [{ subject: 'urn:s:1', predicate: 'urn:p:x', object: { value: 'y' } }]);
    const q = 'SELECT (COUNT(*) AS ?n) WHERE { { ?s ?p ?o } UNION { GRAPH ?g { ?s ?p ?o } } }';
    expect((await a.query(q)).bindings![0].n.value).toBe('1');
    await a.update('DROP ALL');
    expect((await a.query(q)).bindings![0].n.value).toBe('0');
    expect(await a.exportDataset()).toBe('');
  });
});
