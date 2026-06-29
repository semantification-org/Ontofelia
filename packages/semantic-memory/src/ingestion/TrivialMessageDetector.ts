/**
 * TrivialMessageDetector — Rule-based filter that identifies messages
 * that don't need semantic parsing (greetings, confirmations, emoji).
 *
 * Design principle: conservative. When in doubt, the message is NOT trivial.
 * It's better to parse one message too many than to miss a fact.
 */

export type TrivialReason =
  | 'greeting'
  | 'confirmation'
  | 'emoji_only'
  | 'thanks'
  | 'too_short'
  | 'command';

export interface TrivialCheckResult {
  isTrivial: boolean;
  reason?: TrivialReason;
}

/** Greeting patterns (case-insensitive, full-match or start-of-short-message) */
const GREETING_PATTERNS = /^(hello|hi|hey|good\s*(morning|afternoon|evening|night)|h(a)?llo|moin|servus|guten\s*(morgen|tag|abend|nacht)|yo\b)[\s!?.]*$/i;

/** Thanks patterns */
const THANKS_PATTERNS = /^(thx|thanks|thank\s*you|danke|vielen\s*dank|dank(e\s*dir|eschön)?)[\s!?.]*$/i;

/** Confirmation/rejection patterns */
const CONFIRMATION_PATTERNS = /^(yep|yes|no|nope|ja|nein|ok(ay)?|clear|understood|alles\s*klar|verstanden|exactly|genau|right|richtig|stimmt|sure|good|gut|great|super|cool|nice|top|perfect|perfekt|agreed|ack|roger|check|done|erledigt)[\s!?.]*$/i;

/** Pure emoji message (only emoji, whitespace, and variation selectors) */
const EMOJI_ONLY_PATTERN = /^[\p{Emoji_Presentation}\p{Emoji_Modifier_Base}\p{Emoji_Modifier}\p{Extended_Pictographic}\uFE0F\u200D\s]+$/u;

/**
 * Minimum word count below which a message without verbs or nouns is trivial.
 * Messages with 3+ words always go through the parser.
 */
const SHORT_MESSAGE_MAX_WORDS = 2;

export class TrivialMessageDetector {
  /**
   * Check whether a user message is trivial (no semantic content to parse).
   *
   * Conservative: returns `isTrivial: true` only when we're confident
   * there's no extractable fact or question in the message.
   */
  check(message: string): TrivialCheckResult {
    const trimmed = message.trim();

    // Empty messages are trivial
    if (trimmed.length === 0) {
      return { isTrivial: true, reason: 'too_short' };
    }

    // Slash commands are handled by AgentRuntime, not the parser
    if (trimmed.startsWith('/')) {
      return { isTrivial: true, reason: 'command' };
    }

    // Pure emoji → trivial
    if (EMOJI_ONLY_PATTERN.test(trimmed)) {
      return { isTrivial: true, reason: 'emoji_only' };
    }

    // For short messages (≤ SHORT_MESSAGE_MAX_WORDS), check patterns
    const words = trimmed.split(/\s+/);
    if (words.length <= SHORT_MESSAGE_MAX_WORDS) {
      if (GREETING_PATTERNS.test(trimmed)) {
        return { isTrivial: true, reason: 'greeting' };
      }
      if (THANKS_PATTERNS.test(trimmed)) {
        return { isTrivial: true, reason: 'thanks' };
      }
      if (CONFIRMATION_PATTERNS.test(trimmed)) {
        return { isTrivial: true, reason: 'confirmation' };
      }
    }

    // Longer messages that START with a greeting/thanks but contain more content
    // are NOT trivial. Example: "Thanks, I work at Google"
    // → has >2 words, patterns above didn't match because they require full-match.
    // This is by design.

    return { isTrivial: false };
  }
}
