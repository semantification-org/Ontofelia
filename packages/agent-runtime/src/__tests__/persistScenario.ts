import { OxigraphAdapter, GraphRegistry, type EntityFact } from '@ontofelia/semantic-memory';
import type { TriplestoreAdapter, MessageEnvelope } from '@ontofelia/core';
import { CycleManager, type RunCycleOptions, type ToolEpisodeEvent } from '../cognitive/CycleManager.js';
import { GoalStack, GOAL_TYPES } from '../cognitive/GoalStack.js';
import type { PerceptionSource } from '../cognitive/Perception.js';

// A scripted sequence of turns over a fresh embedded store, and a canonical dump
// of what the cognitive layer stored. Used to show that the way the queued
// persist writes (one write after the other, or independent writes together)
// does not change the stored data. Only the public cycle API is used, so the
// same script runs against an older checkout to produce the reference dump.

export const AGENT = 'ontofelia';
export const OWNER = { id: 'owner', channelPrefix: 'webchat', isOwner: true };
export const ALICE = { id: 'alice', channelPrefix: 'webchat', isOwner: false };
const BOB = { id: 'bob', channelPrefix: 'webchat', isOwner: false };
type Sender = typeof OWNER;
export const ZOE = 'urn:ontofelia:entity:zoe';
const ROME = 'urn:ontofelia:entity:rome';
const ATTN = { theta: 0.5, capacity: 200 };

export async function makeStore(
  dataDir = `/tmp/persist-scenario-${process.pid}-${Math.random().toString(16).slice(2)}`,
): Promise<TriplestoreAdapter> {
  const store = new OxigraphAdapter();
  await store.initialize({
    backend: 'oxigraph',
    type: 'embedded',
    dataDir,
    port: 0,
    endpoint: '',
  });
  return store;
}

export const envelope = (text: string, sender: Sender = ALICE): MessageEnvelope =>
  ({
    id: 'm1', channel: 'webchat', accountId: 'acc1', chatType: 'web', sender,
    timestamp: new Date().toISOString(), text, mentions: [], attachments: [],
  }) as MessageEnvelope;

export const aboutSource = (iris: string[]): PerceptionSource => ({
  entities: iris.map((iri, i) => ({ name: `E${i}${iri.slice(-3)}`, source: 'known' as const })),
  storedClaims: iris.map((iri, i) => ({
    subject: `E${i}${iri.slice(-3)}`, predicate: 'p', object: 'o', claimUri: `urn:claim:${i}`, subjectUri: iri,
  })),
});

export const toolRun = (name: string, outcome: 'success' | 'error', id = name): ToolEpisodeEvent[] => [
  { phase: 'called', toolName: name, callId: id, occurredAt: new Date('2026-10-01T10:00:00.000Z'), argsBrief: 'query', args: { query: 'x' } },
  {
    phase: 'completed', toolName: name, callId: id, occurredAt: new Date('2026-10-01T10:00:01.000Z'),
    outcome, durationMs: 12, ...(outcome === 'error' ? { errorClass: 'tool-error' } : {}),
  },
];

export const fact = (scope: 'user' | 'worldview', supersededAt?: string): EntityFact => ({
  entity: ZOE, direction: 'out', subject: ZOE, subjectLabel: 'Zoe',
  predicate: 'urn:ontofelia:prop:city', predicateLabel: 'lives in',
  object: ROME, objectLabel: 'Rome', objectIsIri: true,
  graph: scope === 'user' ? `urn:${AGENT}:user:alice` : `urn:${AGENT}:worldview`, scope,
  ...(supersededAt ? { superseded: { previousObject: 'urn:ontofelia:entity:paris', previousLabel: 'Paris', supersededAt } } : {}),
});

export interface ScenarioTurn {
  text: string;
  sender?: Sender;
  session: string;
  about?: string[];
  tools?: ToolEpisodeEvent[];
  facts?: () => EntityFact[];
  options?: RunCycleOptions;
  /** Goals to push before the turn (session of the turn). */
  pushGoal?: string;
  initiative?: boolean;
}

export const ALL_ON: RunCycleOptions = {
  goalsEnabled: true,
  episodicEnabled: true,
  proceduralEnabled: true,
  metacognitionEnabled: true,
  selfModelEnabled: true,
  attention: ATTN,
  goalSupersedeAfterTurns: 2,
};

/** The scripted turns. Every flag combination the persist branches on appears at least once. */
export function scenarioTurns(): ScenarioTurn[] {
  return [
    // A session of one user, everything on: tools (one fails: an impasse), recall, goals, traces.
    { text: 'who is Zoe?', session: 'sA', about: [ZOE], tools: [...toolRun('lookup', 'success'), ...toolRun('fetch', 'error')], facts: () => [fact('worldview')], options: { ...ALL_ON, promptMode: 'shadow' } },
    // The next message judges the previous turn (back-fill), carry-over runs.
    { text: 'thanks, that was great', session: 'sA', about: [ZOE], tools: toolRun('lookup', 'success'), facts: () => [fact('worldview')], options: { ...ALL_ON, promptMode: 'shadow' } },
    // A changed fact of the sender's own data: a ResolveConflict goal.
    { text: 'what does Zoe do?', session: 'sA', about: [ZOE], facts: () => [fact('user', new Date(Date.now() + 60_000).toISOString())], options: ALL_ON },
    // Another user, another session: no tools, no recall.
    { text: 'hello there', sender: BOB, session: 'sB', options: ALL_ON },
    { text: 'and again', sender: BOB, session: 'sB', options: ALL_ON },
    // Metacognition off (the minimal marker), no procedural memory, no goal stack.
    { text: 'plain turn', session: 'sC', options: { episodicEnabled: true, attention: ATTN } },
    // Episodic memory off.
    { text: 'no episodes', session: 'sC', tools: toolRun('lookup', 'success'), options: { ...ALL_ON, episodicEnabled: false } },
    // No attention settings: no carry-over.
    { text: 'no carry', session: 'sD', tools: toolRun('lookup', 'success'), options: { ...ALL_ON, attention: undefined } },
    // The owner, goal stack on, a long-running goal pushed first and several turns that never touch it.
    { text: 'long goal', sender: OWNER, session: 'sE', pushGoal: 'finish the report', options: ALL_ON },
    { text: 'something else', sender: OWNER, session: 'sE', options: ALL_ON },
    { text: 'still something else', sender: OWNER, session: 'sE', options: ALL_ON },
    { text: 'and more', sender: OWNER, session: 'sE', options: ALL_ON },
    // A working memory too small for the turn: entries are evicted one write at a time.
    { text: 'who is Zoe again?', session: 'sG', about: [ZOE], tools: toolRun('lookup', 'success'), facts: () => [fact('worldview')], options: { ...ALL_ON, attention: { theta: 0.5, capacity: 9 } } },
    // An unattended cycle.
    { text: 'wake', sender: OWNER, session: 'sF', initiative: true, pushGoal: 'check the inbox', options: { ...ALL_ON } },
  ];
}

/** Run the scripted turns on `store`, persisted in order (each turn's records are durable before the next). */
export async function runScenario(
  store: TriplestoreAdapter,
  onError: (e: unknown) => void = () => undefined,
  turns: ScenarioTurn[] = scenarioTurns(),
): Promise<CycleManager> {
  const registry = GraphRegistry.create([AGENT]);
  const cm = new CycleManager(store, registry, AGENT, onError, { awaitPersist: true });
  for (const t of turns) {
    let initiativeGoalUri: string | undefined;
    if (t.pushGoal) {
      initiativeGoalUri = await new GoalStack(store, registry, AGENT, t.session).push({
        goalType: GOAL_TYPES.AnswerQuestion,
        goalLabel: t.pushGoal,
        priority: 0.8,
        forUser: t.sender?.id ?? 'alice',
        ...(t.initiative ? { mandatedBy: 'urn:ontofelia:cog:ep:mandate-1' } : {}),
      });
    }
    await cm.runCycle(
      envelope(t.text, t.sender),
      async (recordTool, prepareGoals, recordInbound, perceive, comprehendHook) => {
        perceive(aboutSource(t.about ?? []));
        await comprehendHook(t.session);
        await prepareGoals(t.session);
        await recordInbound(t.session);
        for (const ev of t.tools ?? []) recordTool(ev);
        return { text: 'ok', sessionId: t.session };
      },
      (r) => r.sessionId,
      (r) => r.text,
      {
        ...t.options,
        entityFacts: t.facts ? async () => t.facts!() : undefined,
        ...(t.initiative ? { mode: 'initiative' as const, initiativeGoalUri } : {}),
      },
    );
    await cm.flushPending();
    await new Promise((r) => setTimeout(r, 3));
  }
  return cm;
}

// ---------------------------------------------------------------------------
// Canonical dump
// ---------------------------------------------------------------------------

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
// A timestamp as written in a literal ("2026-10-15T10:00:41.4Z") or in an episode id ("...T10-00-41-400Z").
const ISO = '\\d{4}-\\d\\d-\\d\\dT\\d\\d[:-]\\d\\d[:-]\\d\\d(?:[.-]\\d+)?Z?';
/** A generated part of an IRI or a literal: a UUID, a random hex tail, a timestamp. */
const GENERATED = new RegExp(
  [UUID, `(?<=(?:trace:|goal_${ISO}_))[0-9a-f]{4,8}`, `(?<=tr_${ISO}_)[0-9a-f]{8}`, ISO].join('|'),
  'g',
);

const MARK = '\u0001';

/**
 * A canonical form of a quad dump, independent of generated ids and timestamps:
 * every term that contains a generated part is replaced by a label computed from
 * its neighbourhood (a few rounds of colour refinement), so two dumps that differ
 * only in the generated ids give identical lines, while a different link between
 * records (a different `precededBy`, another cycle) gives different lines.
 */
export function canonicalQuads(nquads: string): string[] {
  const norm = (t: string) => t.replace(GENERATED, '<gen>');
  const quads = nquads
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => roundScores(parseQuad(l)));
  const isGen = (t: string) => t.startsWith('<') && norm(t) !== t;
  const gens = new Set<string>();
  for (const q of quads) for (const t of q) if (isGen(t)) gens.add(t);

  let label = new Map<string, string>([...gens].map((g) => [g, norm(g)]));
  for (let round = 0; round < 4; round++) {
    const feats = new Map<string, string[]>([...gens].map((g) => [g, []]));
    for (const q of quads) {
      const lab = q.map((t) => (gens.has(t) ? `${MARK}${label.get(t)}` : norm(t)));
      q.forEach((t, pos) => {
        if (!gens.has(t)) return;
        const copy = [...lab];
        copy[pos] = `${MARK}*`;
        feats.get(t)!.push(`${pos}:${copy.join(' ')}`);
      });
    }
    const next = new Map<string, string>();
    for (const g of gens) next.set(g, hash(`${norm(g)}|${feats.get(g)!.sort().join('|')}`));
    label = next;
  }
  const lines = quads.map((q) =>
    q.map((t) => (gens.has(t) ? `<gen:${label.get(t)}>` : norm(t))).join(' '),
  );
  return lines.sort();
}

/**
 * Recall scores decay with the age of the episodes they come from, so they differ
 * in the last digits from run to run: they are compared to two decimals.
 */
function roundScores(q: string[]): string[] {
  if (/\/(?:salience|retrievalScore)>$/.test(q[1]) && /^"[0-9.]+"\^\^/.test(q[2])) {
    const v = Number(q[2].slice(1, q[2].indexOf('"', 1)));
    return [q[0], q[1], `"${v.toFixed(2)}"${q[2].slice(q[2].indexOf('"', 1) + 1)}`, ...q.slice(3)];
  }
  return q;
}

function parseQuad(line: string): string[] {
  const out: string[] = [];
  let i = 0;
  const s = line.trim();
  while (i < s.length && s[i] !== '.') {
    if (s[i] === ' ') { i++; continue; }
    let j = i;
    if (s[i] === '<') {
      j = s.indexOf('>', i) + 1;
    } else if (s[i] === '"') {
      j = i + 1;
      while (s[j] !== '"' || s[j - 1] === '\\') j++;
      j++;
      if (s[j] === '^' ) j = s.indexOf('>', j) + 1;
      else if (s[j] === '@') while (j < s.length && s[j] !== ' ') j++;
    } else {
      while (j < s.length && s[j] !== ' ') j++;
    }
    out.push(s.slice(i, j));
    i = j;
  }
  // subject, predicate, object, optional graph
  return out;
}

function hash(s: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

/** The store's dump as N-Quads. */
export function dumpQuads(store: TriplestoreAdapter): string {
  const raw = (store as unknown as { store: { dump: (o: { format: string }) => string } }).store;
  return raw.dump({ format: 'application/n-quads' });
}
