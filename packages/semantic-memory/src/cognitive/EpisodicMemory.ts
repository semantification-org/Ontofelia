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

import { ALL_USERS_SCOPE, OWNER_USER_KEY, type TriplestoreAdapter } from '@ontofelia/core';
import { GraphUriResolver } from '../utils/GraphUriResolver.js';
import { escapeSparqlStringContent, sparqlIri, sparqlStringLiteral } from '../utils/SparqlSyntax.js';

const COGT = 'urn:shared:ontology#cog/';
const CORE = 'urn:shared:ontology#';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const XSD = 'http://www.w3.org/2001/XMLSchema#';

/** Episodes per VALUES block when fetching multi-valued properties. */
const MULTI_VALUE_CHUNK = 200;

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

/**
 * Whose episodes a read may return: a user key (the id of the per-user graph,
 * `urn:<agent>:user:<id>`) or the explicit {@link ALL_USERS_SCOPE} (`"all"`),
 * which only owner/operator code paths may pass.
 *
 * Every episode carries `cogt:forUser`, the sender's user key. A scoped read
 * returns exactly the episodes whose `forUser` equals the scope. Episodes
 * written before the key existed carry no `forUser` and are treated as
 * owner-only: they are returned for the owner's key and for `"all"`, never for
 * another user.
 */
export type UserScope = string;

export interface EpisodeInput {
  episodeType: EpisodeType;
  occurredAt?: Date;
  sessionId?: string;
  cycleId?: string;
  channel?: string;
  /** Entity IRI of who performed the episode (user or agent self). */
  actor?: string;
  /**
   * The actor was the verified owner of a live conversation when this episode
   * was written. Persisted as `cogt:actorIsOwner` only when true; an absent
   * marker means "not known to be the owner" (also for older episodes).
   */
  actorIsOwner?: boolean;
  /**
   * The sender's user key (`cogt:forUser`). Initiative and system episodes carry
   * the owner's key. Absent only on episodes written before the key existed;
   * those are owner-only on read (see {@link UserScope}).
   */
  forUser?: string;
  /**
   * Privacy class (`core:privacyClass`), e.g. `"secret"`: the retention sweep
   * moves secret-classed episodes to the cold tier early.
   */
  privacyClass?: 'secret';
  /** Entity IRIs this episode is about. */
  about?: string[];
  /** IRIs of the claims stored from this episode's message (`cogt:hasClaim`). */
  hasClaim?: string[];
  /**
   * The episode's session is untrusted (test or dry-run). Persisted as
   * `cogt:sessionUntrusted` only when true; the episodic consolidation never
   * counts an episode of such a session.
   */
  sessionUntrusted?: boolean;
  /**
   * IRI of the graph the sender's own facts go to (`urn:<agent>:user:<id>`, the
   * ingestion routing by sender id), recorded at write time as `cogt:factGraph`.
   * The episodic consolidation promotes into exactly this graph; an episode
   * without it is never promoted from.
   */
  factGraph?: string;
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
  /** The sender's user key; absent on legacy episodes (owner-only). */
  forUser?: string;
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

/** Slim record of an episode that stored claims, for the episodic consolidation. */
export interface ClaimEpisode {
  uri: EpisodeId;
  occurredAt: string;
  sessionId?: string;
  transcriptRef?: string;
  /** Claim IRIs the episode stored (`cogt:hasClaim`). */
  claims: string[];
  /** The episode itself carries `core:privacyClass "secret"`. */
  secret: boolean;
  /** The episode itself is flagged `cogt:sessionUntrusted`. */
  untrusted: boolean;
  /** The sender's fact graph recorded on the episode (`cogt:factGraph`); absent on legacy episodes. */
  factGraph?: string;
}

/** Tag prefix of a `consolidation-promoted` episode: the promotion's claim hash. */
export const CLAIM_HASH_TAG = 'claim-hash:';

/** Fail closed on a missing scope (JS callers, casts): never read unscoped. */
function assertScope(userScope: UserScope): void {
  if (typeof userScope !== 'string' || userScope === '') {
    throw new Error('EpisodicMemory: a userScope (user key or "all") is required');
  }
}

/** Is the episode inside the scope? Legacy episodes (no forUser) are owner-only. */
function inScope(hit: { forUser?: string }, userScope: UserScope): boolean {
  if (userScope === ALL_USERS_SCOPE) return true;
  if (hit.forUser === undefined) return userScope === OWNER_USER_KEY;
  return hit.forUser === userScope;
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
  return escapeSparqlStringContent(s);
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
    const tail = ep.sessionId ? await this.sessionTail(ep.sessionId) : undefined;
    const built = this.build(ep, tail);
    await this.triplestore.update(built.update);
    return built.uri;
  }

  /**
   * Build the INSERT for one episode. `tail` is the session's chain state read
   * just before (absent without a session id); it is the only input besides the
   * episode itself, so a batch can thread it through in memory.
   */
  private build(
    ep: EpisodeInput,
    tail?: { count: number; latestUri?: string; latestId?: string },
  ): { uri: EpisodeId; episodeId: string; update: string; lines: string[] } {
    const graph = this.graphUri();
    const uri = this.newUri();
    const occurredAt = (ep.occurredAt ?? new Date()).toISOString();

    let seq = 1;
    let precededBy = ep.precededBy;
    if (ep.sessionId && tail) {
      // Internal: the chain and the sequence number span the whole session,
      // whoever spoke (a group session has several senders).
      seq = tail.count + 1;
      if (!precededBy && tail.latestUri) {
        // Chain to the most recent episode of the session.
        precededBy = tail.latestUri;
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
    if (ep.actor) lines.push(`<${uri}> <${COGT}actor> ${sparqlIri(ep.actor)} .`);
    if (ep.actorIsOwner === true) lines.push(`<${uri}> <${COGT}actorIsOwner> "true"^^<${XSD}boolean> .`);
    if (ep.forUser !== undefined && ep.forUser !== '')
      lines.push(`<${uri}> <${COGT}forUser> "${escapeLiteral(ep.forUser)}" .`);
    if (ep.privacyClass === 'secret')
      lines.push(`<${uri}> <${CORE}privacyClass> "secret" .`);
    for (const a of ep.about ?? []) lines.push(`<${uri}> <${COGT}about> ${sparqlIri(a)} .`);
    for (const c of ep.hasClaim ?? []) lines.push(`<${uri}> <${COGT}hasClaim> ${sparqlIri(c)} .`);
    if (ep.factGraph) lines.push(`<${uri}> <${COGT}factGraph> ${sparqlIri(ep.factGraph)} .`);
    if (ep.sessionUntrusted === true)
      lines.push(`<${uri}> <${COGT}sessionUntrusted> "true"^^<${XSD}boolean> .`);
    if (precededBy) lines.push(`<${uri}> <${COGT}precededBy> ${sparqlIri(precededBy)} .`);
    if (ep.partOfGoal) lines.push(`<${uri}> <${COGT}partOfGoal> ${sparqlIri(ep.partOfGoal)} .`);
    if (ep.payload) lines.push(`<${uri}> <${COGT}payload> "${escapeLiteral(ep.payload)}" .`);
    if (ep.transcriptRef)
      lines.push(`<${uri}> <${COGT}transcriptRef> "${escapeLiteral(ep.transcriptRef)}" .`);
    if (ep.outcome) lines.push(`<${uri}> <${COGT}outcome> "${escapeLiteral(ep.outcome)}" .`);
    if (ep.errorClass)
      lines.push(`<${uri}> <${COGT}errorClass> "${escapeLiteral(ep.errorClass)}" .`);
    if (ep.durationMs !== undefined)
      lines.push(`<${uri}> <${COGT}durationMs> "${Math.trunc(ep.durationMs)}"^^<${XSD}integer> .`);
    for (const t of ep.tags ?? []) lines.push(`<${uri}> <${COGT}tags> "${escapeLiteral(t)}" .`);

    return { uri, episodeId, lines, update: `INSERT DATA { GRAPH <${graph}> {\n${lines.join('\n')}\n} }` };
  }

  /**
   * Prepare a batch of episodes for ONE update. The session chain is read once
   * (per session id) and threaded through in memory, so the stored episodes are
   * exactly those that appending them one by one in this order would store:
   * the same sequence numbers, the same `precededBy` links (each episode chains
   * to the greatest episode id so far, including the batch's own earlier
   * episodes). The read happens here; nothing is written until `commit()`, so
   * several writers can read first and then issue their writes together.
   *
   * An input that cannot be built (an unsafe IRI) is skipped; the others are
   * kept. If the combined update fails, `commit`
   * falls back to one update per episode (the inserts are idempotent, the
   * episodes already carry their final IRIs) so a failure is reported for the
   * episode that caused it and the others are still stored.
   *
   * With `onError` every failure (a skipped input, a failed insert) is reported
   * through it, one call per failed episode, and `commit` does not throw; without
   * it `commit` throws the first failure.
   */
  async prepareAppendMany(
    inputs: EpisodeInput[],
    onError?: (e: unknown) => void,
  ): Promise<{ uris: EpisodeId[]; commit: () => Promise<void> }> {
    const tails = new Map<string, { count: number; latestUri?: string; latestId: string }>();
    const built: Array<{ uri: EpisodeId; update: string; lines: string[] }> = [];
    for (const ep of inputs) {
      try {
        let tail: { count: number; latestUri?: string; latestId: string } | undefined;
        if (ep.sessionId) {
          tail = tails.get(ep.sessionId);
          if (!tail) {
            const t = await this.sessionTail(ep.sessionId);
            tail = { count: t.count, latestUri: t.latestUri, latestId: t.latestId ?? '' };
            tails.set(ep.sessionId, tail);
          }
        }
        const b = this.build(ep, tail);
        built.push(b);
        if (tail) {
          // The same state a re-read after this append would give.
          tail.count += 1;
          if (tail.latestUri === undefined || b.episodeId > tail.latestId) {
            tail.latestId = b.episodeId;
            tail.latestUri = b.uri;
          }
        }
      } catch (e) {
        if (onError) onError(e);
        else throw e;
      }
    }
    const graph = this.graphUri();
    const commit = async (): Promise<void> => {
      if (built.length === 0) return;
      try {
        await this.triplestore.update(
          `INSERT DATA { GRAPH <${graph}> {\n${built.map((b) => b.lines.join('\n')).join('\n')}\n} }`,
        );
      } catch (batchError) {
        if (built.length === 1) {
          if (onError) onError(batchError);
          else throw batchError;
          return;
        }
        const failures: unknown[] = [];
        await Promise.all(
          built.map((b) =>
            this.triplestore.update(b.update).catch((e) => {
              failures.push(e);
            }),
          ),
        );
        if (!onError && failures.length > 0) throw failures[0];
        for (const f of failures) onError?.(f);
      }
    };
    return { uris: built.map((b) => b.uri), commit };
  }

  /**
   * Add `cogt:about` links to an existing episode. Append-only: nothing already
   * stored is changed or removed, and an IRI the episode already has is simply
   * stated again (a set of triples, so no duplicate arises).
   */
  async addAbout(episodeUri: EpisodeId, about: string[]): Promise<void> {
    if (about.length === 0) return;
    const lines = about.map((a) => `<${episodeUri}> <${COGT}about> ${sparqlIri(a)} .`);
    await this.triplestore.update(`INSERT DATA { GRAPH <${this.graphUri()}> {\n${lines.join('\n')}\n} }`);
  }

  /**
   * The size of a session's episode chain and its newest episode, from a query
   * that selects only the two columns needed (no payloads, no `about`/`tags`).
   * "Newest" follows {@link findInSession}: the greatest `episodeId`.
   */
  private async sessionTail(sessionId: string): Promise<{ count: number; latestUri?: string; latestId?: string }> {
    const graph = this.graphUri();
    const res = await this.triplestore.query(`
      SELECT ?ep ?episodeId WHERE {
        GRAPH <${graph}> {
          ?ep <${COGT}sessionId> "${escapeLiteral(sessionId)}" .
          ?ep a <${COGT}Episode> ;
              <${COGT}episodeId>   ?episodeId ;
              <${COGT}episodeType> ?type ;
              <${COGT}occurredAt>  ?when ;
              <${COGT}salience>    ?salience .
        }
      }`);
    let latestUri: string | undefined;
    let latestId = '';
    let count = 0;
    for (const r of res.bindings ?? []) {
      count++;
      const id = r.episodeId.value;
      if (latestUri === undefined || id > latestId) {
        latestId = id;
        latestUri = r.ep.value;
      }
    }
    return { count, latestUri, latestId };
  }

  /**
   * Retrieve up to `k` episodes ranked by relevance to `query`, newest-first as
   * the tiebreak. Relevance blends text overlap with recency (1-week-ish
   * half-life). Returns `[]` when there are no episodes in `userScope`; throws
   * only when `userScope` is missing.
   */
  async retrieve(
    query: string,
    k: number,
    userScope: UserScope,
    opts: RetrieveOpts = {},
  ): Promise<EpisodeHit[]> {
    assertScope(userScope);
    const all = opts.sessionId
      ? await this.findInSession(opts.sessionId, userScope)
      : await this.readAll(userScope);
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
   * episodes oldest-first (the start episode last). Capped at `max` hops. The
   * walk stops at the first episode outside `userScope`, so a scoped chain never
   * crosses into another user's episodes.
   */
  async chainFrom(fromUri: EpisodeId, userScope: UserScope, max = 50): Promise<EpisodeHit[]> {
    assertScope(userScope);
    const out: EpisodeHit[] = [];
    let cursor: string | undefined = fromUri;
    const seen = new Set<string>();
    while (cursor && out.length < max && !seen.has(cursor)) {
      seen.add(cursor);
      const hit = await this.readOne(cursor);
      if (!hit || !inScope(hit, userScope)) break;
      out.push(hit);
      cursor = hit.precededBy;
    }
    return out.reverse();
  }

  /** All episodes of a session, newest-first (by episodeId, which is sortable). */
  async findInSession(sessionId: string, userScope: UserScope): Promise<EpisodeHit[]> {
    assertScope(userScope);
    const hits = await this.runSelect(
      `?ep <${COGT}sessionId> "${escapeLiteral(sessionId)}" .`,
      userScope,
    );
    return hits.sort((a, b) => (a.episodeId < b.episodeId ? 1 : a.episodeId > b.episodeId ? -1 : 0));
  }

  /**
   * Episodes referencing an entity IRI via cogt:about, newest-first. With
   * `opts.limit` only the newest `limit` episodes inside the scope are loaded in
   * full (see {@link runSelectNewest}); without it every one is.
   */
  async findByEntity(entity: string, userScope: UserScope, opts: { limit?: number } = {}): Promise<EpisodeHit[]> {
    assertScope(userScope);
    const constraint = `?ep <${COGT}about> ${sparqlIri(entity)} .`;
    if (opts.limit !== undefined) return this.runSelectNewest(constraint, userScope, opts.limit);
    const hits = await this.runSelect(constraint, userScope);
    return hits.sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt));
  }

  /** Episodes that are part of a goal (`cogt:partOfGoal`), newest-first. */
  async findByGoal(goal: string, userScope: UserScope, opts: { limit?: number } = {}): Promise<EpisodeHit[]> {
    assertScope(userScope);
    const constraint = `?ep <${COGT}partOfGoal> ${sparqlIri(goal)} .`;
    if (opts.limit !== undefined) return this.runSelectNewest(constraint, userScope, opts.limit);
    const hits = await this.runSelect(constraint, userScope);
    return hits.sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt));
  }

  /**
   * Most-recent episodes, newest-first, sliced to `limit` (read-only; for UI
   * timelines). When `entity` is given, restricts to episodes referencing it
   * via cogt:about.
   */
  async recent(userScope: UserScope, limit = 50, entity?: string): Promise<EpisodeHit[]> {
    assertScope(userScope);
    const hits = entity ? await this.findByEntity(entity, userScope) : await this.readAll(userScope);
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

  private async readAll(userScope: UserScope): Promise<EpisodeHit[]> {
    return this.runSelect('', userScope);
  }

  /** One episode by IRI, unscoped: callers check {@link inScope} themselves. */
  private async readOne(uri: string): Promise<EpisodeHit | undefined> {
    let iri: string;
    try {
      iri = sparqlIri(uri);
    } catch {
      return undefined; // not an IRI: no such episode
    }
    const hits = await this.runSelect(`VALUES ?ep { ${iri} }`, ALL_USERS_SCOPE);
    return hits[0];
  }

  /**
   * Delete every episode written for `userId` (their `cogt:forUser`) and keep
   * the `cogt:precededBy` chain consistent: a surviving episode that pointed at
   * a deleted one is re-linked to the nearest surviving predecessor, or loses
   * the link when there is none. Returns the counts.
   *
   * The matching is done on the values read back from the store (never by
   * interpolating `userId` into a query), and the deletes address episodes by
   * validated IRI. Only the episode resources go; legacy episodes without a
   * `forUser`, other users' episodes and daily summaries are untouched. The
   * owner's key and the all-users scope are refused here: erasing the owner's
   * record is not a user deletion.
   */
  async deleteForUser(userId: string): Promise<{ deleted: number; relinked: number }> {
    if (typeof userId !== 'string' || userId === '' || userId === ALL_USERS_SCOPE) {
      throw new Error('EpisodicMemory.deleteForUser: a concrete user key is required');
    }
    if (userId === OWNER_USER_KEY) {
      throw new Error('EpisodicMemory.deleteForUser: refusing to delete the owner\'s episodes');
    }
    const graph = this.graphUri();
    const res = await this.triplestore.query(`
      SELECT ?ep ?forUser ?precededBy WHERE {
        GRAPH <${graph}> {
          ?ep a <${COGT}Episode> .
          OPTIONAL { ?ep <${COGT}forUser>    ?forUser . }
          OPTIONAL { ?ep <${COGT}precededBy> ?precededBy . }
        }
      }`);
    const prev = new Map<string, string | undefined>();
    const doomed = new Set<string>();
    for (const r of res.bindings ?? []) {
      prev.set(r.ep.value, r.precededBy?.value);
      if (r.forUser?.value === userId) doomed.add(r.ep.value);
    }
    if (doomed.size === 0) return { deleted: 0, relinked: 0 };

    // Re-link survivors whose predecessor is going away.
    let relinked = 0;
    for (const [ep, p] of prev) {
      if (doomed.has(ep) || p === undefined || !doomed.has(p)) continue;
      let cursor: string | undefined = p;
      const seen = new Set<string>();
      while (cursor !== undefined && doomed.has(cursor) && !seen.has(cursor)) {
        seen.add(cursor);
        cursor = prev.get(cursor);
      }
      const survivor = cursor !== undefined && !doomed.has(cursor) ? cursor : undefined;
      const epIri = sparqlIri(ep);
      await this.triplestore.update(`
        DELETE { GRAPH <${graph}> { ${epIri} <${COGT}precededBy> ?old } }
        WHERE  { GRAPH <${graph}> { ${epIri} <${COGT}precededBy> ?old } }`);
      if (survivor !== undefined) {
        await this.triplestore.update(
          `INSERT DATA { GRAPH <${graph}> { ${epIri} <${COGT}precededBy> ${sparqlIri(survivor)} . } }`,
        );
      }
      relinked++;
    }

    for (const ep of doomed) {
      const epIri = sparqlIri(ep);
      await this.triplestore.update(`
        DELETE { GRAPH <${graph}> { ${epIri} ?p ?o } }
        WHERE  { GRAPH <${graph}> { ${epIri} ?p ?o } }`);
    }
    return { deleted: doomed.size, relinked };
  }

  /**
   * The newest `limit` episodes inside `userScope` that satisfy `constraint`,
   * newest first. A first query reads only what is needed to choose (IRI and
   * time), ordered and limited by the store; the full record (payload, links,
   * tags) is then loaded for the chosen episodes only. For a heavily linked
   * entity this reads a few dozen records in full instead of thousands.
   *
   * The scope narrows the first query so the limit applies inside it: a concrete
   * user key matches `cogt:forUser` exactly (the key is written as an escaped
   * literal, see {@link sparqlStringLiteral}); the owner's key also takes the
   * legacy episodes without a user key (owner-only by rule); the all-users scope
   * is not narrowed. The scope is then applied again to the full records, as in
   * {@link runSelect}, so the narrowing can only ever lose episodes, never add
   * one from outside the scope.
   */
  private async runSelectNewest(constraint: string, userScope: UserScope, limit: number): Promise<EpisodeHit[]> {
    const n = Math.max(0, Math.trunc(limit));
    if (n === 0) return [];
    const graph = this.graphUri();
    const pick = async (scopePattern: string): Promise<Array<{ uri: string; t: number }>> => {
      const res = await this.triplestore.query(`
        SELECT ?ep ?when WHERE {
          GRAPH <${graph}> {
            ${constraint}
            ${scopePattern}
            ?ep <${COGT}occurredAt> ?when .
            ?ep a <${COGT}Episode> .
          }
        } ORDER BY DESC(?when) ?ep LIMIT ${n}`);
      return (res.bindings ?? []).map((r) => ({ uri: r.ep.value, t: Date.parse(r.when.value) }));
    };
    const key = sparqlStringLiteral(userScope === ALL_USERS_SCOPE ? '' : userScope);
    let found: Array<{ uri: string; t: number }>;
    if (userScope === ALL_USERS_SCOPE) {
      found = await pick('');
    } else if (userScope === OWNER_USER_KEY) {
      found = [
        ...(await pick(`?ep <${COGT}forUser> ${key} .`)),
        ...(await pick(`FILTER NOT EXISTS { ?ep <${COGT}forUser> ?anyUser . }`)),
      ];
    } else {
      found = await pick(`?ep <${COGT}forUser> ${key} .`);
    }
    const chosen = [...new Map(found.map((f) => [f.uri, f])).values()]
      .sort((a, b) => (b.t || 0) - (a.t || 0) || (a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0))
      .slice(0, n);
    if (chosen.length === 0) return [];
    const values = chosen.map((c) => sparqlIri(c.uri)).join(' ');
    const hits = await this.runSelect(`VALUES ?ep { ${values} }`, userScope);
    return hits.sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt));
  }

  /**
   * The user keys that have episodes with stored claims, at most `limit`. An
   * episode without a `forUser` (written before the key existed) counts for the
   * owner. Only the keys are returned; no episode content leaves this method.
   */
  async usersWithClaimEpisodes(limit = 200): Promise<string[]> {
    const res = await this.triplestore.query(`
      SELECT DISTINCT ?u WHERE {
        GRAPH <${this.graphUri()}> {
          ?ep a <${COGT}Episode> ;
              <${COGT}hasClaim> ?c .
          OPTIONAL { ?ep <${COGT}forUser> ?u . }
        }
      }`);
    const keys = new Set<string>();
    for (const r of res.bindings ?? []) keys.add(r.u?.value ?? OWNER_USER_KEY);
    return [...keys].sort().slice(0, Math.max(0, Math.trunc(limit)));
  }

  /**
   * The newest `limit` episodes of one user that stored claims, with the fields
   * the consolidation needs and nothing else (no payload). `userScope` must be a
   * concrete user key: the all-users scope is refused, so a read here can never
   * mix users. Episodes of the `consolidation-promoted` type are left out (they
   * link the claim they minted and must not count as evidence for it).
   * Also returns the sessions flagged untrusted by any episode.
   */
  async claimEpisodes(
    userScope: UserScope,
    limit: number,
  ): Promise<{ episodes: ClaimEpisode[]; untrustedSessions: Set<string> }> {
    assertScope(userScope);
    if (userScope === ALL_USERS_SCOPE) {
      throw new Error('EpisodicMemory.claimEpisodes: a concrete user key is required');
    }
    const n = Math.max(0, Math.trunc(limit));
    const graph = this.graphUri();
    const key = sparqlStringLiteral(userScope);
    const pick = async (scopePattern: string): Promise<string[]> => {
      const res = await this.triplestore.query(`
        SELECT DISTINCT ?ep ?when WHERE {
          GRAPH <${graph}> {
            ?ep a <${COGT}Episode> ;
                <${COGT}episodeType> ?type ;
                <${COGT}occurredAt> ?when ;
                <${COGT}hasClaim> ?c .
            ${scopePattern}
            FILTER (?type != "consolidation-promoted")
          }
        } ORDER BY DESC(?when) ?ep LIMIT ${n}`);
      return (res.bindings ?? []).map((r) => r.ep.value);
    };
    const uris = new Set<string>(await pick(`?ep <${COGT}forUser> ${key} .`));
    if (userScope === OWNER_USER_KEY) {
      for (const u of await pick(`FILTER NOT EXISTS { ?ep <${COGT}forUser> ?anyUser . }`)) uris.add(u);
    }
    const episodes: ClaimEpisode[] = [];
    const list = [...uris];
    for (let i = 0; i < list.length; i += MULTI_VALUE_CHUNK) {
      const chunk = list.slice(i, i + MULTI_VALUE_CHUNK).map((u) => sparqlIri(u));
      const res = await this.triplestore.query(`
        SELECT ?ep ?when ?forUser ?sessionId ?transcriptRef ?privacy ?untrusted ?factGraph WHERE {
          GRAPH <${graph}> {
            VALUES ?ep { ${chunk.join(' ')} }
            ?ep <${COGT}occurredAt> ?when .
            OPTIONAL { ?ep <${COGT}forUser> ?forUser . }
            OPTIONAL { ?ep <${COGT}sessionId> ?sessionId . }
            OPTIONAL { ?ep <${COGT}transcriptRef> ?transcriptRef . }
            OPTIONAL { ?ep <${CORE}privacyClass> ?privacy . }
            OPTIONAL { ?ep <${COGT}sessionUntrusted> ?untrusted . }
            OPTIONAL { ?ep <${COGT}factGraph> ?factGraph . }
          }
        }`);
      const claims = await this.multiValued(`<${COGT}hasClaim>`, list.slice(i, i + MULTI_VALUE_CHUNK));
      const seen = new Set<string>();
      for (const r of res.bindings ?? []) {
        const uri = r.ep.value;
        // Re-check the scope on the values read back, as runSelect does.
        if (!inScope({ forUser: r.forUser?.value }, userScope)) continue;
        if (seen.has(uri)) continue;
        seen.add(uri);
        const rec: ClaimEpisode = {
          uri,
          occurredAt: r.when.value,
          claims: claims.get(uri) ?? [],
          secret: r.privacy?.value === 'secret',
          untrusted: r.untrusted?.value === 'true',
        };
        if (r.sessionId) rec.sessionId = r.sessionId.value;
        if (r.transcriptRef) rec.transcriptRef = r.transcriptRef.value;
        if (r.factGraph) rec.factGraph = r.factGraph.value;
        episodes.push(rec);
      }
    }
    const marks = await this.triplestore.query(`
      SELECT DISTINCT ?sessionId WHERE {
        GRAPH <${graph}> {
          ?ep <${COGT}sessionUntrusted> "true"^^<${XSD}boolean> ;
              <${COGT}sessionId> ?sessionId .
        }
      }`);
    const untrustedSessions = new Set((marks.bindings ?? []).map((r) => r.sessionId.value));
    return { episodes, untrustedSessions };
  }

  /**
   * The claim hashes of the `consolidation-promoted` episodes written for one
   * user (the ledger of what the consolidation already promoted). Scoped to the
   * user's own episodes.
   */
  async promotedHashes(userScope: UserScope): Promise<Set<string>> {
    assertScope(userScope);
    const hits = await this.runSelect(`?ep <${COGT}episodeType> "consolidation-promoted" .`, userScope);
    const out = new Set<string>();
    for (const h of hits) {
      for (const t of h.tags) if (t.startsWith(CLAIM_HASH_TAG)) out.add(t.slice(CLAIM_HASH_TAG.length));
    }
    return out;
  }

  private async runSelect(constraint: string, userScope: UserScope): Promise<EpisodeHit[]> {
    const graph = this.graphUri();
    const sparql = `
      SELECT ?ep ?episodeId ?type ?when ?salience ?sessionId ?precededBy ?partOfGoal
             ?actor ?forUser ?payload ?transcriptRef ?outcome ?durationMs ?errorClass
      WHERE {
        GRAPH <${graph}> {
          ${constraint}
          ?ep a <${COGT}Episode> ;
              <${COGT}episodeId>   ?episodeId ;
              <${COGT}episodeType> ?type ;
              <${COGT}occurredAt>  ?when ;
              <${COGT}salience>    ?salience .
          OPTIONAL { ?ep <${COGT}sessionId>     ?sessionId . }
          OPTIONAL { ?ep <${COGT}precededBy>    ?precededBy . }
          OPTIONAL { ?ep <${COGT}partOfGoal>    ?partOfGoal . }
          OPTIONAL { ?ep <${COGT}actor>         ?actor . }
          OPTIONAL { ?ep <${COGT}forUser>       ?forUser . }
          OPTIONAL { ?ep <${COGT}payload>       ?payload . }
          OPTIONAL { ?ep <${COGT}transcriptRef> ?transcriptRef . }
          OPTIONAL { ?ep <${COGT}outcome>       ?outcome . }
          OPTIONAL { ?ep <${COGT}durationMs>    ?durationMs . }
          OPTIONAL { ?ep <${COGT}errorClass>    ?errorClass . }
        }
      }`;
    const res = await this.triplestore.query(sparql);
    // The scope is applied to the values read back, never interpolated into the
    // query, so a user key with quotes or newlines cannot alter the query.
    const rows = (res.bindings ?? []).filter((r) =>
      inScope({ forUser: r.forUser?.value }, userScope),
    );

    // `about` and `tags` are multi-valued; fetch them in a second pass, only for
    // the episodes that survived the scope, and group.
    const uris = rows.map((r) => r.ep.value);
    const about = await this.multiValued(`<${COGT}about>`, uris);
    const tags = await this.multiValued(`<${COGT}tags>`, uris);

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
      if (r.forUser) hit.forUser = r.forUser.value;
      if (r.payload) hit.payload = r.payload.value;
      if (r.transcriptRef) hit.transcriptRef = r.transcriptRef.value;
      if (r.outcome) hit.outcome = r.outcome.value;
      if (r.durationMs) hit.durationMs = Number(r.durationMs.value);
      if (r.errorClass) hit.errorClass = r.errorClass.value;
      return hit;
    });
  }

  /**
   * Values of a multi-valued predicate for the given episodes only. The IRIs
   * come from the store itself; they are re-validated before being placed in a
   * VALUES block, and the block is chunked to keep each query small.
   */
  private async multiValued(predicate: string, uris: string[]): Promise<Map<string, string[]>> {
    const graph = this.graphUri();
    const map = new Map<string, string[]>();
    for (let i = 0; i < uris.length; i += MULTI_VALUE_CHUNK) {
      const chunk = uris.slice(i, i + MULTI_VALUE_CHUNK).map((u) => sparqlIri(u));
      const res = await this.triplestore.query(`
        SELECT ?ep ?v WHERE {
          GRAPH <${graph}> {
            VALUES ?ep { ${chunk.join(' ')} }
            ?ep ${predicate} ?v .
          }
        }`);
      for (const r of res.bindings ?? []) {
        const key = r.ep.value;
        const arr = map.get(key) ?? [];
        arr.push(r.v.value);
        map.set(key, arr);
      }
    }
    return map;
  }
}
