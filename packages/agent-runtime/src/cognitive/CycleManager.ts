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
 *   2 Comprehension   — (reserved; no work in Phase B)
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

import { createLogger, type MessageEnvelope, type TriplestoreAdapter } from '@ontofelia/core';
import {
  GraphRegistry,
  GraphUriResolver,
  EpisodicMemory,
  ProceduralMemory,
  SelfModel,
  type TraceInput,
  type SelfView,
} from '@ontofelia/semantic-memory';
import { WorkingMemory } from './WorkingMemory.js';
import { GoalStack, RESPOND_TO_USER, type Goal } from './GoalStack.js';
import {
  Metacognition,
  type ImpasseInput,
  type ImpasseKind,
  type ReflectiveMarkerInput,
} from './Metacognition.js';

/** How many past episodes Phase 2 may pull into the retrieval buffer (C4). */
const RETRIEVAL_K = 5;

/** How many learned skills Phase 3 may surface for the active goal type (E4). */
const SKILL_SUGGESTION_K = 5;
/** How many learned tool sequences Phase 3 may surface (E4). */
const SEQUENCE_SUGGESTION_K = 2;

const COGT = 'urn:shared:ontology#cog/';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const XSD = 'http://www.w3.org/2001/XMLSchema#';

/** The six phase kinds, in cycle order; the array index + 1 is the ordinal. */
const PHASE_KINDS = [
  'perception',
  'comprehension',
  'goal-management',
  'action',
  'response',
  'reflection',
] as const;

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
  outcome?: 'success' | 'error';
  durationMs?: number;
  errorClass?: string;
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

/** The delegated core; receives the tool sink and the goal-context hook. */
export type CoreFn<T> = (
  recordTool: ToolEpisodeRecorder,
  prepareGoals: GoalContextProvider,
) => Promise<T>;

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
   * from `SelfModel.queryFor(goalType)` and constraint pressure is attributed
   * from the self-model's constraints. OFF adds no block and leaves the Phase F
   * constraint-pressure heuristic untouched.
   */
  selfModelEnabled?: boolean;
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

export class CycleManager {
  constructor(
    private readonly triplestore: TriplestoreAdapter,
    private readonly registry: GraphRegistry,
    private readonly agentId: string,
    /** Optional sink for cognitive-write failures (kept off the user path). */
    private readonly onError?: (err: unknown) => void,
  ) {}

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
    const cycleId = `cyc-${newId()}`;
    const cycleUri = `urn:${this.agentId}:cog:cycle:${cycleId}`;
    const startedAt = new Date();
    this.logger.info({ agent: this.agentId, cycleId, phase: 'perception' }, `cycle ${cycleId} started`);

    // Buffer tool events so they can be written as episodes in temporal order
    // after the core completes (see writeEpisodicAndRetrieval). The closure is
    // per-cycle, so concurrent cycles never share state.
    const toolEvents: ToolEpisodeEvent[] = [];
    const recordTool: ToolEpisodeRecorder = (ev) => {
      toolEvents.push(ev);
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
    const prepareGoals: GoalContextProvider = async (sessionId) => {
      if (!options.goalsEnabled) return undefined;
      try {
        const gs = new GoalStack(this.triplestore, this.registry, this.agentId, sessionId);
        const managed = await this.manageGoals(gs, envelope);
        const goal = managed.goal;
        goalConflict = managed.conflict;
        activeGoalUri = goal.uri;
        activeGoalType = goal.goalType;
        const sections = [this.renderActiveGoal(goal)];
        // E4 — bias action selection with learned skills for this goal type.
        if (options.proceduralEnabled) {
          const skillsText = await this.surfaceSkillSuggestions(
            sessionId,
            cycleId,
            cycleUri,
            goal.goalType,
          );
          if (skillsText) sections.push(skillsText);
        }
        // G2 — seed the `[Self]` block from the queryable self-model.
        if (options.selfModelEnabled) {
          const selfText = await this.renderSelfBlock(goal.goalType);
          if (selfText) sections.push(selfText);
        }
        return sections.join('\n\n');
      } catch (e) {
        this.onError?.(e);
        return undefined;
      }
    };

    let result: T;
    let coreError: unknown;
    let status: 'completed' | 'aborted' = 'completed';
    try {
      result = await core(recordTool, prepareGoals);
    } catch (e) {
      status = 'aborted';
      coreError = e;
      result = undefined as unknown as T;
    }
    const endedAt = new Date();
    const durationMs = endedAt.getTime() - startedAt.getTime();
    if (status === 'aborted') {
      this.logger.error({ agent: this.agentId, cycleId, durationMs }, `cycle ${cycleId} aborted`);
    } else {
      this.logger.info({ agent: this.agentId, cycleId, phase: 'reflection', durationMs }, `cycle ${cycleId} completed in ${durationMs}ms`);
    }

    try {
      const sessionId =
        (status === 'completed' && result !== undefined ? sessionIdOf(result) : undefined) ||
        envelope.routingHints?.sessionId ||
        'unknown';
      const responseText =
        status === 'completed' && result !== undefined ? responseTextOf?.(result) : undefined;
      await this.persist(
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
      );
    } catch (persistErr) {
      this.onError?.(persistErr);
    }

    if (coreError) throw coreError;
    return result;
  }

  /**
   * Phase 3 — goal management decision tree (doc 07 §5). Continue an existing
   * substantive goal if one is active; otherwise push a new goal inferred from
   * the inbound intent; otherwise fall back to the implicit RespondToUser goal.
   * Always returns the resulting top active goal.
   */
  private async manageGoals(
    gs: GoalStack,
    envelope: MessageEnvelope,
  ): Promise<{ goal: Goal; conflict: boolean }> {
    const active = await gs.active();
    const substantives = active.filter((g) => g.goalType !== RESPOND_TO_USER);
    // More than one substantive goal contending for the turn is a goal-conflict
    // signal; we still proceed with the highest-priority one (active() is
    // priority-ordered) but flag it for the metacognitive subcycle.
    const conflict = substantives.length > 1;
    if (substantives.length > 0) return { goal: substantives[0], conflict };

    const intent = this.intentGoal(envelope);
    if (intent) {
      const actor = envelope.sender?.id
        ? `urn:entity:agent-sender:${encodeURIComponent(envelope.sender.id)}`
        : undefined;
      const uri = await gs.push({
        goalType: intent.goalType,
        goalLabel: intent.label,
        priority: 0.7,
        triggeredByUser: actor,
      });
      const created = await gs.get(uri);
      if (created) return { goal: created, conflict: false };
    }
    return { goal: await gs.ensureImplicit(), conflict: false };
  }

  /** Map an inbound message to a goal type, or undefined for plain RespondToUser. */
  private intentGoal(envelope: MessageEnvelope): { goalType: string; label: string } | undefined {
    const text = (envelope.text || '').trim();
    if (!text) return undefined;
    const questionLike =
      /\?\s*$/.test(text) ||
      /^(who|what|when|where|why|how|which|is|are|do|does|did|can|could|would|should|will|wer|was|wann|wo|warum|wieso|wie|welche|welcher|ist|sind|kannst|kennst|hast|gibt)\b/i.test(
        text,
      );
    if (questionLike) {
      const brief = text.length > 80 ? `${text.slice(0, 77)}...` : text;
      return { goalType: `${COGT}AnswerQuestion`, label: `Answer: ${brief}` };
    }
    return undefined;
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
    goalType: string,
  ): Promise<string | undefined> {
    const pm = new ProceduralMemory(this.triplestore, this.agentId);
    const [skills, sequences] = await Promise.all([
      pm.suggestSkills(goalType, SKILL_SUGGESTION_K),
      pm.suggestSequenceSkills(goalType, SEQUENCE_SUGGESTION_K),
    ]);
    if (skills.length === 0 && sequences.length === 0) return undefined;

    const wm = new WorkingMemory(this.triplestore, this.registry, this.agentId, sessionId, cycleId);
    const goalPhaseUri = `${cycleUri}_3`;
    const procGraph = pm.graphUri();
    const pct = (n: number) => `${Math.round(n * 100)}%`;

    const lines: string[] = ['[Skills that worked before for this kind of goal]'];
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
    }
    return lines.join('\n');
  }

  /**
   * G2 — render the `[Self]` prompt block from the queryable self-model
   * (doc 08 §2.2): capabilities relevant to the active goal type and the
   * agent's constraints. Returns `undefined` when the self graph holds no
   * capabilities/constraints yet, so an unmigrated agent adds nothing.
   */
  private async renderSelfBlock(goalType: string): Promise<string | undefined> {
    const sm = new SelfModel(this.triplestore, this.agentId);
    const view: SelfView = await sm.queryFor(goalType);
    if (view.capabilities.length === 0 && view.constraints.length === 0) return undefined;
    const lines: string[] = ['[Self]'];
    if (view.capabilities.length > 0) {
      lines.push('Capabilities relevant to this goal:');
      for (const c of view.capabilities) {
        const reqs = c.requires.length > 0 ? ` (uses ${c.requires.join(', ')})` : '';
        lines.push(`• ${c.label}${reqs}`);
      }
    }
    if (view.constraints.length > 0) {
      lines.push('Constraints I must respect:');
      for (const c of view.constraints) {
        const by = c.enforcedBy ? ` [${c.enforcedBy}]` : '';
        lines.push(`• ${c.label}${by}`);
      }
    }
    return lines.join('\n');
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
  ): Promise<void> {
    const perceptionPhaseUri = `${cycleUri}_1`;
    await this.writePerception(envelope, sessionId, cycleId, perceptionPhaseUri);
    const { retrievalHits } = await this.writeEpisodicAndRetrieval(
      envelope,
      sessionId,
      cycleId,
      cycleUri,
      startedAt,
      endedAt,
      responseText,
      toolEvents,
      activeGoalUri,
    );
    if (proceduralEnabled) {
      // E3 — judge the *previous* cycle from this turn's inbound text, then
      // record this turn's traces. Order matters: backfill first so it targets
      // only prior cycles (this cycle's traces aren't written yet, and we also
      // exclude the current cycleId explicitly).
      await this.backfillPriorSatisfaction(sessionId, cycleId, envelope.text || '');
      await this.writeSkillTraces(sessionId, cycleId, toolEvents, activeGoalUri, activeGoalType);
    }
    await this.writeCycleAndPhases(sessionId, cycleUri, startedAt, endedAt, status);
    // Phase 6 reflection. With metacognition ON, detect impasses, run the
    // S1–S4 subcycle for each, and write the *full* marker; OFF restores the
    // minimal Phase B marker exactly (the flag-off equivalence guarantee).
    if (metacognitionEnabled) {
      await this.runMetacognition({
        cycleId,
        cycleUri,
        status,
        responseText,
        toolEvents,
        retrievalHits,
        goalConflict,
        selfModelEnabled,
      });
    } else {
      await this.writeReflectiveMarker(cycleUri, status);
    }
  }

  /**
   * Phase F — the metacognitive half of Phase 6 (doc 08 §5–§6). Detects this
   * cycle's impasses, runs the bounded S1–S4 subcycle to resolve each, and
   * writes the full `cogt:ReflectiveMarker` with the cycle's monitoring
   * signals. All best-effort: it never touches the (already-sent) user reply.
   */
  private async runMetacognition(ctx: {
    cycleId: string;
    cycleUri: string;
    status: 'completed' | 'aborted';
    responseText?: string;
    toolEvents: ToolEpisodeEvent[];
    retrievalHits: number;
    goalConflict: boolean;
    selfModelEnabled: boolean;
  }): Promise<void> {
    const meta = new Metacognition(this.triplestore, this.agentId);

    // --- Detect impasses from the cycle's vantage point (F2). ----------------
    const impasses = this.detectImpasses(ctx);

    // --- S1–S4 subcycle per impasse (F3). The subcycle is a bounded policy
    // lookup plus two writes: it performs no LLM call and cannot itself raise
    // an impasse, so there is no recursion and the cycle can never loop. ------
    const resolved: ResolvedImpasse[] = [];
    for (const input of impasses) {
      try {
        const flagged = await meta.flagImpasse(input); // S1 meta-perception + S2 density
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
        if (autoResolved) await meta.resolveImpasse(flagged.id, resolution, 'metacog');
        resolved.push({ flaggedUri: flagged.id, resolved: autoResolved });
      } catch (e) {
        this.onError?.(e);
      }
    }

    // --- Phase 6 full reflective marker (F4). --------------------------------
    const toolsUsed = new Set(ctx.toolEvents.map((e) => e.callId)).size;
    const toolErrors = ctx.toolEvents.filter(
      (e) => e.phase === 'completed' && e.outcome === 'error',
    ).length;
    const flaggedImpasse = resolved.map((r) => r.flaggedUri);
    const resolvedImpasse = resolved.filter((r) => r.resolved).map((r) => r.flaggedUri);
    const constraintPressure = ctx.selfModelEnabled
      ? await this.selfModelConstraintPressure(ctx.toolEvents)
      : this.constraintPressure(ctx.toolEvents);
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

    await meta.writeMarker({
      cycleUri: ctx.cycleUri,
      cycleStatus,
      toolsUsed,
      toolErrors,
      emptyRetrieval: ctx.retrievalHits === 0,
      toolChurn: this.isToolChurn(ctx.toolEvents),
      constraintPressure,
      flaggedImpasse,
      resolvedImpasse,
      noted,
    });
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
  }): ImpasseInput[] {
    const out: ImpasseInput[] = [];
    if (ctx.goalConflict) {
      out.push({
        kind: 'goal-conflict',
        flaggedInPhase: `${ctx.cycleUri}_3`,
        context: 'More than one substantive goal active for the turn.',
      });
    }
    for (const e of ctx.toolEvents) {
      if (e.phase !== 'completed' || e.outcome !== 'error') continue;
      const denied = /policy|permission|denied|forbidden|unauthor/i.test(e.errorClass ?? '');
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

  /** Constraint pressure = count of policy/permission-denied tool errors. */
  private constraintPressure(toolEvents: ToolEpisodeEvent[]): number {
    return toolEvents.filter(
      (e) =>
        e.phase === 'completed' &&
        e.outcome === 'error' &&
        /policy|permission|denied|forbidden|unauthor/i.test(e.errorClass ?? ''),
    ).length;
  }

  /**
   * G3 — constraint pressure attributed from the self-model: an errored tool
   * call counts as pressure when a `cogt:Constraint` governs that tool (its
   * `cogt:applies` names the tool), the regex heuristic catches it, or both.
   * This makes the self-model's declared constraints, not just error strings,
   * the source of the metacognitive constraint-pressure signal.
   */
  private async selfModelConstraintPressure(toolEvents: ToolEpisodeEvent[]): Promise<number> {
    const sm = new SelfModel(this.triplestore, this.agentId);
    let pressure = 0;
    for (const e of toolEvents) {
      if (e.phase !== 'completed' || e.outcome !== 'error') continue;
      const heuristic = /policy|permission|denied|forbidden|unauthor/i.test(e.errorClass ?? '');
      const governed = (await sm.constraintsForTool(e.toolName)).length > 0;
      if (heuristic || governed) pressure++;
    }
    return pressure;
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
  ): Promise<void> {
    const satisfied = this.classifySatisfaction(text);
    if (satisfied === null) return;
    const pm = new ProceduralMemory(this.triplestore, this.agentId);
    const uris = await pm.findPriorCycleTraceUris(sessionId, cycleId);
    for (const uri of uris) await pm.backfillSatisfaction(uri, satisfied);
  }

  /** Crude satisfaction read of an inbound message: true / false / null (ambiguous). */
  private classifySatisfaction(text: string): boolean | null {
    const t = text.trim().toLowerCase();
    if (!t) return null;
    const positive =
      /\b(thanks|thank you|thx|danke|perfect|perfekt|great|super|awesome|nice|exactly|genau|correct|richtig|stimmt|spot on|works?|funktioniert|top)\b/.test(
        t,
      ) || /(^|\s)(👍|🙏|✅)/.test(text);
    const negative =
      /\b(no|nope|nein|wrong|falsch|incorrect|stop|stopp|not what|that'?s wrong|not right|nicht richtig|quatsch|leider nicht)\b/.test(
        t,
      ) || /(^|\s)(👎|❌)/.test(text);
    if (positive && !negative) return true;
    if (negative && !positive) return false;
    return null;
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
  private async writeSkillTraces(
    sessionId: string,
    cycleId: string,
    toolEvents: ToolEpisodeEvent[],
    activeGoalUri?: string,
    activeGoalType?: string,
  ): Promise<void> {
    // Pair events by callId, preserving first-seen order.
    interface Call {
      callId: string;
      toolName: string;
      argsBrief?: string;
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
      } else {
        call.outcome = ev.outcome;
        call.durationMs = ev.durationMs;
        call.errorClass = ev.errorClass;
      }
    }
    if (order.length === 0) return;

    const pm = new ProceduralMemory(this.triplestore, this.agentId);
    const sequenceLen = order.length;
    let previousTrace: string | undefined;
    let pos = 0;
    for (const callId of order) {
      const c = calls.get(callId)!;
      pos++;
      const brief = c.argsBrief ?? '';
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
        previousTrace,
      };
      previousTrace = await pm.recordTrace(trace);
    }
  }

  /**
   * Episodic memory + retrieval (Phase C, C2 + C4 + the response half of C3).
   *
   *  - Phase 1 records a `message-received` episode (actor = sender, payload =
   *    text, transcriptRef = session) chained to the session's prior episode.
   *  - Phase 2 retrieves up to K relevant *past* episodes and writes them onto
   *    the retrieval buffer with `retrievalScore` and `sourceGraph` provenance.
   *  - Phase 5 records a `response-sent` episode for the textual reply.
   *
   *  - Phase 5 also records `tool-called` / `tool-completed` episodes for each
   *    tool the core invoked (C3), replayed here in arrival order so the
   *    narrative chain stays temporally correct.
   */
  private async writeEpisodicAndRetrieval(
    envelope: MessageEnvelope,
    sessionId: string,
    cycleId: string,
    cycleUri: string,
    startedAt: Date,
    endedAt: Date,
    responseText?: string,
    toolEvents: ToolEpisodeEvent[] = [],
    activeGoalUri?: string,
  ): Promise<{ retrievalHits: number }> {
    let retrievalHits = 0;
    const em = new EpisodicMemory(this.triplestore, this.agentId);
    const text = envelope.text || '';
    const channel = envelope.channel ? String(envelope.channel) : undefined;
    const actor = envelope.sender?.id
      ? `urn:entity:agent-sender:${encodeURIComponent(envelope.sender.id)}`
      : undefined;

    // C2 — perception episode. D4 — backfill the turn's active goal.
    const perceptionEpUri = await em.append({
      episodeType: 'message-received',
      occurredAt: startedAt,
      sessionId,
      cycleId,
      channel,
      actor,
      payload: text,
      transcriptRef: `${sessionId}.jsonl`,
      partOfGoal: activeGoalUri,
    });

    // C4 — pull relevant *past* episodes into the retrieval buffer (excluding
    // the one we just wrote for this turn).
    if (text) {
      const hits = (await em.retrieve(text, RETRIEVAL_K, { sessionId })).filter(
        (h) => h.uri !== perceptionEpUri,
      );
      retrievalHits = hits.length;
      if (hits.length > 0) {
        const wm = new WorkingMemory(
          this.triplestore,
          this.registry,
          this.agentId,
          sessionId,
          cycleId,
        );
        const comprehensionPhaseUri = `${cycleUri}_2`;
        for (const h of hits) {
          await wm.write(
            {
              buffer: 'retrievalBuffer',
              entryKind: 'episode-ref',
              payload: h.payload ?? h.episodeType,
              salience: h.relevanceScore,
              retrievalScore: h.relevanceScore,
              sourceGraph: em.graphUri(),
              refersTo: h.uri,
            },
            comprehensionPhaseUri,
          );
        }
      }
    }

    // C3 — tool-called / tool-completed episodes, in arrival order.
    for (const ev of toolEvents) {
      if (ev.phase === 'called') {
        await em.append({
          episodeType: 'tool-called',
          occurredAt: ev.occurredAt,
          sessionId,
          cycleId,
          payload: ev.argsBrief ? `${ev.toolName} (${ev.argsBrief})` : ev.toolName,
          tags: [ev.callId],
        });
      } else {
        await em.append({
          episodeType: 'tool-completed',
          occurredAt: ev.occurredAt,
          sessionId,
          cycleId,
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
      await em.append({
        episodeType: 'response-sent',
        occurredAt: endedAt,
        sessionId,
        cycleId,
        channel,
        actor: `urn:${this.agentId}:self#${this.agentId}`,
        payload: responseText,
        transcriptRef: `${sessionId}.jsonl`,
        partOfGoal: activeGoalUri,
      });
    }
    return { retrievalHits };
  }

  /** B5 — Phase 1 perception: message text and sender onto the perception buffer. */
  private async writePerception(
    envelope: MessageEnvelope,
    sessionId: string,
    cycleId: string,
    phaseUri: string,
  ): Promise<void> {
    const wm = new WorkingMemory(this.triplestore, this.registry, this.agentId, sessionId, cycleId);
    const text = envelope.text || '';
    if (text) {
      await wm.write(
        { buffer: 'perceptionBuffer', entryKind: 'message-text', payload: text, salience: 1.0 },
        phaseUri,
      );
    }
    if (envelope.sender?.id) {
      await wm.write(
        {
          buffer: 'perceptionBuffer',
          entryKind: 'sender-id',
          payload: envelope.sender.id,
          salience: 1.0,
        },
        phaseUri,
      );
    }
    if (envelope.channel) {
      await wm.write(
        {
          buffer: 'perceptionBuffer',
          entryKind: 'channel',
          payload: String(envelope.channel),
          salience: 0.6,
        },
        phaseUri,
      );
    }
  }

  /** B4 — reify the cycle and its six phases into cog:cycles:<sess>. */
  private async writeCycleAndPhases(
    sessionId: string,
    cycleUri: string,
    startedAt: Date,
    endedAt: Date,
    status: 'completed' | 'aborted',
  ): Promise<void> {
    const graph = GraphUriResolver.getCogCyclesGraph(this.agentId, sessionId);
    this.registry.assertWritable(graph);

    const tStart = startedAt.toISOString();
    const tEnd = endedAt.toISOString();
    const dt = (s: string) => `"${s}"^^<${XSD}dateTime>`;

    const lines: string[] = [
      `<${cycleUri}> <${RDF_TYPE}> <${COGT}Cycle> .`,
      `<${cycleUri}> <${COGT}cycleStatus> "${status}" .`,
      `<${cycleUri}> <${COGT}startedAt> ${dt(tStart)} .`,
      `<${cycleUri}> <${COGT}endedAt> ${dt(tEnd)} .`,
    ];

    // Phase timings: 1-2 precede the core, 3-5 span it, 6 follows. With no
    // sub-phase instrumentation in Phase B the cycle boundaries are the only
    // honest timestamps, so phases share them accordingly.
    const span = (ordinal: number): [string, string] => {
      if (ordinal <= 2) return [tStart, tStart];
      if (ordinal <= 5) return [tStart, tEnd];
      return [tEnd, tEnd];
    };

    PHASE_KINDS.forEach((kind, i) => {
      const ordinal = i + 1;
      const phaseUri = `${cycleUri}_${ordinal}`;
      const [s, e] = span(ordinal);
      lines.push(`<${phaseUri}> <${RDF_TYPE}> <${COGT}Phase> .`);
      lines.push(`<${phaseUri}> <${COGT}partOfCycle> <${cycleUri}> .`);
      lines.push(`<${phaseUri}> <${COGT}phaseKind> "${escapeLiteral(kind)}" .`);
      lines.push(`<${phaseUri}> <${COGT}ordinal> "${ordinal}"^^<${XSD}integer> .`);
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
