/**
 * Satisfaction classifier for the weak follow-up signal (doc 06 §3): is the
 * user's next message a thank-you / confirmation (`true`), a rejection /
 * correction (`false`), or neither (`null`)?
 *
 * It is deliberately crude and conservative; ambiguity returns `null`, which
 * writes nothing. German and English.
 *
 *  - **Word boundaries**: matches whole words only, with Unicode-aware
 *    boundaries (JS `\b` is ASCII-only and splits "schön" or "müde").
 *  - **Negation scope**: a negator ("not", "n't", "never", "no", "nicht",
 *    "kein", "nie", ...) flips the polarity of the next polar word within three
 *    tokens, inside one clause (punctuation or "but"/"aber" ends the scope).
 *    "not good" is dissatisfied, "not bad" and "nicht schlecht" are deliberately
 *    satisfied (the usual idiom), "nicht gut" is dissatisfied. German "nicht"
 *    after a positive word ("funktioniert nicht", "stimmt nicht") flips that
 *    word too.
 *  - **"no"** counts as a rejection only as the first word of a clause; inside
 *    a sentence it is a negator ("no good"), and "no problem"/"kein Problem"
 *    are confirmations.
 *  - **Ambiguity returns null**: a question mark, a contrast marker ("but",
 *    "aber"), mixed polarity, or a long message (more than 240 characters, which
 *    is a new request, not a reaction).
 */

const MAX_REACTION_CHARS = 240;

const POSITIVE = new Set([
  'thanks', 'thank', 'thx', 'thanx', 'danke', 'dank', 'dankeschön', 'dankeschoen', 'merci',
  'perfect', 'perfekt', 'great', 'super', 'awesome', 'nice', 'exactly', 'genau', 'correct',
  'richtig', 'stimmt', 'works', 'worked', 'funktioniert', 'top', 'klasse', 'prima', 'toll',
  'gut', 'good', 'excellent', 'wonderful', 'wunderbar', 'ausgezeichnet', 'passt', 'helpful',
  'hilfreich',
]);

const NEGATIVE = new Set([
  'wrong', 'falsch', 'incorrect', 'stop', 'stopp', 'quatsch', 'bad', 'schlecht', 'useless',
  'unbrauchbar', 'nonsense', 'unsinn', 'terrible', 'awful', 'leider', 'unfortunately',
]);

/** Negative words that a following "nicht" must not flip ("leider nicht"). */
const NEGATORS_EN = new Set(['not', 'never', 'neither', 'hardly', 'barely', 'cannot']);
const NEGATORS_DE = new Set([
  'nicht', 'kein', 'keine', 'keinen', 'keinem', 'keiner', 'keines', 'nie', 'niemals', 'kaum',
  'nix', 'weder',
]);
/** Words that open a rejection only at the start of a clause. */
const CLAUSE_START_NO = new Set(['no', 'nope', 'nein']);
const CONTRAST = new Set(['but', 'however', 'although', 'though', 'aber', 'jedoch', 'allerdings', 'doch']);

/** Multi-word expressions, matched before tokenising (lower-case text). */
const POSITIVE_PHRASES: RegExp[] = [
  /(?<![\p{L}\p{N}_])(?:no problem|no worries|kein problem|keine sorge|spot on|vielen dank|thank you|that'?s right|that is right|you'?re right|you are right|du hast recht|hast recht)(?![\p{L}\p{N}_])/gu,
];
const NEGATIVE_PHRASES: RegExp[] = [
  /(?<![\p{L}\p{N}_])(?:not what|not right|that'?s not it|that is not it|so nicht)(?![\p{L}\p{N}_])/gu,
];
/** Greetings that contain a positive word without being feedback. */
const GREETINGS =
  /(?<![\p{L}\p{N}_])(?:good (?:morning|evening|night|afternoon|day|luck)|guten (?:morgen|tag|abend)|gute nacht)(?![\p{L}\p{N}_])/gu;

function isNegator(tok: string): boolean {
  return NEGATORS_EN.has(tok) || NEGATORS_DE.has(tok) || /n't$/.test(tok);
}

/** Split into word tokens and single punctuation tokens that end a clause. */
function tokenize(text: string): string[] {
  const out: string[] = [];
  const re = /[\p{L}\p{N}]+(?:'[\p{L}]+)?|[.,;:!?—–()\n]/gu;
  for (const m of text.matchAll(re)) out.push(m[0]);
  return out;
}

const CLAUSE_END = new Set(['.', ',', ';', ':', '!', '?', '—', '–', '(', ')', '\n']);

/** Crude satisfaction read of an inbound message: true / false / null (ambiguous). */
export function classifySatisfaction(raw: string): boolean | null {
  if (typeof raw !== 'string') return null;
  const original = raw.trim();
  if (original === '' || original.length > MAX_REACTION_CHARS) return null;
  let t = original.normalize('NFC').toLowerCase().replace(/[’‘`]/g, "'");
  if (t.includes('?')) return null;

  let pos = 0;
  let neg = 0;
  if (/(^|\s)(👍|🙏|✅)/u.test(original)) pos++;
  if (/(^|\s)(👎|❌)/u.test(original)) neg++;

  t = t.replace(GREETINGS, ' ');
  for (const re of POSITIVE_PHRASES) t = t.replace(re, () => (pos++, ' '));
  for (const re of NEGATIVE_PHRASES) t = t.replace(re, () => (neg++, ' '));

  const toks = tokenize(t);
  let scope = 0; // tokens left in which the last negator still applies
  let lastPolar: { tok: string; positive: boolean; idx: number } | undefined;
  let clauseStart = true;
  let contrast = false;
  for (let i = 0; i < toks.length; i++) {
    const tok = toks[i];
    if (CLAUSE_END.has(tok)) {
      scope = 0;
      clauseStart = true;
      lastPolar = undefined;
      continue;
    }
    if (CONTRAST.has(tok)) {
      contrast = true;
      scope = 0;
      clauseStart = true;
      lastPolar = undefined;
      continue;
    }
    if (CLAUSE_START_NO.has(tok) && clauseStart) {
      // "no good" negates the word that follows; a bare "no," is a rejection.
      if (hasPolarAhead(toks, i)) scope = 3;
      else neg++;
      clauseStart = false;
      continue;
    }
    if (isNegator(tok) || tok === 'no' || CLAUSE_START_NO.has(tok)) {
      // German "nicht" after a positive word negates it ("funktioniert nicht").
      if (
        NEGATORS_DE.has(tok) &&
        lastPolar?.positive === true &&
        lastPolar.idx === i - 1 &&
        !hasPolarAhead(toks, i)
      ) {
        pos--;
        neg++;
        lastPolar = undefined;
      } else {
        scope = 3;
      }
      clauseStart = false;
      continue;
    }
    clauseStart = false;
    // "work" is feedback only when negated ("doesn't work"), never on its own.
    if (tok === 'work') {
      if (scope > 0) {
        neg++;
        scope = 0;
      }
      continue;
    }
    const isPos = POSITIVE.has(tok);
    const isNeg = NEGATIVE.has(tok);
    if (isPos || isNeg) {
      let positive = isPos;
      // "leider" / "unfortunately" are not polar words that can be negated.
      const negatable = tok !== 'leider' && tok !== 'unfortunately';
      if (scope > 0 && negatable) {
        positive = !positive;
        scope = 0;
      }
      if (positive) pos++;
      else neg++;
      lastPolar = { tok, positive: isPos && positive, idx: i };
      continue;
    }
    if (scope > 0) scope--;
  }

  if (contrast) return null;
  if (pos > 0 && neg === 0) return true;
  if (neg > 0 && pos === 0) return false;
  return null;
}

/** True when a polar word follows within the negation window of toks[i]. */
function hasPolarAhead(toks: string[], i: number): boolean {
  for (let j = i + 1; j <= i + 3 && j < toks.length; j++) {
    if (CLAUSE_END.has(toks[j]) || CONTRAST.has(toks[j])) return false;
    if (POSITIVE.has(toks[j]) || NEGATIVE.has(toks[j])) return true;
  }
  return false;
}
