/**
 * EpisodicConsolidation — repeated assertions in a user's own episodes become
 * facts in that user's own graph (docs/cognitive-architecture/05 §6.1, pattern 1).
 *
 * Privacy rule (binding): a fact is promoted ONLY into the graph
 * `urn:<agent>:user:<key>` of the user whose episodes assert it, namely the
 * graph recorded on the episode (`factGraph`); episodes without one are skipped. It never goes
 * to the worldview and never to another user's graph; there is no parameter or
 * code path that selects a different target. Episodes are read per user and the
 * evidence of one (user, s, p, o) never mixes users: user A's episodes count
 * only towards promotions into A's graph.
 *
 * What counts, deterministically and without any model call:
 *  - an episode of the user that stored a claim (`cogt:hasClaim`);
 *  - the claim is still `accepted` (a retracted claim no longer exists, a
 *    superseded or rejected one is not accepted), was asserted in the
 *    worldview or the user's own graph, and is not itself a consolidation;
 *  - the episode is not secret-classed and neither it nor its session is
 *    flagged `cogt:sessionUntrusted`.
 * A (user, s, p, o) is promoted when it has at least K distinct episodes
 * ({@link EpisodicConsolidationSettings.minEpisodes}) in at least Q distinct evidence
 * groups ({@link EpisodicConsolidationSettings.minGroups}); a group is one session
 * (transcriptRef without its line index, else sessionId) on one UTC day. One session on one day is one
 * group however many episodes it holds.
 *
 * Idempotence: the promotion is keyed by a claim hash over (user, s, p, o). A
 * `consolidation-promoted` episode carries the hash as a tag and is the ledger:
 * a hash found there is never promoted again, so a fact the user later
 * retracted or that was superseded does not come back. The user graph is also
 * checked, so a triple or accepted claim that is already there is not
 * duplicated (nothing is written for it: no corroboration evidence is added).
 * A triple the worldview holds as an independent accepted claim (one the user's
 * episodes did not themselves store) is counted `alreadyKnown` and not copied.
 *
 * No watermark is kept: the counts need the older episodes too, a rerun is
 * already a no-op by the ledger, and the read is bounded per user instead.
 */

import { createHash } from 'node:crypto';
import { compareIso, type TriplestoreAdapter } from '@ontofelia/core';
import { GraphUriResolver } from '../utils/GraphUriResolver.js';
import { sparqlIri } from '../utils/SparqlSyntax.js';
import type { KnowledgeEngine } from '../KnowledgeEngine.js';
import { CLAIM_HASH_TAG, EpisodicMemory, type ClaimEpisode } from './EpisodicMemory.js';

const CORE = 'urn:shared:ontology#';
const XSD_STRING = 'http://www.w3.org/2001/XMLSchema#string';

/** The two thresholds; both live in the setup graph (`cog:consolidationMinEpisodes`, `cog:consolidationMinGroups`). */
export interface EpisodicConsolidationSettings {
  /** K: distinct independent episodes asserting the same triple. */
  minEpisodes: number;
  /** Q: distinct evidence groups (session x day) among them. */
  minGroups: number;
}

export const DEFAULT_EPISODIC_CONSOLIDATION_SETTINGS: EpisodicConsolidationSettings = { minEpisodes: 3, minGroups: 2 };

/** Hard bounds of one run; reads and writes never exceed them. */
export const EPISODIC_CONSOLIDATION_LIMITS = {
  /** Users looked at per run. */
  maxUsers: 200,
  /** Newest claim-bearing episodes read per user. */
  maxEpisodesPerUser: 500,
  /** Promotions written per user and run. */
  maxPromotionsPerUser: 20,
  /** Promotions written per run, all users together. */
  maxPromotionsPerRun: 100,
} as const;

export interface EpisodicConsolidationReport {
  now: string;
  users: number;
  episodesScanned: number;
  /** Distinct (user, s, p, o) seen in countable episodes. */
  triplesSeen: number;
  /** Candidates that reached K and Q. */
  qualified: number;
  promoted: number;
  /** Qualified but the ledger already lists the hash. */
  alreadyPromoted: number;
  /** Qualified but the user graph already holds the triple or an accepted claim. */
  alreadyPresent: number;
  /** Qualified but the worldview already holds an independent accepted claim for the triple. */
  alreadyKnown: number;
  /** Qualified but a functional predicate already has another accepted value. */
  conflicts: number;
  /** Qualified but cut by a per-run bound. */
  deferred: number;
  excluded: { untrustedEpisodes: number; secretEpisodes: number; claims: number; noFactGraphEpisodes: number };
}

/** A candidate fact of one user. */
interface Candidate {
  key: string;
  subject: string;
  predicate: string;
  object: { kind: 'iri' | 'literal'; value: string };
  episodes: Map<string, ClaimEpisode>;
  claims: Set<string>;
}

function emptyReport(now: Date): EpisodicConsolidationReport {
  return {
    now: now.toISOString(),
    users: 0,
    episodesScanned: 0,
    triplesSeen: 0,
    qualified: 0,
    promoted: 0,
    alreadyPromoted: 0,
    alreadyPresent: 0,
    alreadyKnown: 0,
    conflicts: 0,
    deferred: 0,
    excluded: { untrustedEpisodes: 0, secretEpisodes: 0, claims: 0, noFactGraphEpisodes: 0 },
  };
}

/** Deterministic hash of one promotion: the user is part of it, so users never share one. */
export function consolidationClaimHash(
  userKey: string,
  subject: string,
  predicate: string,
  object: { kind: 'iri' | 'literal'; value: string },
): string {
  return createHash('sha256')
    .update(JSON.stringify([userKey, subject, predicate, object.kind, object.value]))
    .digest('hex');
}

/**
 * The evidence group of an episode: its session on its UTC day. The session is
 * the transcript reference WITHOUT its line index (`<session>.jsonl:line_12`
 * names a message, not a session), else the session id. Every message of one
 * session on one day therefore falls into one group.
 */
function groupOf(ep: ClaimEpisode): string {
  const t = Date.parse(ep.occurredAt);
  const day = Number.isNaN(t) ? 'unknown-day' : new Date(t).toISOString().slice(0, 10);
  const session = ep.transcriptRef?.replace(/:line_\d+$/, '') ?? ep.sessionId ?? 'no-session';
  return `${session}|${day}`;
}

export class EpisodicConsolidation {
  private readonly episodic: EpisodicMemory;

  constructor(
    private readonly triplestore: TriplestoreAdapter,
    private readonly agentId: string,
    private readonly engine: KnowledgeEngine,
  ) {
    this.episodic = new EpisodicMemory(triplestore, agentId);
  }

  async run(
    settings: EpisodicConsolidationSettings = DEFAULT_EPISODIC_CONSOLIDATION_SETTINGS,
    now: Date = new Date(),
  ): Promise<EpisodicConsolidationReport> {
    const report = emptyReport(now);
    const k = Math.max(1, Math.trunc(settings.minEpisodes));
    const q = Math.max(1, Math.trunc(settings.minGroups));
    const users = await this.episodic.usersWithClaimEpisodes(EPISODIC_CONSOLIDATION_LIMITS.maxUsers);
    let budget = EPISODIC_CONSOLIDATION_LIMITS.maxPromotionsPerRun;

    for (const userKey of users) {
      if (!this.usableUserKey(userKey)) continue;
      report.users++;
      const perUser = await this.runUser(userKey, k, q, Math.min(budget, EPISODIC_CONSOLIDATION_LIMITS.maxPromotionsPerUser), now, report);
      budget -= perUser;
      if (budget <= 0) break;
    }
    return report;
  }

  /** A key that cannot form a safe user-graph IRI, or is reserved, is skipped. */
  private usableUserKey(userKey: string): boolean {
    if (userKey === '' || userKey === 'all') return false;
    try {
      sparqlIri(GraphUriResolver.getUserGraph(this.agentId, userKey));
      return true;
    } catch {
      return false;
    }
  }

  private async runUser(
    userKey: string,
    k: number,
    q: number,
    promotionBudget: number,
    now: Date,
    report: EpisodicConsolidationReport,
  ): Promise<number> {
    const { episodes, untrustedSessions } = await this.episodic.claimEpisodes(
      userKey,
      EPISODIC_CONSOLIDATION_LIMITS.maxEpisodesPerUser,
    );
    report.episodesScanned += episodes.length;

    const usable: ClaimEpisode[] = [];
    for (const ep of episodes) {
      if (ep.secret) {
        report.excluded.secretEpisodes++;
      } else if (ep.untrusted || (ep.sessionId !== undefined && untrustedSessions.has(ep.sessionId))) {
        report.excluded.untrustedEpisodes++;
      } else {
        usable.push(ep);
      }
    }

    // Promote only into the graph recorded on the episode (the graph the
    // ingestion wrote the sender's own facts to). An episode without a usable
    // one (legacy, or not one of this agent's user graphs) is not guessed about.
    const prefix = `urn:${this.agentId}:user:`;
    const groups = new Map<string, ClaimEpisode[]>();
    for (const ep of usable) {
      const g = ep.factGraph;
      const key = g !== undefined && g.startsWith(prefix) ? g.slice(prefix.length) : '';
      if (g === undefined || !this.usableUserKey(key) || GraphUriResolver.getUserGraph(this.agentId, key) !== g) {
        report.excluded.noFactGraphEpisodes++;
        continue;
      }
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g)!.push(ep);
    }
    let written = 0;
    for (const [graph, eps] of [...groups.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      written += await this.runGraph(userKey, graph, graph.slice(prefix.length), eps, k, q, promotionBudget - written, now, report);
    }
    return written;
  }

  /** One fact graph of one user: count, qualify and promote into exactly that graph. */
  private async runGraph(
    userKey: string,
    graph: string,
    graphKey: string,
    usable: ClaimEpisode[],
    k: number,
    q: number,
    promotionBudget: number,
    now: Date,
    report: EpisodicConsolidationReport,
  ): Promise<number> {
    const claimTerms = await this.readAcceptedClaims(
      [...new Set(usable.flatMap((e) => e.claims))],
      graph,
    );

    const candidates = new Map<string, Candidate>();
    for (const ep of usable) {
      for (const claimUri of new Set(ep.claims)) {
        const term = claimTerms.get(claimUri);
        if (!term) {
          report.excluded.claims++;
          continue;
        }
        const key = JSON.stringify([term.subject, term.predicate, term.object.kind, term.object.value]);
        let c = candidates.get(key);
        if (!c) {
          c = { key, subject: term.subject, predicate: term.predicate, object: term.object, episodes: new Map(), claims: new Set() };
          candidates.set(key, c);
        }
        c.episodes.set(ep.uri, ep);
        c.claims.add(claimUri);
      }
    }
    report.triplesSeen += candidates.size;

    const qualified = [...candidates.values()].filter(
      (c) => c.episodes.size >= k && new Set([...c.episodes.values()].map(groupOf)).size >= q,
    );
    report.qualified += qualified.length;
    if (qualified.length === 0) return 0;

    // Strongest support first, then the most recent episode, then the hash:
    // a fixed order, so which of two competing values is tried first never
    // depends on the store's row order.
    const latest = (c: Candidate) =>
      [...c.episodes.values()].map((e) => e.occurredAt).sort(compareIso).pop() as string;
    // The hash names the user, or the graph when it is not the cognitive user's own.
    const hashKey = graph === GraphUriResolver.getUserGraph(this.agentId, userKey) ? userKey : graph;
    const withHash = qualified.map((c) => ({ c, hash: consolidationClaimHash(hashKey, c.subject, c.predicate, c.object) }));
    withHash.sort(
      (a, b) =>
        b.c.episodes.size - a.c.episodes.size ||
        compareIso(latest(b.c), latest(a.c)) ||
        (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0),
    );

    const ledger = await this.episodic.promotedHashes(userKey);
    let written = 0;
    for (const { c, hash } of withHash) {
      if (ledger.has(hash)) {
        report.alreadyPromoted++;
        continue;
      }
      if (written >= promotionBudget) {
        report.deferred++;
        continue;
      }
      const sources = [...c.episodes.keys()].sort();
      const res = await this.engine.promoteToUserGraph({
        agentId: this.agentId,
        userKey: graphKey,
        subjectUri: c.subject,
        predicateUri: c.predicate,
        object: c.object,
        sourceEpisodes: sources,
        supportClaims: [...c.claims].sort(),
        claimHash: hash,
      });
      if (res.outcome === 'already-present') {
        report.alreadyPresent++;
        continue;
      }
      if (res.outcome === 'already-known') {
        report.alreadyKnown++;
        continue;
      }
      if (res.outcome === 'conflict') {
        report.conflicts++;
        continue;
      }
      await this.episodic.append({
        episodeType: 'consolidation-promoted',
        occurredAt: now,
        forUser: userKey,
        factGraph: graph,
        about: [c.subject],
        hasClaim: res.claimUri ? [res.claimUri] : [],
        tags: ['consolidation', `${CLAIM_HASH_TAG}${hash}`],
        salience: 0.3,
      });
      ledger.add(hash);
      written++;
      report.promoted++;
    }
    return written;
  }

  /**
   * The accepted claims among `claimUris`, as plain terms. A claim that is gone
   * (retracted), not accepted (superseded, rejected), asserted in a graph other
   * than the worldview or this user's own graph, itself a consolidation, secret
   * classed, or whose object is not a plain IRI or string, is absent from the
   * result.
   */
  private async readAcceptedClaims(
    claimUris: string[],
    userGraph: string,
  ): Promise<Map<string, { subject: string; predicate: string; object: { kind: 'iri' | 'literal'; value: string } }>> {
    const out = new Map<string, { subject: string; predicate: string; object: { kind: 'iri' | 'literal'; value: string } }>();
    const claimsGraph = GraphUriResolver.getClaimsGraph(this.agentId);
    const worldview = GraphUriResolver.getWorldviewGraph(this.agentId);
    const safe: string[] = [];
    for (const c of claimUris) {
      try {
        safe.push(sparqlIri(c));
      } catch {
        /* an unsafe IRI is no claim */
      }
    }
    for (let i = 0; i < safe.length; i += 200) {
      const res = await this.triplestore.query(`
        SELECT ?c ?s ?p ?o ?g ?kind ?privacy WHERE {
          GRAPH <${claimsGraph}> {
            VALUES ?c { ${safe.slice(i, i + 200).join(' ')} }
            ?c a <${CORE}Claim> ;
               <${CORE}claimSubject> ?s ;
               <${CORE}claimPredicate> ?p ;
               <${CORE}claimObject> ?o ;
               <${CORE}assertedInGraph> ?g ;
               <${CORE}status> "accepted" .
            OPTIONAL { ?c <${CORE}sourceKind> ?kind . }
            OPTIONAL { ?c <${CORE}privacyClass> ?privacy . }
          }
        }`);
      for (const r of res.bindings ?? []) {
        if (r.g.value !== worldview && r.g.value !== userGraph) continue;
        if (r.kind?.value === 'consolidation-episodic' || r.privacy?.value === 'secret') continue;
        const o = r.o;
        let object: { kind: 'iri' | 'literal'; value: string };
        if (o.type === 'uri') {
          object = { kind: 'iri', value: o.value };
        } else if (o.type === 'literal' && !o.language && (!o.datatype || o.datatype === XSD_STRING)) {
          object = { kind: 'literal', value: o.value };
        } else {
          continue;
        }
        out.set(r.c.value, { subject: r.s.value, predicate: r.p.value, object });
      }
    }
    return out;
  }
}
