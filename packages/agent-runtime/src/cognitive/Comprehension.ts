/**
 * Comprehension — Phase 2 of the cognitive cycle, run BEFORE the LLM call
 * (docs/cognitive-architecture/03-cognitive-cycle.md §3, 05 §5).
 *
 * It reads, never writes. From what perception found it recalls
 *
 *  - episodes of this sender: entity-anchored (episodes `about` a perceived
 *    entity, across sessions), goal-anchored (episodes `partOfGoal` the active
 *    goal) and session-temporal (the newest episodes of this session);
 *  - one-hop facts of each perceived entity from the sender's own graph and the
 *    worldview, with a supersession note where a fact was revised;
 *
 * scores them, keeps the best {@link RECALL_CAP}, and returns them in memory.
 * The cycle writes the entries to the retrieval buffer from its queued persist
 * (off the reply path); a later phase reads the in-memory result.
 *
 * ── Privacy ─────────────────────────────────────────────────────────────────
 * Every episode read passes the sender's own user key as scope (the owner's
 * key for the owner, never the all-users scope); a missing or all-users key
 * disables episodic recall (fail closed). Facts come only from the sender's
 * graph and the worldview. An episode that matches a credential shape, or has
 * lost its payload, is never recalled.
 *
 * ── Scoring (doc 05 §5.4), every component in [0, 1] ────────────────────────
 *
 *   score = 0.4·entity + 0.3·goal + 0.2·recency + 0.1·tag
 *
 *   entity   share of the perceived entity IRIs the episode is `about`:
 *            |about ∩ perceived| / |perceived| (0 when nothing was perceived)
 *   goal     1 when the episode is `partOfGoal` the active goal, else 0. The
 *            implicit RespondToUser goal anchors nothing and gives 0.
 *   recency  exp(-age_hours / 168), 1 for an age of zero or less
 *   tag      share of the perceived tags (the intent label) the episode carries:
 *            |tags ∩ perceived| / |perceived tags|
 *
 * A fact has no goal, recency or tag, so it is scored on the same scale as
 * 0.4·1 (it is directly about a perceived entity) + 0.3·specificity, with
 * specificity user 1.0 > worldview 0.6 > shared world 0.3 (no shared world
 * graph is read yet). A fact therefore never exceeds 0.7.
 *
 * Candidates: per perceived entity and for the active goal, the newest
 * {@link CANDIDATES_PER_ANCHOR} episodes of the sender; for the session, the
 * newest {@link SESSION_RECENT_K}. The pool is cut by recency before scoring so
 * the cost does not grow with a heavily linked entity.
 *
 * Ties are broken by: higher score, user fact before worldview fact before
 * episode, newer first, then by IRI/payload, so the order is deterministic.
 *
 * ── Budget ──────────────────────────────────────────────────────────────────
 * The target for the whole phase is {@link PHASE2_BUDGET_MS} (500 ms, p95 at
 * 10 000 episodes; measured by `scripts/bench-cog.ts`). Entities left pending by
 * perception are resolved here, read-only and with the sender's scope, only when
 * there are at most {@link MAX_PENDING_LOOKUP} of them and only for up to
 * {@link PENDING_LOOKUP_MS}; a lookup that is not done by then is skipped for
 * recall (the queued persist resolves them as before). A hard deadline of
 * {@link PHASE2_DEADLINE_MS} ends the phase: recall is then dropped as a whole
 * and the answer goes ahead without it.
 */

import { ALL_USERS_SCOPE, OWNER_USER_KEY } from '@ontofelia/core';
import type { EntityFact, EpisodeHit, EpisodicMemory } from '@ontofelia/semantic-memory';
import { looksLikeSecret } from './privacyClass.js';
import { resolvePerception, type Perception } from './Perception.js';
import { RESPOND_TO_USER } from './GoalStack.js';

/** At most this many entries reach the retrieval buffer per turn. */
export const RECALL_CAP = 8;
/** Phase-2 time target (ms); what the bench holds the p95 against. */
export const PHASE2_BUDGET_MS = 500;
/** Hard end of the phase (ms); recall is dropped, the answer goes ahead. */
export const PHASE2_DEADLINE_MS = 1500;
/** Pending entities are looked up here only when there are at most this many. */
export const MAX_PENDING_LOOKUP = 3;
/** Time allowed for the pending-entity lookup (ms). */
export const PENDING_LOOKUP_MS = 150;
/** Perceived entity IRIs that anchor recall (matches the ner-result cap). */
export const MAX_RECALL_ENTITIES = 5;
/** Newest episodes of the session that are candidates. */
export const SESSION_RECENT_K = 5;
/**
 * Candidate pool per entity and per goal: the newest this many episodes in the
 * sender's scope are loaded and scored; older ones are not. (With a weight of
 * 0.2 on recency and a cap of eight entries, the cut-off only matters for an
 * entity that appears in more than this many of the sender's episodes.)
 */
export const CANDIDATES_PER_ANCHOR = 30;
/** Longest payload kept on a retrieval entry (characters). */
export const MAX_ENTRY_PAYLOAD = 400;
/** Facts read per perceived entity before ranking. */
export const FACTS_PER_ENTITY = 4;

export const WEIGHTS = { entity: 0.4, goal: 0.3, recency: 0.2, tag: 0.1 } as const;
export const SPECIFICITY = { user: 1.0, worldview: 0.6, world: 0.3 } as const;
/** Recency decay constant: one week in hours (doc 05 §5.4). */
const RECENCY_TAU_HOURS = 168;

/** Episode types worth recalling: what was said and what was decided. */
const RECALLABLE_TYPES = new Set([
  'message-received',
  'response-sent',
  'goal-pushed',
  'goal-resolved',
  'goal-abandoned',
]);

export interface ScoreComponents {
  entity: number;
  goal: number;
  recency: number;
  tag: number;
}

export interface RecallEntry {
  kind: 'episode-ref' | 'fact';
  /** The text for the retrieval buffer (bounded by {@link MAX_ENTRY_PAYLOAD}). */
  payload: string;
  score: number;
  /** Graph the entry was read from. */
  sourceGraph: string;
  /** Episode IRI (episode-ref) or the entity IRI the fact is about (fact). */
  refersTo: string;
  /** The sender's user key; every entry is for exactly this user. */
  forUser: string;
  /** Episodes: the four score components. */
  components?: ScoreComponents;
  occurredAt?: string;
  /** Facts: where it came from. */
  specificity?: 'user' | 'worldview';
  /** Facts: set when a later fact replaced an earlier value ("this changed"). */
  changed?: { previous: string; supersededAt?: string };
}

export interface ComprehensionResult {
  /** Best first, at most {@link RECALL_CAP}. */
  entries: RecallEntry[];
  /** No entry: what the metacognition marker reads as `emptyRetrieval`. */
  empty: boolean;
  /**
   * `ok`: every read finished. `partial`: some read failed, the rest is used.
   * `timeout`: the hard deadline passed, nothing is used.
   */
  status: 'ok' | 'partial' | 'timeout';
  elapsedMs: number;
  /** Perception with the pending entities resolved here (when they were). */
  perception?: Perception;
  /** The pending-entity lookup ran to completion here, so persist need not repeat it. */
  pendingResolved: boolean;
}

export interface ComprehensionDeps {
  episodic: Pick<EpisodicMemory, 'findByEntity' | 'findByGoal' | 'findInSession' | 'graphUri'>;
  /** One-hop facts of entity IRIs for this sender (user graph + worldview). */
  entityFacts?: (entityIris: string[]) => Promise<EntityFact[]>;
  /** Read-only, sender-scoped lookup of pending entity names (lower-cased name -> IRIs). */
  resolveEntities?: (names: string[]) => Promise<Map<string, string[]>>;
  now?: () => number;
  /** Failures of single reads; never thrown to the caller. */
  onError?: (err: unknown) => void;
}

export interface ComprehensionInput {
  /** The sender's user key (`cogUserKey`). */
  userKey: string;
  sessionId: string;
  perception?: Perception;
  activeGoalUri?: string;
  activeGoalType?: string;
  /** This turn's own inbound episode; never recalled. */
  inboundEpisodeUri?: string;
  /** False when `flagEpisodicMemory` is off: no episode is read. */
  episodicEnabled: boolean;
}

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
}

/** exp(-age/168h); an episode from the future counts as age zero. */
export function recencyOf(occurredAt: string, nowMs: number): number {
  const t = Date.parse(occurredAt);
  if (Number.isNaN(t)) return 0;
  return clamp01(Math.exp(-Math.max(0, nowMs - t) / 3_600_000 / RECENCY_TAU_HOURS));
}

/** The four components and the weighted score of one episode. */
export function scoreEpisode(
  hit: Pick<EpisodeHit, 'about' | 'partOfGoal' | 'tags' | 'occurredAt'>,
  ctx: { entityIris: string[]; goalUri?: string; tags: string[]; nowMs: number },
): { score: number; components: ScoreComponents } {
  const about = new Set(hit.about);
  const entity =
    ctx.entityIris.length === 0
      ? 0
      : ctx.entityIris.filter((e) => about.has(e)).length / ctx.entityIris.length;
  const goal = ctx.goalUri !== undefined && hit.partOfGoal === ctx.goalUri ? 1 : 0;
  const recency = recencyOf(hit.occurredAt, ctx.nowMs);
  const own = new Set(hit.tags);
  const tag =
    ctx.tags.length === 0 ? 0 : ctx.tags.filter((t) => own.has(t)).length / ctx.tags.length;
  const score =
    WEIGHTS.entity * entity + WEIGHTS.goal * goal + WEIGHTS.recency * recency + WEIGHTS.tag * tag;
  return { score, components: { entity, goal, recency, tag } };
}

/** Score of a one-hop fact: 0.4·1 + 0.3·specificity (see the header). */
export function scoreFact(scope: 'user' | 'worldview'): number {
  return WEIGHTS.entity * 1 + WEIGHTS.goal * SPECIFICITY[scope];
}

function bound(text: string): string {
  return text.length > MAX_ENTRY_PAYLOAD ? `${text.slice(0, MAX_ENTRY_PAYLOAD - 1)}…` : text;
}

function factText(f: EntityFact): string {
  const base = `${f.subjectLabel} ${f.predicateLabel} ${f.objectLabel}`;
  return f.superseded ? `${base} (changed; previously ${f.superseded.previousLabel})` : base;
}

/** Resolve with `undefined` when `p` is not settled within `ms`; never rejects. */
function within<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), Math.max(0, ms));
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(undefined);
      },
    );
  });
}

/** Run Phase 2. Reads only; resolves in every case (a failure is a smaller result). */
export async function comprehend(
  deps: ComprehensionDeps,
  input: ComprehensionInput,
): Promise<ComprehensionResult> {
  const now = deps.now ?? Date.now;
  const started = now();
  const empty = (status: ComprehensionResult['status'], perception?: Perception, pendingResolved = false) =>
    ({ entries: [], empty: true, status, elapsedMs: now() - started, perception, pendingResolved }) as ComprehensionResult;

  const work = (async (): Promise<ComprehensionResult> => {
    let degraded = false;
    const fail = (e: unknown) => {
      degraded = true;
      try {
        deps.onError?.(e);
      } catch {
        /* reporting is best-effort */
      }
    };

    // Pending entities: resolve read-only and sender-scoped, if cheap enough.
    let perception = input.perception;
    let pendingResolved = false;
    if (
      perception &&
      perception.pending.length > 0 &&
      perception.pending.length <= MAX_PENDING_LOOKUP &&
      deps.resolveEntities
    ) {
      const found = await within(deps.resolveEntities(perception.pending), PENDING_LOOKUP_MS);
      if (found) {
        perception = resolvePerception(perception, found);
        pendingResolved = true;
      }
    }

    const entityIris = (perception?.about ?? []).slice(0, MAX_RECALL_ENTITIES);
    const tags = perception?.tags ?? [];
    const goalUri =
      input.activeGoalUri !== undefined && input.activeGoalType !== RESPOND_TO_USER
        ? input.activeGoalUri
        : undefined;
    const user = input.userKey;
    const nowMs = now();

    // Fail closed: episodes are read only with a concrete user key.
    const scopeOk = typeof user === 'string' && user !== '' && user !== ALL_USERS_SCOPE;
    const em = deps.episodic;
    const guard = <T>(p: Promise<T[]>): Promise<T[]> => p.catch((e) => (fail(e), [] as T[]));

    const [byEntity, byGoal, inSession, facts] = await Promise.all([
      input.episodicEnabled && scopeOk
        ? Promise.all(entityIris.map((iri) => guard(em.findByEntity(iri, user, { limit: CANDIDATES_PER_ANCHOR }))))
        : Promise.resolve([] as EpisodeHit[][]),
      input.episodicEnabled && scopeOk && goalUri !== undefined
        ? guard(em.findByGoal(goalUri, user, { limit: CANDIDATES_PER_ANCHOR }))
        : Promise.resolve([] as EpisodeHit[]),
      input.episodicEnabled && scopeOk && input.sessionId
        ? guard(em.findInSession(input.sessionId, user))
        : Promise.resolve([] as EpisodeHit[]),
      deps.entityFacts && entityIris.length > 0
        ? guard(deps.entityFacts(entityIris))
        : Promise.resolve([] as EntityFact[]),
    ]);

    // ── Episodes ────────────────────────────────────────────────────────────
    const eligible = (h: EpisodeHit): boolean => {
      if (h.uri === input.inboundEpisodeUri) return false; // this turn's own message
      if (!RECALLABLE_TYPES.has(h.episodeType)) return false;
      if (!h.payload) return false; // warm tier: text dropped
      if (looksLikeSecret(h.payload)) return false;
      // Defence in depth: the read is already scoped; repeat the rule here.
      if (h.forUser === undefined) return user === OWNER_USER_KEY;
      return h.forUser === user;
    };
    // Session-temporal candidates: the newest few (findInSession is newest first).
    const sessionRecent = inSession.filter(eligible).slice(0, SESSION_RECENT_K);
    const candidates = new Map<string, EpisodeHit>();
    for (const h of [...byEntity.flat(), ...byGoal, ...sessionRecent]) {
      if (eligible(h) && !candidates.has(h.uri)) candidates.set(h.uri, h);
    }
    const graph = em.graphUri();
    const entries: Array<RecallEntry & { rank: number }> = [];
    for (const h of candidates.values()) {
      const { score, components } = scoreEpisode(h, { entityIris, goalUri, tags, nowMs });
      entries.push({
        kind: 'episode-ref',
        payload: bound(h.payload as string),
        score,
        sourceGraph: graph,
        refersTo: h.uri,
        forUser: user,
        components,
        occurredAt: h.occurredAt,
        rank: 2,
      });
    }

    // ── Facts ───────────────────────────────────────────────────────────────
    for (const f of facts) {
      const text = factText(f);
      if (looksLikeSecret(text)) continue;
      entries.push({
        kind: 'fact',
        payload: bound(text),
        score: scoreFact(f.scope),
        sourceGraph: f.graph,
        refersTo: f.entity,
        forUser: user,
        specificity: f.scope,
        ...(f.superseded
          ? {
              changed: {
                previous: f.superseded.previousLabel,
                ...(f.superseded.supersededAt ? { supersededAt: f.superseded.supersededAt } : {}),
              },
            }
          : {}),
        rank: f.scope === 'user' ? 0 : 1,
      });
    }

    entries.sort(
      (a, b) =>
        b.score - a.score ||
        a.rank - b.rank ||
        Date.parse(b.occurredAt ?? '') - Date.parse(a.occurredAt ?? '') || // NaN || falls through
        (a.refersTo < b.refersTo ? -1 : a.refersTo > b.refersTo ? 1 : 0) ||
        (a.payload < b.payload ? -1 : a.payload > b.payload ? 1 : 0),
    );
    const top = entries.slice(0, RECALL_CAP).map(({ rank: _rank, ...e }) => e as RecallEntry);
    return {
      entries: top,
      empty: top.length === 0,
      status: degraded ? 'partial' : 'ok',
      elapsedMs: now() - started,
      perception,
      pendingResolved,
    };
  })();

  const result = await within(
    work.catch((e) => {
      try {
        deps.onError?.(e);
      } catch {
        /* reporting is best-effort */
      }
      return empty('partial', input.perception);
    }),
    PHASE2_DEADLINE_MS,
  );
  return result ?? empty('timeout', input.perception);
}
