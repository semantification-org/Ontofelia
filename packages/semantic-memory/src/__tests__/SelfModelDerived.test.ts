import { describe, it, expect, beforeEach } from 'vitest';
import type { TriplestoreAdapter } from '@ontofelia/core';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { OxigraphAdapter } from '../adapters/OxigraphAdapter.js';
import { KnowledgeEngine } from '../KnowledgeEngine.js';
import { GraphRegistry } from '../utils/GraphRegistry.js';
import { SelfModel, type DerivedSelfSources } from '../cognitive/SelfModel.js';

// The derived part of the self-model: written atomically from the tool
// registry / policy / guardian / directive sources, replaced on every reseed,
// disjoint from the bootstrap persona and from learned self-model facts.

const AGENT = 'ontofelia';
const COGT = 'urn:shared:ontology#cog/';
const CORE = 'urn:ontofelia:core#';
const BOOTSTRAP = 'urn:ontofelia:core#Ontofelia';
const SELF_GRAPH = 'urn:ontofelia:self';
const SELF = 'urn:ontofelia:self#ontofelia';
const REPO_BOOTSTRAP = path.resolve(__dirname, '../../../../bootstrap');

const SOURCES: DerivedSelfSources = {
  tools: [
    { name: 'memory_ask', category: 'memory', policy: 'allowed' },
    { name: 'web_fetch', category: 'web', policy: 'allowed' },
    { name: 'exec', category: 'shell', policy: 'needs-approval', policyBeforeGuardian: 'allowed' },
    { name: 'fs_write', category: 'filesystem', policy: 'needs-approval', policyBeforeGuardian: 'needs-approval' },
    { name: 'blocked_tool', category: 'utility', policy: 'denied', policyBeforeGuardian: 'denied' },
  ],
  guardedTools: ['exec', 'cron_manage'],
};

async function makeStore(): Promise<TriplestoreAdapter> {
  const store = new OxigraphAdapter();
  await store.initialize({
    backend: 'oxigraph', type: 'embedded',
    dataDir: `/tmp/self-derived-${process.pid}-${Math.random().toString(16).slice(2)}`, port: 0, endpoint: '',
  });
  return store;
}

/** Every triple of the self graph as a sorted, comparable list. */
async function selfTriples(store: TriplestoreAdapter, filter = ''): Promise<string[]> {
  const res = await store.query(`SELECT ?s ?p ?o WHERE { GRAPH <${SELF_GRAPH}> { ?s ?p ?o } ${filter} }`);
  return (res.bindings ?? [])
    .map((b) => `${b.s.value} | ${b.p.value} | ${b.o.type}:${b.o.value}`)
    .sort();
}
const bootstrapTriples = (store: TriplestoreAdapter) =>
  selfTriples(store, `FILTER(STRSTARTS(STR(?s), "${CORE}"))`);

describe('SelfModel derived data', () => {
  let store: TriplestoreAdapter;
  let sm: SelfModel;
  let ke: KnowledgeEngine;

  beforeEach(async () => {
    store = await makeStore();
    sm = new SelfModel(store, AGENT);
    ke = new KnowledgeEngine(store, undefined, GraphRegistry.create([AGENT]));
    // A fresh install: the real bootstrap persona, nothing learned yet.
    await ke.seedCoreGraphs(REPO_BOOTSTRAP, AGENT);
  });

  it('on a fresh install queryFor(goalType) returns rows once derived, for every goal type', async () => {
    expect((await sm.queryFor('urn:shared:ontology#cog/ExecuteCommand')).capabilities).toEqual([]);
    await sm.reseedDerived(SOURCES);
    for (const goal of ['ExecuteCommand', 'AnswerQuestion', 'HandleRequest', 'RespondToUser']) {
      const view = await sm.queryFor(`${COGT}${goal}`);
      expect(view.constraints.length, goal).toBeGreaterThan(0);
    }
    const exec = await sm.queryFor(`${COGT}ExecuteCommand`);
    expect(exec.capabilities.map((c) => c.requires[0]).sort()).toEqual(['exec', 'fs_write']);
    const answer = await sm.queryFor(`${COGT}AnswerQuestion`);
    expect(answer.capabilities.map((c) => c.requires[0]).sort()).toEqual(['memory_ask', 'web_fetch']);
    // A chat turn (RespondToUser) is shown constraints only: derived tools are never unscoped.
    expect((await sm.queryFor(`${COGT}RespondToUser`)).capabilities).toEqual([]);
    // The safety directive of the real bootstrap persona became a constraint.
    const cons = (await sm.queryFor(`${COGT}ExecuteCommand`)).constraints;
    const directive = cons.find((c) => c.derivedFrom === 'behavior-directive');
    expect(directive?.label).toBe('safety before speed');
    expect(directive?.scope).toBe('safety');
    expect(cons.some((c) => c.derivedFrom === 'tool-policy')).toBe(true);
    expect(cons.some((c) => c.derivedFrom === 'guardian-policy')).toBe(true);
  });

  it('maps tool categories to goal types conservatively: unknown categories only to HandleRequest', async () => {
    await sm.reseedDerived({ tools: [{ name: 'odd', category: 'brand-new', policy: 'allowed' }], guardedTools: [] });
    expect((await sm.queryFor(`${COGT}HandleRequest`)).capabilities).toHaveLength(1);
    for (const g of ['AnswerQuestion', 'ExecuteCommand', 'AnswerInTopic', 'RespondToUser']) {
      expect((await sm.queryFor(`${COGT}${g}`)).capabilities, g).toHaveLength(0);
    }
    expect((await sm.queryFor(undefined)).capabilities).toHaveLength(0);
  });

  it('"which tools need approval" is one SPARQL query over the self graph', async () => {
    await sm.reseedDerived(SOURCES);
    const q = sm.toolsNeedingApprovalQuery();
    expect(q).toContain('SELECT DISTINCT ?tool');
    const res = await store.query(q);
    expect((res.bindings ?? []).map((b) => b.tool.value)).toEqual(['urn:tool:exec', 'urn:tool:fs_write']);
    expect(await sm.toolsNeedingApproval()).toEqual(['exec', 'fs_write']);
  });

  it('states the autonomy level, owner relation and authority from the verdicts', async () => {
    await sm.reseedDerived(SOURCES);
    const res = await store.query(`SELECT ?level ?rel ?auth WHERE { GRAPH <${SELF_GRAPH}> {
      <${SELF}> <${COGT}hasDerivedProfile> ?p . ?p <${COGT}autonomyLevel> ?level ; <${COGT}ownerRelation> ?rel ;
        <${COGT}owner> ?o ; <${COGT}authorityOver> ?auth } }`);
    expect(res.bindings?.map((b) => b.auth.value).sort()).toEqual(['urn:tool:memory_ask', 'urn:tool:web_fetch']);
    expect(res.bindings?.[0].level.value).toBe('semi-autonomous');
    expect(res.bindings?.[0].rel.value).toBe('approves-gated-tools');

    await sm.reseedDerived({ tools: [{ name: 'a', policy: 'allowed' }], guardedTools: [] });
    const open = await store.query(`SELECT ?level WHERE { GRAPH <${SELF_GRAPH}> { ?p <${COGT}autonomyLevel> ?level } }`);
    expect(open.bindings?.map((b) => b.level.value)).toEqual(['autonomous']);
    await sm.reseedDerived({ tools: [{ name: 'a', policy: 'denied' }], guardedTools: [] });
    const shut = await store.query(`SELECT ?level WHERE { GRAPH <${SELF_GRAPH}> { ?p <${COGT}autonomyLevel> ?level } }`);
    expect(shut.bindings?.map((b) => b.level.value)).toEqual(['restricted']);
  });

  it('a reseed with unchanged sources gives an identical triple set', async () => {
    await sm.reseedDerived(SOURCES);
    const before = await selfTriples(store);
    await sm.reseedDerived(SOURCES);
    await sm.reseedDerived({ ...SOURCES, tools: [...SOURCES.tools].reverse() });
    const after = await selfTriples(store);
    expect(after).toEqual(before);
    expect(before.length).toBeGreaterThan(50);
  });

  it('removing a tool removes its capability (and its approval entry) on reseed', async () => {
    await sm.reseedDerived(SOURCES);
    await sm.reseedDerived({ ...SOURCES, tools: SOURCES.tools.filter((t) => t.name !== 'fs_write' && t.name !== 'web_fetch') });
    const all = (await selfTriples(store)).join('\n');
    expect(all).not.toContain('fs_write');
    expect(all).not.toContain('web_fetch');
    expect(all).toContain('memory_ask');
    expect(await sm.toolsNeedingApproval()).toEqual(['exec']);
    expect((await sm.queryFor(`${COGT}ExecuteCommand`)).capabilities.map((c) => c.requires[0])).toEqual(['exec']);
  });

  it('a policy change is followed: a tool that became denied no longer needs approval', async () => {
    await sm.reseedDerived(SOURCES);
    await sm.reseedDerived({
      ...SOURCES,
      tools: SOURCES.tools.map((t) => (t.name === 'fs_write' ? { ...t, policy: 'denied' as const, policyBeforeGuardian: 'denied' as const } : t)),
    });
    expect(await sm.toolsNeedingApproval()).toEqual(['exec']);
    const view = await sm.queryFor(`${COGT}ExecuteCommand`);
    expect(view.capabilities.find((c) => c.requires[0] === 'fs_write')?.policyStatus).toBe('denied');
  });

  it('leaves the bootstrap persona and learned self-model facts untouched', async () => {
    // Learned side: seeded capability/constraint plus a plain fact on the self-model subject.
    await sm.seed({
      capabilities: [{ id: 'chat', label: 'Chat', requires: ['memory_ask'] }],
      constraints: [{ id: 'no_secret', label: 'Never persist secrets', applies: ['memory_store'], enforcedBy: 'MemorySkill' }],
    });
    await store.update(`INSERT DATA { GRAPH <${SELF_GRAPH}> {
      <${SELF}> <${COGT}operatesIn> <urn:env:example.org> ;
                <${COGT}requiresApproval> <urn:tool:learned_one> ;
                <${COGT}ownerRelation> "learned-relation" . } }`);
    const persona = await bootstrapTriples(store);
    expect(persona.length).toBeGreaterThan(20);
    const learned = (await selfTriples(store)).filter((t) => !persona.includes(t));

    await sm.reseedDerived(SOURCES);
    await sm.reseedDerived({ tools: [], guardedTools: [] });
    await sm.reseedDerived(SOURCES);

    expect(await bootstrapTriples(store)).toEqual(persona);
    const all = await selfTriples(store);
    for (const t of learned) expect(all, t).toContain(t);
    // Everything added is on the self-model subject or on a derived node; the bootstrap subject is never a subject of it.
    const derivedPrefix = sm.derivedPrefix();
    const added = all.filter((t) => !persona.includes(t) && !learned.includes(t));
    expect(added.length).toBeGreaterThan(0);
    for (const t of added) {
      const subject = t.split(' | ')[0];
      expect(subject === SELF || subject.startsWith(derivedPrefix), t).toBe(true);
      expect(subject).not.toBe(BOOTSTRAP);
    }
    // The learned triples with predicates the derivation also uses stay beside the derived ones.
    const approval = await sm.toolsNeedingApproval();
    expect(approval).toEqual(['exec', 'fs_write']); // derived profile only, not the learned self-subject triple
    expect(all).toContain(`${SELF} | ${COGT}requiresApproval | uri:urn:tool:learned_one`);
  });

  it('keeps the reseed tripwire quiet and survives a persona reseed with derived data present', async () => {
    await sm.reseedDerived(SOURCES);
    const derived = (await selfTriples(store)).filter((t) => !t.startsWith(`${BOOTSTRAP} `) && !t.startsWith(CORE));
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'self-derived-boot-'));
    try {
      const ttl = await fs.readFile(path.join(REPO_BOOTSTRAP, 'self.ttl'), 'utf-8');
      await fs.writeFile(path.join(dir, 'self.ttl'), ttl, 'utf-8');
      const r = await ke.reseedSelf(dir, AGENT); // throws ReseedInvariantError if a preserved triple moved
      expect(r.preserved).toBeGreaterThanOrEqual(derived.length);
      const after = await selfTriples(store);
      for (const t of derived) expect(after, t).toContain(t);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('derived nodes carry no rdfs label or comment, so they never take part in entity resolution by label', async () => {
    await sm.reseedDerived(SOURCES);
    const dp = sm.derivedPrefix();
    const res = await store.query(`SELECT ?s ?p WHERE { GRAPH <${SELF_GRAPH}> { ?s ?p ?o
      FILTER(STRSTARTS(STR(?s), "${dp}") && STRSTARTS(STR(?p), "http://www.w3.org/2000/01/rdf-schema#")) } }`);
    expect(res.bindings ?? []).toEqual([]);
  });

  it('the legacy persona rendering is byte-identical before and after a derivation', async () => {
    const before = await ke.getSystemPromptContext(AGENT, 'alice');
    expect(before).toContain('## My Identity & Personality');
    await sm.reseedDerived(SOURCES);
    expect(await ke.getSystemPromptContext(AGENT, 'alice')).toBe(before);
  });

  it('writes tool names and labels as inert literals and IRIs (hostile names cannot break out of the update)', async () => {
    const hostile = 'x"> . } } ; DROP ALL ; { <urn:a> <urn:b> "';
    await sm.reseedDerived({ tools: [{ name: hostile, category: 'web', policy: 'allowed', description: 'a"b\nc\\' }], guardedTools: [] });
    const view = await sm.queryFor(`${COGT}AnswerQuestion`);
    expect(view.capabilities[0].requires[0]).toBe(hostile);
    expect((await bootstrapTriples(store)).length).toBeGreaterThan(20); // nothing dropped
  });
});
