/**
 * CogCleanup — age-based removal of the per-cycle cognitive graphs.
 *
 * Every cycle with the cycle manager on writes one working-memory graph
 * (`urn:<agent>:cog:working:<session>:<cycle>`) and appends to a per-session
 * cycle graph (`urn:<agent>:cog:cycles:<session>`). Nothing else ever removes
 * them, so they accumulate. This sweep drops
 *
 *  - working graphs whose newest timestamp is older than 7 days, and
 *  - cycle graphs whose newest timestamp is older than 30 days.
 *
 * Safety:
 *  - Only graphs the registry classifies as `cog-working` / `cog-cycles` of this
 *    agent are ever considered; every deletion passes `assertWritable` first.
 *    Episodic, procedural, meta, goal, user, session and shared graphs are not
 *    candidates, whatever their age.
 *  - Age is read as the newest `xsd:dateTime` object in the graph; no message
 *    text or user key is read, so no cross-user read is involved. A graph whose
 *    age cannot be determined is kept.
 */

import type { TriplestoreAdapter } from '@ontofelia/core';
import type { GraphRegistry } from '@ontofelia/semantic-memory';

const XSD_DATETIME = 'http://www.w3.org/2001/XMLSchema#dateTime';
const DAY_MS = 86_400_000;

/** Working-memory graphs live this long after their last write. */
export const WORKING_GRAPH_MAX_AGE_DAYS = 7;
/** Cycle graphs live this long after their last write. */
export const CYCLE_GRAPH_MAX_AGE_DAYS = 30;

export interface CleanupReport {
  now: string;
  workingScanned: number;
  workingDropped: number;
  cyclesScanned: number;
  cyclesDropped: number;
  /** Candidate graphs kept because no timestamp could be read. */
  undated: number;
  /** Present only when procedural memory is on: the 90-day trace sweep. */
  procedural?: { tracesDropped: number; summariesDropped: number };
}

export class CogCleanup {
  constructor(
    private readonly triplestore: TriplestoreAdapter,
    private readonly registry: GraphRegistry,
    private readonly agentId: string,
  ) {}

  async run(now: Date = new Date()): Promise<CleanupReport> {
    const report: CleanupReport = {
      now: now.toISOString(),
      workingScanned: 0,
      workingDropped: 0,
      cyclesScanned: 0,
      cyclesDropped: 0,
      undated: 0,
    };
    for (const graph of await this.candidateGraphs()) {
      const desc = this.registry.describe(graph);
      if (!desc || desc.agentId !== this.agentId) continue;
      let maxAgeDays: number;
      if (desc.role === 'cog-working') {
        maxAgeDays = WORKING_GRAPH_MAX_AGE_DAYS;
        report.workingScanned++;
      } else if (desc.role === 'cog-cycles') {
        maxAgeDays = CYCLE_GRAPH_MAX_AGE_DAYS;
        report.cyclesScanned++;
      } else {
        continue;
      }
      const newest = await this.newestTimestamp(graph);
      if (newest === undefined) {
        report.undated++;
        continue;
      }
      if (now.getTime() - newest <= maxAgeDays * DAY_MS) continue;
      this.registry.assertWritable(graph);
      await this.triplestore.deleteGraph(graph);
      if (desc.role === 'cog-working') report.workingDropped++;
      else report.cyclesDropped++;
    }
    return report;
  }

  /** Graph names under this agent's `cog:working:` / `cog:cycles:` prefixes. */
  private async candidateGraphs(): Promise<string[]> {
    // The agent id is validated by the registry (lowercase identifier), so the
    // prefixes are safe to place in the query.
    const working = `urn:${this.agentId}:cog:working:`;
    const cycles = `urn:${this.agentId}:cog:cycles:`;
    const res = await this.triplestore.query(`
      SELECT DISTINCT ?g WHERE {
        GRAPH ?g { ?s ?p ?o }
        FILTER(STRSTARTS(STR(?g), "${working}") || STRSTARTS(STR(?g), "${cycles}"))
      }`);
    return (res.bindings ?? []).map((b) => b.g.value);
  }

  private async newestTimestamp(graph: string): Promise<number | undefined> {
    const res = await this.triplestore.query(`
      SELECT ?t WHERE {
        GRAPH <${graph}> { ?s ?p ?t . FILTER(datatype(?t) = <${XSD_DATETIME}>) }
      } ORDER BY DESC(?t) LIMIT 1`);
    const v = res.bindings?.[0]?.t?.value;
    if (!v) return undefined;
    const ms = Date.parse(v);
    return Number.isNaN(ms) ? undefined : ms;
  }
}
