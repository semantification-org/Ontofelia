import { describe, it, expect, beforeEach } from 'vitest';
import { OxigraphAdapter, GraphRegistry, EpisodicMemory } from '@ontofelia/semantic-memory';
import type { TriplestoreAdapter } from '@ontofelia/core';
import {
  GoalStack,
  addIso8601Duration,
  DEFAULT_MIN_WAKE_INTERVAL_MS,
  INITIATIVE_FAILURES_EXCEEDED,
} from '../cognitive/GoalStack.js';

// Initiative wake policy over the goal graphs. Like the base GoalStack suite,
// this runs against embedded Oxigraph (SPARQL projection).

const AGENT = 'ontofelia';
const SESS = 'sess_wake_1';
const COGT = 'urn:shared:ontology#cog/';
const ANSWER = `${COGT}AnswerQuestion`;
const OWNER_ACTOR = 'urn:entity:agent-sender:owner';
const SELF_ACTOR = `urn:${AGENT}:self#${AGENT}`;

async function makeStore(): Promise<TriplestoreAdapter> {
  const store = new OxigraphAdapter();
  await store.initialize({
    backend: 'oxigraph',
    type: 'embedded',
    dataDir: `/tmp/goalwake-test-${process.pid}-${Math.random().toString(16).slice(2)}`,
    port: 0,
    endpoint: '',
  });
  return store;
}

/** Seed a real owner-utterance (`message-received`) episode; return its IRI. */
async function seedOwnerMandate(store: TriplestoreAdapter): Promise<string> {
  const em = new EpisodicMemory(store, AGENT);
  return em.append({
    episodeType: 'message-received',
    actor: OWNER_ACTOR,
    payload: 'keep working on the report and remind me when done',
    occurredAt: new Date('2026-05-01T00:00:00.000Z'),
  });
}

describe('addIso8601Duration', () => {
  const base = new Date('2026-01-01T00:00:00.000Z');
  it('adds hours, minutes, seconds and days', () => {
    expect(addIso8601Duration(base, 'PT2H').toISOString()).toBe('2026-01-01T02:00:00.000Z');
    expect(addIso8601Duration(base, 'PT30M').toISOString()).toBe('2026-01-01T00:30:00.000Z');
    expect(addIso8601Duration(base, 'PT45S').toISOString()).toBe('2026-01-01T00:00:45.000Z');
    expect(addIso8601Duration(base, 'P1D').toISOString()).toBe('2026-01-02T00:00:00.000Z');
    expect(addIso8601Duration(base, 'P1DT12H').toISOString()).toBe('2026-01-02T12:00:00.000Z');
  });
  it('rejects unsupported / malformed durations', () => {
    expect(() => addIso8601Duration(base, 'P1W')).toThrow(/Unsupported/);
    expect(() => addIso8601Duration(base, 'P1M')).toThrow(/Unsupported/); // month
    expect(() => addIso8601Duration(base, 'P1Y')).toThrow(/Unsupported/);
    expect(() => addIso8601Duration(base, 'PT')).toThrow(/Unsupported/); // no component
    expect(() => addIso8601Duration(base, 'garbage')).toThrow(/Unsupported/);
  });
  // ── M1: huge in-grammar duration must throw, not return Invalid Date ──
  it('rejects a huge in-grammar duration instead of returning Invalid Date (M1)', () => {
    // P999999999D overflows the Date range → previously new Date(NaN) silently.
    expect(() => addIso8601Duration(base, 'P999999999D')).toThrow(/out of range/);
    // in-grammar but beyond the ~10-year ceiling.
    expect(() => addIso8601Duration(base, 'P4000D')).toThrow(/out of range/);
    // just under the ceiling is fine (a real Date).
    expect(Number.isNaN(addIso8601Duration(base, 'P3000D').getTime())).toBe(false);
  });
});

describe('GoalStack — wake policy', () => {
  let store: TriplestoreAdapter;
  let registry: GraphRegistry;
  let gs: GoalStack;
  let mandate: string; // a real owner-utterance episode IRI

  beforeEach(async () => {
    store = await makeStore();
    registry = GraphRegistry.create([AGENT]);
    gs = new GoalStack(store, registry, AGENT, SESS);
    mandate = await seedOwnerMandate(store);
  });

  it('persists wake fields on push and reads them back', async () => {
    const wakeAt = new Date('2026-02-01T10:00:00.000Z');
    const uri = await gs.push({
      goalType: ANSWER,
      goalLabel: 'keep working on the report',
      priority: 0.7,
      mandatedBy: mandate,
      servesDrive: 'urn:shared:ontology#cog/drive/Service',
      wakeAt,
      wakeEvery: 'PT2H',
    });
    const goal = await gs.get(uri);
    expect(goal!.mandatedBy).toBe(mandate);
    expect(goal!.servesDrive).toBe('urn:shared:ontology#cog/drive/Service');
    expect(Date.parse(goal!.wakeAt!)).toBe(wakeAt.getTime());
    expect(goal!.wakeEvery).toBe('PT2H');
  });

  it('dueWakes enforces the mandate gate and the active+due filter', async () => {
    const past = new Date('2026-01-01T00:00:00.000Z');
    const future = new Date('2030-01-01T00:00:00.000Z');
    const now = new Date('2026-06-01T00:00:00.000Z');

    // due + mandated + active → eligible
    const due = await gs.push({ goalType: ANSWER, goalLabel: 'due', priority: 0.8, mandatedBy: mandate, wakeAt: past });
    // mandated but wake in the future → not due
    await gs.push({ goalType: ANSWER, goalLabel: 'future', priority: 0.8, mandatedBy: mandate, wakeAt: future });
    // due wake but NO mandate → mandate gate excludes it
    await gs.push({ goalType: ANSWER, goalLabel: 'unmandated', priority: 0.8, wakeAt: past });
    // mandated + due but not active → excluded
    const blocked = await gs.push({ goalType: ANSWER, goalLabel: 'blocked', priority: 0.8, mandatedBy: mandate, wakeAt: past, status: 'blocked' });

    const due2 = await gs.dueWakes(now);
    expect(due2.map((g) => g.uri)).toEqual([due]);
    expect(due2.map((g) => g.uri)).not.toContain(blocked);

    // wakingGoals returns all active+validly-mandated+wakeAt (future included), not the unmandated one.
    const waking = await gs.wakingGoals();
    expect(waking.length).toBe(2);
    expect(waking.every((g) => g.mandatedBy === mandate)).toBe(true);
  });

  // ── H4: mandate gate is structurally validated (self-mandate escape) ──
  it('rejects a fabricated, non-episode, or agent-authored mandate (H4)', async () => {
    const past = new Date('2026-01-01T00:00:00.000Z');
    const now = new Date('2026-06-01T00:00:00.000Z');

    // (a) mandatedBy → a non-existent / fabricated IRI
    await gs.push({ goalType: ANSWER, goalLabel: 'fabricated', priority: 0.8, mandatedBy: 'urn:ontofelia:cog:ep:does-not-exist', wakeAt: past });
    // (b) mandatedBy → a subject that exists but is NOT an episode (a drive)
    await gs.push({ goalType: ANSWER, goalLabel: 'non-episode', priority: 0.8, mandatedBy: 'urn:shared:ontology#cog/drive/Service', wakeAt: past });
    // (c) mandatedBy → an episode authored by the agent itself (not an owner utterance)
    const em = new EpisodicMemory(store, AGENT);
    const selfEp = await em.append({ episodeType: 'response-sent', actor: SELF_ACTOR, payload: 'I did the thing', occurredAt: past });
    await gs.push({ goalType: ANSWER, goalLabel: 'self-authored', priority: 0.8, mandatedBy: selfEp, wakeAt: past });
    // an initiative-authored skip episode also must not count as a mandate
    const initEp = await em.append({ episodeType: 'initiative', actor: SELF_ACTOR, payload: 'skipped', occurredAt: past });
    await gs.push({ goalType: ANSWER, goalLabel: 'initiative-authored', priority: 0.8, mandatedBy: initEp, wakeAt: past });

    // Only the real owner-utterance mandate is eligible.
    const valid = await gs.push({ goalType: ANSWER, goalLabel: 'valid', priority: 0.8, mandatedBy: mandate, wakeAt: past });

    const due = await gs.dueWakes(now);
    expect(due.map((g) => g.uri)).toEqual([valid]);
    expect(await gs.isMandateValid('urn:ontofelia:cog:ep:does-not-exist')).toBe(false);
    expect(await gs.isMandateValid('urn:shared:ontology#cog/drive/Service')).toBe(false);
    expect(await gs.isMandateValid(selfEp)).toBe(false);
    expect(await gs.isMandateValid(initEp)).toBe(false);
    expect(await gs.isMandateValid(mandate)).toBe(true);
  });

  // ── B1: sub-cooldown / zero wakeEvery is rejected at write time ──
  it('rejects zero and sub-cooldown wakeEvery on setWake and push (B1)', async () => {
    const now = new Date('2026-06-01T00:00:00.000Z');
    const uri = await gs.push({ goalType: ANSWER, goalLabel: 'floor', priority: 0.7, mandatedBy: mandate });
    // zero-length intervals
    await expect(gs.setWake(uri, { wakeEvery: 'PT0S' }, now)).rejects.toThrow(/below the minimum|out of range/);
    await expect(gs.setWake(uri, { wakeEvery: 'P0D' }, now)).rejects.toThrow(/below the minimum/);
    // 1s — below the 30-min floor
    await expect(gs.setWake(uri, { wakeEvery: 'PT1S' }, now)).rejects.toThrow(/below the minimum/);
    // just under the cooldown floor (29 min < 30 min)
    await expect(gs.setWake(uri, { wakeEvery: 'PT29M' }, now)).rejects.toThrow(/below the minimum/);
    // exactly at the floor is accepted
    await expect(gs.setWake(uri, { wakeEvery: 'PT30M' }, now)).resolves.toBeUndefined();
    // push must reject a sub-floor interval too
    await expect(
      gs.push({ goalType: ANSWER, goalLabel: 'bad', priority: 0.7, mandatedBy: mandate, wakeEvery: 'PT1S' }),
    ).rejects.toThrow(/below the minimum/);
    // floor equals the documented 30-minute cooldown
    expect(DEFAULT_MIN_WAKE_INTERVAL_MS).toBe(30 * 60_000);
  });

  it('recordWake rolls a recurring wake forward and stamps lastWakeAt/wakeCount', async () => {
    const uri = await gs.push({
      goalType: ANSWER,
      goalLabel: 'recurring',
      priority: 0.7,
      mandatedBy: mandate,
      wakeAt: new Date('2026-01-01T00:00:00.000Z'),
      wakeEvery: 'PT2H',
    });
    const now = new Date('2026-06-01T09:00:00.000Z');
    await gs.recordWake(uri, now);
    const goal = await gs.get(uri);
    expect(Date.parse(goal!.lastWakeAt!)).toBe(now.getTime());
    expect(goal!.wakeCount).toBe(1);
    // next wake = now + PT2H
    expect(Date.parse(goal!.wakeAt!)).toBe(Date.parse('2026-06-01T11:00:00.000Z'));
  });

  it('recordWake clears wakeAt for a one-shot goal (no wakeEvery)', async () => {
    const uri = await gs.push({
      goalType: ANSWER,
      goalLabel: 'one-shot',
      priority: 0.7,
      mandatedBy: mandate,
      wakeAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    await gs.recordWake(uri, new Date('2026-06-01T09:00:00.000Z'));
    const goal = await gs.get(uri);
    expect(goal!.wakeAt).toBeUndefined();
    expect(goal!.wakeCount).toBe(1);
  });

  it('recordWakeFailure blocks the goal at the threshold; clearWakeFailures resets', async () => {
    const uri = await gs.push({ goalType: ANSWER, goalLabel: 'failing', priority: 0.7, mandatedBy: mandate });
    expect(await gs.recordWakeFailure(uri)).toBe(1);
    expect(await gs.recordWakeFailure(uri)).toBe(2);
    let goal = await gs.get(uri);
    expect(goal!.status).toBe('active'); // not yet at threshold

    expect(await gs.recordWakeFailure(uri)).toBe(3);
    goal = await gs.get(uri);
    expect(goal!.status).toBe('blocked');
    expect(goal!.blockedReason).toBe(INITIATIVE_FAILURES_EXCEEDED);

    await gs.clearWakeFailures(uri);
    goal = await gs.get(uri);
    expect(goal!.consecutiveFailures).toBeUndefined();
  });

  it('setWake seeds an initial wakeAt from wakeEvery when none is given', async () => {
    const uri = await gs.push({ goalType: ANSWER, goalLabel: 'seed', priority: 0.7, mandatedBy: mandate });
    const now = new Date('2026-06-01T00:00:00.000Z');
    await gs.setWake(uri, { wakeEvery: 'P1D' }, now);
    const goal = await gs.get(uri);
    expect(goal!.wakeEvery).toBe('P1D');
    expect(Date.parse(goal!.wakeAt!)).toBe(Date.parse('2026-06-02T00:00:00.000Z'));
  });
});
