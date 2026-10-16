/**
 * Goal lifecycle rules of Phase 3 (docs/cognitive-architecture/07 §3, §5).
 *
 * Pure and synchronous: no store access and no model call. The cycle manager
 * applies these rules to the perception of the turn.
 *
 * Decision tree, steps 1 and 2 (the first match wins):
 *
 *  1. The message closes the active goal of the user: a satisfaction cue
 *     ("that's it", "passt", "erledigt") resolves it, a cancel cue ("nevermind",
 *     "vergiss es", "stop") abandons it. See {@link detectGoalSignal}.
 *  2. The message continues an active goal of the user whose entities overlap
 *     the entities the message is about; otherwise a new goal is created from
 *     the intent ({@link INTENT_GOAL_TYPE}).
 *
 * Anything else keeps the earlier behaviour: an active goal of the user is
 * continued, otherwise the implicit RespondToUser goal serves the turn.
 */

import { GOAL_TYPES } from './GoalStack.js';
import type { IntentLabel } from './Perception.js';

/**
 * Intent -> goal type. `chit-chat` and `feedback` create no goal: the implicit
 * RespondToUser goal covers them.
 */
export const INTENT_GOAL_TYPE: Readonly<Record<IntentLabel, string | undefined>> = {
  question: GOAL_TYPES.AnswerQuestion,
  command: GOAL_TYPES.ExecuteCommand,
  request: GOAL_TYPES.HandleRequest,
  'topic-reference': GOAL_TYPES.AnswerInTopic,
  'chit-chat': undefined,
  feedback: undefined,
};

const LABEL_PREFIX: Readonly<Record<string, string>> = {
  [GOAL_TYPES.AnswerQuestion]: 'Answer',
  [GOAL_TYPES.ExecuteCommand]: 'Execute',
  [GOAL_TYPES.HandleRequest]: 'Handle request',
  [GOAL_TYPES.AnswerInTopic]: 'Topic',
};

const MAX_LABEL_TEXT = 80;

/** The goal type and label a message of the given intent creates, or undefined. */
export function goalFromIntent(
  intent: IntentLabel,
  text: string,
): { goalType: string; label: string } | undefined {
  const goalType = INTENT_GOAL_TYPE[intent];
  const trimmed = text.trim();
  if (!goalType || trimmed === '') return undefined;
  const brief = trimmed.length > MAX_LABEL_TEXT ? `${trimmed.slice(0, MAX_LABEL_TEXT - 3)}...` : trimmed;
  return { goalType, label: `${LABEL_PREFIX[goalType]}: ${brief}` };
}

export type GoalSignal = 'satisfied' | 'cancelled';

/** A closer is recognised only as a whole short message: cue plus filler words. */
const MAX_SIGNAL_WORDS = 7;

/** Words that may surround a cue without changing its meaning. */
const FILLER = new Set([
  'thanks', 'thank', 'thx', 'you', 'danke', 'dir', 'dank', 'vielen', 'ok', 'okay', 'super', 'perfect',
  'perfekt', 'great', 'nice', 'cool', 'fine', 'gut', 'good', 'so', 'then', 'now', 'jetzt', 'nun', 'also',
  'ja', 'yes', 'yep', 'please', 'bitte', 'it', 'that', 'this', 'das', 'es', 'dies', 'is', 'ist', 'for',
  'now', 'mal', 'doch', 'schon', 'hey', 'ofelia', 'alles', 'all', 'damit', 'für', 'heute',
]);

/**
 * Satisfaction cues: the user says the matter is closed. Plain thanks or
 * praise is NOT one (it often arrives in the middle of a task); the message
 * must also say that it is done.
 */
export const SATISFACTION_CUES: readonly string[] = [
  "that's it", 'thats it', "that's all", 'thats all', 'that is it', 'that is all', 'all done', 'done',
  'passt', 'erledigt', 'fertig', 'gelöst', 'geloest', 'das wars', "das war's", 'das reicht', 'reicht',
];

/** Cancel cues: the user withdraws the request. */
export const CANCEL_CUES: readonly string[] = [
  'nevermind', 'never mind', 'forget it', 'forget that', 'forget about it', 'scratch that', 'drop it',
  'cancel', 'cancel that', 'cancel it', 'stop', 'stop it', 'stop that',
  'vergiss es', 'vergiss das', 'vergiss es wieder', 'lass gut sein', 'doch nicht', 'abbrechen',
  'abbruch', 'stopp', 'stopp es',
];

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[‘’´`]/g, "'")
    .split(/\s+/)
    .map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
    .filter((w) => w !== '');
}

/** True when `cue` occurs in `tokens` as a run and every other token is filler. */
function matchesCue(tokens: string[], cue: string): boolean {
  const c = words(cue);
  for (let i = 0; i + c.length <= tokens.length; i++) {
    if (c.every((w, j) => tokens[i + j] === w)) {
      const rest = [...tokens.slice(0, i), ...tokens.slice(i + c.length)];
      if (rest.every((t) => FILLER.has(t))) return true;
    }
  }
  return false;
}

/**
 * Does the message close the active goal? A question (question mark, or
 * perception intent `question`) never does. A cancel cue wins over a
 * satisfaction cue when both are present ("done, forget it"). The cue lists
 * are exported for the documentation and the tests.
 */
export function detectGoalSignal(text: string, intent?: IntentLabel): GoalSignal | undefined {
  if (!text || text.includes('?') || intent === 'question') return undefined;
  const tokens = words(text);
  if (tokens.length === 0 || tokens.length > MAX_SIGNAL_WORDS) return undefined;
  if (CANCEL_CUES.some((c) => matchesCue(tokens, c))) return 'cancelled';
  if (SATISFACTION_CUES.some((c) => matchesCue(tokens, c))) return 'satisfied';
  return undefined;
}

/** Number of entity IRIs two lists share. */
export function entityOverlap(a: readonly string[] | undefined, b: readonly string[]): number {
  if (!a || a.length === 0 || b.length === 0) return 0;
  const set = new Set(b);
  let n = 0;
  for (const x of new Set(a)) if (set.has(x)) n++;
  return n;
}

/**
 * Salience of a goalBuffer entry (doc 04 §4): the top goal 1.0; a parent 0.7,
 * minus 0.1 for each further level up, never below 0.3. `depth` is 0 for the
 * top goal, 1 for its parent, 2 for the grandparent, ...
 */
export function goalSalience(depth: number): number {
  if (depth <= 0) return 1.0;
  return Math.round(Math.max(0.3, 0.7 - 0.1 * (depth - 1)) * 10) / 10;
}
