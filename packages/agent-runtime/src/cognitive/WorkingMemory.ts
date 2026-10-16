/**
 * WorkingMemory — the per-cycle blackboard (docs/cognitive-architecture/04).
 *
 * Every fragment that may end up in the LLM prompt is a `cogt:WorkingMemoryEntry`
 * resource living in the cycle's `urn:<agent>:cog:working:<sess>:<cycle>` graph.
 * Each entry carries a buffer, an entry kind, a payload and a numeric salience;
 * the *global workspace* (the prompt projection) is the salience-≥θ slice,
 * rendered in a fixed buffer order.
 *
 * Implementation notes:
 *  - Writes are emitted as typed SPARQL `INSERT DATA` (not adapter.insertTriples)
 *    because the adapters drop literal datatypes, and numeric comparison of
 *    `cogt:salience` in SPARQL needs a real `xsd:decimal`.
 *  - Every mutating call routes through {@link GraphRegistry.assertWritable} so a
 *    buggy cycle can never write outside the registered cog:working graph.
 */

import type { TriplestoreAdapter } from '@ontofelia/core';
import { GraphRegistry, GraphUriResolver } from '@ontofelia/semantic-memory';

const COGT = 'urn:shared:ontology#cog/';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const XSD = 'http://www.w3.org/2001/XMLSchema#';

/** The six buffers a WM entry may belong to (doc 04 §2). */
export type BufferName =
  | 'perceptionBuffer'
  | 'retrievalBuffer'
  | 'goalBuffer'
  | 'actionBuffer'
  | 'selfBuffer'
  | 'metaBuffer';

/**
 * Controlled vocabulary of entry kinds (doc 04 §3.1). Kept as a widenable union
 * so callers get autocomplete without the type rejecting a new kind a later
 * phase introduces.
 */
export type EntryKind =
  | 'message-text'
  | 'sender-id'
  | 'ner-result'
  | 'parsed-claim'
  | 'intent'
  | 'fact'
  | 'episode-ref'
  | 'goal-active'
  | 'goal-parent'
  | 'action-proposal'
  | 'action-result'
  | 'capability'
  | 'constraint'
  | 'persona-fragment'
  | 'reflection'
  | 'impasse-flag'
  | (string & {});

/** A reference to the phase resource that authored an entry. */
export type PhaseRef = string;

/** Opaque identifier (an IRI) of a written entry. */
export type WMEntryId = string;

export interface WMEntryInput {
  buffer: BufferName;
  entryKind: EntryKind;
  payload: string;
  /** Salience in [0,1]; values outside the range are clamped. */
  salience: number;
  refersTo?: string;
  sourceGraph?: string;
  retrievalScore?: number;
  carryForward?: boolean;
  /** Lifetime in cycles; decremented on each carry-over. */
  expiresAfter?: number;
  forGoal?: string;
  /**
   * Action fields (`actionBuffer` only). Kept as plain literals: the doc's
   * `actionType` is the entry kind here, and `toolArgs` is a keys-only brief.
   */
  toolName?: string;
  /** Correlation id of the tool call; pairs an `action-result` to its proposal. */
  callId?: string;
  /** Keys-only, masked summary of the arguments. Never a value. */
  toolArgs?: string;
  /** Result of a tool call (`action-result`). */
  outcome?: 'success' | 'error';
  denialClass?: string;
  durationMs?: number;
}

export interface WMEntry extends WMEntryInput {
  /**
   * The sender's user key (`cogt:forUser`) the entry was written for. Absent on
   * entries written before the key existed (treated as owner-only by readers).
   */
  forUser?: string;
  id: WMEntryId;
  writtenBy: PhaseRef;
  writtenAt: string;
  carriedFrom?: string;
}

export interface WMReadFilter {
  buffer?: BufferName;
  entryKind?: EntryKind;
  /** Inclusive lower bound on salience. */
  minSalience?: number;
  /** Only entries written for exactly this user key (`cogt:forUser`). */
  forUser?: string;
  /** Only entries flagged `cogt:carryForward true`. */
  carryForwardOnly?: boolean;
  /** At most this many entries, highest salience first (a whole-graph read when absent). */
  limit?: number;
}

/**
 * Fixed render order of the global workspace (doc 04 §5). Perception is last so
 * the model sees context before the question. `actionBuffer` is not in the
 * doc's five-buffer prose order; it is slotted after retrieval (actions follow
 * from what was retrieved) while preserving the documented subsequence.
 */
const BUFFER_ORDER: BufferName[] = [
  'selfBuffer',
  'goalBuffer',
  'retrievalBuffer',
  'actionBuffer',
  'metaBuffer',
  'perceptionBuffer',
];

/** Default hard cap on entries per cycle (doc 04 §7). */
export const DEFAULT_CAPACITY = 200;
/** A drop of an entry above this salience counts towards a `wm-overflow` impasse (doc 04 §7). */
export const OVERFLOW_SALIENCE = 0.7;
/** Salience added to an entry about an entity of the active goal (doc 07 §6.1). */
export const GOAL_BOOST = 0.2;
/**
 * Hard lower bound of the drop floor for carried entries. The effective floor is
 * `min(CARRY_FLOOR, θ)`: a carried entry that fell below it is no longer worth
 * keeping and is deleted from the cycle. Deliberately low (0.1, well under the
 * default θ of 0.5) so that carried material is kept rather than lost early.
 */
export const CARRY_FLOOR = 0.1;
/** Salience multiplier applied to entries carried into the next cycle (§6). */
export const CARRY_DECAY = 0.7;
/** Default global-workspace cutoff (doc 04 §4). */
export const DEFAULT_THETA = 0.5;

/**
 * The global-workspace projection on any list of entries: keep those with
 * `salience ≥ θ`, ordered by the fixed buffer sequence and then by descending
 * salience (stable, so equal entries keep their input order). This is the one
 * piece of projection code: {@link WorkingMemory.globalWorkspace} applies it to
 * the stored entries, the prompt assembler to the cycle's in-memory view.
 */
export function projectGlobalWorkspace<T extends { buffer: BufferName; salience: number }>(
  entries: readonly T[],
  theta = DEFAULT_THETA,
): T[] {
  const min = clamp01(theta);
  return entries
    .filter((e) => e.salience >= min)
    .sort((a, b) => {
      const ai = BUFFER_ORDER.indexOf(a.buffer);
      const bi = BUFFER_ORDER.indexOf(b.buffer);
      const ar = ai === -1 ? BUFFER_ORDER.length : ai;
      const br = bi === -1 ? BUFFER_ORDER.length : bi;
      if (ar !== br) return ar - br;
      return b.salience - a.salience;
    });
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/** Round to 6 decimals so repeated ×0.7 steps store exact-looking decimals. */
function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/** An entry the cap removed. */
export interface DroppedEntry {
  id: WMEntryId;
  buffer: BufferName;
  salience: number;
}

export interface WorkingMemoryOptions {
  /** Entry cap per cycle graph; defaults to {@link DEFAULT_CAPACITY}. */
  capacity?: number;
  /** Called once for every entry the cap removed (after its deletion). */
  onDrop?: (dropped: DroppedEntry) => void;
}

export interface CarryOptions {
  /**
   * Goal IRIs that are still live. `goalBuffer` entries whose `forGoal` is in
   * the set carry; without it no goal entry carries.
   */
  liveGoals?: ReadonlySet<string>;
}

export interface AttentionInput {
  /** Entity IRIs of the active goal: entries `refersTo` one get {@link GOAL_BOOST}. */
  boostEntities: ReadonlySet<string>;
  /** Entity IRIs of every live goal: carried entries about none of them are damped. */
  keepEntities: ReadonlySet<string>;
  /** θ in use; the drop floor is `min(CARRY_FLOOR, θ)`. */
  theta: number;
}

export interface AttentionReport {
  boosted: number;
  damped: number;
  dropped: number;
}

const EXTRA_CAPACITY_MAX = 10_000;

/** Escape a string for safe inclusion inside a SPARQL double-quoted literal. */
function escapeLiteral(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

export class WorkingMemory {
  constructor(
    private readonly triplestore: TriplestoreAdapter,
    private readonly registry: GraphRegistry,
    private readonly agentId: string,
    private readonly sessionId: string,
    private readonly cycleId: string,
    /** The sender's user key; written as `cogt:forUser` on every entry. */
    private readonly forUser?: string,
    options: WorkingMemoryOptions = {},
  ) {
    const cap = options.capacity;
    this.capacity =
      cap !== undefined && Number.isInteger(cap) && cap >= 1 && cap <= EXTRA_CAPACITY_MAX
        ? cap
        : DEFAULT_CAPACITY;
    this.onDrop = options.onDrop;
  }

  private readonly capacity: number;
  private readonly onDrop?: (dropped: DroppedEntry) => void;

  graphUri(): string {
    return GraphUriResolver.getCogWorkingGraph(this.agentId, this.sessionId, this.cycleId);
  }

  private newEntryId(): WMEntryId {
    const rand =
      typeof globalThis.crypto?.randomUUID === 'function'
        ? globalThis.crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return `urn:${this.agentId}:cog:wm:${rand}`;
  }

  /** Write a new entry into the cycle's working graph; returns its IRI. */
  async write(entry: WMEntryInput, writtenBy: PhaseRef): Promise<WMEntryId> {
    const graph = this.graphUri();
    this.registry.assertWritable(graph);

    const { id, lines } = this.entryLines(entry, writtenBy);
    await this.triplestore.update(`INSERT DATA { GRAPH <${graph}> {\n${lines.join('\n')}\n} }`);
    await this.enforceCap();
    return id;
  }

  /**
   * Whether `n` more entries fit under the cap without any eviction: the count
   * now is at most `capacity - n`. A bounded probe (at most one row), like the
   * one {@link write} runs after each insert. When this holds, writing the `n`
   * entries one by one would evict nothing, so {@link insertMany} stores exactly
   * the same graph.
   */
  async hasRoomFor(n: number): Promise<boolean> {
    if (n <= 0) return true;
    const room = this.capacity - n;
    if (room < 0) return false;
    const probe = await this.triplestore.query(`
      SELECT ?e WHERE {
        GRAPH <${this.graphUri()}> { ?e a <${COGT}WorkingMemoryEntry> ; <${COGT}salience> ?s }
      } LIMIT 1 OFFSET ${room}`);
    return (probe.bindings ?? []).length === 0;
  }

  /**
   * Write several entries with ONE update and no cap enforcement. The caller
   * has checked {@link hasRoomFor} for every entry it is about to write and
   * writes nothing else to this graph meanwhile; under that condition this is
   * the same stored graph as `write()` per entry (which would evict nothing).
   * Returns the entry IRIs in order. The update is issued synchronously when
   * this is called.
   */
  insertMany(items: Array<{ entry: WMEntryInput; writtenBy: PhaseRef }>): Promise<WMEntryId[]> {
    const graph = this.graphUri();
    this.registry.assertWritable(graph);
    const ids: WMEntryId[] = [];
    const lines: string[] = [];
    for (const it of items) {
      const built = this.entryLines(it.entry, it.writtenBy);
      ids.push(built.id);
      lines.push(...built.lines);
    }
    if (lines.length === 0) return Promise.resolve(ids);
    return this.triplestore
      .update(`INSERT DATA { GRAPH <${graph}> {\n${lines.join('\n')}\n} }`)
      .then(() => ids);
  }

  private entryLines(entry: WMEntryInput, writtenBy: PhaseRef): { id: WMEntryId; lines: string[] } {
    const id = this.newEntryId();
    const salience = clamp01(entry.salience);
    const writtenAt = new Date().toISOString();

    const lines: string[] = [
      `<${id}> <${RDF_TYPE}> <${COGT}WorkingMemoryEntry> .`,
      `<${id}> <${COGT}writtenTo> "${escapeLiteral(entry.buffer)}" .`,
      `<${id}> <${COGT}writtenBy> <${writtenBy}> .`,
      `<${id}> <${COGT}writtenAt> "${writtenAt}"^^<${XSD}dateTime> .`,
      `<${id}> <${COGT}entryKind> "${escapeLiteral(entry.entryKind)}" .`,
      `<${id}> <${COGT}payload> "${escapeLiteral(entry.payload)}" .`,
      `<${id}> <${COGT}salience> "${salience}"^^<${XSD}decimal> .`,
    ];
    if (entry.refersTo) lines.push(`<${id}> <${COGT}refersTo> <${entry.refersTo}> .`);
    if (entry.sourceGraph)
      lines.push(`<${id}> <${COGT}sourceGraph> "${escapeLiteral(entry.sourceGraph)}" .`);
    if (entry.retrievalScore !== undefined)
      lines.push(
        `<${id}> <${COGT}retrievalScore> "${clamp01(entry.retrievalScore)}"^^<${XSD}decimal> .`,
      );
    if (entry.carryForward !== undefined)
      lines.push(`<${id}> <${COGT}carryForward> "${entry.carryForward}"^^<${XSD}boolean> .`);
    if (entry.expiresAfter !== undefined)
      lines.push(
        `<${id}> <${COGT}expiresAfter> "${Math.trunc(entry.expiresAfter)}"^^<${XSD}integer> .`,
      );
    if (entry.forGoal) lines.push(`<${id}> <${COGT}forGoal> <${entry.forGoal}> .`);
    if (entry.toolName) lines.push(`<${id}> <${COGT}toolName> "${escapeLiteral(entry.toolName)}" .`);
    if (entry.callId) lines.push(`<${id}> <${COGT}callId> "${escapeLiteral(entry.callId)}" .`);
    if (entry.toolArgs !== undefined)
      lines.push(`<${id}> <${COGT}toolArgs> "${escapeLiteral(entry.toolArgs)}" .`);
    if (entry.outcome) lines.push(`<${id}> <${COGT}outcome> "${escapeLiteral(entry.outcome)}" .`);
    if (entry.denialClass)
      lines.push(`<${id}> <${COGT}denialClass> "${escapeLiteral(entry.denialClass)}" .`);
    if (entry.durationMs !== undefined)
      lines.push(`<${id}> <${COGT}durationMs> "${Math.max(0, Math.trunc(entry.durationMs))}"^^<${XSD}integer> .`);
    if (this.forUser) lines.push(`<${id}> <${COGT}forUser> "${escapeLiteral(this.forUser)}" .`);
    return { id, lines };
  }

  /** Read entries, optionally filtered by buffer / kind / minimum salience. */
  async read(filter: WMReadFilter = {}): Promise<WMEntry[]> {
    const graph = this.graphUri();
    const filters: string[] = [];
    if (filter.buffer) filters.push(`FILTER(?buffer = "${escapeLiteral(filter.buffer)}")`);
    if (filter.entryKind) filters.push(`FILTER(?kind = "${escapeLiteral(filter.entryKind)}")`);
    if (filter.minSalience !== undefined)
      filters.push(`FILTER(?salience >= ${clamp01(filter.minSalience)})`);
    if (filter.forUser !== undefined) filters.push(`FILTER(BOUND(?forUser) && ?forUser = "${escapeLiteral(filter.forUser)}")`);
    if (filter.carryForwardOnly) filters.push(`FILTER(BOUND(?carryForward) && ?carryForward = true)`);
    const limit =
      filter.limit !== undefined && Number.isInteger(filter.limit) && filter.limit >= 1
        ? `ORDER BY DESC(?salience) LIMIT ${Math.min(filter.limit, EXTRA_CAPACITY_MAX)}`
        : '';

    const sparql = `
      SELECT ?entry ?buffer ?writtenBy ?writtenAt ?kind ?payload ?salience
             ?refersTo ?sourceGraph ?retrievalScore ?carryForward ?expiresAfter
             ?forGoal ?carriedFrom ?forUser
             ?toolName ?callId ?toolArgs ?outcome ?denialClass ?durationMs
      WHERE {
        GRAPH <${graph}> {
          ?entry a <${COGT}WorkingMemoryEntry> ;
                 <${COGT}writtenTo> ?buffer ;
                 <${COGT}writtenBy> ?writtenBy ;
                 <${COGT}writtenAt> ?writtenAt ;
                 <${COGT}entryKind> ?kind ;
                 <${COGT}payload>   ?payload ;
                 <${COGT}salience>  ?salience .
          OPTIONAL { ?entry <${COGT}refersTo>       ?refersTo . }
          OPTIONAL { ?entry <${COGT}sourceGraph>    ?sourceGraph . }
          OPTIONAL { ?entry <${COGT}retrievalScore> ?retrievalScore . }
          OPTIONAL { ?entry <${COGT}carryForward>   ?carryForward . }
          OPTIONAL { ?entry <${COGT}expiresAfter>   ?expiresAfter . }
          OPTIONAL { ?entry <${COGT}forGoal>        ?forGoal . }
          OPTIONAL { ?entry <${COGT}carriedFrom>    ?carriedFrom . }
          OPTIONAL { ?entry <${COGT}forUser>        ?forUser . }
          OPTIONAL { ?entry <${COGT}toolName>       ?toolName . }
          OPTIONAL { ?entry <${COGT}callId>         ?callId . }
          OPTIONAL { ?entry <${COGT}toolArgs>       ?toolArgs . }
          OPTIONAL { ?entry <${COGT}outcome>        ?outcome . }
          OPTIONAL { ?entry <${COGT}denialClass>    ?denialClass . }
          OPTIONAL { ?entry <${COGT}durationMs>     ?durationMs . }
          ${filters.join('\n          ')}
        }
      } ${limit}`;

    const res = await this.triplestore.query(sparql);
    const rows = res.bindings ?? [];
    return rows.map((r) => {
      const num = (k: string): number | undefined =>
        r[k] !== undefined ? Number(r[k].value) : undefined;
      const entry: WMEntry = {
        id: r.entry.value,
        buffer: r.buffer.value as BufferName,
        writtenBy: r.writtenBy.value,
        writtenAt: r.writtenAt.value,
        entryKind: r.kind.value,
        payload: r.payload.value,
        salience: Number(r.salience.value),
      };
      if (r.refersTo) entry.refersTo = r.refersTo.value;
      if (r.sourceGraph) entry.sourceGraph = r.sourceGraph.value;
      if (r.retrievalScore) entry.retrievalScore = num('retrievalScore');
      if (r.carryForward) entry.carryForward = r.carryForward.value === 'true';
      if (r.expiresAfter) entry.expiresAfter = num('expiresAfter');
      if (r.forGoal) entry.forGoal = r.forGoal.value;
      if (r.carriedFrom) entry.carriedFrom = r.carriedFrom.value;
      if (r.forUser) entry.forUser = r.forUser.value;
      if (r.toolName) entry.toolName = r.toolName.value;
      if (r.callId) entry.callId = r.callId.value;
      if (r.toolArgs) entry.toolArgs = r.toolArgs.value;
      if (r.outcome && (r.outcome.value === 'success' || r.outcome.value === 'error')) entry.outcome = r.outcome.value;
      if (r.denialClass) entry.denialClass = r.denialClass.value;
      if (r.durationMs) entry.durationMs = num('durationMs');
      return entry;
    });
  }

  /**
   * The global workspace: entries with `salience ≥ θ`, ordered by the fixed
   * buffer sequence and then by descending salience within each buffer.
   */
  async globalWorkspace(theta = DEFAULT_THETA): Promise<WMEntry[]> {
    const entries = await this.read({ minSalience: theta });
    return projectGlobalWorkspace(entries, theta);
  }

  /** Additively adjust an entry's salience, clamped to [0,1]. */
  async adjustSalience(id: WMEntryId, delta: number): Promise<void> {
    const graph = this.graphUri();
    this.registry.assertWritable(graph);

    const res = await this.triplestore.query(`
      SELECT ?s WHERE { GRAPH <${graph}> { <${id}> <${COGT}salience> ?s } }`);
    const current = res.bindings?.[0]?.s?.value;
    if (current === undefined) return;
    const next = clamp01(Number(current) + delta);

    await this.triplestore.update(`
      DELETE { GRAPH <${graph}> { <${id}> <${COGT}salience> ?old } }
      INSERT { GRAPH <${graph}> { <${id}> <${COGT}salience> "${next}"^^<${XSD}decimal> } }
      WHERE  { GRAPH <${graph}> { <${id}> <${COGT}salience> ?old } }`);
  }

  /**
   * Copy carry-eligible entries into `toCycleId`'s working graph with decayed
   * salience and a `cogt:carriedFrom` back-link (doc 04 §6). Returns the number
   * of entries carried.
   *
   * Carry rule: an entry carries if it is in `selfBuffer` (session-constant),
   * or it is a `goalBuffer` entry of a goal in `opts.liveGoals`, or it has
   * `carryForward = true` (a flagged metacognition note, for one) and is not
   * expired (`expiresAfter` unset or > 0).
   *
   * Scoping: only entries written for this instance's user carry (an entry
   * without `forUser` carries only for an instance without one), and the target
   * graph belongs to the same session by construction.
   *
   * An entry the target cycle already holds in the same form (same buffer,
   * kind, payload and goal) is "refreshed" and is not copied again.
   */
  async carryForward(toCycleId: string, opts: CarryOptions = {}): Promise<number> {
    const prepared = await this.prepareCarryForward(toCycleId, opts);
    await prepared.commit();
    return prepared.count;
  }

  /**
   * The reads of {@link carryForward} first, the write later: `count` entries
   * will be carried, and `commit()` stores them (one update, issued
   * synchronously when called; a no-op when nothing carries).
   */
  async prepareCarryForward(
    toCycleId: string,
    opts: CarryOptions = {},
  ): Promise<{ count: number; commit: () => Promise<void> }> {
    const none = { count: 0, commit: async () => undefined };
    const target = GraphUriResolver.getCogWorkingGraph(this.agentId, this.sessionId, toCycleId);
    this.registry.assertWritable(target);

    const all = (await this.read()).filter((e) => (e.forUser ?? undefined) === this.forUser);
    const eligible = all.filter(
      (e) =>
        e.buffer === 'selfBuffer' ||
        (e.buffer === 'goalBuffer' && e.forGoal !== undefined && opts.liveGoals?.has(e.forGoal) === true) ||
        (e.carryForward === true && (e.expiresAfter === undefined || e.expiresAfter > 0)),
    );
    if (eligible.length === 0) return none;

    const present = await new WorkingMemory(
      this.triplestore,
      this.registry,
      this.agentId,
      this.sessionId,
      toCycleId,
      this.forUser,
    ).read();
    const sig = (e: { buffer: string; entryKind: string; payload: string; forGoal?: string }) =>
      `${e.buffer}\u0000${e.entryKind}\u0000${e.payload}\u0000${e.forGoal ?? ''}`;
    const have = new Set(present.map(sig));
    const todo = eligible.filter((e) => !have.has(sig(e)));
    if (todo.length === 0) return none;

    const lines: string[] = [];
    for (const e of todo) {
      const id = this.newEntryId();
      const salience = clamp01(round6(e.salience * CARRY_DECAY));
      lines.push(`<${id}> <${RDF_TYPE}> <${COGT}WorkingMemoryEntry> .`);
      lines.push(`<${id}> <${COGT}writtenTo> "${escapeLiteral(e.buffer)}" .`);
      lines.push(`<${id}> <${COGT}writtenBy> <${e.writtenBy}> .`);
      lines.push(`<${id}> <${COGT}writtenAt> "${new Date().toISOString()}"^^<${XSD}dateTime> .`);
      lines.push(`<${id}> <${COGT}entryKind> "${escapeLiteral(e.entryKind)}" .`);
      lines.push(`<${id}> <${COGT}payload> "${escapeLiteral(e.payload)}" .`);
      lines.push(`<${id}> <${COGT}salience> "${salience}"^^<${XSD}decimal> .`);
      lines.push(`<${id}> <${COGT}carriedFrom> <${e.id}> .`);
      if (e.forUser) lines.push(`<${id}> <${COGT}forUser> "${escapeLiteral(e.forUser)}" .`);
      if (e.refersTo) lines.push(`<${id}> <${COGT}refersTo> <${e.refersTo}> .`);
      if (e.carryForward !== undefined)
        lines.push(`<${id}> <${COGT}carryForward> "${e.carryForward}"^^<${XSD}boolean> .`);
      if (e.expiresAfter !== undefined)
        lines.push(
          `<${id}> <${COGT}expiresAfter> "${Math.max(0, Math.trunc(e.expiresAfter) - 1)}"^^<${XSD}integer> .`,
        );
      if (e.forGoal) lines.push(`<${id}> <${COGT}forGoal> <${e.forGoal}> .`);
      if (e.sourceGraph)
        lines.push(`<${id}> <${COGT}sourceGraph> "${escapeLiteral(e.sourceGraph)}" .`);
    }
    return {
      count: todo.length,
      commit: async () => {
        await this.triplestore.update(`INSERT DATA { GRAPH <${target}> {\n${lines.join('\n')}\n} }`);
      },
    };
  }

  /**
   * Goal-steered attention over this cycle's graph (doc 07 §6), once per cycle:
   *
   *  - an entry that `refersTo` an entity of the active goal gets +0.2 (cap 1);
   *  - a carried entry (has `carriedFrom`) that refers to an entity of no live
   *    goal and was not refreshed this cycle (no fresh, non-carried entry refers
   *    to the same entity) is damped ×0.7;
   *  - a carried entry that ends below the floor `min(0.1, θ)` is deleted.
   *
   * Entries without `refersTo` are never damped here (the ×0.7 of the carry
   * itself is their decay); fresh entries are never dropped by the floor. The
   * read is bounded by the cap.
   */
  async attend(input: AttentionInput): Promise<AttentionReport> {
    const prepared = await this.prepareAttend(input);
    await prepared.commit();
    return prepared.report;
  }

  /**
   * The reads and the decisions of {@link attend} first, the write later:
   * `report` says what will change and `commit()` stores it (one update, issued
   * synchronously when called; a no-op when nothing changes).
   */
  async prepareAttend(input: AttentionInput): Promise<{ report: AttentionReport; commit: () => Promise<void> }> {
    const graph = this.graphUri();
    this.registry.assertWritable(graph);
    const report: AttentionReport = { boosted: 0, damped: 0, dropped: 0 };
    const entries = await this.read();
    const floor = Math.min(CARRY_FLOOR, clamp01(input.theta));
    const refreshed = new Set<string>();
    for (const e of entries) if (e.carriedFrom === undefined && e.refersTo) refreshed.add(e.refersTo);

    // The deletions and salience changes go out as one update (one operation per
    // entry, in entry order), so a pass over many entries is one write.
    const ops: string[] = [];
    for (const e of entries) {
      let next = e.salience;
      if (e.refersTo && input.boostEntities.has(e.refersTo)) {
        next = clamp01(round6(next + GOAL_BOOST));
        if (next !== e.salience) report.boosted++;
      } else if (
        e.carriedFrom !== undefined &&
        e.refersTo &&
        !input.keepEntities.has(e.refersTo) &&
        !refreshed.has(e.refersTo)
      ) {
        next = clamp01(round6(next * CARRY_DECAY));
        report.damped++;
      }
      if (e.carriedFrom !== undefined && next < floor) {
        ops.push(`
          DELETE { GRAPH <${graph}> { <${e.id}> ?p ?o } }
          WHERE  { GRAPH <${graph}> { <${e.id}> ?p ?o } }`);
        report.dropped++;
        continue;
      }
      if (next !== e.salience) {
        ops.push(`
          DELETE { GRAPH <${graph}> { <${e.id}> <${COGT}salience> ?old } }
          INSERT { GRAPH <${graph}> { <${e.id}> <${COGT}salience> "${next}"^^<${XSD}decimal> } }
          WHERE  { GRAPH <${graph}> { <${e.id}> <${COGT}salience> ?old } }`);
      }
    }
    const update = ops.join(' ;\n');
    return {
      report,
      commit: async () => {
        if (ops.length > 0) await this.triplestore.update(update);
      },
    };
  }

  /**
   * Mark the graph closed: a `cogt:closedAt` timestamp on the graph resource.
   * Nothing is deleted; the age-based sweep removes the graph on its normal
   * schedule (the timestamp counts as the graph's last write). Idempotent.
   */
  async markClosed(at: Date = new Date()): Promise<void> {
    const graph = this.graphUri();
    this.registry.assertWritable(graph);
    // One update: the delete, then the insert.
    await this.triplestore.update(`
      DELETE { GRAPH <${graph}> { <${graph}> <${COGT}closedAt> ?old } }
      WHERE  { GRAPH <${graph}> { <${graph}> <${COGT}closedAt> ?old } } ;
      INSERT DATA { GRAPH <${graph}> { <${graph}> <${COGT}closedAt> "${at.toISOString()}"^^<${XSD}dateTime> } }`);
  }

  /** Apply the entry cap now (after a bulk copy such as a carry-over). */
  async enforce(): Promise<void> {
    await this.enforceCap();
  }

  /** Drop the whole working graph. Carried entries already live in the next cycle. */
  async close(): Promise<void> {
    await this.triplestore.deleteGraph(this.graphUri());
  }

  /**
   * Enforce the per-cycle entry cap by dropping the lowest-salience entries
   * first (doc 04 §7). No-op while under the cap.
   *
   * Incremental: each write first runs a bounded probe that asks only whether an
   * entry exists beyond the cap (`LIMIT 1 OFFSET capacity`). The probe stops
   * after at most capacity + 1 rows and returns at most one, so a write on a
   * graph under the cap never lists the whole graph. Only when the cap is
   * actually exceeded is the ordered list read and trimmed.
   */
  private async enforceCap(): Promise<void> {
    const graph = this.graphUri();
    // Avoid SPARQL COUNT/aggregates: the embedded Oxigraph (WASM) build throws
    // "unreachable" on them.
    const probe = await this.triplestore.query(`
      SELECT ?e WHERE {
        GRAPH <${graph}> { ?e a <${COGT}WorkingMemoryEntry> ; <${COGT}salience> ?s }
      } LIMIT 1 OFFSET ${this.capacity}`);
    if ((probe.bindings ?? []).length === 0) return;

    // Over the cap: list salience-ascending and trim in TS.
    const res = await this.triplestore.query(`
      SELECT ?e ?s ?b WHERE {
        GRAPH <${graph}> { ?e a <${COGT}WorkingMemoryEntry> ; <${COGT}salience> ?s ; <${COGT}writtenTo> ?b }
      } ORDER BY ASC(?s)`);
    const rows = res.bindings ?? [];
    if (rows.length <= this.capacity) return;

    const victims = rows.slice(0, rows.length - this.capacity);
    for (const row of victims) {
      const e = row.e.value;
      await this.triplestore.update(`
        DELETE { GRAPH <${graph}> { <${e}> ?p ?o } }
        WHERE  { GRAPH <${graph}> { <${e}> ?p ?o } }`);
      this.onDrop?.({ id: e, buffer: row.b.value as BufferName, salience: Number(row.s.value) });
    }
  }
}
