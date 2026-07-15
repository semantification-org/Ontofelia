import { describe, it, expect, beforeEach } from 'vitest';
import { OxigraphAdapter, GraphRegistry } from '@ontofelia/semantic-memory';
import type { TriplestoreAdapter } from '@ontofelia/core';
import {
  NotificationService,
  type NotificationChannelPort,
  type NotificationPolicy,
} from '../cognitive/NotificationService.js';

const AGENT = 'ontofelia';
const COGT = 'urn:shared:ontology#cog/';

async function makeStore(): Promise<TriplestoreAdapter> {
  const store = new OxigraphAdapter();
  await store.initialize({
    backend: 'oxigraph',
    type: 'embedded',
    dataDir: `/tmp/notifsvc-test-${process.pid}-${Math.random().toString(16).slice(2)}`,
    port: 0,
    endpoint: '',
  });
  return store;
}

/** Capturing fake channel adapter (records every send). */
class FakeChannel implements NotificationChannelPort {
  sends: Array<{ target: string; text: string }> = [];
  async sendText(target: string, text: string): Promise<unknown> {
    this.sends.push({ target, text });
    return {};
  }
}

/** Count 'notification' episodes whose JSON payload mentions a given reason. */
async function countNotificationEpisodes(
  store: TriplestoreAdapter,
  reason: string,
): Promise<number> {
  const graph = `urn:${AGENT}:cog:episodic`;
  const res = await store.query(`
    SELECT ?ep ?p WHERE {
      GRAPH <${graph}> {
        ?ep a <${COGT}Episode> ; <${COGT}episodeType> "notification" ; <${COGT}payload> ?p .
      }
    }`);
  return (res.bindings ?? []).filter((b) => b.p.value.includes(`"reason":"${reason}"`)).length;
}

describe('NotificationService', () => {
  let store: TriplestoreAdapter;
  let registry: GraphRegistry;
  let channel: FakeChannel;
  let clockNow: Date;

  const basePolicy: NotificationPolicy = {
    maxPerDay: 5,
    minPriorityDuringQuietHours: 'high',
    timezone: 'UTC', // deterministic quiet-hours eval regardless of host TZ
  };

  function makeService(overrides: {
    policy?: Partial<NotificationPolicy>;
    target?: string | undefined;
    channel?: NotificationChannelPort | undefined | (() => NotificationChannelPort | undefined);
  } = {}) {
    return new NotificationService({
      triplestore: store,
      registry,
      agentId: AGENT,
      policy: { ...basePolicy, ...overrides.policy },
      channel: overrides.channel !== undefined ? overrides.channel : channel,
      resolveTarget: () => ('target' in overrides ? overrides.target : 'owner-chat-1'),
      clock: () => clockNow,
    });
  }

  beforeEach(async () => {
    store = await makeStore();
    registry = GraphRegistry.create([AGENT]);
    channel = new FakeChannel();
    clockNow = new Date('2026-06-01T12:00:00.000Z'); // midday UTC (outside quiet hours)
  });

  describe('daily cap', () => {
    it('suppresses after maxPerDay and persists across a service rebuild', async () => {
      const svc = makeService({ policy: { maxPerDay: 2 } });
      // Distinct timestamps: two sends in the same instant collapse to one RDF
      // stamp (triples are a set), which is unrealistic for real deliveries.
      clockNow = new Date('2026-06-01T12:00:00.000Z');
      expect((await svc.deliver({ message: 'a', priority: 'normal' })).sent).toBe(true);
      clockNow = new Date('2026-06-01T12:01:00.000Z');
      expect((await svc.deliver({ message: 'b', priority: 'normal' })).sent).toBe(true);
      clockNow = new Date('2026-06-01T12:02:00.000Z');
      const third = await svc.deliver({ message: 'c', priority: 'normal' });
      expect(third.sent).toBe(false);
      expect(third.reason).toBe('daily-cap');
      expect(channel.sends).toHaveLength(2);

      // Rebuild the service from the same store: the counter is persisted, so
      // a fresh instance still sees the cap as reached.
      const svc2 = makeService({ policy: { maxPerDay: 2 } });
      clockNow = new Date('2026-06-01T12:03:00.000Z');
      const again = await svc2.deliver({ message: 'd', priority: 'high' });
      expect(again.sent).toBe(false);
      expect(again.reason).toBe('daily-cap');
      expect(channel.sends).toHaveLength(2);
    });
  });

  describe('quiet hours', () => {
    const quiet = { quietHours: { start: '22:00', end: '08:00' } }; // wraps midnight

    it('suppresses a normal notification inside the window', async () => {
      clockNow = new Date('2026-06-01T23:00:00.000Z');
      const svc = makeService({ policy: quiet });
      const r = await svc.deliver({ message: 'x', priority: 'normal' });
      expect(r.sent).toBe(false);
      expect(r.reason).toBe('quiet-hours');
    });

    it('suppresses after midnight (wrap handling)', async () => {
      clockNow = new Date('2026-06-01T03:00:00.000Z');
      const svc = makeService({ policy: quiet });
      const r = await svc.deliver({ message: 'x', priority: 'normal' });
      expect(r.sent).toBe(false);
      expect(r.reason).toBe('quiet-hours');
    });

    it('high priority bypasses quiet hours', async () => {
      clockNow = new Date('2026-06-01T23:00:00.000Z');
      const svc = makeService({ policy: quiet });
      const r = await svc.deliver({ message: 'urgent', priority: 'high' });
      expect(r.sent).toBe(true);
      expect(channel.sends).toHaveLength(1);
    });

    it('sends normally outside the window', async () => {
      clockNow = new Date('2026-06-01T12:00:00.000Z');
      const svc = makeService({ policy: quiet });
      const r = await svc.deliver({ message: 'x', priority: 'normal' });
      expect(r.sent).toBe(true);
    });
  });

  describe('no target', () => {
    it('suppresses without throwing when no owner target resolves', async () => {
      const svc = makeService({ target: undefined });
      const r = await svc.deliver({ message: 'x', priority: 'high' });
      expect(r.sent).toBe(false);
      expect(r.reason).toBe('no-target');
      expect(channel.sends).toHaveLength(0);
    });
  });

  describe('episodes', () => {
    it('writes a notification episode for a sent message', async () => {
      const svc = makeService();
      await svc.deliver({ message: 'a', priority: 'normal' });
      expect(await countNotificationEpisodes(store, 'sent')).toBe(1);
    });

    it('writes an episode for each suppressed reason', async () => {
      // daily-cap
      const capped = makeService({ policy: { maxPerDay: 0 } });
      await capped.deliver({ message: 'a', priority: 'normal' });
      expect(await countNotificationEpisodes(store, 'daily-cap')).toBe(1);

      // quiet-hours
      clockNow = new Date('2026-06-01T23:00:00.000Z');
      const quietSvc = makeService({ policy: { quietHours: { start: '22:00', end: '08:00' } } });
      await quietSvc.deliver({ message: 'b', priority: 'normal' });
      expect(await countNotificationEpisodes(store, 'quiet-hours')).toBe(1);

      // no-target
      const noTarget = makeService({ target: undefined });
      await noTarget.deliver({ message: 'c', priority: 'high' });
      expect(await countNotificationEpisodes(store, 'no-target')).toBe(1);
    });
  });

  describe('digest', () => {
    it('queues suppressed items and drainDigest returns then clears them', async () => {
      const svc = makeService({ policy: { maxPerDay: 0 } }); // everything suppressed
      clockNow = new Date('2026-06-01T10:00:00.000Z');
      await svc.deliver({ message: 'first', priority: 'normal', goalId: 'urn:goal:1' });
      clockNow = new Date('2026-06-01T11:00:00.000Z');
      await svc.deliver({ message: 'second', priority: 'high' });

      const drained = await svc.drainDigest();
      expect(drained).toHaveLength(2);
      // Oldest-first ordering.
      expect(drained[0].message).toBe('first');
      expect(drained[0].goalId).toBe('urn:goal:1');
      expect(drained[0].reason).toBe('daily-cap');
      expect(drained[1].message).toBe('second');

      // Second drain is empty (queue cleared).
      expect(await svc.drainDigest()).toHaveLength(0);
    });

    // M2: the queued digest is bounded at queue time (drop-oldest).
    it('bounds the stored queue to the newest 50 items (M2)', async () => {
      const svc = makeService({ policy: { maxPerDay: 0 } }); // all suppressed
      for (let i = 0; i < 100; i++) {
        clockNow = new Date(Date.UTC(2026, 5, 1, 0, i, 0)); // distinct minute per item
        await svc.deliver({ message: `msg-${i}`, priority: 'normal' });
      }
      const drained = await svc.drainDigest();
      expect(drained.length).toBe(50);
      const messages = drained.map((d) => d.message);
      // Newest kept, oldest dropped.
      expect(messages).toContain('msg-99');
      expect(messages).not.toContain('msg-0');
    });
  });

  // H1 — invalid IANA timezone must NOT throw and lose the message.
  describe('invalid timezone (H1)', () => {
    const quiet = { quietHours: { start: '22:00', end: '08:00' }, timezone: 'Totally/Bogus' };

    it('does not throw and delivers a high-priority message despite a bad tz', async () => {
      clockNow = new Date('2026-06-01T12:00:00.000Z');
      const svc = makeService({ policy: quiet });
      const r = await svc.deliver({ message: 'urgent', priority: 'high' });
      expect(r.sent).toBe(true);
      expect(channel.sends).toHaveLength(1);
    });

    it('deliver() resolves (never throws) for a normal message with a bad tz', async () => {
      clockNow = new Date('2026-06-01T12:00:00.000Z');
      const svc = makeService({ policy: quiet });
      await expect(svc.deliver({ message: 'x', priority: 'normal' })).resolves.toBeDefined();
    });
  });

  // M1 — an adapter failure is recorded honestly as 'send-failed', not 'no-target'.
  describe('send failure (M1)', () => {
    it('reports send-failed and records a send-failed episode without consuming budget', async () => {
      const throwing: NotificationChannelPort = {
        async sendText() { throw new Error('telegram 502'); },
      };
      const svc = makeService({ channel: throwing });
      const r = await svc.deliver({ message: 'x', priority: 'high' });
      expect(r.sent).toBe(false);
      expect(r.reason).toBe('send-failed');
      expect(await countNotificationEpisodes(store, 'send-failed')).toBe(1);
      // Budget not consumed: a second attempt is not capped by a phantom send.
      expect(await countNotificationEpisodes(store, 'sent')).toBe(0);
    });
  });

  // M3 — concurrent deliveries are serialized; the cap holds exactly.
  describe('concurrency (M3)', () => {
    it('two concurrent deliver() with maxPerDay:1 send exactly one, suppress one', async () => {
      const svc = makeService({ policy: { maxPerDay: 1 } });
      clockNow = new Date('2026-06-01T12:00:00.000Z');
      const [a, b] = await Promise.all([
        svc.deliver({ message: 'a', priority: 'normal' }),
        svc.deliver({ message: 'b', priority: 'normal' }),
      ]);
      const results = [a, b];
      expect(results.filter((r) => r.sent)).toHaveLength(1);
      const suppressed = results.filter((r) => !r.sent);
      expect(suppressed).toHaveLength(1);
      expect(suppressed[0].reason).toBe('daily-cap');
      expect(channel.sends).toHaveLength(1);
    });
  });

  // H1 — the sink path (notify) must NEVER throw even if the store errors, and
  // must still preserve the message (digest) so nothing is silently lost.
  describe('notify() never throws (H1)', () => {
    it('swallows a store error and still records the message as a digest item', async () => {
      // Store proxy that throws on the daily-cap read (readSendStamps), so
      // deliver() rejects mid-flight; notify() must catch and preserve.
      const proxy = new Proxy(store, {
        get(target, prop, receiver) {
          if (prop === 'query') {
            return (sparql: string) => {
              if (sparql.includes('notifyRunAt')) throw new Error('store outage');
              return (target as TriplestoreAdapter).query(sparql);
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      }) as TriplestoreAdapter;

      const svc = new NotificationService({
        triplestore: proxy,
        registry,
        agentId: AGENT,
        policy: basePolicy,
        channel,
        resolveTarget: () => 'owner-chat-1',
        clock: () => clockNow,
      });

      await expect(svc.notify({ message: 'preserve me', priority: 'normal' })).resolves.toBeUndefined();
      // The message was preserved as an 'error' digest item (drain uses a query
      // that does not touch notifyRunAt, so it succeeds through the proxy).
      const drained = await svc.drainDigest();
      expect(drained.some((d) => d.message === 'preserve me' && d.reason === 'error')).toBe(true);
    });
  });
});
