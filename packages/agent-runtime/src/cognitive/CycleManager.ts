/**
 * CycleManager — the synchronous six-phase cognitive cycle
 * (docs/cognitive-architecture/03-cognitive-cycle.md, Phase B).
 *
 * One cycle is run per inbound turn. In Phase B the three middle phases
 * (goal-management, action, response) are *delegated* to the existing
 * AgentRuntime core via the `core` callback; the cycle brackets that call and
 * reifies the cognitive record around it:
 *
 *   1 Perception      — message text / sender onto the perception buffer (B5)
 *   2 Comprehension   — episodic and semantic recall for the turn, read-only,
 *                       before the LLM call (Comprehension.ts)
 *   3 Goal management ┐
 *   4 Action          ├ delegated to `core()` (the legacy LLM + tool loop)
 *   5 Response        ┘
 *   6 Reflection      — a ReflectiveMarker into cog:meta (B6)
 *
 * Every cognitive write is wrapped so it can NEVER alter or fail the user
 * response: the cycle returns exactly what `core()` returned. Because nothing
 * reads these graphs yet in Phase B, the records are written *after* the core
 * call (when the session id is known); later phases will move perception ahead
 * of the LLM call.
 */

import {
  OWNER_USER_KEY,
  cogUserKey,
  compareIso,
  compareIsoDesc,
  createLogger,
  isHumanOwnerTurn,
  type MessageEnvelope,
  type ToolDenialClass,
  type TriplestoreAdapter,
} from '@ontofelia/core';
import {
  GraphRegistry,
  GraphUriResolver,
  EpisodicMemory,
  sparqlIri,
  ProceduralMemory,
  FOLLOWUP_SATISFACTION_WEIGHT,
  FOLLOWUP_MAX_GAP_MS,
  SUGGESTION_MIN_SUCCESS_RATE,
  SUGGESTION_MIN_SAMPLES,
  SelfModel,
  DERIVED_LABELS,
  type TraceInput,
  type AdherenceSummaryInput,
  type EpisodeInput,
  type SelfView,
} from '@ontofelia/semantic-memory';
import {
  WorkingMemory,
  OVERFLOW_SALIENCE,
  CARRY_DECAY,
  DEFAULT_THETA,
  type WMEntryInput,
  type WorkingMemoryOptions,
} from './WorkingMemory.js';
import {
  assemblePrompt,
  diffCognitiveBlocks,
  type Assembled,
  type BlockDiff,
  type WorkspaceEntry,
  MAX_QUOTED_LINE,
} from './PromptAssembler.js';
import type { AttentionSettings, PromptMode, PromptSettings } from './CognitiveConfig.js';
import {
  GOAL_TYPES,
  GoalStack,
  RESPOND_TO_USER,
  goalBelongsTo,
  type Goal,
  type GoalTransition,
  type GoalViewer,
} from './GoalStack.js';
import { detectGoalSignal, entityOverlap, goalFromIntent, goalSalience } from './GoalLifecycle.js';
import { goalEpisodeInput } from './GoalEpisodes.js';
import { looksLikeSecret } from './privacyClass.js';
import { classifySatisfaction } from './Satisfaction.js';
import { defaultArgRedactionRules, redactToolArgs, type MaskedArg } from './ArgRedaction.js';
import type { ArgDigestKeySource } from './ArgDigestKey.js';
import { CognitiveConfig } from './CognitiveConfig.js';
import { neutraliseQuoted } from './untrustedText.js';
import {
  comprehend,
  type ComprehensionResult,
  type ComprehensionDeps,
  type RecallEntry,
} from './Comprehension.js';
import {
  buildPerception,
  classifyIntent,
  resolvePerception,
  type Perception,
  type PerceptionSource,
} from './Perception.js';
import {
  Metacognition,
  CHURN_ENTRY_KIND,
  CHURN_NOTE_TEXT,
  CHURN_SALIENCE,
  CHURN_TOOL_CALLS,
  UNKNOWN_NUDGE_ENTRY_KIND,
  UNKNOWN_NUDGE_SALIENCE,
  UNKNOWN_NUDGE_TEXT,
  conflictsOfTurn,
  goalProgressOf,
  isUnknownQuestion,
  uncertaintyOf,
  type ImpasseInput,
  type ImpasseKind,
  type ReflectiveMarkerInput,
} from './Metacognition.js';

/** How many learned skills Phase 3 may surface for the active goal type (E4). */
const SKILL_SUGGESTION_K = 5;
/** How many learned tool sequences Phase 3 may surface (E4). */
const SEQUENCE_SUGGESTION_K = 2;

const COGT = 'urn:shared:ontology#cog/';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const XSD = 'http://www.w3.org/2001/XMLSchema#';

/** The six phase kinds, in cycle order; the array index + 1 is the `phaseIndex`. */
const PHASE_KINDS = [
  'perception',
  'comprehension',
  'goal-management',
  'action',
  'response',
  'reflection',
] as const;

/**
 * The phases that cover the delegated core (action, response). If the core
 * threw, these two are marked `aborted`; the others ran to their end.
 */
const CORE_PHASE_INDEXES: ReadonlySet<number> = new Set([4, 5]);

/** Most tool calls of one cycle that become action entries (bounds the WM writes). */
const MAX_ACTION_CALLS = 25;
/** Salience of an action entry: an audit trail, below the default θ, never prompt material. */
const ACTION_SALIENCE = 0.4;
/** Longest tool name kept in an action entry. */
const ACTION_NAME_MAX = 120;

/** One tool call as the action buffer sees it (masked; never an argument value). */
interface ActionCall {
  callId: string;
  toolName: string;
  /** Keys-only brief of the arguments. */
  brief: string;
  /** Paths of the arguments the redaction rules masked (no values, no hashes). */
  maskedPaths: string[];
  forGoal?: string;
  result?: { outcome: 'success' | 'error'; denialClass?: string; durationMs?: number };
}

/** A tool name as stored in an action entry: inert characters only, bounded. */
function safeToolName(name: string): string {
  return String(name ?? '').replace(/[^A-Za-z0-9_.:\/-]/g, '_').slice(0, ACTION_NAME_MAX) || '_';
}

/** Fixed-format payload of an `action-proposal`. */
function proposalPayload(c: ActionCall): string {
  const masked = c.maskedPaths.length > 0 ? `; masked: ${c.maskedPaths.join(', ')}` : '';
  return `tool-call ${safeToolName(c.toolName)}; args: ${c.brief || '(none)'}${masked}`;
}

/** Fixed-format payload of an `action-result`. */
function resultPayload(c: ActionCall, r: NonNullable<ActionCall['result']>): string {
  const denial = r.denialClass ? ` (${safeToolName(r.denialClass)})` : '';
  const ms = r.durationMs !== undefined ? `, ${Math.max(0, Math.trunc(r.durationMs))} ms` : '';
  return `tool-result ${safeToolName(c.toolName)}: ${r.outcome === 'success' ? 'ok' : 'error'}${denial}${ms}`;
}

export interface CycleResult<T> {
  cycleId: string;
  cycleUri: string;
  status: 'completed' | 'aborted';
  result: T;
}

/**
 * A tool-execution event captured during the delegated core (C3). Events are
 * buffered by the per-cycle recorder and replayed as episodes after core, so
 * the episodic chain stays in temporal order (message → tool calls → response).
 */
export interface ToolEpisodeEvent {
  phase: 'called' | 'completed';
  toolName: string;
  /** Correlation id linking a `called` event to its `completed` event. */
  callId: string;
  occurredAt: Date;
  /** Redacted, value-free summary of the arguments — never raw secrets. */
  argsBrief?: string;
  /**
   * The raw arguments, held in memory for the cycle only so the procedural
   * trace can hash the masked ones. Never persisted as is (see ArgRedaction.ts)
   * and dropped at once when procedural memory is off.
   */
  args?: Record<string, unknown>;
  outcome?: 'success' | 'error';
  durationMs?: number;
  errorClass?: string;
  /**
   * Typed reason a failed call failed, from the dispatch chokepoint. Constraint
   * pressure and the policy-denied impasse read this, never `errorClass` text.
   */
  denialClass?: ToolDenialClass;
}

/** Sink the runtime tool loop calls; a no-op (undefined) on the legacy path. */
export type ToolEpisodeRecorder = (ev: ToolEpisodeEvent) => void;

/**
 * Phase 3/4 hook (Phase D). The core calls this once it has resolved the
 * session id but before the LLM call; it runs the goal-management decision
 * tree and returns the `[Active goal]` text to splice into the prompt (or
 * `undefined` when the goal stack is disabled). A no-op on the legacy path.
 */
export type GoalContextProvider = (sessionId: string) => Promise<string | undefined>;

/**
 * Records the inbound `message-received` episode of a conversational turn
 * before the core runs its tools, and returns its IRI (undefined in initiative
 * mode, or when the write failed). Idempotent per cycle. The core calls it once
 * the session id is resolved and after the goal hook, so the episode still
 * carries the turn's active goal.
 */
export type InboundEpisodeRecorder = (sessionId: string) => Promise<string | undefined>;

/**
 * Phase 1 hook. The core calls it once per turn with what it already computed
 * (resolved entities, parse result, stored claims) and before the LLM call. It
 * is pure and synchronous: the perception record is kept in memory for the later
 * phases and written to the store only by the queued persist.
 */
export type PerceptionRecorder = (source: PerceptionSource) => Perception;

/**
 * Phase 2 hook. The core calls it once per turn after perception and before the
 * goal hook and the LLM call. It only reads (episodes of the sender, one-hop
 * facts of the perceived entities); the result stays in memory for the later
 * phases and reaches the retrieval buffer only through the queued persist.
 * Resolves to `undefined` on an unattended cycle and when the read itself
 * failed; it never throws.
 */
export type ComprehensionRecorder = (sessionId: string) => Promise<ComprehensionResult | undefined>;

/**
 * Churn hook (metacognition). The core calls it for every tool call of a turn
 * with the running count (1, 2, ...). At the {@link CHURN_TOOL_CALLS}th call,
 * with metacognition on, the cycle keeps one `metaBuffer` warning for its queued
 * persist; with metacognition off it does nothing.
 */
export type ToolCallHook = (callCount: number) => void;

/** The delegated core; receives the tool sink and the phase hooks. */
export type CoreFn<T> = (
  recordTool: ToolEpisodeRecorder,
  prepareGoals: GoalContextProvider,
  recordInbound: InboundEpisodeRecorder,
  perceive: PerceptionRecorder,
  comprehendHook: ComprehensionRecorder,
  onToolCall: ToolCallHook,
) => Promise<T>;

/** The delegated streaming core: yields the consumer's chunks as they happen. */
export type StreamCoreFn<C> = (
  recordTool: ToolEpisodeRecorder,
  prepareGoals: GoalContextProvider,
  recordInbound: InboundEpisodeRecorder,
  perceive: PerceptionRecorder,
  comprehendHook: ComprehensionRecorder,
) => AsyncIterable<C>;

export interface RunCycleOptions {
  /** When true, Phase 3 manages an explicit goal stack (cog.flagGoalStack). */
  goalsEnabled?: boolean;
  /** When true, Phase 5 writes one cogt:SkillTrace per tool call (cog.flagProceduralMemory). */
  proceduralEnabled?: boolean;
  /**
   * When true (cog.flagMetacognition), phases may raise `cogt:Impasse`s, the
   * cycle runs the S1–S4 metacognitive subcycle to resolve each, and Phase 6
   * writes the *full* `cogt:ReflectiveMarker` instead of the minimal Phase B
   * marker. OFF restores the Phase B reflection exactly.
   */
  metacognitionEnabled?: boolean;
  /**
   * When true (cog.flagSelfModelQuery), Phase 4 seeds a `[Self]` prompt block
   * from `SelfModel.queryFor(goalType)`, rendered through fixed templates. OFF
   * adds no block. Constraint pressure does not depend on this flag: it counts
   * the typed tool denials (policy-denied, guardian-approval-required).
   */
  selfModelEnabled?: boolean;
  /**
   * When explicitly `false` (cog.flagEpisodicMemory off), the cycle writes no
   * episodes; cycle resources, working memory and the reflective marker are
   * still written. Absent or `true` keeps the prior behaviour.
   */
  episodicEnabled?: boolean;
  /**
   * Optional real-time sink for the cognitive phases so a live status UI (e.g.
   * the Telegram progress checklist) can show them explicitly. Best-effort and
   * off the persistence path; failures are swallowed.
   */
  onPhase?: (phase: 'perception' | 'goal_management' | 'reflection', label: string, data?: unknown) => void;
  /**
   * When true, `runCycle` resolves only after this cycle's cognitive records are
   * written (the pre-queue behaviour). Default false: the records are queued per
   * session, in order, and the reply returns without waiting for them. Tests set
   * it to read the records straight after the call.
   */
  awaitPersist?: boolean;
  /**
   * Read-only lookup of the existing nodes the given mentioned entity names
   * denote for this turn's sender (lower-cased name -> node IRIs). Called only
   * from the queued persist, never on the reply path; a failure is reported to
   * `onError` and leaves the names unresolved.
   */
  resolveEntities?: (names: string[]) => Promise<Map<string, string[]>>;
  /**
   * Read-only one-hop facts of entity IRIs for this turn's sender (their own
   * graph and the worldview). Called from Phase 2, before the LLM call; absent
   * means no semantic recall.
   */
  entityFacts?: ComprehensionDeps['entityFacts'];
  /**
   * `cog.flagEpisodicRecall`. In this version it only records whether a later
   * step may put the recalled entries into the prompt; the recall itself, the
   * working-memory entries and the marker bit follow the cycle flag alone.
   */
  episodicRecallEnabled?: boolean;
  /**
   * How the cognitive prompt blocks are built (docs/cognitive-architecture/09
   * §2). `off` (the default, and always for an unattended cycle): the legacy
   * strings, byte for byte. `shadow`: the prompt assembler also runs and its
   * output and a diff against the blocks actually sent are recorded; the prompt
   * is unchanged. `live`: the blocks come from the assembler; the `[Recalled]`
   * block additionally needs `episodicRecallEnabled`.
   */
  promptMode?: PromptMode;
  /** θ and the token caps for the assembler; defaults apply when absent. */
  promptSettings?: PromptSettings;
  /**
   * Canary of the "I don't know" nudge (metacognition on, live prompt): by
   * default the nudge reaches the prompt of the owner only; `true` (setup key
   * `cog.unknownNudgeAllUsers`) lets it reach every user. Shadow mode records it
   * for every user either way.
   */
  unknownNudgeAllUsers?: boolean;
  /**
   * Attention and carry-over (docs/cognitive-architecture/04 §6-§7, 07 §6). When
   * present, the queued persist carries the previous cycle's entries of the
   * same session and user into this cycle, applies the goal-steered salience
   * rules, applies the capacity, and marks the previous working graph closed.
   * Absent (the default): none of that happens. The runtime passes it whenever
   * the cycle manager is on.
   */
  attention?: AttentionSettings;
  /**
   * With the goal stack on: a substantive goal that lost the competition and was
   * neither chosen nor touched for this many turns of its session is abandoned
   * ({@link SUPERSEDED_REASON}). Absent or 0: no goal is ever superseded. The
   * runtime passes the setup value (`cog.goalSupersedeAfterTurns`, default 10).
   */
  goalSupersedeAfterTurns?: number;
  /**
   * Cycle mode (docs/initiative-architecture.md §6). `'conversational'` (the
   * default) is byte-for-byte the prior behaviour. `'initiative'` runs an
   * unattended cycle: Phase 3 does NOT seed the implicit RESPOND_TO_USER goal
   * (there is no user to respond to) and Phase 6 records an initiative episode
   * capturing the trigger, outcome and reason.
   */
  mode?: 'conversational' | 'initiative';
  /**
   * IRI of the goal that triggered this initiative cycle. In initiative mode
   * this goal becomes the active context for Phase 3/4. Ignored in
   * conversational mode.
   */
  initiativeGoalUri?: string;
}

/** What the metacognitive half of Phase 6 needs to know about the cycle. */
interface MetaCycleContext {
    cycleId: string;
    cycleUri: string;
    status: 'completed' | 'aborted';
    responseText?: string;
    toolEvents: ToolEpisodeEvent[];
    retrievalHits: number;
    goalConflict: boolean;
    selfModelEnabled: boolean;
    wmOverflow?: { dropped: number; capacity: number };
    userKey?: string;
    sessionId?: string;
    activeGoalUri?: string;
    /** Episodes (`impasse-flagged`, `meta-reflected`) are written only when true. */
    episodicEnabled?: boolean;
    /** Conversational turn with the new signals; absent for an initiative cycle. */
    signals?: TurnSignals;
    intent?: string;
    goalsResolved?: number;
    conflictCount?: number;
  }

/** Goal lifecycle records a cycle collects for its queued persist. */
interface GoalExtras {
  /** Transitions of goals during the turn (episodes are written from them). */
  events: GoalTransition[];
  /** The competition decided this turn: winner and losers (a `ChooseGoal` record). */
  choice?: { winner: string; losers: string[] };
  /** The implicit RespondToUser goal serving this cycle, resolved at its end. */
  implicitUri?: string;
  /** What decided the turn's goal (see {@link GoalCause}); set by the conversational tree. */
  cause?: GoalCause;
  /**
   * The supersession of idle competition losers (goal stack on, conversational
   * turn): the turn's winner and the number of turns after which a goal that
   * was neither chosen nor touched is abandoned.
   */
  supersede?: { afterTurns: number; winner: string };
}

/** The reason stamped on a goal that a newer intent has superseded. */
export const SUPERSEDED_REASON = 'superseded by newer intent';
/** Goal types the decision tree creates from an intent; only these are superseded. */
const SUPERSEDABLE_TYPES: ReadonlySet<string> = new Set([
  GOAL_TYPES.AnswerQuestion,
  GOAL_TYPES.ExecuteCommand,
  GOAL_TYPES.HandleRequest,
  GOAL_TYPES.AnswerInTopic,
]);
/** Most goals followed per session and user by the supersession bookkeeping. */
const MAX_TRACKED_GOALS = 200;

/**
 * Why the turn's goal is the goal: `cue` (the message closed the top goal),
 * `overlap` (its entities matched), `intent` (a new goal from the intent, or a
 * follow-up of the same kind) are caused by the user; `carry` (no link to the
 * message: the most recent open goal was kept), `armed` (a mandate or wake) and
 * `implicit` are not.
 */
type GoalCause = 'cue' | 'overlap' | 'intent' | 'carry' | 'armed' | 'implicit';

/** Per-turn observations the metacognition marker is derived from. */
interface TurnSignals {
  /** The top goal changed without a user trigger; undefined when not measured. */
  goalDrift?: boolean;
  /** Facts stored from this message, from the ingestion report. */
  storedFacts: number;
}

/** Sessions (per user) whose newest working graph the carry-over remembers. */
const LAST_CYCLE_MAX = 1000;
/** Most conflicts of one turn that become a `ResolveConflict` goal. */
const MAX_CONFLICT_GOALS = 3;
/** Priority of a `ResolveConflict` goal: below the 0.7 of a goal the user asked for. */
const CONFLICT_GOAL_PRIORITY = 0.5;
/** How many levels of parent goals reach the goalBuffer. */
const MAX_GOAL_PARENT_DEPTH = 5;

/** Most recent intent first (creation time), then higher priority. */
function byRecentIntent(a: Goal, b: Goal): number {
  return compareIsoDesc(a.createdAt, b.createdAt) || b.priority - a.priority;
}

/**
 * Instants measured in memory while a cycle runs; they become the phase
 * boundaries (see {@link CycleManager.writeCycleAndPhases}).
 */
interface PhaseMarks {
  cycleStart: Date;
  /** The perception record was computed (end of Phase 1). */
  perceivedAt?: Date;
  /** The goal hook started / returned (Phase 3). */
  goalStart?: Date;
  goalEnd?: Date;
  /** The core returned (end of Phase 5). */
  coreEnd?: Date;
}

/** A flagged impasse paired with the resolution its subcycle chose (F3). */
interface ResolvedImpasse {
  flaggedUri: string;
  resolved: boolean;
}

/** Tiny FNV-1a hash (hex). Used to fingerprint the already-redacted args brief. */
function fnv1aHex(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

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

/** Salience of the self-model entries written for the prompt assembler. */
/** Whether a completed tool call was refused by policy or by a missing approval (not an ordinary failure). */
function isConstraintDenial(e: Pick<ToolEpisodeEvent, 'denialClass'>): boolean {
  return e.denialClass === 'policy-denied' || e.denialClass === 'guardian-approval-required';
}

const SELF_SALIENCE = { capability: 0.7, restrictedTool: 0.8, constraint: 0.9 } as const;
/** Longest label / tool name rendered into the `[Self]` block, in characters. */
const SELF_LABEL_MAX = 120;
const SELF_NAME_MAX = 60;
/** At most this many derived tool capabilities are rendered per turn. */
const SELF_TOOL_CAP = 8;
/** The only words a tool's policy status renders as. */
const SELF_POLICY_WORDS: Readonly<Record<'allowed' | 'needs-approval' | 'denied', string>> = {
  allowed: 'allowed',
  'needs-approval': 'needs approval',
  denied: 'denied by default',
};

/**
 * What the prompt assembler produced next to the prompt actually sent (shadow
 * mode). Stored in the cycles graph by the queued persist.
 */
interface ShadowRecord {
  assembledText: string;
  tokens: number;
  droppedForeign: number;
  diff: BlockDiff;
  cut: Assembled['cut'];
}

/** New skill traces after which a consolidation is requested (doc 06 §5). */
export const CONSOLIDATION_TRACE_THRESHOLD = 50;
/** Most rows read from the previous cycle's graph for the live prompt. */
const CARRIED_PROMPT_READ = 20;

export interface CycleManagerOptions {
  /** Default for {@link RunCycleOptions.awaitPersist}; a per-call value wins. */
  awaitPersist?: boolean;
  /**
   * Key of the digests of masked tool arguments (procedural traces). Without a
   * source no digest is stored, only the path of the masked argument.
   */
  argDigestKey?: ArgDigestKeySource;
}

/** How many persist timings the manager keeps (a bounded ring). */
export const PERSIST_SAMPLE_CAP = 500;

/** Timing of one turn's queued persist: milliseconds, and full dumps the adapter wrote meanwhile (when it counts them). */
export interface PersistSample {
  ms: number;
  dumps?: number;
}

export class CycleManager {
  constructor(
    private readonly triplestore: TriplestoreAdapter,
    private readonly registry: GraphRegistry,
    private readonly agentId: string,
    /** Optional sink for cognitive-write failures (kept off the user path). */
    private readonly onError?: (err: unknown) => void,
    private readonly defaults: CycleManagerOptions = {},
  ) {}

  /**
   * Tail of the persistence queue per session: a cycle's records are written
   * only after the previous cycle of the same session finished writing, so the
   * episode chain and the prior-cycle satisfaction backfill keep their order.
   * Different sessions run independently.
   */
  private readonly persistTails = new Map<string, Promise<void>>();
  /**
   * The newest cycle whose working graph was written, per session and user, for
   * the carry-over into the next cycle. In memory: after a restart the first
   * cycle of a session simply has nothing to carry. Bounded.
   */
  private readonly lastCycle = new Map<string, string>();
  /**
   * The top (non-implicit) goal of the newest turn, per session and user, to tell
   * a goal drift from a goal the user chose. In memory and bounded: after a
   * restart the first turn has nothing to compare with and reports no drift.
   */
  private readonly lastTopGoal = new Map<string, string>();
  /**
   * (session, user) pairs whose stale implicit goals were already cleaned up by
   * this process (the first touch of a session; see {@link CycleManager.manageGoals}).
   */
  private readonly touchedGoalSessions = new Set<string>();
  /** Turn counter and per-goal last-activity turn, per session and user (see {@link supersedeIdleLosers}). */
  private readonly goalTurns = new Map<string, { turn: number; goals: Map<string, { lastActiveTurn: number; updatedAt: string }> }>();
  /** Background work (queued persists, triggered consolidations) not yet settled. */
  private readonly inFlight = new Set<Promise<unknown>>();

  private tracesSinceConsolidation = 0;
  private consolidationTrigger?: () => Promise<unknown>;
  private consolidationThreshold = CONSOLIDATION_TRACE_THRESHOLD;

  /**
   * Register the callback that runs a consolidation once enough new traces have
   * been written. The check is a counter increment; the callback does the work
   * (no model call) in the background and its failures go to `onError`.
   */
  setConsolidationTrigger(
    trigger: (() => Promise<unknown>) | undefined,
    threshold = CONSOLIDATION_TRACE_THRESHOLD,
  ): void {
    this.consolidationTrigger = trigger;
    this.consolidationThreshold = threshold;
  }

  private argDigestKey?: ArgDigestKeySource;

  /** Set the key source of the digests of masked arguments (see {@link CycleManagerOptions.argDigestKey}). */
  setArgDigestKey(source: ArgDigestKeySource | undefined): void {
    this.argDigestKey = source;
  }

  /** Reset the new-trace counter (a consolidation just ran, whoever started it). */
  resetTraceCounter(): void {
    this.tracesSinceConsolidation = 0;
  }

  private noteTracesWritten(n: number): void {
    if (n <= 0 || !this.consolidationTrigger) return;
    this.tracesSinceConsolidation += n;
    if (this.tracesSinceConsolidation < this.consolidationThreshold) return;
    this.tracesSinceConsolidation = 0;
    this.track(
      Promise.resolve()
        .then(() => this.consolidationTrigger?.())
        .catch((e) => this.onError?.(e)),
    );
  }

  private track<P extends Promise<unknown>>(p: P): P {
    this.inFlight.add(p);
    const done = () => {
      this.inFlight.delete(p);
    };
    p.then(done, done);
    return p;
  }

  /**
   * Resolve once every queued cycle record (and any triggered consolidation) has
   * settled. The runtime calls this on a clean stop so queued writes are not lost.
   */
  async flushPending(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight]);
    }
  }

  /** Newest persist timings, oldest first; bounded by {@link PERSIST_SAMPLE_CAP}. */
  private readonly persistLog: PersistSample[] = [];

  /**
   * The persist timings of the newest turns of this process (read-only copy,
   * oldest first, at most `limit`, never more than {@link PERSIST_SAMPLE_CAP}).
   * Numbers only: no text of any turn is kept here. In memory, so a restart
   * starts with an empty window.
   */
  recentPersists(limit: number = PERSIST_SAMPLE_CAP): PersistSample[] {
    const n = Number.isInteger(limit) ? Math.max(0, Math.min(limit, PERSIST_SAMPLE_CAP)) : PERSIST_SAMPLE_CAP;
    return n === 0 ? [] : this.persistLog.slice(-n).map((x) => ({ ...x }));
  }

  /** Run one turn's persist and record how long it took and how many dumps the adapter wrote meanwhile. */
  private async timePersist(job: () => Promise<void>): Promise<void> {
    const dumps = (): number | undefined => {
      const c = (this.triplestore as { dumpCount?: unknown }).dumpCount;
      return typeof c === 'number' ? c : undefined;
    };
    const t0 = performance.now();
    const d0 = dumps();
    try {
      await job();
    } finally {
      const d1 = dumps();
      this.persistLog.push({
        ms: Math.round((performance.now() - t0) * 100) / 100,
        ...(d0 !== undefined && d1 !== undefined ? { dumps: d1 - d0 } : {}),
      });
      if (this.persistLog.length > PERSIST_SAMPLE_CAP) this.persistLog.splice(0, this.persistLog.length - PERSIST_SAMPLE_CAP);
    }
  }

  /** Queue `job` behind the session's earlier jobs; resolves when `job` is done. */
  private enqueuePersist(sessionId: string, job: () => Promise<void>): Promise<void> {
    const prev = this.persistTails.get(sessionId) ?? Promise.resolve();
    // The tail never rejects: a failed job reports to onError and the queue goes on.
    const run = prev.then(job).catch((e) => this.onError?.(e));
    this.persistTails.set(sessionId, run);
    this.track(run);
    run.then(() => {
      if (this.persistTails.get(sessionId) === run) this.persistTails.delete(sessionId);
    });
    return run;
  }

  private readonly logger = createLogger('cognitive-cycle');

  /**
   * Run one cognitive cycle around `core`. The user-visible result is whatever
   * `core` returns (or throws); cognitive bookkeeping is best-effort.
   *
   * `sessionIdOf` extracts the resolved session id from the core result so the
   * per-session cognitive graphs can be addressed.
   */
  async runCycle<T>(
    envelope: MessageEnvelope,
    core: CoreFn<T>,
    sessionIdOf: (result: T) => string,
    responseTextOf?: (result: T) => string | undefined,
    options: RunCycleOptions = {},
  ): Promise<T> {
    const cycle = this.openCycle(envelope, options);
    let result: T;
    let coreError: unknown;
    let status: 'completed' | 'aborted' = 'completed';
    try {
      result = await core(cycle.recordTool, cycle.prepareGoals, cycle.recordInbound, cycle.perceive, cycle.comprehend, cycle.onToolCall);
    } catch (e) {
      status = 'aborted';
      coreError = e;
      result = undefined as unknown as T;
    }
    let sessionId = 'unknown';
    let responseText: string | undefined;
    try {
      sessionId =
        (status === 'completed' && result !== undefined ? sessionIdOf(result) : undefined) ||
        envelope.routingHints?.sessionId ||
        'unknown';
      responseText =
        status === 'completed' && result !== undefined ? responseTextOf?.(result) : undefined;
    } catch (extractErr) {
      this.onError?.(extractErr);
    }
    await cycle.finish(status, sessionId, responseText);

    if (coreError) throw coreError;
    return result;
  }

  /**
   * Run one cognitive cycle around a streaming core. Every chunk the core
   * yields is passed on unchanged and as it arrives; the cycle only observes
   * it. The cycle is closed after the stream ends: `completed` when the core
   * finished or the consumer stopped after the final chunk, `aborted` when the
   * core threw or the consumer stopped iterating (or aborted) before it. The
   * records are queued like a non-stream cycle's. A core error is re-thrown to
   * the consumer after the cycle is closed.
   *
   * `describe` reads a chunk and reports the session id it carries, the final
   * response text, and whether the chunk is the final one; the last value seen
   * for each wins.
   */
  async *runCycleStream<C>(
    envelope: MessageEnvelope,
    core: StreamCoreFn<C>,
    describe: (chunk: C) => { sessionId?: string; text?: string; final?: boolean } | undefined,
    options: RunCycleOptions = {},
  ): AsyncGenerator<C> {
    const cycle = this.openCycle(envelope, options);
    let sessionId: string | undefined;
    let responseText: string | undefined;
    let sawFinal = false;
    let coreDone = false;
    let coreFailed = false;
    let status: 'completed' | 'aborted';
    const inner = core(cycle.recordTool, cycle.prepareGoals, cycle.recordInbound, cycle.perceive, cycle.comprehend);
    try {
      for await (const chunk of inner) {
        try {
          const d = describe(chunk);
          if (d?.sessionId) sessionId = d.sessionId;
          if (d?.text !== undefined) responseText = d.text;
          if (d?.final) sawFinal = true;
        } catch (extractErr) {
          this.onError?.(extractErr);
        }
        yield chunk;
      }
      coreDone = true;
    } catch (e) {
      coreFailed = true;
      throw e;
    } finally {
      // Reached on normal end, on a core error and when the consumer stops early.
      status = !coreFailed && (coreDone || sawFinal) ? 'completed' : 'aborted';
      await cycle.finish(
        status,
        sessionId || envelope.routingHints?.sessionId || 'unknown',
        status === 'completed' ? responseText : undefined,
      );
    }
  }

  /**
   * Set up one cycle: the per-cycle tool sink, the goal hook and the inbound
   * episode recorder, plus `finish`, which closes the cycle and queues its
   * records. Shared by {@link runCycle} and {@link runCycleStream}.
   */
  private openCycle(envelope: MessageEnvelope, options: RunCycleOptions) {
    const cycleId = `cyc-${newId()}`;
    const cycleUri = `urn:${this.agentId}:cog:cycle:${cycleId}`;
    const startedAt = new Date();
    this.logger.info({ agent: this.agentId, cycleId, phase: 'perception' }, `cycle ${cycleId} started`);
    const emitPhase = (phase: 'perception' | 'goal_management' | 'reflection', label: string, data?: unknown) => {
      try { options.onPhase?.(phase, label, data); } catch { /* status UI is best-effort */ }
    };
    emitPhase('perception', 'Perception');

    // Buffer tool events so they can be written as episodes in temporal order
    // after the core completes (see writeEpisodicAndRetrieval). The closure is
    // per-cycle, so concurrent cycles never share state.
    const toolEvents: ToolEpisodeEvent[] = [];
    // Action buffer (docs/cognitive-architecture/04): one masked proposal and one
    // result per tool call, kept in memory here and written by the queued persist.
    // Both cores (runCore, streamCore) report every call through `recordTool`, so
    // this one observer covers the blocking and the streamed turn alike.
    const actionCalls = new Map<string, ActionCall>();
    const noteAction = (ev: ToolEpisodeEvent): void => {
      try {
        if (ev.phase === 'called') {
          if (actionCalls.has(ev.callId) || actionCalls.size >= MAX_ACTION_CALLS) return;
          const redacted =
            ev.args !== undefined
              ? redactToolArgs(ev.args, defaultArgRedactionRules())
              : {
                  brief: looksLikeSecret(ev.argsBrief) ? '' : String(ev.argsBrief ?? '').replace(/[^A-Za-z0-9_, -]/g, '_').slice(0, 400),
                  masked: [] as Array<{ path: string }>,
                };
          actionCalls.set(ev.callId, {
            callId: ev.callId,
            toolName: ev.toolName,
            brief: redacted.brief,
            maskedPaths: redacted.masked.map((m) => m.path),
            ...(activeGoalUri ? { forGoal: activeGoalUri } : {}),
          });
          return;
        }
        const call = actionCalls.get(ev.callId);
        if (!call) return;
        call.result = {
          outcome: ev.outcome === 'success' ? 'success' : 'error',
          ...(ev.denialClass ? { denialClass: ev.denialClass } : {}),
          ...(ev.durationMs !== undefined ? { durationMs: ev.durationMs } : {}),
        };
      } catch (e) {
        this.onError?.(e);
      }
    };
    // Phase 3/4 (Phase D). The core invokes this once the session is resolved;
    // it runs the goal decision tree and hands back the `[Active goal]` prompt
    // text. The chosen goal's URI is captured per-cycle so Phase 5 can backfill
    // `cogt:partOfGoal` onto this turn's episodes. Disabled => no goal work.
    let activeGoalUri: string | undefined;
    let activeGoalType: string | undefined;
    // Set when Phase 3 sees more than one substantive active goal — a
    // goal-conflict impasse signal for the metacognitive subcycle (F2).
    let goalConflict = false;
    // Goal lifecycle records of this turn, written by the queued persist.
    const goalExtras: GoalExtras = { events: [] };
    const mode = options.mode ?? 'conversational';
    // Metacognition signals of a conversational turn (docs/cognitive-architecture
    // 08 §3, §7). With the flag off none of this state is ever filled or written.
    const mcOn = options.metacognitionEnabled === true && mode === 'conversational';
    const signals: TurnSignals = { storedFacts: 0 };
    // Meta entries collected during the turn; the queued persist writes them.
    const metaWm: WMEntryInput[] = [];
    // Churn warning (metacognition): one entry per turn, at the fifth tool call.
    // The calls are counted in the tool sink below, which the blocking and the
    // streamed core both report through; `onToolCall` (the blocking core's own
    // count) feeds the same guard, so a turn never gets two.
    let churnWritten = false;
    const noteToolCount = (callCount: number): void => {
      if (!mcOn || churnWritten || callCount < CHURN_TOOL_CALLS) return;
      churnWritten = true; // once per turn
      metaWm.push({
        buffer: 'metaBuffer',
        entryKind: CHURN_ENTRY_KIND,
        payload: CHURN_NOTE_TEXT,
        salience: CHURN_SALIENCE,
        carryForward: false,
      });
    };
    const onToolCall: ToolCallHook = noteToolCount;
    const calledIds = new Set<string>();
    const recordTool: ToolEpisodeRecorder = (ev) => {
      noteAction(ev);
      if (ev.phase === 'called' && !calledIds.has(ev.callId)) {
        calledIds.add(ev.callId);
        noteToolCount(calledIds.size);
      }
      if (ev.args !== undefined && options.proceduralEnabled !== true) {
        const { args: _dropped, ...rest } = ev;
        toolEvents.push(rest);
        return;
      }
      toolEvents.push(ev);
    };
    // Phase 1 (perception) in memory, plus the phase boundaries measured as the
    // hooks run. `perceivedAt` closes Phase 1; the goal hook brackets Phase 3.
    let perception: Perception | undefined;
    const marks: PhaseMarks = { cycleStart: startedAt };
    const perceive: PerceptionRecorder = (source) => {
      signals.storedFacts = source.storedFactCount ?? source.storedClaims.length;
      perception = buildPerception(
        {
          text: envelope.text || '',
          senderId: envelope.sender?.id,
          senderIsOwner: envelope.sender?.isOwner === true,
          channel: envelope.channel ? String(envelope.channel) : undefined,
        },
        source,
      );
      marks.perceivedAt = new Date();
      return perception;
    };
    let inboundEpisodeUri: string | undefined;
    // Phase 2 in memory. Read-only: the result is kept for the later phases and
    // written to the retrieval buffer by the queued persist.
    let comprehension: ComprehensionResult | undefined;
    // Set when Phase 2 already looked up the pending entities to the end, so the
    // queued persist does not repeat the lookup.
    let pendingResolved = false;
    const comprehendHook: ComprehensionRecorder = async (sessionId) => {
      if (mode !== 'conversational') return undefined;
      try {
        const userKey = cogUserKey(envelope.sender);
        // The active goal for this sender (read-only); the implicit
        // RespondToUser goal is filtered out by comprehend().
        let goal: Goal | undefined;
        if (options.goalsEnabled) {
          try {
            const active = await new GoalStack(
              this.triplestore,
              this.registry,
              this.agentId,
              sessionId,
              undefined,
              this.viewerOf(envelope),
            ).active();
            goal = active.find((g) => g.goalType !== RESPOND_TO_USER);
          } catch (e) {
            this.onError?.(e);
          }
        }
        const result = await comprehend(
          {
            episodic: new EpisodicMemory(this.triplestore, this.agentId),
            entityFacts: options.entityFacts,
            resolveEntities: options.resolveEntities,
            onError: (e) => this.onError?.(e),
          },
          {
            userKey,
            sessionId,
            perception,
            activeGoalUri: goal?.uri,
            activeGoalType: goal?.goalType,
            inboundEpisodeUri,
            episodicEnabled: options.episodicEnabled !== false,
          },
        );
        comprehension = result;
        if (result.pendingResolved && result.perception) {
          perception = result.perception;
          pendingResolved = true;
        }
        return result;
      } catch (e) {
        this.onError?.(e);
        return undefined;
      }
    };
    // Prompt assembler (docs/cognitive-architecture/09 §2). Only conversational
    // turns use it; an unattended cycle always keeps the legacy strings.
    const promptMode: PromptMode = mode === 'conversational' ? (options.promptMode ?? 'off') : 'off';
    const userKey = cogUserKey(envelope.sender);
    // Goal and self entries produced for the assembler; the queued persist writes
    // them to working memory (nothing is awaited before the LLM call for them).
    const queuedWm: WMEntryInput[] = [];
    // Goal / skill / self entries of the in-memory working-memory view.
    const phaseView: WorkspaceEntry[] = [];
    let shadow: ShadowRecord | undefined;
    // Suggestions the Phase 3 hook produced, and the tools among them that the
    // final prompt really shows (decided in prepareGoals).
    let suggestionItems: Array<{ text: string; tools: string[] }> = [];
    let shownTools: string[] | undefined;
    // The live prompt builds each cognitive block from its own flag, so the
    // skills and self blocks no longer wait for the goal stack. With the goal
    // stack off the goal blocks are absent and the goal type is unknown. The
    // shadow and legacy paths keep their old dependency on the goal stack.
    const goalsOn = options.goalsEnabled === true;
    const decoupled = promptMode === 'live' && mode === 'conversational';
    const prepareGoalsInner: GoalContextProvider = async (sessionId) => {
      if (!goalsOn && !decoupled) return undefined;
      try {
        const sections: string[] = [];
        let goalType: string | undefined;
        if (goalsOn) {
          const gs = new GoalStack(
            this.triplestore,
            this.registry,
            this.agentId,
            sessionId,
            undefined,
            this.viewerOf(envelope),
            // Episodes of this turn's transitions are written by the queued persist.
            (t) => {
              goalExtras.events.push(t);
            },
          );
          const managed =
            mode === 'conversational'
              ? await this.manageConversationalGoals(gs, envelope, sessionId, startedAt, perception, goalExtras)
              : await this.manageInitiativeGoals(gs, options.initiativeGoalUri);
          const goal = managed.goal;
          goalConflict = managed.conflict;
          if (mcOn) signals.goalDrift = this.noteTopGoal(sessionId, userKey, goal, goalExtras.cause);
          activeGoalUri = goal.uri;
          activeGoalType = goal.goalType;
          goalType = goal.goalType;
          if (mode === 'conversational' && (options.goalSupersedeAfterTurns ?? 0) > 0) {
            goalExtras.supersede = { afterTurns: options.goalSupersedeAfterTurns as number, winner: goal.uri };
          }
          emitPhase('goal_management', 'Deliberation', { goalType: goal.goalType });
          sections.push(this.renderActiveGoal(goal));
          if (promptMode !== 'off') {
            const body = sections[0].slice('[Active goal]\n'.length);
            phaseView.push({ buffer: 'goalBuffer', entryKind: 'goal-active', text: body, salience: goalSalience(0), forUser: userKey });
            queuedWm.push({ buffer: 'goalBuffer', entryKind: 'goal-active', payload: body, salience: goalSalience(0), forGoal: goal.uri });
            // Parents of the top goal, nearest first (doc 04 §4).
            for (const p of await this.goalParents(gs, goal)) {
              phaseView.push({ buffer: 'goalBuffer', entryKind: 'goal-parent', text: p.text, salience: p.salience, forUser: userKey });
              queuedWm.push({ buffer: 'goalBuffer', entryKind: 'goal-parent', payload: p.text, salience: p.salience, forGoal: p.uri });
            }
          }
        }
        // E4 — bias action selection with learned skills for this goal type.
        if (options.proceduralEnabled) {
          const skillsText = await this.surfaceSkillSuggestions(
            sessionId,
            cycleId,
            cycleUri,
            goalType,
            cogUserKey(envelope.sender),
          );
          if (skillsText) {
            sections.push(skillsText.text);
            suggestionItems = skillsText.items.map((it) => ({ text: it.text, tools: it.tools }));
            if (promptMode !== 'off') {
              // Written to working memory by surfaceSkillSuggestions as before.
              for (const it of skillsText.items) {
                phaseView.push({
                  buffer: 'retrievalBuffer',
                  entryKind: it.kind,
                  text: it.text,
                  salience: it.score,
                  retrievalScore: it.score,
                  agentLevel: true,
                  forUser: userKey,
                });
              }
            }
          }
        }
        // G2 — seed the `[Self]` block from the queryable self-model.
        if (options.selfModelEnabled) {
          const selfText = await this.renderSelfBlock(goalType);
          if (selfText) {
            sections.push(selfText.text);
            if (promptMode !== 'off') {
              const add = (entryKind: 'capability' | 'constraint', text: string, salience: number) => {
                phaseView.push({ buffer: 'selfBuffer', entryKind, text, salience, agentLevel: true, forUser: userKey });
                queuedWm.push({ buffer: 'selfBuffer', entryKind, payload: text, salience });
              };
              for (const c of selfText.caps) add('capability', c.text, c.salience);
              for (const c of selfText.cons) add('constraint', c, SELF_SALIENCE.constraint);
            }
          }
        }
        return sections.length > 0 ? sections.join('\n\n') : undefined;
      } catch (e) {
        this.onError?.(e);
        return undefined;
      }
    };
    // The suggested tools whose line is in the prompt that goes out.
    const noteShown = (promptText: string | undefined): void => {
      const tools = new Set<string>();
      if (promptText) {
        for (const it of suggestionItems) {
          if (promptText.includes(`• ${it.text}`)) for (const t of it.tools) tools.add(t);
        }
      }
      shownTools = tools.size > 0 ? [...tools] : undefined;
    };
    const prepareGoals: GoalContextProvider = async (sessionId) => {
      marks.goalStart = new Date();
      suggestionItems = [];
      shownTools = undefined;
      try {
        const legacy = await prepareGoalsInner(sessionId);
        if (promptMode === 'off') {
          noteShown(legacy);
          return legacy;
        }
        // The "I don't know" nudge: recorded in shadow for every user; in live
        // mode it reaches the prompt of the owner, or of everyone when the
        // setup key says so (canary).
        const unknown = mcOn && isUnknownQuestion(perception?.intent, comprehension);
        const unknownNudge =
          unknown && (promptMode === 'shadow' || userKey === OWNER_USER_KEY || options.unknownNudgeAllUsers === true);
        // Live prompt: what the previous cycle of this session and user carries
        // forward (read-only, bounded, scoped to the sender).
        const carried =
          promptMode === 'live'
            ? await this.carriedPromptEntries(sessionId, userKey, options.promptSettings?.theta ?? DEFAULT_THETA, cycleId)
            : [];
        const composed = this.composeCognitivePrompt(promptMode, legacy, {
          perception,
          comprehension,
          phaseView: carried.length > 0 ? [...phaseView, ...carried] : phaseView,
          userKey,
          unknownNudge,
          options,
          setShadow: (r) => {
            shadow = r;
          },
          cycleId,
        });
        noteShown(composed);
        return composed;
      } finally {
        marks.goalEnd = new Date();
      }
    };

    // The inbound episode is written ahead of the core (conversational turns
    // only) so tools can reference it as a goal mandate. persist() reuses it
    // instead of writing a second one.
    // (declared above, before the Phase 2 hook that must exclude it)
    // The `about` the inbound episode was written with (before resolution).
    let inboundAbout: string[] = [];
    const recordInbound: InboundEpisodeRecorder = async (sessionId) => {
      if (mode !== 'conversational') return undefined;
      if (options.episodicEnabled === false) return undefined;
      if (inboundEpisodeUri) return inboundEpisodeUri;
      try {
        inboundEpisodeUri = await this.appendInboundEpisode(
          envelope,
          sessionId,
          cycleId,
          startedAt,
          activeGoalUri,
          perception,
        );
        inboundAbout = perception?.about ?? [];
      } catch (e) {
        this.onError?.(e);
      }
      return inboundEpisodeUri;
    };

    const finish = async (
      status: 'completed' | 'aborted',
      sessionId: string,
      responseText: string | undefined,
    ): Promise<void> => {
      const endedAt = new Date();
      const durationMs = endedAt.getTime() - startedAt.getTime();
      if (status === 'aborted') {
        this.logger.error({ agent: this.agentId, cycleId, durationMs }, `cycle ${cycleId} aborted`);
      } else {
        this.logger.info({ agent: this.agentId, cycleId, phase: 'reflection', durationMs }, `cycle ${cycleId} completed in ${durationMs}ms`);
        emitPhase('reflection', 'Reflection');
      }
      // The "I don't know" entry (question intent and an empty retrieval) and the
      // churn warning, written by the queued persist; none with metacognition off.
      const metaEntries: WMEntryInput[] = [];
      if (mcOn) {
        if (isUnknownQuestion(perception?.intent, comprehension)) {
          metaEntries.push({
            buffer: 'metaBuffer',
            entryKind: UNKNOWN_NUDGE_ENTRY_KIND,
            payload: UNKNOWN_NUDGE_TEXT,
            salience: UNKNOWN_NUDGE_SALIENCE,
            carryForward: false,
          });
        }
        metaEntries.push(...metaWm);
      }
      // The action buffer of the turn: proposal (phase 4) then result (phase 5) per call.
      const actions: Array<{ phase: 4 | 5; entry: WMEntryInput }> = [];
      for (const c of actionCalls.values()) {
        actions.push({
          phase: 4,
          entry: {
            buffer: 'actionBuffer',
            entryKind: 'action-proposal',
            payload: proposalPayload(c),
            salience: ACTION_SALIENCE,
            toolName: safeToolName(c.toolName),
            callId: c.callId,
            toolArgs: c.brief,
            ...(c.forGoal ? { forGoal: c.forGoal } : {}),
          },
        });
        if (c.result) {
          actions.push({
            phase: 5,
            entry: {
              buffer: 'actionBuffer',
              entryKind: 'action-result',
              payload: resultPayload(c, c.result),
              salience: ACTION_SALIENCE,
              toolName: safeToolName(c.toolName),
              callId: c.callId,
              outcome: c.result.outcome,
              ...(c.result.denialClass ? { denialClass: safeToolName(c.result.denialClass) } : {}),
              ...(c.result.durationMs !== undefined ? { durationMs: c.result.durationMs } : {}),
              ...(c.forGoal ? { forGoal: c.forGoal } : {}),
            },
          });
        }
      }
      const queued = this.enqueuePersist(sessionId, () =>
        this.timePersist(() => this.persist(
          envelope,
          sessionId,
          cycleId,
          cycleUri,
          startedAt,
          endedAt,
          status,
          responseText,
          toolEvents,
          activeGoalUri,
          activeGoalType,
          options.proceduralEnabled === true,
          options.metacognitionEnabled === true,
          goalConflict,
          options.selfModelEnabled === true,
          mode,
          options.initiativeGoalUri,
          inboundEpisodeUri,
          options.episodicEnabled !== false,
          perception,
          { ...marks, coreEnd: endedAt },
          pendingResolved ? undefined : options.resolveEntities,
          inboundAbout,
          comprehension,
          {
            wm: queuedWm,
            actions,
            ...(shownTools ? { suggestedTools: shownTools } : {}),
            meta: metaEntries,
            ...(mcOn ? { signals, conflictGoals: options.goalsEnabled === true } : {}),
            shadow,
            goal: goalExtras,
            ...(mode === 'conversational' && options.attention
              ? { attention: options.attention, goalsEnabled: options.goalsEnabled === true }
              : {}),
          },
        )),
      );
      if (options.awaitPersist ?? this.defaults.awaitPersist ?? false) await queued;
    };

    return { recordTool, prepareGoals, recordInbound, perceive, comprehend: comprehendHook, onToolCall, finish };
  }

  /**
   * Phase 3 of an unattended initiative cycle (docs/initiative-architecture.md
   * §6): the triggering goal is the active context and the implicit
   * RESPOND_TO_USER goal is NEVER seeded — there is no user to respond to.
   */
  private async manageInitiativeGoals(
    gs: GoalStack,
    initiativeGoalUri?: string,
  ): Promise<{ goal: Goal; conflict: boolean }> {
    const active = await gs.active();
    const substantives = active.filter((g) => g.goalType !== RESPOND_TO_USER);
    if (initiativeGoalUri) {
      const triggering = await gs.get(initiativeGoalUri);
      if (triggering) return { goal: triggering, conflict: substantives.length > 1 };
    }
    if (substantives.length > 0) return { goal: substantives[0], conflict: substantives.length > 1 };
    if (active.length > 0) return { goal: active[0], conflict: false };
    // No goal at all is not expected (the trigger came from a due wake); fall
    // back to the implicit goal only as a last resort so the cycle can run.
    return { goal: await gs.ensureImplicit(), conflict: false };
  }

  /**
   * Phase 3 of a conversational turn — the goal decision tree (doc 07 §5; see
   * GoalLifecycle.ts for the rules). Only goals that belong to the sender take
   * part: the owner's view also holds other users' goals, which a turn of the
   * owner must neither continue, close nor compete with.
   *
   *  0. First touch of the session by this process: implicit goals left over
   *     from earlier cycles are resolved (no migration needed).
   *  1. A satisfaction cue resolves, a cancel cue abandons the top goal. Armed
   *     goals (owner mandate / wake) are left to their tools.
   *  2. Entities of the message overlap a goal's entities: continue that goal.
   *     Else the intent creates a new goal (question, command, request,
   *     topic-reference); chit-chat and feedback create none. A follow-up
   *     without entities of the same goal type as the latest goal continues it.
   *  Otherwise the earlier behaviour: continue an active goal, else the
   *  implicit RespondToUser goal, which is resolved when the cycle ends.
   *
   * When several goals compete, the one with the most recent intent wins and a
   * `cogt:ChooseGoal` record names the winner and the losers.
   */
  private async manageConversationalGoals(
    gs: GoalStack,
    envelope: MessageEnvelope,
    sessionId: string,
    cycleStart: Date,
    perception: Perception | undefined,
    extras: GoalExtras,
  ): Promise<{ goal: Goal; conflict: boolean }> {
    const userKey = cogUserKey(envelope.sender);
    const text = envelope.text || '';

    // 0. Hygiene on the first touch of the session by this process.
    const touched = `${sessionId}\u0000${userKey}`;
    if (!this.touchedGoalSessions.has(touched)) {
      if (this.touchedGoalSessions.size >= 5000) this.touchedGoalSessions.clear();
      this.touchedGoalSessions.add(touched);
      try {
        await gs.resolveStaleImplicit(cycleStart, new Date(), userKey);
      } catch (e) {
        this.onError?.(e);
      }
    }

    const intent = perception?.intent ?? classifyIntent(text);
    const about = perception?.about ?? [];
    const mine = (await gs.active()).filter((g) => goalBelongsTo(g, userKey));
    const isArmed = (g: Goal) => g.mandatedBy !== undefined || g.wakeAt !== undefined || g.wakeEvery !== undefined;
    const armed = mine.filter((g) => g.goalType !== RESPOND_TO_USER && isArmed(g));
    let candidates = mine.filter((g) => g.goalType !== RESPOND_TO_USER && !isArmed(g)).sort(byRecentIntent);

    // 1. The user closes the top goal.
    const signal = detectGoalSignal(text, intent);
    if (signal && candidates.length === 0) {
      // A closer with nothing to close creates no goal ("passt" is not a topic).
      if (armed[0]) {
        extras.cause = 'armed';
        return { goal: armed[0], conflict: false };
      }
      return this.implicitGoal(gs, userKey, extras);
    }
    if (signal) {
      const [top, ...rest] = candidates;
      await gs.setStatus(top.uri, signal === 'satisfied' ? 'resolved' : 'abandoned');
      candidates = rest;
      const next = candidates[0] ?? armed[0];
      if (next) {
        extras.cause = 'cue';
        return { goal: next, conflict: false };
      }
      return this.implicitGoal(gs, userKey, extras);
    }

    // 2a. Continue a goal whose entities overlap the message's entities.
    const overlapping = candidates
      .filter((g) => entityOverlap(g.about, about) > 0)
      .sort((a, b) => entityOverlap(b.about, about) - entityOverlap(a.about, about) || byRecentIntent(a, b));
    if (overlapping.length > 0) {
      const winner = overlapping[0];
      extras.cause = 'overlap';
      return this.decided(winner, overlapping.slice(1), extras);
    }

    // 2b. A new goal from the intent; it is the most recent intent, so it wins.
    // A message without entities of its own that asks for the same kind of goal
    // as the most recent one is a follow-up ("and how fast is it?"): it
    // continues that goal instead of stacking a second one of the same type.
    const wanted = goalFromIntent(intent, text);
    const followUp = wanted !== undefined && about.length === 0 && candidates[0]?.goalType === wanted.goalType;
    if (wanted && !followUp) {
      const actor = envelope.sender?.id
        ? `urn:entity:agent-sender:${encodeURIComponent(envelope.sender.id)}`
        : undefined;
      const uri = await gs.push({
        goalType: wanted.goalType,
        goalLabel: wanted.label,
        priority: 0.7,
        triggeredByUser: actor,
        forUser: userKey,
        about,
      });
      const created = await gs.get(uri);
      if (created) {
        extras.cause = 'intent';
        return this.decided(created, candidates, extras);
      }
    }

    // No new goal: keep the earlier behaviour. A follow-up of the same kind is
    // the user's doing; keeping the latest goal with no link to the message is not.
    if (candidates.length > 0) {
      extras.cause = wanted && followUp ? 'intent' : 'carry';
      return this.decided(candidates[0], candidates.slice(1), extras);
    }
    if (armed.length > 0) {
      extras.cause = 'armed';
      return { goal: armed[0], conflict: armed.length > 1 };
    }
    return this.implicitGoal(gs, userKey, extras);
  }

  /**
   * Goal drift: the turn's top goal differs from the newest turn's top goal of
   * this session and user, and the user did not cause the change (see
   * {@link GoalCause}). The implicit RespondToUser goal is no top goal, so a turn
   * that ends on it neither drifts nor leaves anything to compare with.
   */
  private noteTopGoal(sessionId: string, userKey: string, goal: Goal, cause: GoalCause | undefined): boolean {
    const key = `${sessionId}\u0000${userKey}`;
    const previous = this.lastTopGoal.get(key);
    const top = goal.goalType === RESPOND_TO_USER ? undefined : goal.uri;
    const drift =
      previous !== undefined && top !== undefined && top !== previous && (cause === 'carry' || cause === 'armed');
    this.lastTopGoal.delete(key);
    if (top !== undefined) {
      this.lastTopGoal.set(key, top);
      if (this.lastTopGoal.size > LAST_CYCLE_MAX) {
        const oldest = this.lastTopGoal.keys().next().value;
        if (oldest !== undefined) this.lastTopGoal.delete(oldest);
      }
    }
    return drift;
  }

  /** The goal of the turn when `losers` competed with it: record the choice. */
  private decided(winner: Goal, losers: Goal[], extras: GoalExtras): { goal: Goal; conflict: boolean } {
    if (losers.length === 0) return { goal: winner, conflict: false };
    extras.choice = { winner: winner.uri, losers: losers.map((g) => g.uri) };
    return { goal: winner, conflict: true };
  }

  /** The implicit RespondToUser goal of this cycle; resolved when the cycle ends. */
  private async implicitGoal(
    gs: GoalStack,
    userKey: string,
    extras: GoalExtras,
  ): Promise<{ goal: Goal; conflict: boolean }> {
    const goal = await gs.ensureImplicit(new Date(), userKey);
    extras.cause = 'implicit';
    if (goal.goalType === RESPOND_TO_USER) extras.implicitUri = goal.uri;
    return { goal, conflict: false };
  }

  /**
   * Parents of `goal` for the goalBuffer, nearest first: 0.7, minus 0.1 per
   * further level, never below 0.3 ({@link goalSalience}). Read through the
   * viewer-scoped stack, so a parent the sender may not see is not followed.
   */
  private async goalParents(
    gs: GoalStack,
    goal: Goal,
  ): Promise<Array<{ uri: string; text: string; salience: number }>> {
    const out: Array<{ uri: string; text: string; salience: number }> = [];
    const seen = new Set<string>([goal.uri]);
    let cur = goal;
    for (let depth = 1; depth <= MAX_GOAL_PARENT_DEPTH && cur.parentGoal; depth++) {
      if (seen.has(cur.parentGoal)) break;
      const parent = await gs.get(cur.parentGoal);
      if (!parent) break;
      seen.add(parent.uri);
      const shortType = parent.goalType.split('/').pop() ?? parent.goalType;
      out.push({ uri: parent.uri, text: `${parent.goalLabel} (type: ${shortType})`, salience: goalSalience(depth) });
      cur = parent;
    }
    return out;
  }

  /**
   * Goal-competition losers (docs/cognitive-architecture/07 §5): a goal that
   * lost to a newer intent stays active until something closes it. One turn of
   * the session and user is counted per call. A substantive goal the user's
   * decision tree created (not armed, not long-term, not the turn's winner) that
   * was neither chosen nor touched (its `updatedAt` unchanged) for `afterTurns`
   * turns is abandoned with {@link SUPERSEDED_REASON}, and the goal-abandoned
   * episode is written for the goal's owner.
   *
   * The bookkeeping is in memory and bounded: a goal is first seen at the turn
   * this process first reads it, so a restart only delays an abandonment, never
   * hastens one. Goals with a mandate or a wake belong to the owner's order and
   * are never superseded here.
   */
  private async supersedeIdleLosers(
    envelope: MessageEnvelope,
    sessionId: string,
    rule: { afterTurns: number; winner: string },
  ): Promise<GoalTransition[]> {
    const userKey = cogUserKey(envelope.sender);
    const key = `${sessionId}\u0000${userKey}`;
    let track = this.goalTurns.get(key);
    if (!track) {
      track = { turn: 0, goals: new Map() };
      this.goalTurns.set(key, track);
      if (this.goalTurns.size > LAST_CYCLE_MAX) {
        const oldest = this.goalTurns.keys().next().value;
        if (oldest !== undefined) this.goalTurns.delete(oldest);
      }
    }
    track.turn++;
    const transitions: GoalTransition[] = [];
    const gs = new GoalStack(
      this.triplestore,
      this.registry,
      this.agentId,
      sessionId,
      undefined,
      this.viewerOf(envelope),
      (t) => {
        transitions.push({ ...t, reason: SUPERSEDED_REASON });
      },
    );
    const active = (await gs.active()).filter((g) => g.goalType !== RESPOND_TO_USER && goalBelongsTo(g, userKey));
    const live = new Set(active.map((g) => g.uri));
    for (const uri of [...track.goals.keys()]) if (!live.has(uri)) track.goals.delete(uri);
    for (const g of active) {
      let rec = track.goals.get(g.uri);
      if (!rec) {
        if (track.goals.size >= MAX_TRACKED_GOALS) continue;
        rec = { lastActiveTurn: track.turn, updatedAt: g.updatedAt };
        track.goals.set(g.uri, rec);
        continue;
      }
      if (g.uri === rule.winner || compareIso(g.updatedAt, rec.updatedAt) !== 0) {
        rec.lastActiveTurn = track.turn;
        rec.updatedAt = g.updatedAt;
        continue;
      }
      const armed = g.mandatedBy !== undefined || g.wakeAt !== undefined || g.wakeEvery !== undefined;
      if (armed || g.longTerm === true || !SUPERSEDABLE_TYPES.has(g.goalType)) continue;
      if (track.turn - rec.lastActiveTurn < rule.afterTurns) continue;
      await gs.setStatus(g.uri, 'abandoned', SUPERSEDED_REASON);
      track.goals.delete(g.uri);
    }
    // The caller writes the episodes of these transitions, in its episode batch.
    return transitions;
  }

  /** `cogt:ChooseGoal`: which goal won a competition, which lost, and why. */
  private async writeChooseGoal(
    sessionId: string,
    cycleUri: string,
    userKey: string,
    choice: NonNullable<GoalExtras['choice']>,
  ): Promise<void> {
    const graph = GraphUriResolver.getCogCyclesGraph(this.agentId, sessionId);
    this.registry.assertWritable(graph);
    const uri = `${cycleUri}_choose`;
    const lines = [
      `<${uri}> <${RDF_TYPE}> <${COGT}ChooseGoal> .`,
      `<${uri}> <${COGT}partOfCycle> <${cycleUri}> .`,
      `<${uri}> <${COGT}forUser> "${escapeLiteral(userKey)}" .`,
      `<${uri}> <${COGT}createdAt> "${new Date().toISOString()}"^^<${XSD}dateTime> .`,
      `<${uri}> <${COGT}winner> ${sparqlIri(choice.winner)} .`,
      `<${uri}> <${COGT}chosenBecause> "most-recent-intent" .`,
    ];
    for (const l of choice.losers) lines.push(`<${uri}> <${COGT}loser> ${sparqlIri(l)} .`);
    await this.triplestore.update(`INSERT DATA { GRAPH <${graph}> {\n${lines.join('\n')}\n} }`);
  }

  /**
   * The entries the previous cycle of this session and user carries into this
   * one, for the live prompt (docs/cognitive-architecture/04 §11). The carry
   * itself is written by the queued persist after the turn, so the prompt reads
   * the previous graph and applies the carry rule: flagged (`carryForward`),
   * not expired, written for exactly this sender, with the carry decay on the
   * salience, kept only above θ. Self and goal entries are rebuilt every turn
   * and are not read; the nudge kinds are fixed sentences of the current turn.
   * Read-only, at most {@link CARRIED_PROMPT_READ} rows, text neutralised. A
   * failed or empty read gives no entries and never reaches the reply.
   */
  private async carriedPromptEntries(
    sessionId: string,
    userKey: string,
    theta: number,
    cycleId: string,
  ): Promise<WorkspaceEntry[]> {
    try {
      if (userKey === '') return [];
      const prevCycleId = this.lastCycle.get(`${sessionId}\u0000${userKey}`);
      if (!prevCycleId || prevCycleId === cycleId) return [];
      const prev = new WorkingMemory(this.triplestore, this.registry, this.agentId, sessionId, prevCycleId, userKey);
      const rows = await prev.read({ carryForwardOnly: true, forUser: userKey, limit: CARRIED_PROMPT_READ });
      const out: WorkspaceEntry[] = [];
      for (const e of rows) {
        if (e.forUser !== userKey) continue;
        if (e.expiresAfter !== undefined && e.expiresAfter <= 0) continue;
        if (e.buffer === 'selfBuffer' || e.buffer === 'goalBuffer' || e.buffer === 'perceptionBuffer') continue;
        if (e.entryKind === UNKNOWN_NUDGE_ENTRY_KIND || e.entryKind === CHURN_ENTRY_KIND) continue;
        const salience = e.salience * CARRY_DECAY;
        if (salience < theta) continue;
        const text = neutraliseQuoted(e.payload, MAX_QUOTED_LINE);
        if (text === '') continue;
        out.push({
          buffer: e.buffer,
          entryKind: e.entryKind,
          text,
          salience,
          ...(e.retrievalScore !== undefined ? { retrievalScore: e.retrievalScore * CARRY_DECAY } : {}),
          forUser: userKey,
        });
      }
      return out;
    } catch (e) {
      this.onError?.(e);
      return [];
    }
  }

  /** The goal-forest view of this turn's sender (see {@link GoalStack}). */
  private viewerOf(envelope: MessageEnvelope): GoalViewer {
    return { userId: cogUserKey(envelope.sender), isOwner: envelope.sender?.isOwner === true };
  }

  /** Phase 4 — render the active goal as an `[Active goal]` prompt section. */
  private renderActiveGoal(goal: Goal): string {
    const shortType = goal.goalType.split('/').pop() ?? goal.goalType;
    const lines = [
      '[Active goal]',
      `- ${goal.goalLabel} (type: ${shortType}, priority: ${goal.priority})`,
    ];
    if (goal.successCriterion) lines.push(`- Success criterion: ${goal.successCriterion}`);
    if (goal.currentStep) lines.push(`- Current step: ${goal.currentStep}`);
    return lines.join('\n');
  }

  /**
   * Build the cognitive prompt blocks with the prompt assembler from this
   * cycle's in-memory working-memory view (perception + comprehension + the
   * goal, skill and self entries). Shadow: record the output and its diff
   * against `legacy` (the text actually sent) and return `legacy`. Live: return
   * the assembled text. Never throws: on a failure the legacy text goes out.
   */
  private composeCognitivePrompt(
    mode: 'shadow' | 'live',
    legacy: string | undefined,
    ctx: {
      perception?: Perception;
      comprehension?: ComprehensionResult;
      phaseView: WorkspaceEntry[];
      userKey: string;
      unknownNudge?: boolean;
      options: RunCycleOptions;
      setShadow: (r: ShadowRecord) => void;
      cycleId: string;
    },
  ): string | undefined {
    try {
      const view: WorkspaceEntry[] = [];
      for (const e of ctx.perception?.entries ?? []) {
        view.push({
          buffer: e.buffer,
          entryKind: e.entryKind,
          text: e.payload,
          salience: e.salience,
          forUser: ctx.userKey,
        });
      }
      for (const e of ctx.comprehension?.entries ?? []) {
        view.push({
          buffer: 'retrievalBuffer',
          entryKind: e.kind,
          text: e.payload,
          salience: e.score,
          retrievalScore: e.score,
          forUser: e.forUser,
        });
      }
      view.push(...ctx.phaseView);
      if (ctx.unknownNudge) {
        view.push({
          buffer: 'metaBuffer',
          entryKind: UNKNOWN_NUDGE_ENTRY_KIND,
          text: UNKNOWN_NUDGE_TEXT,
          salience: UNKNOWN_NUDGE_SALIENCE,
          forUser: ctx.userKey,
        });
      }
      const settings = ctx.options.promptSettings;
      const assembled = assemblePrompt({
        entries: view,
        theta: settings?.theta,
        userKey: ctx.userKey,
        recallEnabled: ctx.options.episodicRecallEnabled === true,
        recalledTokenCap: settings?.recalledTokenCap,
        totalTokenCap: settings?.totalTokenCap,
      });
      if (mode === 'live') return assembled.text === '' ? undefined : assembled.text;
      const diff = diffCognitiveBlocks(legacy, assembled.text);
      ctx.setShadow({
        assembledText: assembled.text,
        tokens: assembled.tokens,
        droppedForeign: assembled.droppedForeign,
        diff,
        cut: assembled.cut,
      });
      // Debug log: sizes and block names only, never the recalled text.
      this.logger.debug(
        { agent: this.agentId, cycleId: ctx.cycleId, tokens: assembled.tokens, droppedForeign: assembled.droppedForeign, diff },
        `prompt shadow for cycle ${ctx.cycleId}`,
      );
      return legacy;
    } catch (e) {
      this.onError?.(e);
      return legacy;
    }
  }

  /**
   * E4 — surface the top learned skills/sequences for `goalType` into the
   * retrieval buffer (entryKind `skill-suggestion` / `sequence-suggestion`,
   * carrying a score) and render the `[Skills that worked]` prompt block
   * (doc 06 §4/§6). Procedural memory *biases* action selection — it does not
   * dictate it. Returns `undefined` when nothing has been learned yet.
   */
  private async surfaceSkillSuggestions(
    sessionId: string,
    cycleId: string,
    cycleUri: string,
    goalType: string | undefined,
    userKey: string,
  ): Promise<{ text: string; items: Array<{ kind: string; text: string; score: number; tools: string[] }> } | undefined> {
    const pm = new ProceduralMemory(this.triplestore, this.agentId);
    // Only skills that have worked: a success rate of at least 0.7 over at
    // least 3 recorded calls (a low-success tool is never suggested).
    const [skills, sequences] = await Promise.all([
      pm.suggestSkills(goalType ?? '', SKILL_SUGGESTION_K, {
        minSuccessRate: SUGGESTION_MIN_SUCCESS_RATE,
        minSamples: SUGGESTION_MIN_SAMPLES,
        ...(goalType === undefined ? { untyped: true } : {}),
      }),
      pm.suggestSequenceSkills(goalType ?? '', SEQUENCE_SUGGESTION_K, {
        minSuccessRate: SUGGESTION_MIN_SUCCESS_RATE,
        ...(goalType === undefined ? { untyped: true } : {}),
      }),
    ]);
    if (skills.length === 0 && sequences.length === 0) return undefined;

    const wm = new WorkingMemory(this.triplestore, this.registry, this.agentId, sessionId, cycleId, userKey);
    const goalPhaseUri = `${cycleUri}_3`;
    const procGraph = pm.graphUri();
    const pct = (n: number) => `${Math.round(n * 100)}%`;

    const lines: string[] = ['[Skills that worked before for this kind of goal]'];
    const items: Array<{ kind: string; text: string; score: number; tools: string[] }> = [];
    for (const s of skills) {
      await wm.write(
        {
          buffer: 'retrievalBuffer',
          entryKind: 'skill-suggestion',
          payload: s.toolName,
          salience: s.score,
          retrievalScore: s.score,
          sourceGraph: procGraph,
          refersTo: s.skillUri,
        },
        goalPhaseUri,
      );
      const parts = [`used ${s.successCount}×`, `${pct(s.successRate)} success`];
      if (s.satisfactionRate > 0) parts.push(`satisfied ${pct(s.satisfactionRate)}`);
      if (s.meanDurationMs > 0) parts.push(`~${Math.round(s.meanDurationMs)} ms avg`);
      lines.push(`• ${s.toolName} — ${parts.join(', ')}`);
      items.push({ kind: 'skill-suggestion', text: lines[lines.length - 1].slice(2), score: s.score, tools: [s.toolName] });
    }
    for (const seq of sequences) {
      await wm.write(
        {
          buffer: 'retrievalBuffer',
          entryKind: 'sequence-suggestion',
          payload: seq.steps.map((st) => st.toolName).join(' → '),
          salience: seq.successRate,
          retrievalScore: seq.successRate,
          sourceGraph: procGraph,
          refersTo: seq.seqUri,
        },
        goalPhaseUri,
      );
      const chain = seq.steps.map((st) => st.toolName).join(' → ');
      lines.push(`• [sequence] ${chain} (${seq.successCount}×, ${pct(seq.successRate)} success)`);
      items.push({
        kind: 'sequence-suggestion',
        text: lines[lines.length - 1].slice(2),
        score: seq.successRate,
        tools: seq.steps.map((st) => st.toolName),
      });
    }
    return { text: lines.join('\n'), items };
  }

  /**
   * G2 — render the `[Self]` prompt block from the queryable self-model
   * (doc 08 §2.2): capabilities relevant to the active goal type and the
   * agent's constraints. Returns `undefined` when the self graph holds no
   * capabilities/constraints yet, so an unmigrated agent adds nothing.
   */
  private async renderSelfBlock(
    goalType: string | undefined,
  ): Promise<
    { text: string; caps: Array<{ text: string; salience: number }>; cons: string[] } | undefined
  > {
    const sm = new SelfModel(this.triplestore, this.agentId);
    const view: SelfView = await sm.queryFor(goalType);
    if (view.capabilities.length === 0 && view.constraints.length === 0) return undefined;

    // Every line is a fixed template; store text only fills a slot, one inert
    // line at a time. A row that does not fit its template is left out.
    const caps: Array<{ text: string; salience: number }> = [];
    const learned = view.capabilities.filter((c) => c.derivedFrom === undefined);
    for (const c of learned) {
      const label = neutraliseQuoted(c.label, SELF_LABEL_MAX);
      if (label === '') continue;
      const reqs = c.requires.length > 0 ? ` (uses ${c.requires.map((r) => neutraliseQuoted(r, SELF_NAME_MAX)).join(', ')})` : '';
      caps.push({ text: `${label}${reqs}`, salience: SELF_SALIENCE.capability });
    }
    // Tool capabilities: tools that are not freely usable first (they are what
    // the model most needs to know), then by name; at most SELF_TOOL_CAP lines.
    const tools: Array<{ text: string; salience: number; free: boolean; name: string }> = [];
    for (const c of view.capabilities) {
      if (c.derivedFrom !== 'tool-registry' || c.policyStatus === undefined) continue;
      const name = neutraliseQuoted(c.requires[0] ?? '', SELF_NAME_MAX);
      if (name === '') continue;
      const free = c.policyStatus === 'allowed';
      tools.push({
        text: `has tool ${name} (policy: ${SELF_POLICY_WORDS[c.policyStatus]})`,
        salience: free ? SELF_SALIENCE.capability : SELF_SALIENCE.restrictedTool,
        free,
        name,
      });
    }
    tools.sort((x, y) => Number(x.free) - Number(y.free) || (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
    for (const t of tools.slice(0, SELF_TOOL_CAP)) caps.push({ text: t.text, salience: t.salience });

    const cons: string[] = [];
    for (const c of view.constraints) {
      if (c.derivedFrom === 'tool-policy') cons.push(DERIVED_LABELS.toolPolicy);
      else if (c.derivedFrom === 'guardian-policy') cons.push(DERIVED_LABELS.guardian);
      else if (c.derivedFrom === 'behavior-directive') {
        const label = neutraliseQuoted(c.label, SELF_LABEL_MAX);
        const scope = neutraliseQuoted(c.scope ?? '', SELF_NAME_MAX);
        if (label !== '') cons.push(`Binding rule${scope ? ` (${scope})` : ''}: ${label}`);
      } else if (c.derivedFrom === undefined) {
        const label = neutraliseQuoted(c.label, SELF_LABEL_MAX);
        if (label === '') continue;
        const by = c.enforcedBy ? ` [${neutraliseQuoted(c.enforcedBy, SELF_NAME_MAX)}]` : '';
        cons.push(`${label}${by}`);
      }
    }
    if (caps.length === 0 && cons.length === 0) return undefined;

    const lines: string[] = ['[Self]'];
    if (caps.length > 0) {
      lines.push('Capabilities relevant to this goal:');
      for (const c of caps) lines.push(`• ${c.text}`);
    }
    if (cons.length > 0) {
      lines.push('Constraints I must respect:');
      for (const c of cons) lines.push(`• ${c}`);
    }
    return { text: lines.join('\n'), caps, cons };
  }

  private async persist(
    envelope: MessageEnvelope,
    sessionId: string,
    cycleId: string,
    cycleUri: string,
    startedAt: Date,
    endedAt: Date,
    status: 'completed' | 'aborted',
    responseText?: string,
    toolEvents: ToolEpisodeEvent[] = [],
    activeGoalUri?: string,
    activeGoalType?: string,
    proceduralEnabled = false,
    metacognitionEnabled = false,
    goalConflict = false,
    selfModelEnabled = false,
    mode: 'conversational' | 'initiative' = 'conversational',
    initiativeGoalUri?: string,
    inboundEpisodeUri?: string,
    episodicEnabled = true,
    perception?: Perception,
    marks: PhaseMarks = { cycleStart: startedAt, coreEnd: endedAt },
    resolveEntities?: RunCycleOptions['resolveEntities'],
    inboundAbout: string[] = [],
    comprehension?: ComprehensionResult,
    extras: {
      wm: WMEntryInput[];
      /** Action-buffer entries of the turn's tool calls, with the phase that wrote each. */
      actions?: Array<{ phase: 4 | 5; entry: WMEntryInput }>;
      /** Tools named by the suggestions the prompt showed this turn; absent when none. */
      suggestedTools?: string[];
      /** Metacognition entries for the `metaBuffer` (the nudge, the churn warning). */
      meta?: WMEntryInput[];
      /** Per-turn observations; present only with metacognition on. */
      signals?: TurnSignals;
      /** Push a `ResolveConflict` goal for a conflict of the turn (metacognition and goals on). */
      conflictGoals?: boolean;
      shadow?: ShadowRecord;
      goal?: GoalExtras;
      attention?: AttentionSettings;
      goalsEnabled?: boolean;
    } = { wm: [] },
  ): Promise<void> {
    const perceptionPhaseUri = `${cycleUri}_1`;
    // Capacity and drop accounting for this cycle's working-memory writes. Every
    // drop of an entry above the overflow salience is counted; one impasse per
    // cycle is raised from the total (metacognition on only).
    const overflow = { dropped: 0 };
    const wmOpts: WorkingMemoryOptions | undefined = extras.attention
      ? {
          capacity: extras.attention.capacity,
          onDrop: (d) => {
            if (d.salience > OVERFLOW_SALIENCE) overflow.dropped++;
          },
        }
      : undefined;
    // Conversational turns write the perception record (computed before the LLM
    // call); a turn whose core never reached the hook (the context build threw)
    // gets the envelope-only record. Initiative turns keep the earlier write.
    let record =
      mode === 'initiative'
        ? undefined
        : (perception ??
          buildPerception({
            text: envelope.text || '',
            senderId: envelope.sender?.id,
            senderIsOwner: envelope.sender?.isOwner === true,
            channel: envelope.channel ? String(envelope.channel) : undefined,
          }));
    // Entities no stored fact named are resolved here, off the reply path, with
    // a read-only lookup. The result feeds the ner-result entries, the response
    // episode and (append-only) the inbound episode written before the tool loop.
    if (record && record.pending.length > 0 && resolveEntities) {
      try {
        const found = await resolveEntities(record.pending);
        record = resolvePerception(record, found);
      } catch (e) {
        this.onError?.(e);
      }
    }
    // The turn's records are written in waves. Inside a wave every write is
    // independent of the others, so each task first does its reads and builds
    // its statement, and then all of them are issued in one synchronous pass:
    // the store flushes once for the whole wave. A wave ends only when all its
    // writes are durable; the next wave starts after it. Ordering kept, and why:
    //  - wave 1 -> carry-over: the carry reads this cycle's working graph (the
    //    entries it must not copy again) and the goal stack (the conflict goals
    //    pushed in wave 1);
    //  - carry-over -> wave 2: the goal-stack reads of the supersession and of
    //    the implicit goal's end must see the goals as the carry saw them;
    //  - inside wave 2 the episodes are ONE chained batch in the order the
    //    episodes were once appended one by one (goal transitions, supersession,
    //    tool and reply, initiative, reflection): the chain (`precededBy`,
    //    sequence number) is read once and threaded through in memory;
    //  - impasses are flagged one after the other: each flag reads the density of
    //    the earlier ones, and its episode follows the episodes of wave 2.
    const retrievalHits = comprehension?.entries.length ?? 0;
    const userKeyOfCycle = mode === 'initiative' ? OWNER_USER_KEY : cogUserKey(envelope.sender);
    const conflicts =
      extras.signals && comprehension ? conflictsOfTurn(comprehension.entries, startedAt.toISOString()) : [];
    const goalExtras = extras.goal;

    // --- Wave 1: working memory, cycle record, traces, conflict goals. -------
    await this.runWave([
      // Entities that were resolved late are added to the inbound episode (append-only).
      async () => {
        if (!(record && episodicEnabled && inboundEpisodeUri)) return undefined;
        const late = record.about.filter((a) => !inboundAbout.includes(a));
        if (late.length === 0) return undefined;
        return () => new EpisodicMemory(this.triplestore, this.agentId).addAbout(inboundEpisodeUri, late);
      },
      () =>
        this.prepareWorkingMemory(envelope, sessionId, cycleId, cycleUri, perceptionPhaseUri, record, comprehension, extras, wmOpts),
      // Conflicts this turn surfaced in the sender's own data: a ResolveConflict goal each.
      async () =>
        conflicts.length > 0 && extras.conflictGoals && goalExtras
          ? () => this.pushConflictGoals(envelope, sessionId, conflicts, goalExtras)
          : undefined,
      async () =>
        proceduralEnabled
          ? this.prepareProcedural(envelope, sessionId, cycleId, mode, toolEvents, activeGoalUri, activeGoalType, extras.suggestedTools)
          : undefined,
      async () => () =>
        this.writeCycleAndPhases(sessionId, cycleUri, startedAt, endedAt, status, userKeyOfCycle, marks, toolEvents),
      async () =>
        extras.shadow
          ? () => this.writePromptShadow(sessionId, cycleUri, cogUserKey(envelope.sender), extras.shadow as ShadowRecord)
          : undefined,
      async () => (extras.attention ? this.closePreviousGraph(envelope, sessionId, cycleId) : undefined),
    ]);

    // Carry-over from the previous cycle and the goal-steered salience rules.
    // The carry's own insert is written here (it reads what wave 1 wrote); the
    // salience changes are written in the last wave.
    const attend = extras.attention
      ? await this.carryAndAttend(envelope, sessionId, cycleId, activeGoalUri, extras.attention, extras.goalsEnabled === true, wmOpts)
      : undefined;

    // --- Wave 2: episodes, goal records, reflection. --------------------------
    // The supersession reads the goal stack before the implicit goal is ended;
    // an idle loser it abandons is written here, its episode joins the batch.
    let superseded: GoalTransition[] = [];
    if (goalExtras?.supersede) {
      try {
        superseded = await this.supersedeIdleLosers(envelope, sessionId, goalExtras.supersede);
      } catch (e) {
        this.onError?.(e);
      }
    }
    const episodes: EpisodeInput[] = [];
    if (episodicEnabled) {
      for (const t of goalExtras?.events ?? []) episodes.push(goalEpisodeInput(t, { sessionId, cycleId }));
      for (const t of superseded) episodes.push(goalEpisodeInput(t, { sessionId, cycleId }));
      episodes.push(
        ...this.episodeInputs(envelope, sessionId, cycleId, startedAt, endedAt, responseText, toolEvents, activeGoalUri, inboundEpisodeUri, record),
      );
      // Initiative episode (docs/initiative-architecture.md §6): one auditable
      // record per unattended cycle — trigger, outcome and reason. Written only in
      // initiative mode, so conversational persistence is byte-identical.
      if (mode === 'initiative') {
        episodes.push(
          this.initiativeEpisodeInput(envelope, sessionId, cycleId, endedAt, status, responseText, toolEvents, activeGoalUri ?? initiativeGoalUri),
        );
      }
    }
    // Phase 6 reflection. With metacognition ON, detect impasses, run the
    // S1–S4 subcycle for each, and write the *full* marker; OFF restores the
    // minimal Phase B marker exactly (the flag-off equivalence guarantee). A
    // cycle without impasses has no subcycle, so its marker and reflection
    // episode are known now and join this wave; with impasses the subcycle runs
    // after the wave (see runMetacognition).
    const metaCtx = {
      cycleId,
      cycleUri,
      status,
      responseText,
      toolEvents,
      retrievalHits,
      goalConflict,
      selfModelEnabled,
      sessionId,
      activeGoalUri,
      episodicEnabled,
      wmOverflow: overflow.dropped > 0 && extras.attention ? { dropped: overflow.dropped, capacity: extras.attention.capacity } : undefined,
      userKey: userKeyOfCycle,
      ...(extras.signals
        ? {
            signals: extras.signals,
            intent: record?.intent,
            goalsResolved: (goalExtras?.events ?? []).filter(
              (t) => t.kind === 'resolved' && t.goalType !== RESPOND_TO_USER,
            ).length,
            conflictCount: conflicts.length,
          }
        : {}),
    };
    let reflection: ReflectiveMarkerInput | undefined;
    let impassesToResolve = false;
    if (metacognitionEnabled) {
      if (this.detectImpasses(metaCtx).length === 0) {
        const plan = this.planReflection(metaCtx, []);
        reflection = plan.marker;
        if (plan.episode) episodes.push(plan.episode);
      } else {
        impassesToResolve = true;
      }
    }
    await this.runWave([
      async () => attend,
      async () => {
        if (episodes.length === 0) return undefined;
        const batch = await new EpisodicMemory(this.triplestore, this.agentId).prepareAppendMany(episodes, (e) =>
          this.onError?.(e),
        );
        return batch.commit;
      },
      async () => (goalExtras?.choice ? () => this.writeChooseGoal(sessionId, cycleUri, cogUserKey(envelope.sender), goalExtras.choice!) : undefined),
      // The implicit goal serves one cycle only (doc 07 §5.1), so sessions do
      // not keep a zombie.
      async () =>
        goalExtras?.implicitUri
          ? new GoalStack(this.triplestore, this.registry, this.agentId, sessionId, undefined, this.viewerOf(envelope)).prepareSetStatus(
              goalExtras.implicitUri,
              'resolved',
            )
          : undefined,
      async () => {
        if (reflection) {
          const marker = reflection;
          return async () => {
            await new Metacognition(this.triplestore, this.agentId).writeMarker(marker);
          };
        }
        return metacognitionEnabled ? undefined : () => this.writeReflectiveMarker(cycleUri, status);
      },
    ]);
    if (impassesToResolve) await this.runMetacognition(metaCtx);
  }

  /**
   * Run one wave: every task does its reads and builds its writes (a failure is
   * reported on its own), then all the writes are issued in one synchronous pass
   * so the store flushes once for the wave, and the wave resolves when all of
   * them are durable. A failing write is reported on its own and does not stop
   * the others. A task returns the write (or writes) to issue, or nothing.
   */
  private async runWave(
    tasks: Array<() => Promise<(() => Promise<unknown>) | Array<() => Promise<unknown>> | undefined>>,
  ): Promise<void> {
    const prepared = await Promise.all(
      tasks.map(async (task) => {
        try {
          return await task();
        } catch (e) {
          this.onError?.(e);
          return undefined;
        }
      }),
    );
    const commits = prepared.flatMap((c) => (c === undefined ? [] : Array.isArray(c) ? c : [c]));
    // Each commit issues its update before its first await: all are in the
    // store's queue before the flush starts.
    await Promise.all(
      commits.map(async (commit) => {
        try {
          await commit();
        } catch (e) {
          this.onError?.(e);
        }
      }),
    );
  }

  /**
   * The working-memory entries of the turn as writes: perception, recall, the
   * entries for the prompt assembler, the action buffer and the meta entries,
   * one write per group. When all of them fit under the entry cap together,
   * nothing is evicted by any of them, so the groups are independent and go out
   * together. Over the cap the eviction after each entry decides what stays, so
   * the entries are written one by one in the original order.
   */
  private async prepareWorkingMemory(
    envelope: MessageEnvelope,
    sessionId: string,
    cycleId: string,
    cycleUri: string,
    perceptionPhaseUri: string,
    record: Perception | undefined,
    comprehension: ComprehensionResult | undefined,
    extras: { wm: WMEntryInput[]; actions?: Array<{ phase: 4 | 5; entry: WMEntryInput }>; meta?: WMEntryInput[] },
    wmOpts: WorkingMemoryOptions | undefined,
  ): Promise<Array<() => Promise<unknown>> | undefined> {
    const at = (entry: WMEntryInput, writtenBy: string) => ({ entry, writtenBy });
    const groups: Array<Array<{ entry: WMEntryInput; writtenBy: string }>> = [
      this.perceptionEntries(envelope, record).map((e) => at(e, perceptionPhaseUri)),
      comprehension && comprehension.entries.length > 0
        ? this.recallEntries(comprehension).map((e) => at(e, `${cycleUri}_2`))
        : [],
      extras.wm.map((e) => at(e, `${cycleUri}_3`)),
      (extras.actions ?? []).map((a) => at(a.entry, `${cycleUri}_${a.phase}`)),
      (extras.meta ?? []).map((e) => at(e, `${cycleUri}_6`)),
    ].filter((g) => g.length > 0);
    const total = groups.reduce((n, g) => n + g.length, 0);
    if (total === 0) return undefined;
    const wm = new WorkingMemory(
      this.triplestore,
      this.registry,
      this.agentId,
      sessionId,
      cycleId,
      cogUserKey(envelope.sender),
      wmOpts,
    );
    if (await wm.hasRoomFor(total)) {
      return groups.map((g) => async () => {
        await wm.insertMany(g);
      });
    }
    return [
      async () => {
        for (const g of groups) {
          try {
            for (const it of g) await wm.write(it.entry, it.writtenBy);
          } catch (e) {
            this.onError?.(e);
          }
        }
      },
    ];
  }

  /**
   * E3 — the procedural records of the turn as one write. The prior cycle is
   * judged first (a read-then-write on traces of EARLIER cycles; this cycle's
   * traces are not written yet and are excluded by id as well), then this
   * turn's traces and, when suggestions were shown, the adherence summary are
   * written together.
   */
  private async prepareProcedural(
    envelope: MessageEnvelope,
    sessionId: string,
    cycleId: string,
    mode: 'conversational' | 'initiative',
    toolEvents: ToolEpisodeEvent[],
    activeGoalUri: string | undefined,
    activeGoalType: string | undefined,
    suggestedTools: string[] | undefined,
  ): Promise<(() => Promise<unknown>) | undefined> {
    const traceUser = mode === 'initiative' ? OWNER_USER_KEY : cogUserKey(envelope.sender);
    // An initiative cycle has no user message to react to.
    if (mode === 'conversational') {
      await this.backfillPriorSatisfaction(sessionId, cycleId, envelope.text || '', traceUser);
    }
    const plan = await this.planSkillTraces(sessionId, cycleId, toolEvents, activeGoalUri, activeGoalType, traceUser, suggestedTools);
    if (!plan) return undefined;
    return async () => {
      await new ProceduralMemory(this.triplestore, this.agentId).recordTraces(plan.traces, plan.summary);
      this.noteTracesWritten(plan.traces.length);
    };
  }

  /**
   * Phase F — the metacognitive half of Phase 6 (doc 08 §5–§6). Detects this
   * cycle's impasses, runs the bounded S1–S4 subcycle to resolve each, and
   * writes the full `cogt:ReflectiveMarker` with the cycle's monitoring
   * signals. All best-effort: it never touches the (already-sent) user reply.
   */
  private async runMetacognition(ctx: MetaCycleContext): Promise<void> {
    const meta = new Metacognition(this.triplestore, this.agentId);

    // --- Detect impasses from the cycle's vantage point (F2). ----------------
    const impasses = this.detectImpasses(ctx);

    // --- S1–S4 subcycle per impasse (F3). The subcycle is a bounded policy
    // lookup plus two writes: it performs no LLM call and cannot itself raise
    // an impasse, so there is no recursion and the cycle can never loop. The
    // impasses are handled one after the other: flagging reads how many of the
    // kind are already flagged. -----------------------------------------------
    const resolved: ResolvedImpasse[] = [];
    for (const input of impasses) {
      try {
        // Every impasse carries the user of the cycle, unless the detector set one.
        const flagged = await meta.flagImpasse({
          ...input,
          ...(input.forUser === undefined && ctx.userKey ? { forUser: ctx.userKey } : {}),
        }); // S1 meta-perception + S2 density
        this.logger.warn(
          { agent: this.agentId, kind: flagged.kind, chronic: flagged.chronic, phase: input.flaggedInPhase },
          `impasse flagged: ${flagged.kind}${flagged.chronic ? ' (chronic)' : ''}`,
        );
        const resolution = meta.pickResolution(flagged.kind, {
          attempt: 0,
          recentDensity: 0,
          chronic: flagged.chronic, // S2 → chronic short-circuits to ask-user
        }); // S3 meta-decision
        // S4 resume: ask-user is *recorded* but left for the human; everything
        // else is auto-resolved by the policy. Chronic always defers to user.
        const autoResolved = resolution !== 'ask-user';
        // The episode of the impasse (the kind and the detector's context: tool
        // name and error class, never user text; episodic flag only) and the
        // resolution stamp are independent writes and go out together.
        await Promise.all([
          this.appendMetaEpisode(ctx, {
            episodeType: 'impasse-flagged',
            payload: `${flagged.kind}${flagged.chronic ? ' (chronic)' : ''}: ${input.context}`,
            tags: [flagged.kind],
            forUser: input.forUser ?? ctx.userKey,
          }),
          autoResolved ? meta.resolveImpasse(flagged.id, resolution, 'metacog') : undefined,
        ]);
        resolved.push({ flaggedUri: flagged.id, resolved: autoResolved });
      } catch (e) {
        this.onError?.(e);
      }
    }

    // --- Phase 6 full reflective marker (F4) and its episode. ----------------
    const plan = this.planReflection(ctx, resolved);
    await this.runWave([
      async () => async () => {
        await meta.writeMarker(plan.marker);
      },
      async () => {
        if (!plan.episode) return undefined;
        const batch = await new EpisodicMemory(this.triplestore, this.agentId).prepareAppendMany([plan.episode], (e) =>
          this.onError?.(e),
        );
        return batch.commit;
      },
    ]);
  }

  /**
   * The full reflective marker of a cycle and the episode of the reflection (a
   * fixed-format line of the marker's counts; absent with the episodic flag off),
   * from the cycle's context and its resolved impasses. Pure: nothing is written.
   */
  private planReflection(
    ctx: MetaCycleContext,
    resolved: ResolvedImpasse[],
  ): { marker: ReflectiveMarkerInput; episode?: EpisodeInput } {
    const toolsUsed = new Set(ctx.toolEvents.map((e) => e.callId)).size;
    const toolErrors = ctx.toolEvents.filter(
      (e) => e.phase === 'completed' && e.outcome === 'error',
    ).length;
    const flaggedImpasse = resolved.map((r) => r.flaggedUri);
    const resolvedImpasse = resolved.filter((r) => r.resolved).map((r) => r.flaggedUri);
    const constraintPressure = this.constraintPressure(ctx.toolEvents);
    const cycleStatus: ReflectiveMarkerInput['cycleStatus'] =
      ctx.status === 'aborted'
        ? 'aborted'
        : resolvedImpasse.length > 0
          ? 'impasse-resolved'
          : 'completed';
    const noted =
      flaggedImpasse.length > 0
        ? `${flaggedImpasse.length} impasse(s) flagged, ${resolvedImpasse.length} auto-resolved.`
        : ctx.status === 'completed'
          ? 'Cycle completed; no impasse.'
          : 'Cycle aborted; core delegation threw.';

    // The metacognition signals of a conversational turn.
    const emptyRetrieval = ctx.retrievalHits === 0;
    const sig = ctx.signals;
    const stepUpdates = ctx.toolEvents.filter(
      (e) => e.toolName === 'update_goal_step' && e.phase === 'completed' && e.outcome === 'success',
    ).length;
    const goalProgress = sig
      ? goalProgressOf({ stepUpdates, goalsResolved: ctx.goalsResolved ?? 0 })
      : undefined;

    const marker: ReflectiveMarkerInput = {
      cycleUri: ctx.cycleUri,
      cycleStatus,
      toolsUsed,
      toolErrors,
      emptyRetrieval,
      toolChurn: this.isToolChurn(ctx.toolEvents),
      constraintPressure,
      flaggedImpasse,
      resolvedImpasse,
      noted,
      ...(ctx.userKey ? { forUser: ctx.userKey } : {}),
      ...(sig
        ? {
            newKnowledge: String(sig.storedFacts),
            uncertainty: uncertaintyOf({ emptyRetrieval, intent: ctx.intent, toolErrors }),
            conflictSurfaced: ctx.conflictCount ?? 0,
            ...(goalProgress ? { goalProgress } : {}),
            ...(sig.goalDrift !== undefined ? { goalDrift: sig.goalDrift } : {}),
          }
        : {}),
    };
    // The episode of the reflection: a fixed-format line of the marker's counts.
    const episode = this.metaEpisodeInput(ctx, {
      episodeType: 'meta-reflected',
      payload:
        `cycle ${cycleStatus}; tools ${toolsUsed}, tool errors ${toolErrors}, ` +
        `impasses ${flaggedImpasse.length} flagged / ${resolvedImpasse.length} resolved` +
        (sig ? `, uncertainty ${uncertaintyOf({ emptyRetrieval, intent: ctx.intent, toolErrors })}` : ''),
      tags: [cycleStatus],
      forUser: ctx.userKey,
    });
    return { marker, ...(episode ? { episode } : {}) };
  }

  /**
   * Append a metacognition episode of the cycle (`impasse-flagged`,
   * `meta-reflected`): gated by the episodic flag, carries the cycle id, the
   * user key and the turn's goal where known. Best-effort; never throws.
   */
  private async appendMetaEpisode(
    ctx: { cycleId: string; sessionId?: string; activeGoalUri?: string; episodicEnabled?: boolean },
    ep: { episodeType: 'impasse-flagged' | 'meta-reflected'; payload: string; tags: string[]; forUser?: string },
  ): Promise<void> {
    try {
      const input = this.metaEpisodeInput(ctx, ep);
      if (input) await new EpisodicMemory(this.triplestore, this.agentId).append(input);
    } catch (e) {
      this.onError?.(e);
    }
  }

  /** The metacognition episode, or undefined with the episodic flag off. */
  private metaEpisodeInput(
    ctx: { cycleId: string; sessionId?: string; activeGoalUri?: string; episodicEnabled?: boolean },
    ep: { episodeType: 'impasse-flagged' | 'meta-reflected'; payload: string; tags: string[]; forUser?: string },
  ): EpisodeInput | undefined {
    if (ctx.episodicEnabled === false) return undefined;
    return {
      episodeType: ep.episodeType,
      occurredAt: new Date(),
      ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
      cycleId: ctx.cycleId,
      actor: `urn:${this.agentId}:self#${this.agentId}`,
      ...(ep.forUser ? { forUser: ep.forUser } : {}),
      ...(ctx.activeGoalUri ? { partOfGoal: ctx.activeGoalUri } : {}),
      ...this.privacyOf(ep.payload),
      payload: ep.payload,
      tags: ep.tags,
      salience: 0.3,
    };
  }

  /**
   * A `ResolveConflict` goal for each conflict the turn surfaced in the sender's
   * own data (at most {@link MAX_CONFLICT_GOALS}); the goal belongs to the sender
   * and is about the entity of the changed fact. A conflict the sender already
   * has an open goal for is not pushed twice. The transition reaches the goal
   * episodes through the turn's own list. Best-effort.
   */
  private async pushConflictGoals(
    envelope: MessageEnvelope,
    sessionId: string,
    conflicts: RecallEntry[],
    extras: GoalExtras,
  ): Promise<void> {
    try {
      const userKey = cogUserKey(envelope.sender);
      const gs = new GoalStack(
        this.triplestore,
        this.registry,
        this.agentId,
        sessionId,
        undefined,
        this.viewerOf(envelope),
        (t) => {
          extras.events.push(t);
        },
      );
      const open = (await gs.active()).filter(
        (g) => g.goalType === GOAL_TYPES.ResolveConflict && goalBelongsTo(g, userKey),
      );
      for (const c of conflicts.slice(0, MAX_CONFLICT_GOALS)) {
        const brief = c.payload.length > 80 ? `${c.payload.slice(0, 77)}...` : c.payload;
        const label = `Resolve conflict: ${brief}`;
        if (open.some((g) => g.goalLabel === label)) continue;
        let about: string[] = [];
        try {
          sparqlIri(c.refersTo);
          about = [c.refersTo];
        } catch {
          /* an unsafe IRI is left out */
        }
        await gs.push({
          goalType: GOAL_TYPES.ResolveConflict,
          goalLabel: label,
          priority: CONFLICT_GOAL_PRIORITY,
          forUser: userKey,
          about,
        });
      }
    } catch (e) {
      this.onError?.(e);
    }
  }

  /**
   * Map this cycle's observable signals to impasse inputs (F2, doc 08 §4):
   *  - a goal-conflict flagged by Phase 3;
   *  - every errored tool call (Phase 5 `tool-error`, or `tool-policy-denied-all`
   *    when the error class names a policy/permission denial);
   *  - an empty action selection (core finished with neither a reply nor a tool
   *    call), which only counts when the cycle itself completed.
   */
  private detectImpasses(ctx: {
    cycleUri: string;
    status: 'completed' | 'aborted';
    responseText?: string;
    toolEvents: ToolEpisodeEvent[];
    goalConflict: boolean;
    cycleId?: string;
    wmOverflow?: { dropped: number; capacity: number };
    userKey?: string;
  }): ImpasseInput[] {
    const out: ImpasseInput[] = [];
    // At most one wm-overflow per cycle, however many entries were dropped.
    if (ctx.wmOverflow) {
      out.push({
        kind: 'wm-overflow',
        flaggedInPhase: `${ctx.cycleUri}_3`,
        context: `Working memory at capacity ${ctx.wmOverflow.capacity}: ${ctx.wmOverflow.dropped} entry(ies) above salience ${OVERFLOW_SALIENCE} dropped.`,
        ...(ctx.cycleId ? { cycleId: ctx.cycleId } : {}),
        ...(ctx.userKey ? { forUser: ctx.userKey } : {}),
      });
    }
    if (ctx.goalConflict) {
      out.push({
        kind: 'goal-conflict',
        flaggedInPhase: `${ctx.cycleUri}_3`,
        context: 'More than one substantive goal active for the turn.',
      });
    }
    for (const e of ctx.toolEvents) {
      if (e.phase !== 'completed' || e.outcome !== 'error') continue;
      const denied = isConstraintDenial(e);
      const kind: ImpasseKind = denied ? 'tool-policy-denied-all' : 'tool-error';
      out.push({
        kind,
        flaggedInPhase: `${ctx.cycleUri}_5`,
        context: `${e.toolName}: ${e.errorClass ?? 'error'}`,
      });
    }
    const nothingHappened =
      ctx.status === 'completed' && !ctx.responseText && ctx.toolEvents.length === 0;
    if (nothingHappened) {
      out.push({
        kind: 'action-selection-empty',
        flaggedInPhase: `${ctx.cycleUri}_4`,
        context: 'Core produced neither a response nor a tool call.',
      });
    }
    return out;
  }

  /**
   * Constraint pressure = count of tool calls the system refused: denied by the
   * tool policy or held back for an owner approval that was not granted. Read
   * from the typed denial class of the dispatch chokepoint, so the self-model
   * flag changes what is shown in the prompt, not what is counted here.
   */
  private constraintPressure(toolEvents: ToolEpisodeEvent[]): number {
    return toolEvents.filter((e) => e.phase === 'completed' && e.outcome === 'error' && isConstraintDenial(e)).length;
  }

  /** Tool churn = the same tool invoked three or more times in one cycle. */
  private isToolChurn(toolEvents: ToolEpisodeEvent[]): boolean {
    const counts = new Map<string, number>();
    for (const e of toolEvents) {
      if (e.phase !== 'called') continue;
      counts.set(e.toolName, (counts.get(e.toolName) ?? 0) + 1);
    }
    for (const n of counts.values()) if (n >= 3) return true;
    return false;
  }

  /**
   * E3 — back-fill the weak `userSatisfied` signal onto the *previous* cycle's
   * skill traces (doc 06 §3). The signal comes one cycle late: a fresh inbound
   * message is the user's reaction to the prior turn. The classifier is
   * intentionally crude — clear thanks/affirmation => true, clear
   * rejection/correction => false, anything ambiguous (incl. a topic change)
   * => null, which leaves `userSatisfied` unset.
   */
  private async backfillPriorSatisfaction(
    sessionId: string,
    cycleId: string,
    text: string,
    userKey: string,
  ): Promise<void> {
    const satisfied = this.classifySatisfaction(text);
    if (satisfied === null) return;
    const pm = new ProceduralMemory(this.triplestore, this.agentId);
    // Only this user's own, not yet judged traces of the latest earlier cycle,
    // and only while that cycle is recent enough to be what the user reacts to.
    const uris = await pm.findPriorCycleTraceUris(sessionId, cycleId, {
      forUser: userKey,
      onlyUnjudged: true,
      maxGapMs: FOLLOWUP_MAX_GAP_MS,
    });
    // Each trace is its own record: the back-fills are independent and go out together.
    await Promise.all(uris.map((uri) => pm.backfillSatisfaction(uri, satisfied, FOLLOWUP_SATISFACTION_WEIGHT)));
  }

  /** Satisfaction read of an inbound message: true / false / null (ambiguous). */
  private classifySatisfaction(text: string): boolean | null {
    return classifySatisfaction(text);
  }

  /**
   * E2 — one `cogt:SkillTrace` per tool call (gated by cog.flagProceduralMemory).
   * The traces reuse the C3 tool-event buffer, so no new live-path
   * instrumentation is needed. `called`/`completed` events are paired by
   * `callId`: the `called` event supplies the (keys-only, secret-free) args
   * brief, the `completed` event supplies outcome/duration/errorClass.
   *
   * Redaction: `toolArgsBrief` is already keys-only and `toolArgsHash` is the
   * FNV-1a of that keys-only brief, so no argument value reaches procedural
   * memory. `forGoal`/`forGoalType` come from this turn's active goal; the
   * sequence position/length and `previousTrace` link are derived from call
   * order so the consolidation job can later detect tool sequences.
   */
  private async planSkillTraces(
    sessionId: string,
    cycleId: string,
    toolEvents: ToolEpisodeEvent[],
    activeGoalUri?: string,
    activeGoalType?: string,
    userKey: string = OWNER_USER_KEY,
    suggestedTools?: string[],
  ): Promise<{ traces: TraceInput[]; summary?: AdherenceSummaryInput } | undefined> {
    // Pair events by callId, preserving first-seen order.
    interface Call {
      callId: string;
      toolName: string;
      argsBrief?: string;
      args?: Record<string, unknown>;
      startedAt: Date;
      outcome?: 'success' | 'error';
      durationMs?: number;
      errorClass?: string;
    }
    const calls = new Map<string, Call>();
    const order: string[] = [];
    for (const ev of toolEvents) {
      let call = calls.get(ev.callId);
      if (!call) {
        call = { callId: ev.callId, toolName: ev.toolName, startedAt: ev.occurredAt };
        calls.set(ev.callId, call);
        order.push(ev.callId);
      }
      if (ev.phase === 'called') {
        call.startedAt = ev.occurredAt;
        if (ev.argsBrief !== undefined) call.argsBrief = ev.argsBrief;
        if (ev.args !== undefined) call.args = ev.args;
      } else {
        call.outcome = ev.outcome;
        call.durationMs = ev.durationMs;
        call.errorClass = ev.errorClass;
      }
    }
    if (order.length === 0) return undefined;

    const rules = await new CognitiveConfig(this.triplestore, this.agentId).argRedactionRules();
    // The key is fetched (and its file created) only when an argument is masked.
    let digestKey: Buffer | undefined;
    let digestKeyRead = false;
    const suggested = suggestedTools && suggestedTools.length > 0 ? new Set(suggestedTools) : undefined;
    let adhered = 0;
    const sequenceLen = order.length;
    const traces: TraceInput[] = [];
    let pos = 0;
    for (const callId of order) {
      const c = calls.get(callId)!;
      pos++;
      // The brief is keys only; a masked value is kept as its sha256 alone.
      let redacted =
        c.args !== undefined
          ? redactToolArgs(c.args, rules)
          : { brief: looksLikeSecret(c.argsBrief) ? '' : (c.argsBrief ?? ''), masked: [] as MaskedArg[] };
      if (c.args !== undefined && redacted.masked.length > 0) {
        if (!digestKeyRead) {
          digestKeyRead = true;
          digestKey = await (this.argDigestKey ?? this.defaults.argDigestKey)?.get();
        }
        if (digestKey) redacted = redactToolArgs(c.args, rules, digestKey);
      }
      const brief = redacted.brief;
      // Adherence is recorded on every traced call, but only when the prompt
      // showed suggestions this turn; otherwise it is left unset.
      const adherence = suggested ? suggested.has(c.toolName) : undefined;
      if (adherence) adhered++;
      // No `completed` event => the call never resolved (e.g. aborted cycle);
      // a trace is still written per the DoD, recorded as a partial outcome.
      const outcome: TraceInput['outcome'] = c.outcome ?? 'partial';
      const trace: TraceInput = {
        toolName: c.toolName,
        toolArgsHash: fnv1aHex(brief),
        toolArgsBrief: brief,
        executedAt: c.startedAt,
        durationMs: c.durationMs ?? 0,
        outcome,
        errorClass: c.errorClass,
        forGoal: activeGoalUri,
        forGoalType: activeGoalType,
        cycleId,
        sessionId,
        sequencePos: pos,
        sequenceLen,
        forUser: userKey,
        ...(redacted.masked.some((m) => m.digest !== undefined)
          ? { maskedArgs: redacted.masked.flatMap((m) => (m.digest !== undefined ? [{ path: m.path, digest: m.digest, scheme: m.scheme ?? ('hmac-sha256' as const) }] : [])) }
          : {}),
        ...(adherence !== undefined ? { proceduralAdherence: adherence } : {}),
      };
      // `previousTrace` (the link to the call before) is set when the batch is written.
      traces.push(trace);
    }
    return {
      traces,
      ...(suggested ? { summary: {
        cycleId,
        sessionId,
        forUser: userKey,
        executedAt: calls.get(order[0])!.startedAt,
        suggestedTools: suggested.size,
        tracedCalls: order.length,
        adheredCalls: adhered,
      } } : {}),
    };
  }

  /** `core:privacyClass "secret"` for a payload that matches a credential shape. */
  private privacyOf(payload: string | undefined): { privacyClass?: 'secret' } {
    return looksLikeSecret(payload) ? { privacyClass: 'secret' } : {};
  }

  /**
   * C2 — append the `message-received` perception episode (actor = sender,
   * payload = text, transcriptRef = session). D4 — backfills the turn's active
   * goal when known.
   */
  private async appendInboundEpisode(
    envelope: MessageEnvelope,
    sessionId: string,
    cycleId: string,
    occurredAt: Date,
    activeGoalUri?: string,
    perception?: Perception,
  ): Promise<string> {
    return new EpisodicMemory(this.triplestore, this.agentId).append(
      this.inboundEpisodeInput(envelope, sessionId, cycleId, occurredAt, activeGoalUri, perception),
    );
  }

  /** The `message-received` episode of a turn, ready to append (see {@link appendInboundEpisode}). */
  private inboundEpisodeInput(
    envelope: MessageEnvelope,
    sessionId: string,
    cycleId: string,
    occurredAt: Date,
    activeGoalUri?: string,
    perception?: Perception,
  ): EpisodeInput {
    const channel = envelope.channel ? String(envelope.channel) : undefined;
    const actor = envelope.sender?.id
      ? `urn:entity:agent-sender:${encodeURIComponent(envelope.sender.id)}`
      : undefined;
    // Owner marker (the mandate gate reads it, docs §5.1): only a live,
    // human-facing turn from the verified owner carries it. Synthetic envelopes
    // (initiative, scheduler, cron trigger, webhooks) also claim isOwner and are
    // excluded by isHumanOwnerTurn.
    const actorIsOwner = isHumanOwnerTurn(envelope);
    return {
      episodeType: 'message-received',
      occurredAt,
      sessionId,
      cycleId,
      channel,
      actor,
      ...(actorIsOwner ? { actorIsOwner: true } : {}),
      forUser: cogUserKey(envelope.sender),
      // The graph the ingestion writes this sender's own facts to (it routes by
      // the raw sender id, not by the cognitive key); the consolidation promotes
      // into exactly this graph.
      ...this.factGraphOf(envelope),
      ...this.privacyOf(envelope.text),
      payload: envelope.text || '',
      // Without a perception record (no hook ran) the episode is as before.
      // With one, the transcript reference carries the line index of the user
      // entry in the session JSONL (zero-based), e.g. `<session>.jsonl:line_12`.
      transcriptRef:
        perception?.transcriptLine !== undefined
          ? `${sessionId}.jsonl:line_${perception.transcriptLine}`
          : `${sessionId}.jsonl`,
      ...(perception
        ? {
            about: perception.about,
            tags: perception.tags,
            hasClaim: perception.hasClaim,
          }
        : {}),
      partOfGoal: activeGoalUri,
    };
  }

  /** `{ factGraph }` for an inbound episode, or nothing when the sender has no usable id. */
  private factGraphOf(envelope: MessageEnvelope): { factGraph?: string } {
    const id = envelope.sender?.id;
    if (typeof id !== 'string' || id === '') return {};
    try {
      const graph = GraphUriResolver.getUserGraph(this.agentId, id);
      sparqlIri(graph);
      return { factGraph: graph };
    } catch {
      return {};
    }
  }

  /**
   * Attention and carry-over for one cycle (queued persist, conversational
   * turns). In order:
   *  1. carry the previous cycle's entries of this session and user into this
   *     cycle (selfBuffer, goal entries of goals still live, flagged notes),
   *     decayed ×0.7 and linked by `carriedFrom`, and mark that graph closed;
   *  2. apply the capacity to what the carry added;
   *  3. boost entries about the active goal's entities, damp stale carried
   *     entries, drop carried entries below the floor.
   * Best-effort: a failure goes to `onError` and never reaches the reply.
   */
  private async carryAndAttend(
    envelope: MessageEnvelope,
    sessionId: string,
    cycleId: string,
    activeGoalUri: string | undefined,
    settings: AttentionSettings,
    goalsEnabled: boolean,
    wmOpts: WorkingMemoryOptions | undefined,
  ): Promise<(() => Promise<void>) | undefined> {
    try {
      const userKey = cogUserKey(envelope.sender);
      // Scoping: the key holds session AND user, so a cycle never finds another
      // user's (or another session's) previous graph.
      const key = `${sessionId}\u0000${userKey}`;
      const prevCycleId = this.lastCycle.get(key);

      const liveGoals = new Set<string>();
      const boost = new Set<string>();
      const keep = new Set<string>();
      if (goalsEnabled) {
        const active = await new GoalStack(
          this.triplestore,
          this.registry,
          this.agentId,
          sessionId,
          undefined,
          this.viewerOf(envelope),
        ).active();
        // The implicit respond-to-user goal is a safety net, not something to hold in mind.
        for (const g of active) {
          if (g.goalType === RESPOND_TO_USER) continue;
          liveGoals.add(g.uri);
          for (const a of g.about ?? []) keep.add(a);
          if (g.uri === activeGoalUri) for (const a of g.about ?? []) boost.add(a);
        }
      }

      const wm = new WorkingMemory(this.triplestore, this.registry, this.agentId, sessionId, cycleId, userKey, wmOpts);
      if (prevCycleId && prevCycleId !== cycleId) {
        const prev = new WorkingMemory(this.triplestore, this.registry, this.agentId, sessionId, prevCycleId, userKey);
        // The previous graph is marked closed in wave 1 (see closePreviousGraph).
        const carry = await prev.prepareCarryForward(cycleId, { liveGoals });
        await carry.commit();
        if (carry.count > 0) await wm.enforce();
      }
      // The salience changes read the graph as the carry left it, and are written
      // in the last wave: nothing in that wave reads the working graph.
      const attended = await wm.prepareAttend({ boostEntities: boost, keepEntities: keep, theta: settings.theta });
      return async () => {
        await attended.commit();
        this.lastCycle.delete(key);
        this.lastCycle.set(key, cycleId);
        if (this.lastCycle.size > LAST_CYCLE_MAX) {
          const oldest = this.lastCycle.keys().next().value;
          if (oldest !== undefined) this.lastCycle.delete(oldest);
        }
      };
    } catch (e) {
      this.onError?.(e);
      return undefined;
    }
  }

  /**
   * Mark the previous cycle's working graph of this session and user closed
   * (nothing is deleted; the age-based sweep takes it on its schedule). The mark
   * is a statement about that graph and is independent of the carry, which only
   * reads the graph's entries, so it goes out with the first wave.
   */
  private closePreviousGraph(
    envelope: MessageEnvelope,
    sessionId: string,
    cycleId: string,
  ): (() => Promise<void>) | undefined {
    const userKey = cogUserKey(envelope.sender);
    const prevCycleId = this.lastCycle.get(`${sessionId}\u0000${userKey}`);
    if (!prevCycleId || prevCycleId === cycleId) return undefined;
    return () =>
      new WorkingMemory(this.triplestore, this.registry, this.agentId, sessionId, prevCycleId, userKey).markClosed();
  }

  /**
   * This turn's recall (Phase 2) as retrieval-buffer entries, best first. Each
   * entry carries its score as `retrievalScore` (and as salience) and the graph
   * it was read from; the working memory stamps the sender's user key on every
   * entry.
   */
  private recallEntries(comprehension: ComprehensionResult): WMEntryInput[] {
    const out: WMEntryInput[] = [];
    for (const e of comprehension.entries) {
      // The working memory writes the reference as a bare IRI: only a safe one is kept.
      let refersTo: string | undefined = e.refersTo;
      try {
        sparqlIri(e.refersTo);
      } catch {
        refersTo = undefined;
      }
      out.push({
        buffer: 'retrievalBuffer',
        entryKind: e.kind,
        payload: e.payload,
        salience: e.score,
        retrievalScore: e.score,
        sourceGraph: e.sourceGraph,
        ...(refersTo ? { refersTo } : {}),
      });
    }
    return out;
  }

  /**
   * Shadow mode: store what the prompt assembler produced and how it differs
   * from the blocks actually sent, as a `cogt:PromptShadow` of the cycle. It
   * carries the cycle's `forUser`, like every record of the cycle.
   */
  private async writePromptShadow(
    sessionId: string,
    cycleUri: string,
    userKey: string,
    record: ShadowRecord,
  ): Promise<void> {
    const graph = GraphUriResolver.getCogCyclesGraph(this.agentId, sessionId);
    this.registry.assertWritable(graph);
    const uri = `${cycleUri}_prompt`;
    const summary = JSON.stringify({
      diff: record.diff,
      cut: record.cut,
      droppedForeign: record.droppedForeign,
    });
    const lines = [
      `<${uri}> <${RDF_TYPE}> <${COGT}PromptShadow> .`,
      `<${uri}> <${COGT}partOfCycle> <${cycleUri}> .`,
      `<${uri}> <${COGT}forUser> "${escapeLiteral(userKey)}" .`,
      `<${uri}> <${COGT}createdAt> "${new Date().toISOString()}"^^<${XSD}dateTime> .`,
      `<${uri}> <${COGT}assembledText> "${escapeLiteral(record.assembledText)}" .`,
      `<${uri}> <${COGT}assembledTokens> "${Math.trunc(record.tokens)}"^^<${XSD}integer> .`,
      `<${uri}> <${COGT}diffSummary> "${escapeLiteral(summary)}" .`,
    ];
    await this.triplestore.update(`INSERT DATA { GRAPH <${graph}> {\n${lines.join('\n')}\n} }`);
  }

  /**
   * Episodic memory writes (Phase C, C2 + the response half of C3).
   *
   *  - Phase 1 records a `message-received` episode (actor = sender, payload =
   *    text, transcriptRef = session) chained to the session's prior episode.
   *  - Phase 5 records a `response-sent` episode for the textual reply.
   *  - Phase 5 also records `tool-called` / `tool-completed` episodes for each
   *    tool the core invoked (C3), replayed here in arrival order so the
   *    narrative chain stays temporally correct.
   *
   * Recall is not done here: it happens once, before the answer (Phase 2,
   * Comprehension.ts).
   */
  private episodeInputs(
    envelope: MessageEnvelope,
    sessionId: string,
    cycleId: string,
    startedAt: Date,
    endedAt: Date,
    responseText?: string,
    toolEvents: ToolEpisodeEvent[] = [],
    activeGoalUri?: string,
    inboundEpisodeUri?: string,
    perception?: Perception,
  ): EpisodeInput[] {
    const out: EpisodeInput[] = [];
    const channel = envelope.channel ? String(envelope.channel) : undefined;
    const userKey = cogUserKey(envelope.sender);

    // C2 — perception episode (already written ahead of the core on a
    // conversational turn; see runCycle).
    if (!inboundEpisodeUri) {
      out.push(this.inboundEpisodeInput(envelope, sessionId, cycleId, startedAt, activeGoalUri, perception));
    }

    // C3 — tool-called / tool-completed episodes, in arrival order.
    for (const ev of toolEvents) {
      if (ev.phase === 'called') {
        out.push({
          episodeType: 'tool-called',
          occurredAt: ev.occurredAt,
          sessionId,
          cycleId,
          forUser: userKey,
          payload: ev.argsBrief ? `${ev.toolName} (${ev.argsBrief})` : ev.toolName,
          ...this.privacyOf(ev.argsBrief),
          tags: [ev.callId],
        });
      } else {
        out.push({
          episodeType: 'tool-completed',
          occurredAt: ev.occurredAt,
          sessionId,
          cycleId,
          forUser: userKey,
          payload: `${ev.toolName} -> ${ev.outcome ?? 'unknown'}`,
          outcome: ev.outcome,
          durationMs: ev.durationMs,
          errorClass: ev.errorClass,
          tags: [ev.callId],
        });
      }
    }

    // C3 (response half) — response-sent episode.
    if (responseText) {
      out.push({
        episodeType: 'response-sent',
        occurredAt: endedAt,
        sessionId,
        cycleId,
        channel,
        actor: `urn:${this.agentId}:self#${this.agentId}`,
        forUser: userKey,
        ...this.privacyOf(responseText),
        payload: responseText,
        transcriptRef: `${sessionId}.jsonl`,
        ...(perception ? { about: perception.about } : {}),
        partOfGoal: activeGoalUri,
      });
    }
    return out;
  }

  /**
   * Initiative episode (docs/initiative-architecture.md §6). One episode per
   * unattended cycle recording the trigger (the synthetic envelope text), the
   * outcome (completed/aborted, whether a reply/notification was produced, how
   * many tools ran) and the triggering goal. This is the audit trail for what
   * the agent did while nobody was watching. Reuses EpisodicMemory, so it lands
   * in the same `cog:episodic` graph as every other episode.
   */
  private initiativeEpisodeInput(
    envelope: MessageEnvelope,
    sessionId: string,
    cycleId: string,
    endedAt: Date,
    status: 'completed' | 'aborted',
    responseText: string | undefined,
    toolEvents: ToolEpisodeEvent[],
    goalUri?: string,
  ): EpisodeInput {
    const toolCalls = new Set(
      toolEvents.filter((e) => e.phase === 'called').map((e) => e.callId),
    ).size;
    const outcome: 'success' | 'error' = status === 'completed' ? 'success' : 'error';
    const reason =
      status === 'aborted'
        ? 'initiative cycle aborted (core delegation threw)'
        : responseText
          ? 'initiative cycle completed with output'
          : toolCalls > 0
            ? 'initiative cycle completed with tool action(s)'
            : 'initiative cycle completed as a no-op';
    const trigger = (envelope.text || '').trim();
    const payload = `trigger: ${trigger || '(none)'} | outcome: ${reason} | tools: ${toolCalls}`;
    return {
      episodeType: 'initiative',
      occurredAt: endedAt,
      sessionId,
      cycleId,
      channel: envelope.channel ? String(envelope.channel) : undefined,
      actor: `urn:${this.agentId}:self#${this.agentId}`,
      // Unattended work is the owner's: initiative episodes carry the owner's key.
      forUser: OWNER_USER_KEY,
      payload,
      outcome,
      partOfGoal: goalUri,
      salience: 0.8,
    };
  }

  /**
   * B5 — Phase 1 perception onto the perception buffer. With a perception record
   * its entries in order (message text, sender, channel, entities, claims,
   * intent); without one (initiative turns) the earlier three entries.
   */
  private perceptionEntries(envelope: MessageEnvelope, perception?: Perception): WMEntryInput[] {
    if (perception) return [...perception.entries];
    const out: WMEntryInput[] = [];
    const text = envelope.text || '';
    if (text) {
      out.push({ buffer: 'perceptionBuffer', entryKind: 'message-text', payload: text, salience: 1.0 });
    }
    if (envelope.sender?.id) {
      out.push({
        buffer: 'perceptionBuffer',
        entryKind: 'sender-id',
        payload: envelope.sender.id,
        salience: 1.0,
      });
    }
    if (envelope.channel) {
      out.push({
        buffer: 'perceptionBuffer',
        entryKind: 'channel',
        payload: String(envelope.channel),
        salience: 0.6,
      });
    }
    return out;
  }

  /** B4 — reify the cycle and its six phases into cog:cycles:<sess>. */
  private async writeCycleAndPhases(
    sessionId: string,
    cycleUri: string,
    startedAt: Date,
    endedAt: Date,
    status: 'completed' | 'aborted',
    userKey: string,
    marks: PhaseMarks = { cycleStart: startedAt, coreEnd: endedAt },
    toolEvents: ToolEpisodeEvent[] = [],
  ): Promise<void> {
    const graph = GraphUriResolver.getCogCyclesGraph(this.agentId, sessionId);
    this.registry.assertWritable(graph);

    const tStart = startedAt.toISOString();
    const tEnd = endedAt.toISOString();
    const dt = (s: string) => `"${s}"^^<${XSD}dateTime>`;

    const lines: string[] = [
      `<${cycleUri}> <${RDF_TYPE}> <${COGT}Cycle> .`,
      `<${cycleUri}> <${COGT}cycleStatus> "${status}" .`,
      // Doc 03 §1 names: the cycle's id and session as plain literals, so a cycle
      // joins the episodes (which carry `cogt:cycleId`) in one query.
      `<${cycleUri}> <${COGT}cycleId> "${escapeLiteral(cycleUri.slice(cycleUri.lastIndexOf(':') + 1))}" .`,
      `<${cycleUri}> <${COGT}sessionId> "${escapeLiteral(sessionId)}" .`,
      `<${cycleUri}> <${COGT}startedAt> ${dt(tStart)} .`,
      `<${cycleUri}> <${COGT}endedAt> ${dt(tEnd)} .`,
      `<${cycleUri}> <${COGT}forUser> "${escapeLiteral(userKey)}" .`,
    ];

    // Phase boundaries come from instants measured in memory while the cycle
    // ran. Phase k spans [b[k-1], b[k]]:
    //   b0 cycle start          b1 perception record computed
    //   b2 goal hook started    b3 goal hook returned
    //   b4 last tool completed  b5 core returned      b6 now (records written)
    // Phase 1 therefore covers the context build and the perception compute;
    // Phase 2 is reserved (no work yet) and spans the gap to the goal hook;
    // Phase 4 ends with the last tool call (zero length on a turn without
    // tools), Phase 5 is the rest of the core, Phase 6 is the reflection write.
    // Boundaries are forced non-decreasing and the times are millisecond
    // resolution, so a phase that finishes within one millisecond has zero length.
    const lastToolDone = toolEvents
      .filter((e) => e.phase === 'completed')
      .reduce<Date | undefined>((m, e) => (!m || e.occurredAt > m ? e.occurredAt : m), undefined);
    const raw: Array<Date | undefined> = [
      marks.cycleStart,
      marks.perceivedAt,
      marks.goalStart,
      marks.goalEnd,
      lastToolDone,
      marks.coreEnd ?? endedAt,
      new Date(),
    ];
    const bounds: number[] = [];
    raw.forEach((d, i) => {
      const prev = i === 0 ? startedAt.getTime() : bounds[i - 1];
      bounds.push(Math.max(prev, d ? d.getTime() : prev));
    });
    // The tool completion must not run past the end of the core.
    bounds[4] = Math.min(bounds[4], bounds[5]);
    bounds[3] = Math.min(bounds[3], bounds[4]);
    const span = (ordinal: number): [string, string] => [
      new Date(bounds[ordinal - 1]).toISOString(),
      new Date(bounds[ordinal]).toISOString(),
    ];

    PHASE_KINDS.forEach((kind, i) => {
      const phaseIndex = i + 1;
      const phaseUri = `${cycleUri}_${phaseIndex}`;
      const [s, e] = span(phaseIndex);
      // Doc names (03 §1, §10): hasPhase, phaseIndex, phaseStatus. `partOfCycle`
      // (the inverse link) and `phaseKind` are kept; the old `ordinal` is no
      // longer written (the inspector still reads it on stored cycles).
      const phaseStatus = status === 'aborted' && CORE_PHASE_INDEXES.has(phaseIndex) ? 'aborted' : 'completed';
      lines.push(`<${cycleUri}> <${COGT}hasPhase> <${phaseUri}> .`);
      lines.push(`<${phaseUri}> <${RDF_TYPE}> <${COGT}Phase> .`);
      lines.push(`<${phaseUri}> <${COGT}partOfCycle> <${cycleUri}> .`);
      lines.push(`<${phaseUri}> <${COGT}phaseKind> "${escapeLiteral(kind)}" .`);
      lines.push(`<${phaseUri}> <${COGT}phaseIndex> "${phaseIndex}"^^<${XSD}integer> .`);
      lines.push(`<${phaseUri}> <${COGT}phaseStatus> "${phaseStatus}" .`);
      lines.push(`<${phaseUri}> <${COGT}startedAt> ${dt(s)} .`);
      lines.push(`<${phaseUri}> <${COGT}endedAt> ${dt(e)} .`);
    });

    await this.triplestore.update(`INSERT DATA { GRAPH <${graph}> {\n${lines.join('\n')}\n} }`);
  }

  /** B6 — Phase 6 reflection: a ReflectiveMarker into cog:meta. */
  private async writeReflectiveMarker(
    cycleUri: string,
    status: 'completed' | 'aborted',
  ): Promise<void> {
    const graph = GraphUriResolver.getCogMetaGraph(this.agentId);
    this.registry.assertWritable(graph);

    const markerUri = `urn:${this.agentId}:cog:marker:${newId()}`;
    const note =
      status === 'completed'
        ? 'Cycle completed; response delegated to runtime core.'
        : 'Cycle aborted; core delegation threw.';
    const lines = [
      `<${markerUri}> <${RDF_TYPE}> <${COGT}ReflectiveMarker> .`,
      `<${markerUri}> <${COGT}reflectsOn> <${cycleUri}> .`,
      `<${markerUri}> <${COGT}createdAt> "${new Date().toISOString()}"^^<${XSD}dateTime> .`,
      `<${markerUri}> <${COGT}noted> "${escapeLiteral(note)}" .`,
    ];
    await this.triplestore.update(`INSERT DATA { GRAPH <${graph}> {\n${lines.join('\n')}\n} }`);
  }
}
