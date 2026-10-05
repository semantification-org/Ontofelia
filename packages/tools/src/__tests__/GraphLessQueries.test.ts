/**
 * ontology_inspect and memory_reflect must read named graphs: the embedded
 * store has an empty default graph, so graph-less patterns return nothing.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ToolContext } from '@ontofelia/core';
import { OxigraphAdapter } from '@ontofelia/semantic-memory';
import { OntologyInspectTool } from '../memory/ontology_inspect.js';
import { MemoryReflectTool } from '../memory/memory_reflect.js';

const AGENT = 'ontofelia';
const OWL = 'http://www.w3.org/2002/07/owl#';
const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

let store: OxigraphAdapter;

async function insert(graph: string, triples: string) {
  await store.update(`INSERT DATA { GRAPH <${graph}> { ${triples} } }`);
}

function ctx(senderId: string): ToolContext {
  return { agentId: AGENT, sessionId: 's', workspacePath: '/tmp', channelType: 'cli',
    senderId, isOwner: false } as unknown as ToolContext;
}

beforeEach(async () => {
  store = new OxigraphAdapter();
  await store.initialize({ backend: 'oxigraph', type: 'embedded',
    dataDir: mkdtempSync(join(tmpdir(), 'graphless-')), port: 0, endpoint: '' } as never);
});

describe('ontology_inspect', () => {
  it('lists classes and properties from the shared ontology and the schema graph', async () => {
    await insert('urn:shared:ontology',
      `<urn:t:Widget> <${RDF_TYPE}> <${OWL}Class> ; <${RDFS}label> "Widget" .
       <urn:t:hasPart> <${RDF_TYPE}> <${OWL}ObjectProperty> ; <${RDFS}domain> <urn:t:Widget> .`);
    await insert(`urn:${AGENT}:schema`,
      `<urn:t:hasColor> <${RDF_TYPE}> <${OWL}DatatypeProperty> .`);
    const res = await new OntologyInspectTool(store as never).execute({}, ctx('alice'));
    const out = res.output as string;
    expect(out).toContain('urn:t:Widget (Widget)');
    expect(out).toContain('urn:t:hasPart (Domain: urn:t:Widget');
    expect(out).toContain('urn:t:hasColor');
  });

  it('does not report classes sitting in a user graph', async () => {
    await insert(`urn:${AGENT}:user:bob`, `<urn:t:Secret> <${RDF_TYPE}> <${OWL}Class> .`);
    const res = await new OntologyInspectTool(store as never).execute({}, ctx('alice'));
    expect(res.output as string).not.toContain('urn:t:Secret');
  });
});

describe('memory_reflect', () => {
  beforeEach(async () => {
    await insert(`urn:${AGENT}:user:alice`, `<urn:t:a> <urn:t:p> "ALICE-OWN" .`);
    await insert(`urn:${AGENT}:user:bob`, `<urn:t:b> <urn:t:p> "BOB-PRIVATE" .`);
    await insert(`urn:${AGENT}:worldview`, `<urn:t:w> <urn:t:p> "WORLD-FACT" .`);
    await insert(`urn:${AGENT}:inferred`, `<urn:t:i> <urn:t:p> "INFERRED-MIXED" .`);
  });

  for (const includeInferred of [true, false]) {
    it(`returns own and worldview triples only (includeInferred=${includeInferred})`, async () => {
      const res = await new MemoryReflectTool(store as never)
        .execute({ includeInferred }, ctx('alice'));
      const out = res.output as string;
      expect(out).toContain('ALICE-OWN');
      expect(out).toContain('WORLD-FACT');
      expect(out).not.toContain('BOB-PRIVATE');
      expect(out).not.toContain('INFERRED-MIXED');
    });
  }

  it('reads only the worldview when there is no sender', async () => {
    const res = await new MemoryReflectTool(store as never).execute({}, ctx(''));
    const out = res.output as string;
    expect(out).toContain('WORLD-FACT');
    expect(out).not.toContain('ALICE-OWN');
    expect(out).not.toContain('BOB-PRIVATE');
  });
});
