/**
 * Perception — Phase 1 of the cognitive cycle, computed BEFORE the LLM call
 * (docs/cognitive-architecture/03-cognitive-cycle.md §2).
 *
 * Everything here is pure, synchronous and in memory: it works on data the
 * runtime already computed for the turn (resolved entities, the semantic parse
 * result, the ingestion report's claim ids) and makes no model call and no
 * store access. The result is handed to the cycle, which writes it to working
 * memory, the phase resources and the episode off the reply path.
 *
 * Salience values follow docs/cognitive-architecture/04-working-memory.md §4.1:
 *
 *   message text   1.0
 *   sender         0.9, +0.1 when the sender is the owner
 *   NER result     0.7 per resolved entity node, at most {@link MAX_NER_ENTRIES}
 *   parsed claim   0.6 (the "+0.1 if it contradicts a stored fact" modifier is
 *                  not applied: contradiction is only known after the store
 *                  lookup that belongs to Comprehension)
 *   intent         0.8
 *   channel        0.6 (not in the doc table; kept from the earlier cycle)
 *
 * Choices the doc leaves open: at most {@link MAX_CLAIM_ENTRIES} parsed-claim
 * entries are written per turn.
 */

import type { WMEntryInput } from './WorkingMemory.js';

export type IntentLabel =
  | 'question'
  | 'request'
  | 'command'
  | 'chit-chat'
  | 'feedback'
  | 'topic-reference';

/** Doc 03 §2: at most five recognised entities reach working memory. */
export const MAX_NER_ENTRIES = 5;
/** Upper bound on parsed-claim entries per turn (choice; see the header). */
export const MAX_CLAIM_ENTRIES = 10;

export const SALIENCE = {
  messageText: 1.0,
  sender: 0.9,
  ownerBonus: 0.1,
  ner: 0.7,
  parsedClaim: 0.6,
  intent: 0.8,
  channel: 0.6,
} as const;

/**
 * What the runtime already knows about the turn when perception runs.
 *
 * Entity IRIs are never guessed from a name. A mentioned entity gets its IRI
 * from (1) a fact stored in this turn, whose subject/object IRI is the one the
 * store actually used, or (2) a read-only lookup of the existing node that the
 * queued persist performs ({@link resolvePerception}). Until then the entity is
 * pending and appears neither in `about` nor in a ner-result entry.
 */
export interface PerceptionSource {
  /** Entities found in the message; only `known` matches are candidates. */
  entities: Array<{ name: string; source: 'known' | 'ner' }>;
  /** The semantic parser's result, when a parser ran. */
  parseResult?: {
    facts: Array<{ kind: string; subject: string; predicate: string; object: string }>;
    questionIntent?: unknown;
    meta?: { skipped?: boolean };
  };
  /** Stored facts of this message with the claim IRI minted for each. */
  storedClaims: Array<{
    subject: string;
    predicate: string;
    object: string;
    claimUri: string;
    /** IRI the store used for the subject / for an entity object (absent for a literal). */
    subjectUri?: string;
    objectUri?: string;
  }>;
  /**
   * Claims of facts this message re-asserted (already stored earlier). Only
   * filled while episodic memory is on; they are linked from the episode
   * (`hasClaim`) and nothing else: no working-memory entry, no entity.
   */
  reassertedClaims?: string[];
  /**
   * Number of facts the ingestion report says were stored for this message
   * (the metacognition marker's `newKnowledge`). Absent when no ingestion ran.
   */
  storedFactCount?: number;
  /**
   * Zero-based line index of the user entry in the session's JSONL transcript:
   * the session store's message count when the turn began (every append adds
   * exactly one line), so no file is read. Absent when unknown.
   */
  transcriptLine?: number;
}

export interface PerceptionInput {
  text: string;
  senderId?: string;
  senderIsOwner: boolean;
  channel?: string;
}

/** The perception record: working-memory entries plus the episode enrichment. */
export interface Perception {
  intent: IntentLabel;
  /** Perception-buffer entries in write order. */
  entries: WMEntryInput[];
  /** Known mentioned entities with the node IRIs resolved so far (possibly none yet). */
  entities: Array<{ name: string; iris: string[] }>;
  /** Names of known entities still to resolve (done in the queued persist). */
  pending: string[];
  /** Resolved entity IRIs (episode `about`), sorted and de-duplicated. */
  about: string[];
  /** Position and count of the ner-result entries inside `entries`. */
  nerAt: number;
  nerCount: number;
  /** Episode `tags`: the intent label. */
  tags: string[];
  /** Claim IRIs stored from this message (episode `hasClaim`). */
  hasClaim: string[];
  /** Episode `transcriptRef` with the line index, when known. */
  transcriptLine?: number;
}

// ── Intent classification ───────────────────────────────────────────────────

/**
 * Deterministic rule-based classifier. Rules run in this order, first match wins:
 *
 *  1. empty text                                  -> chit-chat
 *  2. starts with "/" or "!", or its first word is a bare imperative
 *     system verb (run, stop, deploy, starte, lösche ...)     -> command
 *  3. the whole message is a greeting / small talk / acknowledgement
 *     ("hi", "danke" is NOT here, see 6)           -> chit-chat
 *  4. the parser reported a question intent       -> question
 *  5. a polite marker anywhere (please, bitte), a request phrase at the start
 *     (can you, kannst du, ich brauche ...) or a request verb as first word
 *     (explain, erkläre, zeig ...)                -> request
 *  6. no question mark and a feedback cue at the start (thanks, danke, perfect,
 *     wrong, falsch, nein ...)                    -> feedback
 *  7. a question mark at the end, or an interrogative first word
 *     (who, wer, ist, how ...)                    -> question
 *  8. a topic cue (about, zum Thema ...), or at most two bare words, or at most
 *     four words naming a resolved entity         -> topic-reference
 *  9. anything else (statements)                  -> chit-chat
 */
export function classifyIntent(
  text: string,
  hints: { questionIntent?: boolean; resolvedEntities?: number } = {},
): IntentLabel {
  const raw = (text ?? '').trim();
  if (raw === '') return 'chit-chat';
  const lower = raw.toLowerCase();
  // Words with surrounding punctuation stripped; letters (any script) and digits only.
  const words = lower
    .split(/\s+/)
    .map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}']+$/gu, ''))
    .filter((w) => w !== '');
  const first = words[0] ?? '';
  const firstTwo = words.slice(0, 2).join(' ');
  const firstThree = words.slice(0, 3).join(' ');
  const hasQuestionMark = raw.includes('?');

  if (/^[/!]\S/.test(raw) || COMMAND_VERBS.has(first)) return 'command';

  if (isSmallTalk(lower)) return 'chit-chat';

  if (hints.questionIntent) return 'question';

  if (
    /\b(please|bitte|pls|plz)\b/.test(lower) ||
    REQUEST_PHRASES.some((p) => startsWithPhrase(lower, p)) ||
    REQUEST_VERBS.has(first)
  ) {
    return 'request';
  }

  if (
    !hasQuestionMark &&
    (FEEDBACK_CUES.has(first) ||
      FEEDBACK_CUES.has(firstTwo) ||
      FEEDBACK_CUES.has(firstThree) ||
      /^[\s]*(👍|👎|🙏|✅|❌)/u.test(raw))
  ) {
    return 'feedback';
  }

  if (/\?\s*$/.test(raw) || QUESTION_WORDS.has(first)) return 'question';

  if (
    TOPIC_CUES.some((c) => startsWithPhrase(lower, c)) ||
    (words.length <= 2 && !hasQuestionMark) ||
    (words.length <= 4 && (hints.resolvedEntities ?? 0) > 0)
  ) {
    return 'topic-reference';
  }
  return 'chit-chat';
}

const COMMAND_VERBS = new Set([
  'run', 'execute', 'exec', 'start', 'stop', 'restart', 'kill', 'delete', 'remove', 'deploy',
  'install', 'reboot', 'shutdown', 'reset', 'cancel', 'abort', 'enable', 'disable',
  'starte', 'stoppe', 'stopp', 'lösche', 'entferne', 'installiere', 'deploye',
  'abbrechen', 'abbruch', 'aktiviere', 'deaktiviere', 'führe', 'beende', 'öffne', 'schließe',
]);

const REQUEST_PHRASES = [
  'can you', 'could you', 'would you', 'will you', 'i need', 'i want', "i'd like", 'i would like',
  'help me', "let's", 'lets', 'kannst du', 'könntest du', 'koenntest du', 'würdest du',
  'ich brauche', 'ich möchte', 'ich moechte', 'ich will', 'hilf mir', 'lass uns', 'lass mich',
];

const REQUEST_VERBS = new Set([
  'explain', 'tell', 'show', 'give', 'write', 'create', 'make', 'find', 'search', 'summarize',
  'summarise', 'translate', 'list', 'draft', 'describe', 'compare', 'remind', 'check',
  'erkläre', 'erklär', 'sag', 'sage', 'zeig', 'zeige', 'gib', 'schreib', 'schreibe', 'erstelle',
  'mach', 'mache', 'finde', 'such', 'suche', 'fasse', 'übersetze', 'liste', 'beschreibe',
  'vergleiche', 'erinnere', 'prüfe', 'pruefe',
]);

const FEEDBACK_CUES = new Set([
  'thanks', 'thank you', 'thx', 'ty', 'danke', 'dankeschön', 'danke schön', 'vielen dank',
  'perfect', 'perfekt', 'great', 'super', 'awesome', 'nice', 'good job', 'gut gemacht',
  'exactly', 'genau', 'correct', 'richtig', 'stimmt', 'wrong', 'falsch', 'incorrect',
  'nope', 'nein', 'no', 'quatsch', 'nicht richtig', "that's wrong",
  "that's right", 'that is wrong', 'that is right', 'das ist falsch', 'das ist richtig',
  'das stimmt', 'das stimmt nicht', 'not what', 'das war nicht', 'leider nicht',
]);

const QUESTION_WORDS = new Set([
  'who', 'what', 'when', 'where', 'why', 'how', 'which', 'whose', 'is', 'are', 'do', 'does',
  'did', 'can', 'could', 'would', 'should', 'will', 'was', 'wer', 'wann', 'wo', 'warum',
  'wieso', 'weshalb', 'wie', 'welche', 'welcher', 'welches', 'wem', 'wen', 'wessen', 'wohin',
  'woher', 'womit', 'wozu', 'ist', 'sind', 'hat', 'haben', 'gibt', 'kennst', 'weißt',
  'weisst', 'kann', 'kannst', 'muss', 'soll', 'darf', 'war', 'waren',
]);

const TOPIC_CUES = [
  'about ', 'regarding ', 're: ', 'back to ', 'topic:', 'topic ', 'zum thema', 'thema:', 'thema ',
  'bezüglich', 'zurück zu', 'zurueck zu', 'wegen ',
];

const SMALL_TALK = new Set([
  'hi', 'hello', 'hey', 'hallo', 'moin', 'servus', 'huhu', 'yo', 'ciao', 'bye', 'tschüss',
  'tschuess', 'tschau', 'ok', 'okay', 'hmm', 'hm', 'aha', 'ja', 'yes', 'yep', 'jo', 'lol',
  'haha', 'cool', 'gn8', 'gute nacht', 'good night', 'good morning', 'guten morgen',
  'good evening', 'guten abend', 'guten tag', 'good afternoon', 'see you', 'bis später',
  'how are you', 'how are you doing', "what's up", 'whats up', "wie geht's", 'wie gehts',
  'wie geht es dir', 'na', 'na du', 'alles klar', 'bis bald',
]);

/** True when `text` starts with `phrase` and the phrase ends at a word boundary. */
function startsWithPhrase(text: string, phrase: string): boolean {
  if (!text.startsWith(phrase)) return false;
  const next = text[phrase.length];
  return next === undefined || /\P{L}/u.test(next) || /[^\p{L}]$/u.test(phrase);
}

/** True when the whole message is a greeting, acknowledgement or small talk. */
function isSmallTalk(lower: string): boolean {
  const stripped = lower
    .replace(/[^\p{L}\p{N}'\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (SMALL_TALK.has(stripped)) return true;
  // "hi there", "hallo ofelia": a greeting followed by one name-like word.
  const parts = stripped.split(' ');
  return parts.length === 2 && SMALL_TALK.has(parts[0]) && !QUESTION_WORDS.has(parts[1]);
}

// ── Perception record ───────────────────────────────────────────────────────

/** True for a string that is safe to write as a `<...>` IRI in generated SPARQL. */
function isSafeIri(s: string): boolean {
  return /^[A-Za-z][A-Za-z0-9+.-]*:[^\s<>"{}|\\^`]+$/.test(s);
}

function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function nerEntries(entities: Perception['entities']): WMEntryInput[] {
  const out: WMEntryInput[] = [];
  for (const e of entities) {
    for (const iri of e.iris) {
      if (out.length >= MAX_NER_ENTRIES) return out;
      out.push({
        buffer: 'perceptionBuffer',
        entryKind: 'ner-result',
        payload: `entity=${e.name} (resolved)`,
        salience: SALIENCE.ner,
        refersTo: iri,
      });
    }
  }
  return out;
}

function aboutOf(entities: Perception['entities']): string[] {
  return [...new Set(entities.flatMap((e) => e.iris))].sort(byCodePoint);
}

/**
 * Build the perception record for a turn. Deterministic: the same input gives
 * the same entries in the same order (entities are ordered by name, so the
 * matcher's result order does not matter). Entities that no fact stored this
 * turn names stay pending; see {@link resolvePerception}.
 */
export function buildPerception(input: PerceptionInput, source?: PerceptionSource): Perception {
  // Known mentions, one per name (case-insensitive), ordered by name.
  const seenNames = new Set<string>();
  const names = (source?.entities ?? [])
    .filter((e) => e.source === 'known')
    .map((e) => e.name)
    .sort(byCodePoint)
    .filter((n) => (seenNames.has(n.toLowerCase()) ? false : (seenNames.add(n.toLowerCase()), true)));
  // IRIs the store used for the subjects/objects of the facts stored this turn.
  const stored = new Map<string, Set<string>>();
  const note = (name: string, iri?: string) => {
    if (!iri || !isSafeIri(iri)) return;
    const k = name.toLowerCase();
    if (!stored.has(k)) stored.set(k, new Set());
    stored.get(k)!.add(iri);
  };
  for (const c of source?.storedClaims ?? []) {
    note(c.subject, c.subjectUri);
    note(c.object, c.objectUri);
  }
  const entities = names.map((name) => ({
    name,
    iris: [...(stored.get(name.toLowerCase()) ?? [])].sort(byCodePoint),
  }));

  const parse = source?.parseResult;
  const facts = parse && !parse.meta?.skipped ? parse.facts.filter((f) => f.kind === 'fact') : [];
  const intent = classifyIntent(input.text, {
    questionIntent: !!parse && !parse.meta?.skipped && !!parse.questionIntent,
    resolvedEntities: names.length,
  });

  const entries: WMEntryInput[] = [];
  if (input.text) {
    entries.push({
      buffer: 'perceptionBuffer',
      entryKind: 'message-text',
      payload: input.text,
      salience: SALIENCE.messageText,
    });
  }
  if (input.senderId) {
    entries.push({
      buffer: 'perceptionBuffer',
      entryKind: 'sender-id',
      payload: input.senderId,
      salience: SALIENCE.sender + (input.senderIsOwner ? SALIENCE.ownerBonus : 0),
    });
  }
  if (input.channel) {
    entries.push({
      buffer: 'perceptionBuffer',
      entryKind: 'channel',
      payload: input.channel,
      salience: SALIENCE.channel,
    });
  }
  const nerAt = entries.length;
  const ner = nerEntries(entities);
  entries.push(...ner);
  const claimOf = new Map(
    (source?.storedClaims ?? []).map((c) => [`${c.subject}\u0000${c.predicate}\u0000${c.object}`, c.claimUri]),
  );
  for (const f of facts.slice(0, MAX_CLAIM_ENTRIES)) {
    const claimUri = claimOf.get(`${f.subject}\u0000${f.predicate}\u0000${f.object}`);
    entries.push({
      buffer: 'perceptionBuffer',
      entryKind: 'parsed-claim',
      payload: `${f.subject} | ${f.predicate} | ${f.object}`,
      salience: SALIENCE.parsedClaim,
      ...(claimUri && isSafeIri(claimUri) ? { refersTo: claimUri } : {}),
    });
  }
  entries.push({
    buffer: 'perceptionBuffer',
    entryKind: 'intent',
    payload: `intent=${intent}`,
    salience: SALIENCE.intent,
  });

  return {
    intent,
    entries,
    entities,
    pending: entities.filter((e) => e.iris.length === 0).map((e) => e.name),
    about: aboutOf(entities),
    nerAt,
    nerCount: ner.length,
    tags: [intent],
    hasClaim: [...new Set([
      ...(source?.storedClaims ?? []).map((c) => c.claimUri),
      ...(source?.reassertedClaims ?? []),
    ].filter(isSafeIri))],
    ...(source?.transcriptLine !== undefined ? { transcriptLine: source.transcriptLine } : {}),
  };
}

/**
 * Fill in the pending entities from a read-only lookup (`resolved`: lower-cased
 * name -> existing node IRIs) and return the completed record. Names the lookup
 * did not find stay unresolved: no `about`, no ner-result entry. The input
 * record is not modified.
 */
export function resolvePerception(p: Perception, resolved: Map<string, string[]>): Perception {
  const entities = p.entities.map((e) =>
    e.iris.length > 0
      ? e
      : {
          name: e.name,
          iris: [...new Set(resolved.get(e.name.toLowerCase()) ?? [])].filter(isSafeIri).sort(byCodePoint),
        },
  );
  const ner = nerEntries(entities);
  const entries = [...p.entries.slice(0, p.nerAt), ...ner, ...p.entries.slice(p.nerAt + p.nerCount)];
  return {
    ...p,
    entries,
    entities,
    pending: entities.filter((e) => e.iris.length === 0).map((e) => e.name),
    about: aboutOf(entities),
    nerCount: ner.length,
  };
}
