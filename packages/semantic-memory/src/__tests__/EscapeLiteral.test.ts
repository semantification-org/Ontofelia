import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TriplestoreAdapter } from '@ontofelia/core';
import { OxigraphAdapter } from '../adapters/OxigraphAdapter.js';
import { KnowledgeEngine } from '../KnowledgeEngine.js';

const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const RAW = 'line1\r\nline2\tend "q" \\ x';

async function makeStore(): Promise<TriplestoreAdapter> {
  const store = new OxigraphAdapter();
  await store.initialize({
    backend: 'oxigraph',
    type: 'embedded',
    dataDir: mkdtempSync(join(tmpdir(), 'esc-lit-')),
    port: 0,
    endpoint: '',
  });
  return store;
}

describe('KnowledgeEngine.escapeLiteral', () => {
  let store: TriplestoreAdapter;
  let engine: KnowledgeEngine;
  const ctx = { agentId: 'ontofelia', userId: 'owner', sessionId: 's1', isOwner: true };

  beforeEach(async () => {
    store = await makeStore();
    engine = new KnowledgeEngine(store);
  });

  async function allValues(predicate: string): Promise<string[]> {
    const res = await store.query(
      `SELECT ?o WHERE { GRAPH ?g { ?s <${predicate}> ?o } }`,
    );
    return (res.bindings ?? []).map((b) => b.o.value);
  }

  it('stores a literal object containing CR, TAB, quote and backslash byte-exactly', async () => {
    const r = await engine.storeFact(
      {
        subject: 'Anna', subjectType: 'Person', predicate: 'notes',
        object: RAW, objectType: 'literal', sourceKind: 'user' as const,
      },
      ctx,
    );
    expect(r.success).toBe(true);
    const res = await store.query(
      `SELECT ?o WHERE { GRAPH ?g { ?s ?p ?o . FILTER(isLiteral(?o) && CONTAINS(STR(?p), "notes")) } }`,
    );
    const vals = (res.bindings ?? []).map((b) => b.o.value);
    expect(vals).toContain(RAW);
  });

  it('stores a subject label containing CR byte-exactly', async () => {
    const subject = 'Ann\ra';
    const r = await engine.storeFact(
      {
        subject, subjectType: 'Person', predicate: 'likes',
        object: 'Tea', objectType: 'Concept', sourceKind: 'user' as const,
      },
      ctx,
    );
    expect(r.success).toBe(true);
    expect(await allValues(RDFS_LABEL)).toContain(subject);
  });
});
