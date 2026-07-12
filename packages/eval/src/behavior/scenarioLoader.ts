import fs from 'node:fs';
import path from 'node:path';
import type { BehaviorScenario } from './types.js';

/**
 * Loader for behavior scenario JSON files. A file contains an ARRAY of
 * {@link BehaviorScenario} objects (the scenarios are single-message probes,
 * so grouping a scenario class per file keeps the set reviewable — unlike the
 * memory scenarios, which are one multi-turn scenario per file).
 */
export function parseBehaviorScenarios(obj: unknown, sourceName: string): BehaviorScenario[] {
  if (!Array.isArray(obj)) throw new Error(`${sourceName}: expected a JSON array of scenarios`);
  const seen = new Set<string>();
  return obj.map((raw, i) => {
    const s = raw as BehaviorScenario;
    const at = `${sourceName}[${i}]`;
    if (!s || typeof s.id !== 'string' || !s.id) throw new Error(`${at}: missing id`);
    if (seen.has(s.id)) throw new Error(`${at}: duplicate id ${s.id}`);
    seen.add(s.id);
    if (s.class !== 'license' && s.class !== 'control') {
      throw new Error(`${at} (${s.id}): class must be "license" or "control"`);
    }
    if (s.language !== 'en' && s.language !== 'de') {
      throw new Error(`${at} (${s.id}): language must be "en" or "de"`);
    }
    if (typeof s.userMessage !== 'string' || !s.userMessage.trim()) {
      throw new Error(`${at} (${s.id}): missing userMessage`);
    }
    if (s.class === 'control') {
      // Control scenarios are multi-turn: canned read-only tool results are
      // REQUIRED so mandated investigation can be answered offline.
      const canned = s.cannedToolResults;
      if (!canned || typeof canned !== 'object' || Object.keys(canned).length === 0) {
        throw new Error(`${at} (${s.id}): control scenario needs a non-empty cannedToolResults map`);
      }
      for (const [tool, output] of Object.entries(canned)) {
        if (typeof output !== 'string' || !output.trim()) {
          throw new Error(`${at} (${s.id}): cannedToolResults["${tool}"] must be a non-empty string`);
        }
      }
    }
    return s;
  });
}

/** Load all *.json behavior scenario files in a directory (sorted by filename). */
export function loadBehaviorScenarioDir(dir: string): BehaviorScenario[] {
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort();
  const all: BehaviorScenario[] = [];
  const ids = new Set<string>();
  for (const f of files) {
    const scenarios = parseBehaviorScenarios(
      JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')),
      f,
    );
    for (const s of scenarios) {
      if (ids.has(s.id)) throw new Error(`${f}: duplicate scenario id across files: ${s.id}`);
      ids.add(s.id);
      all.push(s);
    }
  }
  return all;
}
