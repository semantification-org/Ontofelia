/**
 * NotificationService — the governed owner-notification layer
 * (docs/initiative-architecture.md §7).
 *
 * It is the concrete {@link NotificationSink} that drops into
 * {@link InitiativeService} (replacing the no-op {@link LoggingNotificationSink})
 * and it also backs the `notify_owner` tool. All delivery policy lives HERE, not
 * in the LLM: every notify is evaluated against the daily cap and quiet hours
 * BEFORE any send, suppressed items are queued as a pending digest, and every
 * notification — sent or suppressed — is written as an episode for the audit
 * trail.
 *
 * Persistence mirrors {@link InitiativeService}'s counter pattern exactly:
 * delivered-notification timestamps live as `cogt:notifyRunAt` triples on
 * `urn:<agent>:setup:notify` in the setup graph, pruned to a rolling 24h. Digest
 * items are separate resources in the same graph, drained-and-cleared on the
 * next owner contact.
 *
 * Determinism: "now" is read only through an injected {@link Clock}, and the
 * outbound channel + target are injected, so tests drive the cap/quiet-hours
 * logic with a fake clock and a capturing fake channel over an in-memory store.
 */

import { createLogger, type TriplestoreAdapter } from '@ontofelia/core';
import {
  EpisodicMemory,
  GraphUriResolver,
  type GraphRegistry,
} from '@ontofelia/semantic-memory';
import type { NotificationSink } from './InitiativeService.js';

const COGT = 'urn:shared:ontology#cog/';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const XSD = 'http://www.w3.org/2001/XMLSchema#';

/** Max queued (suppressed) digest items retained; oldest are dropped (design M2). */
const DIGEST_QUEUE_MAX = 50;

/** Injected clock for deterministic policy evaluation. */
export type Clock = () => Date;

export type NotifyPriority = 'low' | 'normal' | 'high';

/**
 * Why a notify was or was not delivered — mirrored into the episode.
 *  - 'send-failed': the outbound adapter threw/failed (distinct from 'no-target',
 *    which means no owner target/channel was resolvable at all) — honest
 *    provenance (M1).
 *  - 'error': an unexpected error anywhere in the delivery pipeline; the message
 *    is preserved as a digest item and the notify never throws (H1).
 */
export type NotifyReason =
  | 'sent'
  | 'daily-cap'
  | 'quiet-hours'
  | 'no-target'
  | 'send-failed'
  | 'error';

export interface NotifyInput {
  message: string;
  priority: NotifyPriority;
  goalId?: string;
}

/** Result surfaced to the notify_owner tool so it can report sent vs suppressed. */
export interface NotifyResult {
  sent: boolean;
  reason: NotifyReason;
  /** Resolved delivery target when known (for logging/tests); omitted on no-target. */
  target?: string;
}

/** One queued (suppressed) notification, oldest-first when drained. */
export interface DigestItem {
  message: string;
  priority: NotifyPriority;
  reason: Exclude<NotifyReason, 'sent'>;
  goalId?: string;
  ts: string;
}

/**
 * Structural outbound port (satisfied by any ChannelAdapter, e.g. the Telegram
 * adapter). Kept minimal so agent-runtime takes no dependency on @ontofelia/channels.
 */
export interface NotificationChannelPort {
  sendText(target: string, text: string): Promise<unknown>;
}

/** Delivery policy — the config.notifications subset the service enforces. */
export interface NotificationPolicy {
  maxPerDay: number;
  quietHours?: { start: string; end: string };
  minPriorityDuringQuietHours: NotifyPriority;
  /** IANA tz for quiet-hours evaluation; absent = server local. */
  timezone?: string;
}

export interface NotificationServiceOptions {
  triplestore: TriplestoreAdapter;
  registry: GraphRegistry;
  agentId: string;
  policy: NotificationPolicy;
  /**
   * The outbound channel, or a lazy getter (the gateway resolves the telegram
   * adapter after channel setup). Absent/undefined ⇒ no-target suppression.
   */
  channel?: NotificationChannelPort | (() => NotificationChannelPort | undefined);
  /**
   * Resolve the owner delivery target (config.notifications.target ??
   * channels.telegram.ownerChatId ?? first telegram allowlist entry). Returns
   * undefined when no target can be found → no-target suppression.
   */
  resolveTarget: () => string | undefined | Promise<string | undefined>;
  clock?: Clock;
}

const PRIORITY_ORDER: Record<NotifyPriority, number> = { low: 0, normal: 1, high: 2 };

/**
 * Concrete owner-notification sink. Implements {@link NotificationSink} (so it
 * drops straight into InitiativeService) and additionally exposes {@link deliver}
 * (rich result) for the notify_owner tool and {@link drainDigest} for the
 * "while you were away" digest on next owner contact.
 */
export class NotificationService implements NotificationSink {
  private readonly triplestore: TriplestoreAdapter;
  private readonly registry: GraphRegistry;
  private readonly agentId: string;
  private readonly policy: NotificationPolicy;
  private readonly channelRef: NotificationServiceOptions['channel'];
  private readonly resolveTarget: NotificationServiceOptions['resolveTarget'];
  private readonly clock: Clock;
  private readonly logger = createLogger('notify');
  /**
   * Per-service serialization chain (design M3), mirroring InitiativeService's
   * wakeChain. Every {@link deliver} runs exclusively so the
   * read-count → send → record-stamp sequence is effectively atomic (two
   * concurrent notifies can no longer both pass a maxPerDay cap) and overlapping
   * embedded-triplestore writes (dataset rename → ENOENT) cannot race.
   */
  private notifyChain: Promise<unknown> = Promise.resolve();
  /** Keys already logged once (malformed-config warnings — L3/H1). */
  private readonly loggedOnce = new Set<string>();

  constructor(opts: NotificationServiceOptions) {
    this.triplestore = opts.triplestore;
    this.registry = opts.registry;
    this.agentId = opts.agentId;
    this.policy = opts.policy;
    this.channelRef = opts.channel;
    this.resolveTarget = opts.resolveTarget;
    this.clock = opts.clock ?? (() => new Date());
  }

  /**
   * {@link NotificationSink} entry point used by initiative cycles. Fire-and-forget
   * from the caller's view — the delivery decision and its audit are the service's
   * responsibility. Never throws (delivery failures are recorded and swallowed).
   */
  async notify(n: NotifyInput): Promise<void> {
    // The sink contract is "never throws": a delivery failure must not bubble
    // into the initiative cycle and lose the message with no audit. deliver()
    // is already defensive, but any unexpected error (store outage mid-record)
    // is caught here, preserved as a digest item + an 'error' episode, and
    // swallowed (H1).
    try {
      await this.deliver(n);
    } catch (e) {
      this.logger.error(`notify() swallowed unexpected error: ${(e as Error).message}`);
      const priority: NotifyPriority = n.priority ?? 'normal';
      const now = this.clock();
      try {
        await this.queueDigest(n, priority, 'error', now);
      } catch { /* best-effort; never rethrow from the sink */ }
      try {
        await this.recordEpisode(priority, 'error', n.goalId, now);
      } catch { /* best-effort; never rethrow from the sink */ }
    }
  }

  /**
   * Evaluate policy → send or suppress → record an episode → (on suppression)
   * queue a digest item. Returns the decision so the notify_owner tool can tell
   * the LLM whether the owner was reached. Serialized per service (design M3) so
   * the cap check and record are atomic. Never throws for the policy/target/send
   * paths; a truly unexpected store error may reject and is caught by
   * {@link notify} on the sink path.
   */
  async deliver(n: NotifyInput): Promise<NotifyResult> {
    return this.runExclusive(() => this.deliverLocked(n));
  }

  /** Run `fn` after any in-flight deliver for this service completes (M3). */
  private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.notifyChain.then(fn, fn);
    this.notifyChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async deliverLocked(n: NotifyInput): Promise<NotifyResult> {
    const priority: NotifyPriority = n.priority ?? 'normal';
    const now = this.clock();

    // 1. Resolve target. No owner target ⇒ suppress without throwing (design §7).
    let target: string | undefined;
    try {
      target = await this.resolveTarget();
    } catch (e) {
      this.logger.warn(`notify target resolution failed: ${(e as Error).message}`);
    }
    if (!target) {
      this.logger.warn('notify suppressed: no owner target configured (no-target)');
      await this.queueDigest(n, priority, 'no-target', now);
      await this.recordEpisode(priority, 'no-target', n.goalId, now);
      return { sent: false, reason: 'no-target' };
    }

    // 2. Daily cap (counts DELIVERED notifications over the rolling 24h).
    const sentInDay = (await this.readSendStamps()).filter(
      (s) => Date.parse(s) >= now.getTime() - 86_400_000,
    ).length;
    if (sentInDay >= this.policy.maxPerDay) {
      await this.queueDigest(n, priority, 'daily-cap', now);
      await this.recordEpisode(priority, 'daily-cap', n.goalId, now);
      this.logger.info({ priority }, `notify suppressed: daily cap (${this.policy.maxPerDay}/day)`);
      return { sent: false, reason: 'daily-cap', target };
    }

    // 3. Quiet hours: suppress only when the priority is below the quiet-hours
    //    floor; high-priority (or a priority >= floor) always passes through.
    if (this.inQuietHours(now) && PRIORITY_ORDER[priority] < PRIORITY_ORDER[this.policy.minPriorityDuringQuietHours]) {
      await this.queueDigest(n, priority, 'quiet-hours', now);
      await this.recordEpisode(priority, 'quiet-hours', n.goalId, now);
      this.logger.info({ priority }, 'notify suppressed: quiet hours');
      return { sent: false, reason: 'quiet-hours', target };
    }

    // 4. Send.
    const channel = typeof this.channelRef === 'function' ? this.channelRef() : this.channelRef;
    if (!channel) {
      // A target exists but no channel is wired (e.g. telegram disabled). Treat
      // as no-target so the item is not lost and the owner sees it as digest.
      this.logger.warn('notify suppressed: no outbound channel available (no-target)');
      await this.queueDigest(n, priority, 'no-target', now);
      await this.recordEpisode(priority, 'no-target', n.goalId, now);
      return { sent: false, reason: 'no-target', target };
    }
    try {
      await channel.sendText(target, n.message);
    } catch (e) {
      // Delivery failure ⇒ queue as digest so it is not silently lost. Record
      // the HONEST reason 'send-failed' (a target existed and the adapter
      // failed), distinct from 'no-target' (nothing to send to). Budget is not
      // consumed (recordSend is not reached), so a transient failure does not
      // eat the daily cap (M1).
      this.logger.error(`notify send failed: ${(e as Error).message}`);
      await this.queueDigest(n, priority, 'send-failed', now);
      await this.recordEpisode(priority, 'send-failed', n.goalId, now);
      return { sent: false, reason: 'send-failed', target };
    }
    await this.recordSend(now);
    await this.recordEpisode(priority, 'sent', n.goalId, now);
    this.logger.info({ priority, target }, 'notify sent');
    return { sent: true, reason: 'sent', target };
  }

  /**
   * Return and CLEAR the pending digest (oldest-first). Called on the next owner
   * contact so the conversational cycle can open with a "while you were away"
   * summary; a second drain returns [].
   */
  async drainDigest(): Promise<DigestItem[]> {
    const graph = this.setupGraph();
    const res = await this.triplestore.query(`
      SELECT ?item ?msg ?prio ?reason ?ts ?goal WHERE {
        GRAPH <${graph}> {
          ?item <${RDF_TYPE}> <${COGT}NotificationDigestItem> ;
                <${COGT}notifyMessage> ?msg ;
                <${COGT}notifyPriority> ?prio ;
                <${COGT}notifyReason> ?reason ;
                <${COGT}occurredAt> ?ts .
          OPTIONAL { ?item <${COGT}notifyGoalId> ?goal }
        }
      }`);
    const rows = res.bindings ?? [];
    if (rows.length === 0) return [];
    const uris: string[] = [];
    const items: DigestItem[] = [];
    for (const b of rows) {
      uris.push(b.item.value);
      items.push({
        message: b.msg.value,
        priority: b.prio.value as NotifyPriority,
        reason: b.reason.value as DigestItem['reason'],
        goalId: b.goal?.value,
        ts: b.ts.value,
      });
    }
    items.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
    // Delete exactly the drained items by URI, so a concurrently-queued item is
    // not clobbered (deliveries are serialized upstream, but this is cheap).
    const values = uris.map((u) => `<${u}>`).join(' ');
    this.registry.assertWritable(graph);
    await this.triplestore.update(`
      DELETE { GRAPH <${graph}> { ?item ?p ?o } }
      WHERE  { GRAPH <${graph}> { ?item ?p ?o . VALUES ?item { ${values} } } }`);
    return items;
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private setupGraph(): string {
    return GraphUriResolver.getSetupGraph(this.agentId);
  }

  private counterSubject(): string {
    return `urn:${this.agentId}:setup:notify`;
  }

  private async readSendStamps(): Promise<string[]> {
    const res = await this.triplestore.query(`
      SELECT ?t WHERE {
        GRAPH <${this.setupGraph()}> { <${this.counterSubject()}> <${COGT}notifyRunAt> ?t }
      }`);
    return (res.bindings ?? []).map((b) => b.t.value);
  }

  /** Append a delivered-notification stamp and prune anything older than 24h. */
  private async recordSend(now: Date): Promise<void> {
    const graph = this.setupGraph();
    this.registry.assertWritable(graph);
    const cutoff = new Date(now.getTime() - 86_400_000).toISOString();
    await this.triplestore.update(`
      DELETE { GRAPH <${graph}> { <${this.counterSubject()}> <${COGT}notifyRunAt> ?t } }
      WHERE  { GRAPH <${graph}> { <${this.counterSubject()}> <${COGT}notifyRunAt> ?t .
               FILTER (?t < "${cutoff}"^^<${XSD}dateTime>) } }`);
    await this.triplestore.update(`
      INSERT DATA { GRAPH <${graph}> {
        <${this.counterSubject()}> <${COGT}notifyRunAt> "${now.toISOString()}"^^<${XSD}dateTime> .
      } }`);
  }

  private async queueDigest(
    n: NotifyInput,
    priority: NotifyPriority,
    reason: DigestItem['reason'],
    now: Date,
  ): Promise<void> {
    const graph = this.setupGraph();
    this.registry.assertWritable(graph);
    const uri = `urn:${this.agentId}:notify:digest:${this.newId()}`;
    const lines: string[] = [
      `<${uri}> <${RDF_TYPE}> <${COGT}NotificationDigestItem> .`,
      `<${uri}> <${COGT}notifyMessage> "${escapeLiteral(n.message)}" .`,
      `<${uri}> <${COGT}notifyPriority> "${priority}" .`,
      `<${uri}> <${COGT}notifyReason> "${reason}" .`,
      `<${uri}> <${COGT}occurredAt> "${now.toISOString()}"^^<${XSD}dateTime> .`,
    ];
    if (n.goalId) lines.push(`<${uri}> <${COGT}notifyGoalId> "${escapeLiteral(n.goalId)}" .`);
    await this.triplestore.update(`INSERT DATA { GRAPH <${graph}> {\n${lines.join('\n')}\n} }`);
    await this.pruneDigest(graph);
  }

  /**
   * Keep the queued digest bounded (design M2): retain only the newest
   * {@link DIGEST_QUEUE_MAX} items (drop oldest) so a runaway suppression loop
   * cannot balloon the setup graph or the owner's next prompt. Runs under the
   * same per-service mutex as the enclosing deliver, so the count/delete is not
   * raced.
   */
  private async pruneDigest(graph: string): Promise<void> {
    const res = await this.triplestore.query(`
      SELECT ?item ?ts WHERE {
        GRAPH <${graph}> {
          ?item <${RDF_TYPE}> <${COGT}NotificationDigestItem> ;
                <${COGT}occurredAt> ?ts .
        }
      }`);
    const rows = res.bindings ?? [];
    if (rows.length <= DIGEST_QUEUE_MAX) return;
    const ordered = rows
      .map((b) => ({ uri: b.item.value, ts: Date.parse(b.ts.value) }))
      .sort((a, b) => a.ts - b.ts); // oldest-first
    const drop = ordered.slice(0, ordered.length - DIGEST_QUEUE_MAX);
    const values = drop.map((d) => `<${d.uri}>`).join(' ');
    this.registry.assertWritable(graph);
    await this.triplestore.update(`
      DELETE { GRAPH <${graph}> { ?item ?p ?o } }
      WHERE  { GRAPH <${graph}> { ?item ?p ?o . VALUES ?item { ${values} } } }`);
  }

  /** Every notification — sent or suppressed — is an episode (design §7). */
  private async recordEpisode(
    priority: NotifyPriority,
    reason: NotifyReason,
    goalId: string | undefined,
    now: Date,
  ): Promise<void> {
    try {
      const em = new EpisodicMemory(this.triplestore, this.agentId);
      await em.append({
        episodeType: 'notification',
        occurredAt: now,
        actor: `urn:${this.agentId}:self#${this.agentId}`,
        payload: JSON.stringify({ priority, reason, ...(goalId ? { goalId } : {}) }),
        outcome: 'success',
        ...(goalId ? { partOfGoal: goalId } : {}),
        salience: 0.6,
      });
    } catch (e) {
      this.logger.error(`could not record notification episode: ${(e as Error).message}`);
    }
  }

  /**
   * Is `now` inside the owner-local quiet-hours window? The window is evaluated
   * in `policy.timezone` (IANA) when set, else server-local, using the Intl API
   * (no new deps). `end < start` wraps past midnight.
   *
   * DST caveat: the window is compared as wall-clock HH:MM in the target zone,
   * so on the two DST-transition days the real-world quiet window is one hour
   * shorter/longer. This is acceptable for a courtesy quiet window and avoids a
   * timezone-math dependency.
   */
  private inQuietHours(now: Date): boolean {
    const q = this.policy.quietHours;
    if (!q) return false;
    const start = parseHHMM(q.start);
    const end = parseHHMM(q.end);
    if (start === undefined || end === undefined) {
      // Malformed quiet-hours window ⇒ treat as no quiet hours (fail open to
      // delivery, never silently 24/7-suppress). Log once (L3).
      this.logOnce(
        `quiet-hours:${q.start}-${q.end}`,
        `notification quietHours is malformed ("${q.start}"–"${q.end}"); expected "HH:MM". Quiet hours disabled.`,
      );
      return false;
    }
    if (start === end) return false; // empty window
    const nowMin = this.localMinutes(now);
    return start < end
      ? nowMin >= start && nowMin < end
      : nowMin >= start || nowMin < end; // wraps midnight
  }

  /**
   * Minutes-since-midnight for `now` in the configured tz (or server local).
   * A bad IANA timezone makes Intl.DateTimeFormat THROW (H1); we must not let
   * that escape and lose the notification before it can be recorded/queued. On
   * failure we fall back to server-local wall-clock (treat as evaluable, i.e.
   * not force-quiet) and log once.
   */
  private localMinutes(now: Date): number {
    const tz = this.policy.timezone;
    let parts: Intl.DateTimeFormatPart[];
    try {
      parts = new Intl.DateTimeFormat('en-GB', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
        ...(tz ? { timeZone: tz } : {}),
      }).formatToParts(now);
    } catch (e) {
      this.logOnce(
        `bad-tz:${tz}`,
        `notification timezone "${tz}" is invalid (${(e as Error).message}); ` +
          `falling back to server-local time for quiet-hours evaluation.`,
      );
      parts = new Intl.DateTimeFormat('en-GB', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).formatToParts(now);
    }
    let h = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
    const m = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
    if (h === 24) h = 0; // some ICU builds render midnight as "24"
    return h * 60 + m;
  }

  /** Log a warning at most once per distinct key (malformed-config noise, L3/H1). */
  private logOnce(key: string, message: string): void {
    if (this.loggedOnce.has(key)) return;
    this.loggedOnce.add(key);
    this.logger.warn(message);
  }

  private newId(): string {
    return typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
}

/** "HH:MM" → minutes since midnight, or undefined when malformed. */
function parseHHMM(s: string): number | undefined {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return undefined;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return undefined;
  return h * 60 + min;
}

function escapeLiteral(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}
