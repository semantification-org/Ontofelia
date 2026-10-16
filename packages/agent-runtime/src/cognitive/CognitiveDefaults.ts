/**
 * CognitiveDefaults — the staged default-on rollout of the cognitive layer.
 *
 * Product decision: the layer is ON by default for NEW installs; EXISTING
 * installs keep their flags untouched on upgrade and adopt the defaults only
 * through the owner-only `/cog defaults apply`.
 *
 * Default-on set = every flag in {@link COGNITIVE_FLAGS} except
 *   - `flagRetention`: destructive tiering (deletes payloads, collapses
 *     episodes); an open decision, so it stays off;
 *   - `flagInitiative`: the one flag whose feature makes model calls of its own
 *     (a self-started wake runs a full model turn with no user message), so it
 *     stays off. Every other flag works with SPARQL and rules only.
 *
 * Setup keys (`unknownNudgeAllUsers`, thresholds, caps) are never written here;
 * they keep their documented defaults.
 *
 * "Fresh store" (the only case where the boot step writes anything), all of:
 *   1. the self graph was seeded in this very boot (it was empty before), and
 *   2. the setup graph holds no cognitive triple at all (no flag, no setup key,
 *      no marker), and
 *   3. no other graph of this agent holds a single triple (no user data, no
 *      claims, no cognitive records).
 * Anything else is an existing install: nothing is written. The flags and the
 * marker go in ONE update, so a crash leaves all or nothing.
 */

import type { TriplestoreAdapter } from '@ontofelia/core';
import { GraphUriResolver } from '@ontofelia/semantic-memory';
import { COGNITIVE_FLAGS, CognitiveConfig, type CognitiveFlagInfo } from './CognitiveConfig.js';

const COGT = 'urn:shared:ontology#cog/';
const XSD = 'http://www.w3.org/2001/XMLSchema#';

/** Revision of the default-on set; recorded in the marker. Bump when the set changes. */
export const COGNITIVE_DEFAULTS_VERSION = 1;

/** Flags that stay off in the default set, with the reason shown to the owner. */
export const DEFAULT_OFF_FLAGS: Readonly<Record<string, string>> = {
  flagRetention: 'destructive tiering: it deletes payloads and collapses episodes',
  flagInitiative: 'self-started wakes make model calls of their own',
};

/** The flags the defaults turn on, in display order. */
export function defaultOnFlags(): CognitiveFlagInfo[] {
  return COGNITIVE_FLAGS.filter((f) => !(f.name in DEFAULT_OFF_FLAGS));
}

function configSubject(agentId: string): string {
  return `urn:${agentId}:setup:cognitive`;
}

const bool = (on: boolean) => `"${on}"^^<${XSD}boolean>`;

/** The marker triples (time and defaults revision) on the config subject. */
function markerTriples(agentId: string, now: Date): string {
  const s = `<${configSubject(agentId)}>`;
  return (
    `${s} <${COGT}defaultsSeededAt> "${now.toISOString()}"^^<${XSD}dateTime> .\n` +
    `${s} <${COGT}defaultsVersion> "${COGNITIVE_DEFAULTS_VERSION}"^^<${XSD}integer> .`
  );
}

/** Whether the setup graph holds any cognitive triple on the config subject. */
async function hasCognitiveTriple(store: TriplestoreAdapter, agentId: string): Promise<boolean> {
  const graph = GraphUriResolver.getSetupGraph(agentId);
  const res = await store.query(`
    SELECT ?p WHERE {
      GRAPH <${graph}> { ?s ?p ?o . FILTER(STRSTARTS(STR(?p), "${COGT}")) }
    } LIMIT 1`);
  return (res.bindings?.length ?? 0) > 0;
}

/** Whether any graph of this agent, other than self and setup, holds a triple. */
async function hasOtherAgentData(store: TriplestoreAdapter, agentId: string): Promise<boolean> {
  const self = GraphUriResolver.getSelfGraph(agentId);
  const setup = GraphUriResolver.getSetupGraph(agentId);
  const prefix = `urn:${agentId}:`.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const res = await store.query(`
    SELECT ?g WHERE {
      GRAPH ?g { ?s ?p ?o }
      FILTER(STRSTARTS(STR(?g), "${prefix}") && ?g != <${self}> && ?g != <${setup}>)
    } LIMIT 1`);
  return (res.bindings?.length ?? 0) > 0;
}

export interface SeedDefaultsResult {
  /** True when the default set and the marker were written in this call. */
  seeded: boolean;
  /** Why nothing was written, when `seeded` is false. */
  reason?: 'self-graph-not-seeded-this-boot' | 'cognitive-triples-present' | 'agent-data-present';
  /** The flags written (short keys), when `seeded` is true. */
  flags: string[];
}

/**
 * Boot step: write the default-on set and the marker, but only for a fresh
 * store (see the file header). Idempotent: a second boot finds the marker and
 * the self graph filled and writes nothing. Never throws on a read problem
 * beyond what the store raises; the caller decides how to log it.
 *
 * @param selfSeededThisBoot true when `seedCoreGraphs` seeded the self graph in
 *   this boot (it was empty before); the one signal that the store is new.
 */
export async function seedDefaultsForFreshInstall(
  store: TriplestoreAdapter,
  agentId: string,
  selfSeededThisBoot: boolean,
  now: Date = new Date(),
): Promise<SeedDefaultsResult> {
  if (!selfSeededThisBoot) return { seeded: false, reason: 'self-graph-not-seeded-this-boot', flags: [] };
  if (await hasCognitiveTriple(store, agentId)) return { seeded: false, reason: 'cognitive-triples-present', flags: [] };
  if (await hasOtherAgentData(store, agentId)) return { seeded: false, reason: 'agent-data-present', flags: [] };

  const graph = GraphUriResolver.getSetupGraph(agentId);
  const subject = `<${configSubject(agentId)}>`;
  const on = defaultOnFlags();
  const lines = on.map((f) => `${subject} <${COGT}${f.name}> ${bool(true)} .`);
  lines.push(markerTriples(agentId, now));
  await store.update(`INSERT DATA { GRAPH <${graph}> {\n${lines.join('\n')}\n} }`);
  return { seeded: true, flags: on.map((f) => f.key) };
}

/** One row of the diff between the current flags and the default set. */
export interface DefaultsDiffRow {
  name: string;
  key: string;
  /** Current state: a missing flag counts as off. */
  current: boolean;
}

export interface DefaultsReport {
  rows: DefaultsDiffRow[];
  /** Flags the defaults would turn on (currently off or missing). */
  toChange: string[];
  /** Marker: when and with which revision the defaults were last written, if ever. */
  marker?: { at: string; version: string };
}

/** Read the marker, or undefined when the defaults were never written. */
export async function readDefaultsMarker(
  store: TriplestoreAdapter,
  agentId: string,
): Promise<{ at: string; version: string } | undefined> {
  const graph = GraphUriResolver.getSetupGraph(agentId);
  const res = await store.query(`
    SELECT ?at ?v WHERE {
      GRAPH <${graph}> {
        <${configSubject(agentId)}> <${COGT}defaultsSeededAt> ?at .
        OPTIONAL { <${configSubject(agentId)}> <${COGT}defaultsVersion> ?v }
      }
    } LIMIT 1`);
  const b = res.bindings?.[0];
  return b?.at ? { at: b.at.value, version: b.v?.value ?? '?' } : undefined;
}

/** Compare the current flags with the default-on set. Read-only. */
export async function defaultsReport(
  cfg: CognitiveConfig,
  store: TriplestoreAdapter,
  agentId: string,
): Promise<DefaultsReport> {
  const rows: DefaultsDiffRow[] = [];
  for (const f of defaultOnFlags()) {
    rows.push({ name: f.name, key: f.key, current: await cfg.isEnabled(f).catch(() => false) });
  }
  const marker = await readDefaultsMarker(store, agentId).catch(() => undefined);
  return { rows, toChange: rows.filter((r) => !r.current).map((r) => r.name), ...(marker ? { marker } : {}) };
}

/**
 * Adopt the defaults on an existing install: set every default-on flag that is
 * currently missing or off to ON (flags that are already on are not rewritten),
 * then write the marker. Never touches `flagRetention`, `flagInitiative` or any
 * setup key. Returns the flags it changed.
 */
export async function applyDefaults(
  cfg: CognitiveConfig,
  store: TriplestoreAdapter,
  agentId: string,
  now: Date = new Date(),
): Promise<{ changed: string[] }> {
  const report = await defaultsReport(cfg, store, agentId);
  const changed: string[] = [];
  for (const f of defaultOnFlags()) {
    if (!report.toChange.includes(f.name)) continue;
    await cfg.setEnabled(f, true);
    changed.push(f.name);
  }
  const graph = GraphUriResolver.getSetupGraph(agentId);
  const subject = `<${configSubject(agentId)}>`;
  await store.update(`
    DELETE { GRAPH <${graph}> { ${subject} ?p ?o } }
    WHERE  { GRAPH <${graph}> { ${subject} ?p ?o . FILTER(?p IN (<${COGT}defaultsSeededAt>, <${COGT}defaultsVersion>)) } }`);
  await store.update(`INSERT DATA { GRAPH <${graph}> {\n${markerTriples(agentId, now)}\n} }`);
  return { changed };
}
