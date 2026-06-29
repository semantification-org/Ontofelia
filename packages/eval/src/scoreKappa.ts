/**
 * `score-kappa` script (eval-design §4).
 *
 * Usage: node dist/scoreKappa.js <path-to-human-filled-judge-sample.jsonl>
 *
 * The input is a judge-sample JSONL (as exported by the pilot) where a human has
 * filled the `humanScore` slot (0 or 1) for each item. Computes Cohen's κ
 * between the judge and the human and warns when κ < 0.7 (rubric must be revised
 * before the LLM-judged results are trusted).
 */

import fs from 'node:fs';
import { cohensKappa, type JudgedItem } from './llmJudge.js';

function loadItems(file: string): JudgedItem[] {
  const text = fs.readFileSync(file, 'utf-8');
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as JudgedItem);
}

function main(): void {
  const file = process.argv[2];
  if (!file) {
    console.error('Usage: node dist/scoreKappa.js <human-filled-judge-sample.jsonl>');
    process.exit(2);
  }
  const items = loadItems(file);
  const rated = items.filter((i) => i.humanScore != null);
  if (rated.length === 0) {
    console.error(
      `No items with a filled humanScore in ${file}. Fill the "humanScore" slot (0/1) for each item, then re-run.`,
    );
    process.exit(1);
  }
  const k = cohensKappa(rated);
  console.log(`Cohen's κ (judge vs human) over ${k.n} items: ${k.kappa.toFixed(4)}`);
  console.log(`  observed agreement po=${k.po.toFixed(4)}  expected pe=${k.pe.toFixed(4)}`);
  console.log(
    `  confusion: both=1:${k.confusion.agree1} both=0:${k.confusion.agree0} judge1/human0:${k.confusion.j1h0} judge0/human1:${k.confusion.j0h1}`,
  );
  if (k.warn) {
    console.warn(
      `\nWARNING: κ=${k.kappa.toFixed(4)} < 0.7 — judge/human agreement is too low. ` +
        `Revise the judge rubric before trusting the LLM-judged (H0/H1) results.`,
    );
    process.exit(3);
  } else {
    console.log(`\nκ ≥ 0.7 — judge agreement acceptable.`);
  }
}

main();
