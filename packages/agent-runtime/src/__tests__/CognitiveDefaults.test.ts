import { describe, it, expect, afterEach } from 'vitest';
import type { MessageEnvelope, ChannelType } from '@ontofelia/core';
import { COGNITIVE_FLAGS } from '../cognitive/CognitiveConfig.js';
import {
  seedDefaultsForFreshInstall, defaultOnFlags, readDefaultsMarker, COGNITIVE_DEFAULTS_VERSION,
} from '../cognitive/CognitiveDefaults.js';
import { makeEnv, envelope, send, cleanup, setNumber, setFlag, seedSkillAndSelf, rows, OWNER, ALICE, AGENT, COGT, type Env } from './promptHarness.js';
import { bootFreshInstall } from './freshInstall.js';
import { GraphUriResolver } from '@ontofelia/semantic-memory';

// The staged default-on rollout: the boot step for new installs, the owner
// command that lets an existing install adopt the defaults, and the rule that
// nothing else changes.

const SETUP = GraphUriResolver.getSetupGraph(AGENT);
const SUBJECT = `urn:${AGENT}:setup:cognitive`;
const KEEP_OFF = ['flagRetention', 'flagInitiative'];

const flagValues = async (e: Env) =>
  Object.fromEntries(await Promise.all(COGNITIVE_FLAGS.map(async (f) => [f.name, await e.cfg.isEnabled(f)])));
const setupTriples = async (e: Env) =>
  (await rows(e.store, `SELECT ?p ?o WHERE { GRAPH <${SETUP}> { <${SUBJECT}> ?p ?o } }`))
    .map((b) => `${b.p.value.replace(COGT, '')}=${b.o.value}`).sort();
const dump = (e: Env) => e.store.exportDataset('turtle');
/** Every quad of this agent's own graphs (the shared meta graph is re-seeded by every boot). */
const agentDump = async (e: Env) =>
  (await rows(e.store, `SELECT ?g ?s ?p ?o WHERE { GRAPH ?g { ?s ?p ?o } FILTER(STRSTARTS(STR(?g), "urn:${AGENT}:")) }`))
    .map((b) => [b.g, b.s, b.p, b.o].map((t) => t.value).join(' ')).sort().join('\n');
const owner = (text: string) => envelope(text, OWNER);
const schedulerEnv = (text: string): MessageEnvelope => ({
  ...envelope(text, OWNER), channel: 'cron' as ChannelType, chatType: 'cron' as MessageEnvelope['chatType'],
  sender: { id: 'scheduler', channelPrefix: 'cron', isOwner: true },
} as MessageEnvelope);

describe('default-on set', () => {
  it('is every flag except retention and initiative; the docs table says the same', async () => {
    const names = defaultOnFlags().map((f) => f.name);
    expect(names).toHaveLength(COGNITIVE_FLAGS.length - 2);
    for (const k of KEEP_OFF) expect(names).not.toContain(k);
    const { promises: fs } = await import('fs');
    const doc = await fs.readFile(new URL('../../../../docs/cognitive-architecture/09-integration-and-migration.md', import.meta.url), 'utf8');
    const table = [...doc.matchAll(/^\| `(flag[A-Za-z]+)` \| `[a-zA-Z]+` \| (\w+) \| (\w+) \|/gm)].map((m) => ({ name: m[1], dflt: m[2], fresh: m[3] }));
    expect(table).toHaveLength(COGNITIVE_FLAGS.length);
    for (const r of table) {
      expect(r.dflt).toBe('off');
      expect(r.fresh).toBe(names.includes(r.name) ? 'on' : 'off');
    }
  });
});

describe('boot step', () => {
  const made: Env[] = [];
  afterEach(async () => { await cleanup(made); made.length = 0; });
  const env = async (opts: Parameters<typeof makeEnv>[0] = {}) => { const e = await makeEnv(opts); made.push(e); return e; };

  it('fresh store: writes the default set and the marker; retention and initiative stay off; no setup key', async () => {
    const e = await env();
    const at = new Date('2026-10-15T08:00:00.000Z');
    const boot = await bootFreshInstall(e.store, at);
    expect(boot.seeded).toContain(GraphUriResolver.getSelfGraph(AGENT));
    expect(boot.defaults.seeded).toBe(true);
    const v = await flagValues(e);
    for (const f of COGNITIVE_FLAGS) expect(v[f.name]).toBe(!KEEP_OFF.includes(f.name));
    expect(await e.cfg.isRetentionEnabled()).toBe(false);
    const marker = await readDefaultsMarker(e.store, AGENT);
    expect(Date.parse(marker!.at)).toBe(at.getTime());
    expect(marker!.version).toBe(String(COGNITIVE_DEFAULTS_VERSION));
    // Exactly the flags and the two marker triples: no setup key (nudge, thresholds, caps).
    const t = await setupTriples(e);
    expect(t).toHaveLength(defaultOnFlags().length + 2);
    expect(t.filter((x) => !x.startsWith('flag') && !x.startsWith('defaults'))).toEqual([]);
    expect(await e.cfg.unknownNudgeAllUsers()).toBe(false);
    expect((await e.cfg.promptSettings()).totalTokenCap).toBe(1200);
  });

  it('a second boot is a no-op (also when the self graph is wrongly reported as fresh again)', async () => {
    const e = await env();
    await bootFreshInstall(e.store);
    const before = await agentDump(e);
    const again = await bootFreshInstall(e.store);
    expect(again.seeded).toEqual([]);
    expect(again.defaults).toEqual({ seeded: false, reason: 'self-graph-not-seeded-this-boot', flags: [] });
    const forced = await seedDefaultsForFreshInstall(e.store, AGENT, true);
    expect(forced.seeded).toBe(false);
    expect(forced.reason).toBe('cognitive-triples-present');
    expect(await agentDump(e)).toBe(before);
  });

  it('a store with data and no flag triples is an existing install: nothing is written', async () => {
    // Data from before, self graph already seeded in an earlier boot.
    const old = await env({ seed: async ({ store }) => { await seedSkillAndSelf(store); } });
    const before = await agentDump(old);
    const r = await bootFreshInstall(old.store);
    expect(r.defaults.seeded).toBe(false);
    expect(await agentDump(old)).toBe(before);
    expect(await setupTriples(old)).toEqual([]);

    // Even when the self graph is empty at boot (so it is seeded now), other data of the agent blocks the step.
    const odd = await env({ seed: async ({ store }) => {
      await store.update(`INSERT DATA { GRAPH <${GraphUriResolver.getUserGraph(AGENT, 'alice')}> { <urn:x:a> <urn:x:p> "kept" } }`);
    } });
    const r2 = await bootFreshInstall(odd.store);
    expect(r2.seeded).toContain(GraphUriResolver.getSelfGraph(AGENT));
    expect(r2.defaults).toEqual({ seeded: false, reason: 'agent-data-present', flags: [] });
    expect(await setupTriples(odd)).toEqual([]);
  });

  it('a store with some flags set gets nothing, even when the self graph is fresh', async () => {
    const e = await env({ flags: ['flagMetacognition'] });
    const r = await bootFreshInstall(e.store);
    expect(r.defaults).toEqual({ seeded: false, reason: 'cognitive-triples-present', flags: [] });
    expect(await setupTriples(e)).toEqual([`flagMetacognition=true`]);

    // A flag explicitly set off, or a setup key alone, also counts as a cognitive triple.
    const off = await env();
    await setFlag(off.cfg, 'flagCycleManager', false);
    expect((await bootFreshInstall(off.store)).defaults.seeded).toBe(false);
    expect(await flagValues(off)).toEqual(Object.fromEntries(COGNITIVE_FLAGS.map((f) => [f.name, false])));
    const key = await env();
    await setNumber(key.store, 'salienceThreshold', 0.7);
    expect((await bootFreshInstall(key.store)).defaults.seeded).toBe(false);
  });
});

describe('/cog defaults', () => {
  const made: Env[] = [];
  afterEach(async () => { await cleanup(made); made.length = 0; });
  const env = async (opts: Parameters<typeof makeEnv>[0] = {}) => { const e = await makeEnv(opts); made.push(e); return e; };
  const say = async (e: Env, text: string, env_: MessageEnvelope = owner(text)) => (await e.runtime.handleMessage(env_)).text;

  it('shows the diff and writes nothing', async () => {
    const e = await env({ flags: ['flagCycleManager', 'flagRetention'] });
    const before = await dump(e);
    const text = await say(e, '/cog defaults');
    expect(text).toContain('• flagCycleManager: on (no change)');
    expect(text).toContain('• flagEpisodicMemory: off -> on');
    expect(text).toContain(`${defaultOnFlags().length - 1} of ${defaultOnFlags().length} flags would change`);
    expect(text).toContain('• flagRetention: stays off');
    expect(text).toContain('• flagInitiative: stays off');
    expect(text).toContain('The defaults were never written on this install.');
    expect(await dump(e)).toBe(before);
  });

  it('apply turns on only missing or off flags, never retention or initiative, never a setup key; lists each change; writes the marker', async () => {
    const e = await env({ flags: ['flagCycleManager', 'flagRetention'] });
    await setFlag(e.cfg, 'flagGoalStack', false); // explicitly off: apply turns it on
    await setNumber(e.store, 'salienceThreshold', 0.7);
    const keysBefore = (await setupTriples(e)).filter((x) => x.startsWith('salience'));
    const text = await say(e, '/cog defaults apply');
    const want = defaultOnFlags().map((f) => f.name).filter((n) => n !== 'flagCycleManager');
    expect(text).toContain(`Turned on (${want.length}): ${want.join(', ')}.`);
    expect(text).not.toMatch(/Turned on[^\n]*flagCycleManager/);
    const v = await flagValues(e);
    for (const f of COGNITIVE_FLAGS) {
      // retention was ON before (set by the owner); apply never turns it on and never turns it off either
      expect(v[f.name]).toBe(f.name === 'flagInitiative' ? false : true);
    }
    expect((await setupTriples(e)).filter((x) => x.startsWith('salience'))).toEqual(keysBefore);
    expect(await e.cfg.unknownNudgeAllUsers()).toBe(false);
    expect((await readDefaultsMarker(e.store, AGENT))?.version).toBe(String(COGNITIVE_DEFAULTS_VERSION));
    // idempotent: a second apply changes nothing and keeps a single marker
    const again = await say(e, '/cog defaults apply');
    expect(again).toContain('Nothing changed');
    expect((await setupTriples(e)).filter((x) => x.startsWith('defaultsSeededAt'))).toHaveLength(1);
    expect(await say(e, '/cog defaults')).toContain('0 of ');
  });

  it('apply on an install with nothing set leaves retention off', async () => {
    const e = await env();
    await say(e, '/cog defaults apply');
    expect(await e.cfg.isRetentionEnabled()).toBe(false);
    expect(await e.cfg.isInitiativeEnabled()).toBe(false);
    expect(await e.cfg.isCycleManagerEnabled()).toBe(true);
  });

  it('is owner-only: a non-owner changes and learns nothing; a scheduler envelope cannot apply', async () => {
    const e = await env();
    const before = await dump(e);
    for (const t of ['/cog defaults', '/cog defaults apply']) {
      expect(await say(e, t, envelope(t, ALICE))).toBe('This command is owner-only.');
    }
    expect(await say(e, '/cog defaults apply', schedulerEnv('/cog defaults apply'))).toBe('This command needs a live owner turn.');
    expect(await dump(e)).toBe(before);
  });

  it('an unknown argument shows the usage and changes nothing', async () => {
    const e = await env();
    const before = await dump(e);
    expect(await say(e, '/cog defaults now')).toContain('Usage: /cog [health|defaults [apply]|');
    expect(await dump(e)).toBe(before);
  });
});

describe('legacy path for an existing install', () => {
  const made: Env[] = [];
  afterEach(async () => { await cleanup(made); made.length = 0; });

  it('after the boot step on a store with data the prompt has no cognitive block and equals the one without the step', async () => {
    const seed = async ({ store }: Pick<Env, 'store'>) => seedSkillAndSelf(store);
    const plain = await makeEnv({ seed }); made.push(plain);
    await send(plain, 'what is oxigraph?');
    const booted = await makeEnv({ seed: async (x) => { await seed(x); expect((await seedDefaultsForFreshInstall(x.store, AGENT, true)).seeded).toBe(false); } }); made.push(booted);
    await send(booted, 'what is oxigraph?');
    expect(booted.probe.answers[0].system).toBe(plain.probe.answers[0].system);
    expect(booted.probe.answers[0].system).not.toContain('[Self]');
    expect(await rows(booted.store, `SELECT ?s WHERE { GRAPH ?g { ?s a <${COGT}Cycle> } }`)).toHaveLength(0);
  });
});
