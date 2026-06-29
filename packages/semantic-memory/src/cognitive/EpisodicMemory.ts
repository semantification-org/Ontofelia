/**
 * EpisodicMemory — episodic long-term memory over the `urn:<agent>:cog:episodic`
 * graph (docs/cognitive-architecture/05-episodic-memory.md).
 *
 * An episode is anything observable from the agent's first-person perspective
 * worth recalling: a message received, a tool called/completed, a response
 * sent, a goal pushed/resolved. Episodes are entity-linked and chained into a
 * temporal narrative via `cogt:precededBy`. Verbatim transcripts stay in the
 * JSONL session store; episodes refer to them by `cogt:transcriptRef`.
 *
 * Implementation notes mirror {@link WorkingMemory}:
 *  - Writes are typed SPARQL `INSERT DATA` so literal datatypes survive (the
 *    adapters drop them via insertTriples).
 *  - Ranking/ordering is done in TypeScript rather than via SPARQL aggregates,
 *    which the embedded Oxigraph WASM build cannot evaluate.
 */

import type { TriplestoreAdapter } from '@ontofelia/core';
import { GraphUriResolver } from '../utils/GraphUriResolver.js';

const COGT = 'urn:shared:ontology#cog/';
const CORE = 'urn:shared:ontology#';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const XSD = 'http://www.w3.org/2001/XMLSchema#';

/** Minimal per-episode facts the retention sweep classifies on. */
interface RetentionRecord {
  uri: string;
  occurredAt: string;
  privacyClass?: string;
  sessionId?: string;
  hasPayload: boolean;
}

export type EpisodeType =
  | 'message-received'
  | 'tool-called'
  | 'tool-completed'
  | 'response-sent'
  | 'goal-pushed'
  | 'goal-resolved'
  | 'goal-abandoned'
  | 'impasse-flagged'
  | 'meta-reflected'
  | 'consolidation-promoted'
  | (string & {});

export type EpisodeId = string;

export interface EpisodeInput {
  episodeType: EpisodeType;
  occurredAt?: Date;
  sessionId?: string;
  cycleId?: string;
  channel?: string;
  /** Entity IRI of who performed the episode (user or agent self). */
  actor?: string;
  /** Entity IRIs this episode is about. */
  about?: string[];
  /** Explicit predecessor; when omitted, append() chains to the session's last. */
  precededBy?: string;
  partOfGoal?: string;
  /** Message text or a redacted tool-args summary. Never raw secrets. */
  payload?: string;
  transcriptRef?: string;
  outcome?: 'success' | 'error' | 'partial';
  errorClass?: string;
  durationMs?: number;
  tags?: string[];
  /** Defaults per episode type when omitted. */
  salience?: number;
}

export interface EpisodeHit {
  uri: EpisodeId;
  episodeId: string;
  episodeType: EpisodeType;
  occurredAt: string;
  sessionId?: string;
  precededBy?: string;
  partOfGoal?: string;
  actor?: string;
  about: string[];
  payload?: string;
  transcriptRef?: string;
  outcome?: string;
  durationMs?: number;
  errorClass?: string;
  tags: string[];
  salience: number;
  /** Populated by retrieve(); 0 for plain reads. */
  relevanceScore: number;
}

export interface RetrieveOpts {
  /** Restrict the candidate set to one session. */
  sessionId?: string;
}

/**
 * Tier boundaries in days (doc 05 §7), measured from `occurredAt` to `now`.
 * Defaults reproduce the documented Hot/Warm/Cold/Frozen scheme. The retention
 * job loads these from `core:retentionPolicy` (`urn:shared:meta`) when present;
 * absent fields fall back to {@link DEFAULT_RETENTION_POLICY}.
 */
export interface RetentionPolicy {
  /** End of Hot / start of Warm. */
  warmAfterDays?: number;
  /** End of Warm / start of Cold. */
  coldAfterDays?: number;
  /** End of Cold / start of Frozen (hard delete to ids). */
  frozenAfterDays?: number;
  /** Secret-classed episodes go cold this many days after `occurredAt`. */
  secretColdAfterDays?: number;
}

export const DEFAULT_RETENTION_POLICY: Required<RetentionPolicy> = {
  warmAfterDays: 30,
  coldAfterDays: 90,
  frozenAfterDays: 365,
  secretColdAfterDays: 7,
};

export interface RetentionOptions {
  /**
   * When false (the default) `retentionTick` is a logged no-op that deletes
   * nothing — the C5 "reserve the seam" stub. Flipping this on enables real
   * tiering with no change to callers.
   */
  enabled?: boolean;
  /** Overrides the default tier boundaries (doc 05 §7). */
  policy?: RetentionPolicy;
}

export interface RetentionReport {
  now: string;
  scanned: number;
  /** Warm tier: episodes whose payload (rawText) was dropped. */
  warmed: number;
  /** Cold tier: episodes collapsed into per-day summaries. */
  summarized: number;
  /** Cold tier: `cogt:DailySummary` resources created this tick. */
  summariesCreated: number;
  /** Frozen tier: episodes hard-reduced to id-only. */
  frozen: number;
  /** Total episode resources removed (cold originals collapsed away). */
  deleted: number;
  /** Episodes demoted in place (warmed + frozen). */
  demoted: number;
  /** True when this tick performed no destructive work. */
  noop: boolean;
}

/** Per-episode-type default salience (doc 05 §3 / §10). */
const DEFAULT_SALIENCE: Record<string, number> = {
  'message-received': 0.6,
  'response-sent': 0.6,
  'tool-called': 0.4,
  'tool-completed': 0.5,
  'goal-pushed': 0.7,
  'goal-resolved': 0.7,
};

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function escapeLiteral(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

/** Cheap bag-of-words overlap in [0,1] (Jaccard over lowercased word sets). */
function textOverlap(a: string, b: string): number {
  const toks = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((t) => t.length > 2),
    );
  const sa = toks(a);
  const sb = toks(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

export class EpisodicMemory {
  constructor(
    private readonly triplestore: TriplestoreAdapter,
    private readonly agentId: string,
  ) {}

  graphUri(): string {
    return GraphUriResolver.getCogEpisodicGraph(this.agentId);
  }

  private newUri(): string {
    const rand =
      typeof globalThis.crypto?.randomUUID === 'function'
        ? globalThis.crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return `urn:${this.agentId}:cog:ep:${rand}`;
  }

  /**
   * Append an episode. When `precededBy` is not given and a `sessionId` is, the
   * episode is chained to the most recent episode of that session. Returns the
   * new episode's IRI.
   */
  async append(ep: EpisodeInput): Promise<EpisodeId> {
    const graph = this.graphUri();
    const uri = this.newUri();
    const occurredAt = (ep.occurredAt ?? new Date()).toISOString();

    let seq = 1;
    let precededBy = ep.precededBy;
    if (ep.sessionId) {
      const existing = await this.findInSession(ep.sessionId);
      seq = existing.length + 1;
      if (!precededBy && existing.length > 0) {
        // existing is newest-first; chain to the most recent.
        precededBy = existing[0].uri;
      }
    }
    const episodeId = `ep_${occurredAt.replace(/[:.]/g, '-')}_${String(seq).padStart(4, '0')}`;
    const salience = clamp01(ep.salience ?? DEFAULT_SALIENCE[ep.episodeType] ?? 0.5);

    const lines: string[] = [
      `<${uri}> <${RDF_TYPE}> <${COGT}Episode> .`,
      `<${uri}> <${COGT}episodeId> "${escapeLiteral(episodeId)}" .`,
      `<${uri}> <${COGT}episodeType> "${escapeLiteral(ep.episodeType)}" .`,
      `<${uri}> <${COGT}occurredAt> "${occurredAt}"^^<${XSD}dateTime> .`,
      `<${uri}> <${COGT}salience> "${salience}"^^<${XSD}decimal> .`,
    ];
    if (ep.sessionId) lines.push(`<${uri}> <${COGT}sessionId> "${escapeLiteral(ep.sessionId)}" .`);
    if (ep.cycleId) lines.push(`<${uri}> <${COGT}cycleId> "${escapeLiteral(ep.cycleId)}" .`);
    if (ep.channel) lines.push(`<${uri}> <${COGT}channel> "${escapeLiteral(ep.channel)}" .`);
    if (ep.actor) lines.push(`<${uri}> <${COGT}actor> <${ep.actor}> .`);
    for (const a of ep.about ?? []) lines.push(`<${uri}> <${COGT}about> <${a}> .`);
    if (precededBy) lines.push(`<${uri}> <${COGT}precededBy> <${precededBy}> .`);
    if (ep.partOfGoal) lines.push(`<${uri}> <${COGT}partOfGoal> <${ep.partOfGoal}> .`);
    if (ep.payload) lines.push(`<${uri}> <${COGT}payload> "${escapeLiteral(ep.payload)}" .`);
    if (ep.transcriptRef)
      lines.push(`<${uri}> <${COGT}transcriptRef> "${escapeLiteral(ep.transcriptRef)}" .`);
    if (ep.outcome) lines.push(`<${uri}> <${COGT}outcome> "${escapeLiteral(ep.outcome)}" .`);
    if (ep.errorClass)
      lines.push(`<${uri}> <${COGT}errorClass> "${escapeLiteral(ep.errorClass)}" .`);
    if (ep.durationMs !== undefined)
      lines.push(`<${uri}> <${COGT}durationMs> "${Math.trunc(ep.durationMs)}"^^<${XSD}integer> .`);
    for (const t of ep.tags ?? []) lines.push(`<${uri}> <${COGT}tags> "${escapeLiteral(t)}" .`);

    await this.triplestore.update(`INSERT DATA { GRAPH <${graph}> {\n${lines.join('\n')}\n} }`);
    return uri;
  }

  /**
   * Retrieve up to `k` episodes ranked by relevance to `query`, newest-first as
   * the tiebreak. Relevance blends text overlap with recency (1-week-ish
   * half-life). Returns `[]` (never throws) when there are no episodes.
   */
  async retrieve(query: string, k: number, opts: RetrieveOpts = {}): Promise<EpisodeHit[]> {
    const all = opts.sessionId ? await this.findInSession(opts.sessionId) : await this.readAll();
    if (all.length === 0) return [];

    const now = Date.now();
    const scored = all.map((e) => {
      const overlap = e.payload ? textOverlap(query, e.payload) : 0;
      const ageHours = (now - Date.parse(e.occurredAt)) / 3_600_000;
      const recency = Math.exp(-Math.max(0, ageHours) / 168);
      return { ...e, relevanceScore: overlap * 0.6 + recency * 0.4 };
    });
    scored.sort((a, b) => {
      if (b.relevanceScore !== a.relevanceScore) return b.relevanceScore - a.relevanceScore;
      return Date.parse(b.occurredAt) - Date.parse(a.occurredAt); // newest-first tiebreak
    });
    return scored.slice(0, Math.max(0, k));
  }

  /**
   * Walk the `cogt:precededBy` chain backwards from `fromUri`, returning the
   * episodes oldest-first (the start episode last). Capped at `max` hops.
   */
  async chainFrom(fromUri: EpisodeId, max = 50): Promise<EpisodeHit[]> {
    const out: EpisodeHit[] = [];
    let cursor: string | undefined = fromUri;
    const seen = new Set<string>();
    while (cursor && out.length < max && !seen.has(cursor)) {
      seen.add(cursor);
      const hit = await this.readOne(cursor);
      if (!hit) break;
      out.push(hit);
      cursor = hit.precededBy;
    }
    return out.reverse();
  }

  /** All episodes of a session, newest-first (by episodeId, which is sortable). */
  async findInSession(sessionId: string): Promise<EpisodeHit[]> {
    const hits = await this.runSelect(
      `?ep <${COGT}sessionId> "${escapeLiteral(sessionId)}" .`,
    );
    return hits.sort((a, b) => (a.episodeId < b.episodeId ? 1 : a.episodeId > b.episodeId ? -1 : 0));
  }

  /** Episodes referencing an entity IRI via cogt:about, newest-first. */
  async findByEntity(entity: string): Promise<EpisodeHit[]> {
    const hits = await this.runSelect(`?ep <${COGT}about> <${entity}> .`);
    return hits.sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt));
  }

  /**
   * Most-recent episodes, newest-first, sliced to `limit` (read-only; for UI
   * timelines). When `entity` is given, restricts to episodes referencing it
   * via cogt:about.
   */
  async recent(limit = 50, entity?: string): Promise<EpisodeHit[]> {
    const hits = entity ? await this.findByEntity(entity) : await this.readAll();
    return hits
      .sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt))
      .slice(0, Math.max(0, limit));
  }

  /**
   * Retention sweep (doc 05 §7). This is the C5 "reserve the seam" stub: the
   * tiering policy is documented here but no demotion or deletion happens yet.
   * Real tiering (rawText drop / daily summarisation / freeze to ids) is wired
   * up in Phase H alongside the scheduler, so by default this is a no-op that
   * leaves every episode untouched — it only reports what it scanned.
   *
   * Tiers, measured from `occurredAt` to `now`:
   *   - Hot    (0–30d)    keep the full episode (rawText, links, everything).
   *   - Warm   (30–90d)   drop rawText/payload; keep entity links + salience.
   *   - Cold   (90–365d)  collapse a session-day into one summary episode.
   *   - Frozen (>365d)    retain ids + chain only; everything else summarised.
   */
  async retentionTick(now: Date = new Date(), opts: RetentionOptions = {}): Promise<RetentionReport> {
    const records = await this.readForRetention();
    const report: RetentionReport = {
      now: now.toISOString(),
      scanned: records.length,
      warmed: 0,
      summarized: 0,
      summariesCreated: 0,
      frozen: 0,
      deleted: 0,
      demoted: 0,
      noop: true,
    };
    if (!opts.enabled) return report;
    report.noop = false;

    const pol = { ...DEFAULT_RETENTION_POLICY, ...(opts.policy ?? {}) };
    const DAY_MS = 86_400_000;

    // Cold episodes are collapsed per (session, calendar-day) into one summary.
    const coldGroups = new Map<string, RetentionRecord[]>();

    for (const r of records) {
      const ts = Date.parse(r.occurredAt);
      if (Number.isNaN(ts)) continue;
      const ageDays = (now.getTime() - ts) / DAY_MS;
      if (ageDays < 0) continue;

      // Secret-classed episodes go cold early regardless of normal Warm window.
      const secret = r.privacyClass === 'secret';
      const coldThreshold = secret
        ? Math.min(pol.secretColdAfterDays, pol.coldAfterDays)
        : pol.coldAfterDays;

      if (ageDays > pol.frozenAfterDays) {
        await this.freezeEpisode(r.uri);
        report.frozen++;
        report.demoted++;
      } else if (ageDays >= coldThreshold) {
        const day = r.occurredAt.slice(0, 10);
        const key = `${r.sessionId ?? 'nosession'}|${day}`;
        const bucket = coldGroups.get(key);
        if (bucket) bucket.push(r);
        else coldGroups.set(key, [r]);
      } else if (ageDays >= pol.warmAfterDays) {
        if (r.hasPayload) {
          await this.dropPayload(r.uri);
          report.warmed++;
          report.demoted++;
        }
      }
      // Hot tier (younger than warmAfterDays): left untouched.
    }

    for (const [key, group] of coldGroups) {
      await this.collapseToDailySummary(key, group, now);
      report.summariesCreated++;
      report.summarized += group.length;
      report.deleted += group.length;
    }

    return report;
  }

  /**
   * Read the minimal per-episode facts the retention sweep needs. Skips episodes
   * already reduced to Frozen (they carry `cogt:frozen` and lack `occurredAt`),
   * which keeps the sweep idempotent.
   */
  private async readForRetention(): Promise<RetentionRecord[]> {
    const graph = this.graphUri();
    const res = await this.triplestore.query(`
      SELECT ?ep ?when ?privacy ?sessionId ?payload WHERE {
        GRAPH <${graph}> {
          ?ep a <${COGT}Episode> ; <${COGT}occurredAt> ?when .
          OPTIONAL { ?ep <${CORE}privacyClass> ?privacy . }
          OPTIONAL { ?ep <${COGT}sessionId>     ?sessionId . }
          OPTIONAL { ?ep <${COGT}payload>       ?payload . }
          FILTER NOT EXISTS { ?ep <${COGT}frozen> ?f . }
        }
      }`);
    return (res.bindings ?? []).map((r) => ({
      uri: r.ep.value,
      occurredAt: r.when.value,
      privacyClass: r.privacy?.value,
      sessionId: r.sessionId?.value,
      hasPayload: r.payload !== undefined,
    }));
  }

  /** Warm tier: drop the verbatim payload (rawText); transcriptRef is kept. */
  private async dropPayload(uri: string): Promise<void> {
    const graph = this.graphUri();
    await this.triplestore.update(`
      DELETE { GRAPH <${graph}> { <${uri}> <${COGT}payload> ?o } }
      WHERE  { GRAPH <${graph}> { <${uri}> <${COGT}payload> ?o } }`);
  }

  /**
   * Frozen tier: hard-delete everything but the episode id, leaving an id-only
   * tombstone marked `cogt:frozen`. The tombstone no longer satisfies the
   * retrieval/retention queries (which require `occurredAt`), so it is inert.
   */
  private async freezeEpisode(uri: string): Promise<void> {
    const graph = this.graphUri();
    await this.triplestore.update(`
      DELETE { GRAPH <${graph}> { <${uri}> ?p ?o } }
      WHERE  {
        GRAPH <${graph}> {
          <${uri}> ?p ?o .
          FILTER(?p != <${COGT}episodeId>)
        }
      }`);
    await this.triplestore.update(`
      INSERT DATA { GRAPH <${graph}> {
        <${uri}> <${RDF_TYPE}> <${COGT}Episode> .
        <${uri}> <${COGT}frozen> "true"^^<${XSD}boolean> .
      } }`);
  }

  /**
   * Cold tier: collapse a (session, day) bucket of episodes into a single
   * `cogt:DailySummary` resource, then hard-delete the originals. The summary
   * keeps the day, session, episode count and the union of linked entities.
   */
  private async collapseToDailySummary(
    key: string,
    group: RetentionRecord[],
    now: Date,
  ): Promise<void> {
    const graph = this.graphUri();
    const [sessionId, day] = key.split('|');
    const summaryUri = `urn:${this.agentId}:cog:summary:${day}:${this.newUri().split(':').pop()}`;

    // Union of the entities the collapsed episodes were about.
    const about = new Set<string>();
    for (const r of group) {
      const res = await this.triplestore.query(`
        SELECT ?a WHERE { GRAPH <${graph}> { <${r.uri}> <${COGT}about> ?a } }`);
      for (const b of res.bindings ?? []) about.add(b.a.value);
    }

    const lines: string[] = [
      `<${summaryUri}> <${RDF_TYPE}> <${COGT}DailySummary> .`,
      `<${summaryUri}> <${COGT}summaryDate> "${day}"^^<${XSD}date> .`,
      `<${summaryUri}> <${COGT}episodeCount> "${group.length}"^^<${XSD}integer> .`,
      `<${summaryUri}> <${COGT}createdAt> "${now.toISOString()}"^^<${XSD}dateTime> .`,
    ];
    if (sessionId && sessionId !== 'nosession')
      lines.push(`<${summaryUri}> <${COGT}sessionId> "${escapeLiteral(sessionId)}" .`);
    for (const a of about) lines.push(`<${summaryUri}> <${COGT}about> <${a}> .`);

    await this.triplestore.update(`INSERT DATA { GRAPH <${graph}> {\n${lines.join('\n')}\n} }`);

    for (const r of group) {
      await this.triplestore.update(`
        DELETE { GRAPH <${graph}> { <${r.uri}> ?p ?o } }
        WHERE  { GRAPH <${graph}> { <${r.uri}> ?p ?o } }`);
    }
  }

  private async readAll(): Promise<EpisodeHit[]> {
    return this.runSelect('');
  }

  private async readOne(uri: string): Promise<EpisodeHit | undefined> {
    const hits = await this.runSelect(`VALUES ?ep { <${uri}> }`);
    return hits[0];
  }

  private async runSelect(constraint: string): Promise<EpisodeHit[]> {
    const graph = this.graphUri();
    const sparql = `
      SELECT ?ep ?episodeId ?type ?when ?salience ?sessionId ?precededBy ?partOfGoal
             ?actor ?payload ?transcriptRef ?outcome ?durationMs ?errorClass
      WHERE {
        GRAPH <${graph}> {
          ?ep a <${COGT}Episode> ;
              <${COGT}episodeId>   ?episodeId ;
              <${COGT}episodeType> ?type ;
              <${COGT}occurredAt>  ?when ;
              <${COGT}salience>    ?salience .
          ${constraint}
          OPTIONAL { ?ep <${COGT}sessionId>     ?sessionId . }
          OPTIONAL { ?ep <${COGT}precededBy>    ?precededBy . }
          OPTIONAL { ?ep <${COGT}partOfGoal>    ?partOfGoal . }
          OPTIONAL { ?ep <${COGT}actor>         ?actor . }
          OPTIONAL { ?ep <${COGT}payload>       ?payload . }
          OPTIONAL { ?ep <${COGT}transcriptRef> ?transcriptRef . }
          OPTIONAL { ?ep <${COGT}outcome>       ?outcome . }
          OPTIONAL { ?ep <${COGT}durationMs>    ?durationMs . }
          OPTIONAL { ?ep <${COGT}errorClass>    ?errorClass . }
        }
      }`;
    const res = await this.triplestore.query(sparql);
    const rows = res.bindings ?? [];

    // `about` and `tags` are multi-valued; fetch them in a second pass and group.
    const about = await this.multiValued(`<${COGT}about>`, true);
    const tags = await this.multiValued(`<${COGT}tags>`, false);

    return rows.map((r) => {
      const uri = r.ep.value;
      const hit: EpisodeHit = {
        uri,
        episodeId: r.episodeId.value,
        episodeType: r.type.value,
        occurredAt: r.when.value,
        salience: Number(r.salience.value),
        about: about.get(uri) ?? [],
        tags: tags.get(uri) ?? [],
        relevanceScore: 0,
      };
      if (r.sessionId) hit.sessionId = r.sessionId.value;
      if (r.precededBy) hit.precededBy = r.precededBy.value;
      if (r.partOfGoal) hit.partOfGoal = r.partOfGoal.value;
      if (r.actor) hit.actor = r.actor.value;
      if (r.payload) hit.payload = r.payload.value;
      if (r.transcriptRef) hit.transcriptRef = r.transcriptRef.value;
      if (r.outcome) hit.outcome = r.outcome.value;
      if (r.durationMs) hit.durationMs = Number(r.durationMs.value);
      if (r.errorClass) hit.errorClass = r.errorClass.value;
      return hit;
    });
  }

  private async multiValued(predicate: string, isIri: boolean): Promise<Map<string, string[]>> {
    const graph = this.graphUri();
    const res = await this.triplestore.query(`
      SELECT ?ep ?v WHERE {
        GRAPH <${graph}> { ?ep a <${COGT}Episode> ; ${predicate} ?v }
      }`);
    const map = new Map<string, string[]>();
    for (const r of res.bindings ?? []) {
      const key = r.ep.value;
      const val = r.v.value;
      const arr = map.get(key) ?? [];
      arr.push(isIri ? val : val);
      map.set(key, arr);
    }
    return map;
  }
}
