import fs from 'node:fs';
import path from 'node:path';
import type { Scenario, ScenarioTurn } from './types.js';

/** Validate + load a single scenario object. */
export function parseScenario(obj: unknown): Scenario {
  const s = obj as Scenario;
  if (!s || typeof s.id !== 'string') throw new Error('scenario missing id');
  if (typeof s.agentId !== 'string') throw new Error(`scenario ${s.id}: missing agentId`);
  if (typeof s.userId !== 'string') throw new Error(`scenario ${s.id}: missing userId`);
  if (!Array.isArray(s.turns)) throw new Error(`scenario ${s.id}: missing turns`);
  for (const t of s.turns) validateTurn(s.id, t);
  return s;
}

function validateTurn(scenarioId: string, t: ScenarioTurn): void {
  switch (t.kind) {
    case 'assert':
    case 'mutate':
    case 'retract':
      if (typeof t.id !== 'string' || typeof t.text !== 'string') {
        throw new Error(`scenario ${scenarioId}: ${t.kind} turn needs id + text`);
      }
      break;
    case 'pad':
      if (typeof t.count !== 'number') throw new Error(`scenario ${scenarioId}: pad turn needs count`);
      break;
    case 'probe':
      if (typeof t.id !== 'string' || typeof t.query !== 'string' || !t.category || !t.gold) {
        throw new Error(`scenario ${scenarioId}: probe turn needs id, query, category, gold`);
      }
      break;
    default:
      throw new Error(`scenario ${scenarioId}: unknown turn kind ${(t as { kind: string }).kind}`);
  }
}

/** Load all *.json scenarios in a directory (sorted by filename). */
export function loadScenarioDir(dir: string): Scenario[] {
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort();
  return files.map((f) => parseScenario(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'))));
}
