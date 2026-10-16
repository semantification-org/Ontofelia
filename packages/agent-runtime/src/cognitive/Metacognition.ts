/**
 * Metacognition — impasse detection/resolution and rich reflective markers
 * (docs/cognitive-architecture/08-metacognition-and-self-model.md, Phase F).
 *
 * Two jobs, both over `urn:<agent>:cog:meta`:
 *  - **Per cycle:** any phase may raise a `cogt:Impasse`; the cycle manager runs
 *    a metacognitive subcycle (S1–S4) and resolves it via a *policy* lookup
 *    (auditable, not LLM-driven). Phase 6 then writes the full
 *    `cogt:ReflectiveMarker` with the cycle's monitoring signals.
 *  - **Cross cycle:** a scheduled scan promotes recurring impasse kinds to
 *    `cogt:ChronicImpasse` (+ a `ResolveChronicImpasse` long-term goal),
 *    surfaces `cogt:CapabilityGap` from constraint pressure, and flags drift.
 *
 * Writes follow the {@link EpisodicMemory} conventions: typed SPARQL
 * `INSERT DATA` so datatypes survive, counting in TypeScript because the
 * embedded Oxigraph WASM build cannot evaluate aggregates.
 */

import { OWNER_USER_KEY, compareIso, type TriplestoreAdapter } from '@ontofelia/core';
import { GraphUriResolver, reflectOnWorldview, type ConflictDetector } from '@ontofelia/semantic-memory';
import type { ComprehensionResult, RecallEntry } from './Comprehension.js';

const COGT = 'urn:shared:ontology#cog/';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const XSD = 'http://www.w3.org/2001/XMLSchema#';

export type MarkerId = string;
export type ImpasseId = string;

export type ImpasseKind =
  | 'perception-parse-failed'
  | 'comprehension-overflow'
  | 'goal-conflict'
  | 'action-selection-empty'
  | 'action-selection-refused'
  | 'tool-policy-denied-all'
  | 'tool-error'
  | 'tool-timeout'
  | 'wm-overflow'
  | (string & {});

export type Resolution = 'retry' | 'change-goal' | 'ask-user' | 'skip' | 'abort';

export interface ImpasseInput {
  kind: ImpasseKind;
  /** Phase resource URI that raised the impasse. */
  flaggedInPhase: string;
  context: string;
  cycleId?: string;
  occurredAt?: Date;
  /** The user key of the cycle that raised the impasse; written as `cogt:forUser` when given. */
  forUser?: string;
}

export interface FlaggedImpasse {
  id: ImpasseId;
  kind: ImpasseKind;
  /** True when this kind already exceeded its daily cap → a ChronicImpasse. */
  chronic: boolean;
}

export interface SubcycleContext {
  /** How many times the flagged phase has already been retried this cycle. */
  attempt: number;
  /** Recent impasse density (same kind, last 24h) — escalates the resolution. */
  recentDensity: number;
  chronic: boolean;
}

export interface ReflectiveMarkerInput {
  cycleUri: string;
  cycleStatus: 'completed' | 'impasse-resolved' | 'aborted';
  goalProgress?: string;
  newKnowledge?: string;
  uncertainty?: 'low' | 'medium' | 'high';
  toolsUsed?: number;
  toolErrors?: number;
  emptyRetrieval?: boolean;
  goalDrift?: boolean;
  toolChurn?: boolean;
  constraintPressure?: number;
  flaggedImpasse?: string[];
  resolvedImpasse?: string[];
  noted?: string;
  carryForward?: boolean;
  /** Conflicts in the sender's own data that this turn surfaced (count). */
  conflictSurfaced?: number;
  /** The user key of the cycle; written as `cogt:forUser` when given. */
  forUser?: string;
  createdAt?: Date;
}

export interface MetacogReport {
  since: string;
  until: string;
  cyclesScanned: number;
  chronicImpassesRaised: number;
  capabilityGapsRaised: number;
  driftDetected: boolean;
  longtermGoalsCreated: number;
  /** The user key the scan was scoped to. */
  forUser?: string;
  /** Cycles of the window whose marker says the top goal drifted. */
  driftCycles?: number;
  /** Present only when the scan ran the worldview reflection (owner scope). */
  reflection?: { worldviewTriplesCount: number; conflictsFound: number };
}

/** Options of {@link Metacognition.crossCycleScan}. */
export interface ScanScope {
  /**
   * The user whose markers and impasses are scanned; every record the scan
   * writes carries it. Default: the owner, whose scope also holds the records
   * written before the user key existed.
   */
  forUser?: string;
  /**
   * Run the worldview reflection (the former `ReflectionRunner` body) as part
   * of the scan. Owner scope only: the reflection reads agent-level graphs.
   */
  reflection?: { conflictDetector: Pick<ConflictDetector, 'detectConflicts' | 'storeConflicts'> };
}

// ---------------------------------------------------------------------------
// Signals of one cycle (pure; the cycle manager feeds them into the marker)
// ---------------------------------------------------------------------------

/** The tool call at which the churn warning is written (once per turn). */
export const CHURN_TOOL_CALLS = 5;
/** Salience of the churn warning entry. */
export const CHURN_SALIENCE = 0.8;
/** Entry kind of the churn warning in the `metaBuffer`. */
export const CHURN_ENTRY_KIND = 'churn-warning';
/** Entry kind and salience of the "I don't know" nudge in the `metaBuffer`. */
export const UNKNOWN_NUDGE_ENTRY_KIND = 'unknown-nudge';
export const UNKNOWN_NUDGE_SALIENCE = 1.0;

/** The "I don't know" nudge: short and neutral (doc 08 §7). */
export const UNKNOWN_NUDGE_TEXT =
  'Memory holds nothing about what this question asks. If you do not know the answer, ' +
  'say so rather than guess, or ask what is missing.';
/** The churn warning. */
export const CHURN_NOTE_TEXT = `${CHURN_TOOL_CALLS} tool calls have been made in this turn; check that they make progress before calling more.`;

export type Uncertainty = 'low' | 'medium' | 'high';

/**
 * `cogt:uncertainty` of a cycle from two observations:
 *
 *   gap    = the retrieval was empty AND the intent is a question (an empty
 *            recall on small talk is normal and says nothing about certainty)
 *   errors = tool calls of the turn that ended in an error
 *
 *   high   : (gap AND errors >= 1) OR errors >= 3
 *   medium : gap OR errors >= 1
 *   low    : otherwise
 */
export function uncertaintyOf(input: { emptyRetrieval: boolean; intent?: string; toolErrors: number }): Uncertainty {
  const gap = input.emptyRetrieval && input.intent === 'question';
  if ((gap && input.toolErrors >= 1) || input.toolErrors >= 3) return 'high';
  if (gap || input.toolErrors >= 1) return 'medium';
  return 'low';
}

/**
 * The "I don't know" rule (doc 08 §7): the intent is a question AND the
 * retrieval of the turn came back empty. A degraded read (`partial`, `timeout`)
 * or a missing result never counts: a failed lookup is not an unknown.
 */
export function isUnknownQuestion(
  intent: string | undefined,
  comprehension: Pick<ComprehensionResult, 'empty' | 'status'> | undefined,
): boolean {
  return intent === 'question' && comprehension?.status === 'ok' && comprehension.empty === true;
}

/**
 * The conflicts this turn surfaced, from the recall entries: a fact of the
 * sender's OWN graph (never the worldview) that a later fact replaced, where the
 * replacement happened during this turn (`supersededAt` is not before the turn
 * start). Instants are compared as instants, never as strings.
 */
export function conflictsOfTurn(entries: readonly RecallEntry[], turnStartIso: string): RecallEntry[] {
  return entries.filter(
    (e) =>
      e.kind === 'fact' &&
      e.specificity === 'user' &&
      e.changed?.supersededAt !== undefined &&
      compareIso(e.changed.supersededAt, turnStartIso) >= 0,
  );
}

/** `cogt:goalProgress`: goal steps updated and goals resolved in the cycle; undefined when none. */
export function goalProgressOf(input: { stepUpdates: number; goalsResolved: number }): string | undefined {
  const parts: string[] = [];
  if (input.stepUpdates > 0) parts.push(`${input.stepUpdates} step update(s)`);
  if (input.goalsResolved > 0) parts.push(`${input.goalsResolved} goal(s) resolved`);
  return parts.length > 0 ? parts.join(', ') : undefined;
}

/** Most rows one scan read returns (newest first); the scan is bounded. */
export const SCAN_ROW_LIMIT = 5000;
/** Most distinct users a scheduled scan walks. */
export const SCAN_USER_LIMIT = 50;

/** Per-kind daily cap; over this many in 24h a flag becomes a ChronicImpasse. */
const DAILY_CAP: Record<string, number> = {
  'action-selection-empty': 5,
  'action-selection-refused': 5,
  'tool-error': 8,
  'tool-timeout': 8,
  'tool-policy-denied-all': 5,
  'goal-conflict': 5,
  'comprehension-overflow': 5,
  'perception-parse-failed': 5,
  'wm-overflow': 5,
};
const DEFAULT_CAP = 5;

/** ≥ this many of one impasse kind in a scan window crystallises a ChronicImpasse. */
const CHRONIC_SCAN_THRESHOLD = 3;
/** Goal-drift in more than this fraction of a window's cycles flags drift. */
const DRIFT_FRACTION = 0.3;
/** Total constraint pressure over a window beyond this raises a CapabilityGap. */
const CAPGAP_PRESSURE_THRESHOLD = 5;

function escapeLiteral(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

function newId(): string {
  return typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export class Metacognition {
  constructor(
    private readonly triplestore: TriplestoreAdapter,
    private readonly agentId: string,
  ) {}

  metaGraphUri(): string {
    return GraphUriResolver.getCogMetaGraph(this.agentId);
  }

  private longtermGoalsGraphUri(): string {
    return GraphUriResolver.getCogGoalsLongtermGraph(this.agentId);
  }

  /**
   * Raise an impasse. When the kind has already exceeded its daily cap the
   * resource is typed `cogt:ChronicImpasse` (a subclass) so the cycle manager
   * skips the subcycle and goes straight to ask-user — this is the
   * infinite-recursion / loop guard.
   */
  async flagImpasse(input: ImpasseInput): Promise<FlaggedImpasse> {
    const graph = this.metaGraphUri();
    const at = (input.occurredAt ?? new Date()).toISOString();
    const recent = await this.countRecentImpasses(input.kind, input.occurredAt ?? new Date(), input.forUser);
    const cap = DAILY_CAP[input.kind] ?? DEFAULT_CAP;
    const chronic = recent >= cap;
    const uri = `urn:${this.agentId}:cog:impasse:${newId()}`;
    const type = chronic ? `${COGT}ChronicImpasse` : `${COGT}Impasse`;
    const lines = [
      `<${uri}> <${RDF_TYPE}> <${type}> .`,
      `<${uri}> <${COGT}impasseKind> "${escapeLiteral(input.kind)}" .`,
      `<${uri}> <${COGT}flaggedInPhase> <${input.flaggedInPhase}> .`,
      `<${uri}> <${COGT}flaggedAt> "${at}"^^<${XSD}dateTime> .`,
      `<${uri}> <${COGT}context> "${escapeLiteral(input.context)}" .`,
    ];
    if (input.cycleId) lines.push(`<${uri}> <${COGT}cycleId> "${escapeLiteral(input.cycleId)}" .`);
    if (input.forUser) lines.push(`<${uri}> <${COGT}forUser> "${escapeLiteral(input.forUser)}" .`);
    await this.triplestore.update(`INSERT DATA { GRAPH <${graph}> {\n${lines.join('\n')}\n} }`);
    return { id: uri, kind: input.kind, chronic };
  }

  /** Stamp an impasse resolved with the chosen resolution and who resolved it. */
  async resolveImpasse(
    impasseId: ImpasseId,
    resolution: Resolution,
    by: 'metacog' | 'user' | 'timeout',
    now: Date = new Date(),
  ): Promise<void> {
    const graph = this.metaGraphUri();
    // One update: the delete, then the insert.
    await this.triplestore.update(`
      DELETE { GRAPH <${graph}> {
        <${impasseId}> <${COGT}resolution> ?r . <${impasseId}> <${COGT}resolvedBy> ?b .
        <${impasseId}> <${COGT}resolvedAt> ?a . } }
      WHERE  { GRAPH <${graph}> {
        OPTIONAL { <${impasseId}> <${COGT}resolution> ?r } OPTIONAL { <${impasseId}> <${COGT}resolvedBy> ?b }
        OPTIONAL { <${impasseId}> <${COGT}resolvedAt> ?a } } } ;
      INSERT DATA { GRAPH <${graph}> {
        <${impasseId}> <${COGT}resolution> "${escapeLiteral(resolution)}" .
        <${impasseId}> <${COGT}resolvedBy> "${escapeLiteral(by)}" .
        <${impasseId}> <${COGT}resolvedAt> "${now.toISOString()}"^^<${XSD}dateTime> .
      } }`);
  }

  /**
   * Policy-driven resolution choice (doc 08 §5.3). Deliberately a lookup table
   * — auditable and never LLM-driven. Escalates to ask-user/abort under
   * repeated attempts or chronic density so a cycle can never loop.
   */
  pickResolution(kind: ImpasseKind, ctx: SubcycleContext): Resolution {
    if (ctx.chronic) return 'ask-user';
    const firstAttempt = ctx.attempt <= 0;
    switch (kind) {
      case 'action-selection-empty':
        return firstAttempt ? 'retry' : 'ask-user';
      case 'tool-error':
      case 'tool-timeout':
        return firstAttempt ? 'retry' : 'skip';
      case 'goal-conflict':
        return 'change-goal';
      case 'comprehension-overflow':
      case 'wm-overflow':
        return 'skip';
      case 'action-selection-refused':
      case 'tool-policy-denied-all':
      case 'perception-parse-failed':
        return 'ask-user';
      default:
        return 'ask-user';
    }
  }

  /** Write the full Phase-6 reflective marker with this cycle's signals. */
  async writeMarker(input: ReflectiveMarkerInput): Promise<MarkerId> {
    const graph = this.metaGraphUri();
    const uri = `urn:${this.agentId}:cog:marker:${newId()}`;
    const at = (input.createdAt ?? new Date()).toISOString();
    const bool = (b: boolean) => `"${b}"^^<${XSD}boolean>`;
    const int = (n: number) => `"${Math.trunc(n)}"^^<${XSD}integer>`;
    const lines: string[] = [
      `<${uri}> <${RDF_TYPE}> <${COGT}ReflectiveMarker> .`,
      `<${uri}> <${COGT}reflectsOn> <${input.cycleUri}> .`,
      `<${uri}> <${COGT}createdAt> "${at}"^^<${XSD}dateTime> .`,
      `<${uri}> <${COGT}cycleStatus> "${escapeLiteral(input.cycleStatus)}" .`,
    ];
    if (input.goalProgress)
      lines.push(`<${uri}> <${COGT}goalProgress> "${escapeLiteral(input.goalProgress)}" .`);
    if (input.newKnowledge)
      lines.push(`<${uri}> <${COGT}newKnowledge> "${escapeLiteral(input.newKnowledge)}" .`);
    if (input.uncertainty)
      lines.push(`<${uri}> <${COGT}uncertainty> "${escapeLiteral(input.uncertainty)}" .`);
    if (input.toolsUsed !== undefined)
      lines.push(`<${uri}> <${COGT}toolsUsed> ${int(input.toolsUsed)} .`);
    if (input.toolErrors !== undefined)
      lines.push(`<${uri}> <${COGT}toolErrors> ${int(input.toolErrors)} .`);
    if (input.emptyRetrieval !== undefined)
      lines.push(`<${uri}> <${COGT}emptyRetrieval> ${bool(input.emptyRetrieval)} .`);
    if (input.goalDrift !== undefined)
      lines.push(`<${uri}> <${COGT}goalDrift> ${bool(input.goalDrift)} .`);
    if (input.toolChurn !== undefined)
      lines.push(`<${uri}> <${COGT}toolChurn> ${bool(input.toolChurn)} .`);
    if (input.constraintPressure !== undefined)
      lines.push(`<${uri}> <${COGT}constraintPressure> ${int(input.constraintPressure)} .`);
    for (const imp of input.flaggedImpasse ?? [])
      lines.push(`<${uri}> <${COGT}flaggedImpasse> <${imp}> .`);
    for (const imp of input.resolvedImpasse ?? [])
      lines.push(`<${uri}> <${COGT}resolvedImpasse> <${imp}> .`);
    if (input.noted) lines.push(`<${uri}> <${COGT}noted> "${escapeLiteral(input.noted)}" .`);
    if (input.carryForward !== undefined)
      lines.push(`<${uri}> <${COGT}carryForward> ${bool(input.carryForward)} .`);
    if (input.conflictSurfaced !== undefined)
      lines.push(`<${uri}> <${COGT}conflictSurfaced> ${int(input.conflictSurfaced)} .`);
    if (input.forUser) lines.push(`<${uri}> <${COGT}forUser> "${escapeLiteral(input.forUser)}" .`);

    await this.triplestore.update(`INSERT DATA { GRAPH <${graph}> {\n${lines.join('\n')}\n} }`);
    return uri;
  }

  /**
   * Cross-cycle scan (doc 08 §6), scoped to ONE user. Promotes recurring
   * impasse kinds to `cogt:ChronicImpasse` with a `ResolveChronicImpasse`
   * long-term goal, raises a `cogt:CapabilityGap` when constraint pressure
   * accumulates, and reports goal drift when the markers of the window show it
   * in more than {@link DRIFT_FRACTION} of the cycles.
   *
   * Every read is restricted to `scope.forUser` (default: the owner, whose scope
   * also holds the records written before the user key existed), is bounded by
   * {@link SCAN_ROW_LIMIT} (newest first) and compares instants with
   * `compareIso`. Every record written carries the same user. Nothing is
   * aggregated across users. With `scope.reflection` (owner scope only) the
   * worldview reflection that `ReflectionRunner` used to hold runs as well.
   */
  async crossCycleScan(
    window: { since: Date; until: Date },
    scope: ScanScope = {},
  ): Promise<MetacogReport> {
    const user = scope.forUser && scope.forUser !== '' ? scope.forUser : OWNER_USER_KEY;
    const impasses = await this.readImpasses(window, user);
    const markers = await this.readMarkers(window, user);
    const report: MetacogReport = {
      since: window.since.toISOString(),
      until: window.until.toISOString(),
      cyclesScanned: markers.length,
      chronicImpassesRaised: 0,
      capabilityGapsRaised: 0,
      driftDetected: false,
      longtermGoalsCreated: 0,
      forUser: user,
      driftCycles: 0,
    };

    // 1. Recurring impasse kind → ChronicImpasse + long-term resolve goal.
    const byKind = new Map<string, number>();
    for (const i of impasses) byKind.set(i.kind, (byKind.get(i.kind) ?? 0) + 1);
    for (const [kind, count] of byKind) {
      if (count < CHRONIC_SCAN_THRESHOLD) continue;
      await this.raiseChronicImpasse(kind, count, window.until, user);
      report.chronicImpassesRaised++;
      await this.pushLongtermGoal(
        `${COGT}ResolveChronicImpasse`,
        `Resolve chronic impasse: ${kind} (${count}× recently)`,
        window.until,
        user,
      );
      report.longtermGoalsCreated++;
    }

    // 2. Constraint pressure accumulation → CapabilityGap.
    const totalPressure = markers.reduce((a, m) => a + (m.constraintPressure ?? 0), 0);
    if (totalPressure >= CAPGAP_PRESSURE_THRESHOLD) {
      await this.raiseCapabilityGap(totalPressure, window.until, user);
      report.capabilityGapsRaised++;
    }

    // 3. Drift detection over the window, from the markers' `goalDrift` bit.
    if (markers.length > 0) {
      const drifting = markers.filter((m) => m.goalDrift).length;
      report.driftCycles = drifting;
      report.driftDetected = drifting / markers.length > DRIFT_FRACTION;
    }

    // 4. The worldview reflection (the former ReflectionRunner body).
    if (scope.reflection && user === OWNER_USER_KEY) {
      const r = await reflectOnWorldview(
        { triplestore: this.triplestore, conflictDetector: scope.reflection.conflictDetector },
        this.agentId,
      );
      report.reflection = { worldviewTriplesCount: r.worldviewTriplesCount, conflictsFound: r.conflicts.length };
    }
    return report;
  }

  /**
   * The distinct user keys that have a marker or an impasse in the window
   * (at most {@link SCAN_USER_LIMIT}). Only keys are read, no content.
   */
  async usersInWindow(window: { since: Date; until: Date }): Promise<string[]> {
    const graph = this.metaGraphUri();
    const res = await this.triplestore.query(`
      SELECT DISTINCT ?u WHERE {
        GRAPH <${graph}> {
          { ?r a <${COGT}ReflectiveMarker> ; <${COGT}createdAt> ?at ; <${COGT}forUser> ?u . }
          UNION
          { ?r a <${COGT}Impasse> ; <${COGT}flaggedAt> ?at ; <${COGT}forUser> ?u . }
          ${this.windowFilter(window)}
        }
      } LIMIT ${SCAN_USER_LIMIT}`);
    return (res.bindings ?? []).map((r) => r.u.value);
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private windowFilter(window: { since: Date; until: Date }): string {
    return `FILTER(?at >= "${window.since.toISOString()}"^^<${XSD}dateTime> && ?at <= "${window.until.toISOString()}"^^<${XSD}dateTime>)`;
  }

  /**
   * SPARQL restricting `?subject` to one user. The owner's scope also holds
   * records without a user key (written before the key existed); any other user
   * sees only records carrying exactly their key.
   */
  private userPattern(subject: string, user: string, tag: string): string {
    if (user === OWNER_USER_KEY) {
      return `OPTIONAL { ${subject} <${COGT}forUser> ?u${tag} } FILTER(!BOUND(?u${tag}) || ?u${tag} = "${escapeLiteral(user)}")`;
    }
    return `${subject} <${COGT}forUser> "${escapeLiteral(user)}" .`;
  }

  /**
   * The impasses of `kind` in the last 24 h for the daily cap, of one user: the
   * owner's scope (the default, when no user is given) also holds the records
   * written before the user key existed; another user counts only their own.
   */
  private async countRecentImpasses(kind: ImpasseKind, now: Date, forUser?: string): Promise<number> {
    const graph = this.metaGraphUri();
    const user = forUser && forUser !== '' ? forUser : OWNER_USER_KEY;
    const res = await this.triplestore.query(`
      SELECT ?i ?at WHERE {
        GRAPH <${graph}> {
          ?i a <${COGT}Impasse> ; <${COGT}impasseKind> "${escapeLiteral(kind)}" ;
             <${COGT}flaggedAt> ?at .
          ${this.userPattern('?i', user, 'c')}
        }
      }`);
    const cutoff = now.getTime() - 24 * 3_600_000;
    let n = 0;
    for (const r of res.bindings ?? []) if (Date.parse(r.at.value) >= cutoff) n++;
    return n;
  }

  private async readImpasses(
    window: { since: Date; until: Date },
    user: string,
  ): Promise<{ uri: string; kind: string; at: string }[]> {
    const graph = this.metaGraphUri();
    const res = await this.triplestore.query(`
      SELECT ?i ?kind ?at WHERE {
        GRAPH <${graph}> {
          ?i a <${COGT}Impasse> ; <${COGT}impasseKind> ?kind ; <${COGT}flaggedAt> ?at .
          ${this.userPattern('?i', user, 'i')}
          ${this.windowFilter(window)}
        }
      } ORDER BY DESC(?at) LIMIT ${SCAN_ROW_LIMIT}`);
    const since = window.since.toISOString();
    const until = window.until.toISOString();
    const out: { uri: string; kind: string; at: string }[] = [];
    for (const r of res.bindings ?? []) {
      if (compareIso(r.at.value, since) < 0 || compareIso(r.at.value, until) > 0) continue;
      out.push({ uri: r.i.value, kind: r.kind.value, at: r.at.value });
    }
    return out;
  }

  private async readMarkers(
    window: { since: Date; until: Date },
    user: string,
  ): Promise<{ uri: string; goalDrift: boolean; constraintPressure: number; at: string }[]> {
    const graph = this.metaGraphUri();
    const res = await this.triplestore.query(`
      SELECT ?m ?at ?drift ?pressure WHERE {
        GRAPH <${graph}> {
          ?m a <${COGT}ReflectiveMarker> ; <${COGT}createdAt> ?at .
          ${this.userPattern('?m', user, 'm')}
          OPTIONAL { ?m <${COGT}goalDrift> ?drift . }
          OPTIONAL { ?m <${COGT}constraintPressure> ?pressure . }
          ${this.windowFilter(window)}
        }
      } ORDER BY DESC(?at) LIMIT ${SCAN_ROW_LIMIT}`);
    const since = window.since.toISOString();
    const until = window.until.toISOString();
    const out: { uri: string; goalDrift: boolean; constraintPressure: number; at: string }[] = [];
    for (const r of res.bindings ?? []) {
      if (compareIso(r.at.value, since) < 0 || compareIso(r.at.value, until) > 0) continue;
      out.push({
        uri: r.m.value,
        at: r.at.value,
        goalDrift: r.drift?.value === 'true',
        constraintPressure: r.pressure ? Number(r.pressure.value) : 0,
      });
    }
    return out;
  }

  private async raiseChronicImpasse(kind: string, count: number, now: Date, user: string): Promise<void> {
    const graph = this.metaGraphUri();
    // One chronic record per kind and user; the owner keeps the original IRI.
    const who = user === OWNER_USER_KEY ? '' : `u-${encodeURIComponent(user)}:`;
    const uri = `urn:${this.agentId}:cog:chronic:${who}${kind.replace(/[^a-z0-9]+/gi, '_')}`;
    await this.triplestore.update(`
      DELETE { GRAPH <${graph}> { <${uri}> ?p ?o } }
      WHERE  { GRAPH <${graph}> { <${uri}> ?p ?o } }`);
    const lines = [
      `<${uri}> <${RDF_TYPE}> <${COGT}ChronicImpasse> .`,
      `<${uri}> <${COGT}impasseKind> "${escapeLiteral(kind)}" .`,
      `<${uri}> <${COGT}occurrences> "${Math.trunc(count)}"^^<${XSD}integer> .`,
      `<${uri}> <${COGT}flaggedAt> "${now.toISOString()}"^^<${XSD}dateTime> .`,
      `<${uri}> <${COGT}forUser> "${escapeLiteral(user)}" .`,
    ];
    await this.triplestore.update(`INSERT DATA { GRAPH <${graph}> {\n${lines.join('\n')}\n} }`);
  }

  private async raiseCapabilityGap(pressure: number, now: Date, user: string): Promise<void> {
    const graph = this.metaGraphUri();
    const uri = `urn:${this.agentId}:cog:capgap:${newId()}`;
    const lines = [
      `<${uri}> <${RDF_TYPE}> <${COGT}CapabilityGap> .`,
      `<${uri}> <${COGT}constraintPressure> "${Math.trunc(pressure)}"^^<${XSD}integer> .`,
      `<${uri}> <${COGT}flaggedAt> "${now.toISOString()}"^^<${XSD}dateTime> .`,
      `<${uri}> <${COGT}forUser> "${escapeLiteral(user)}" .`,
    ];
    await this.triplestore.update(`INSERT DATA { GRAPH <${graph}> {\n${lines.join('\n')}\n} }`);
  }

  private async pushLongtermGoal(
    goalType: string,
    label: string,
    now: Date,
    user: string,
  ): Promise<void> {
    const graph = this.longtermGoalsGraphUri();
    const iso = now.toISOString();
    const goalId = `goal_${iso.replace(/[:.]/g, '-')}_${Math.random().toString(16).slice(2, 6)}`;
    const uri = `urn:${this.agentId}:cog:goal:${goalId}`;
    // De-dupe: one open ResolveChronicImpasse-style goal per label and user is enough.
    const existing = await this.triplestore.query(`
      SELECT ?g WHERE { GRAPH <${graph}> {
        ?g a <${COGT}Goal> ; <${COGT}goalLabel> "${escapeLiteral(label)}" ;
           <${COGT}goalStatus> "active" .
        ${this.userPattern('?g', user, 'g')}
      } } LIMIT 1`);
    if ((existing.bindings ?? []).length > 0) return;
    const lines = [
      `<${uri}> <${RDF_TYPE}> <${COGT}Goal> .`,
      `<${uri}> <${COGT}goalId> "${escapeLiteral(goalId)}" .`,
      `<${uri}> <${COGT}goalType> <${goalType}> .`,
      `<${uri}> <${COGT}goalLabel> "${escapeLiteral(label)}" .`,
      `<${uri}> <${COGT}goalStatus> "active" .`,
      `<${uri}> <${COGT}priority> "0.4"^^<${XSD}decimal> .`,
      `<${uri}> <${COGT}longTerm> "true"^^<${XSD}boolean> .`,
      `<${uri}> <${COGT}createdAt> "${iso}"^^<${XSD}dateTime> .`,
      `<${uri}> <${COGT}forUser> "${escapeLiteral(user)}" .`,
    ];
    await this.triplestore.update(`INSERT DATA { GRAPH <${graph}> {\n${lines.join('\n')}\n} }`);
  }
}
