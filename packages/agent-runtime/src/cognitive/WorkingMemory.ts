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
}

export interface WMEntry extends WMEntryInput {
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

/** Hard cap on entries per cycle (doc 04 §7). */
const MAX_ENTRIES = 200;
/** Salience multiplier applied to entries carried into the next cycle (§6). */
const CARRY_DECAY = 0.7;
/** Default global-workspace cutoff (doc 04 §4). */
const DEFAULT_THETA = 0.5;

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

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
  ) {}

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

    await this.triplestore.update(`INSERT DATA { GRAPH <${graph}> {\n${lines.join('\n')}\n} }`);
    await this.enforceCap();
    return id;
  }

  /** Read entries, optionally filtered by buffer / kind / minimum salience. */
  async read(filter: WMReadFilter = {}): Promise<WMEntry[]> {
    const graph = this.graphUri();
    const filters: string[] = [];
    if (filter.buffer) filters.push(`FILTER(?buffer = "${escapeLiteral(filter.buffer)}")`);
    if (filter.entryKind) filters.push(`FILTER(?kind = "${escapeLiteral(filter.entryKind)}")`);
    if (filter.minSalience !== undefined)
      filters.push(`FILTER(?salience >= ${clamp01(filter.minSalience)})`);

    const sparql = `
      SELECT ?entry ?buffer ?writtenBy ?writtenAt ?kind ?payload ?salience
             ?refersTo ?sourceGraph ?retrievalScore ?carryForward ?expiresAfter
             ?forGoal ?carriedFrom
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
          ${filters.join('\n          ')}
        }
      }`;

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
      return entry;
    });
  }

  /**
   * The global workspace: entries with `salience ≥ θ`, ordered by the fixed
   * buffer sequence and then by descending salience within each buffer.
   */
  async globalWorkspace(theta = DEFAULT_THETA): Promise<WMEntry[]> {
    const entries = await this.read({ minSalience: theta });
    return entries.sort((a, b) => {
      const ai = BUFFER_ORDER.indexOf(a.buffer);
      const bi = BUFFER_ORDER.indexOf(b.buffer);
      const ar = ai === -1 ? BUFFER_ORDER.length : ai;
      const br = bi === -1 ? BUFFER_ORDER.length : bi;
      if (ar !== br) return ar - br;
      return b.salience - a.salience;
    });
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
   * Carry rule (the subset decidable from WM alone): an entry carries if it is
   * in `selfBuffer` (session-constant), or it has `carryForward = true` and is
   * not expired (`expiresAfter` unset or > 0).
   */
  async carryForward(toCycleId: string): Promise<number> {
    const target = GraphUriResolver.getCogWorkingGraph(this.agentId, this.sessionId, toCycleId);
    this.registry.assertWritable(target);

    const all = await this.read();
    const eligible = all.filter(
      (e) =>
        e.buffer === 'selfBuffer' ||
        (e.carryForward === true && (e.expiresAfter === undefined || e.expiresAfter > 0)),
    );
    if (eligible.length === 0) return 0;

    const lines: string[] = [];
    for (const e of eligible) {
      const id = this.newEntryId();
      const salience = clamp01(e.salience * CARRY_DECAY);
      lines.push(`<${id}> <${RDF_TYPE}> <${COGT}WorkingMemoryEntry> .`);
      lines.push(`<${id}> <${COGT}writtenTo> "${escapeLiteral(e.buffer)}" .`);
      lines.push(`<${id}> <${COGT}writtenBy> <${e.writtenBy}> .`);
      lines.push(`<${id}> <${COGT}writtenAt> "${new Date().toISOString()}"^^<${XSD}dateTime> .`);
      lines.push(`<${id}> <${COGT}entryKind> "${escapeLiteral(e.entryKind)}" .`);
      lines.push(`<${id}> <${COGT}payload> "${escapeLiteral(e.payload)}" .`);
      lines.push(`<${id}> <${COGT}salience> "${salience}"^^<${XSD}decimal> .`);
      lines.push(`<${id}> <${COGT}carriedFrom> <${e.id}> .`);
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
    await this.triplestore.update(`INSERT DATA { GRAPH <${target}> {\n${lines.join('\n')}\n} }`);
    return eligible.length;
  }

  /** Drop the whole working graph. Carried entries already live in the next cycle. */
  async close(): Promise<void> {
    await this.triplestore.deleteGraph(this.graphUri());
  }

  /**
   * Enforce the per-cycle entry cap by dropping the lowest-salience entries
   * first (doc 04 §7). No-op while under the cap.
   */
  private async enforceCap(): Promise<void> {
    const graph = this.graphUri();
    // Avoid SPARQL COUNT/aggregates: the embedded Oxigraph (WASM) build throws
    // "unreachable" on them. List entries salience-ascending and count in TS.
    const res = await this.triplestore.query(`
      SELECT ?e WHERE {
        GRAPH <${graph}> { ?e a <${COGT}WorkingMemoryEntry> ; <${COGT}salience> ?s }
      } ORDER BY ASC(?s)`);
    const rows = res.bindings ?? [];
    if (rows.length <= MAX_ENTRIES) return;

    const victims = rows.slice(0, rows.length - MAX_ENTRIES);
    for (const row of victims) {
      const e = row.e.value;
      await this.triplestore.update(`
        DELETE { GRAPH <${graph}> { <${e}> ?p ?o } }
        WHERE  { GRAPH <${graph}> { <${e}> ?p ?o } }`);
    }
  }
}
