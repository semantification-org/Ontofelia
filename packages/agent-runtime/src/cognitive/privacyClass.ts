/**
 * Privacy classification of an episode payload. The payload itself is stored
 * unchanged; a match only adds `core:privacyClass "secret"` to the episode so
 * the retention sweep can move it to the cold tier early.
 *
 * The patterns are deliberately narrow (well-known credential shapes and an
 * explicit `name: value` assignment of a secret-like name): a false negative
 * leaves the episode on the normal retention schedule, a false positive only
 * shortens it.
 */

const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/,
  /\bgithub_pat_[A-Za-z0-9_]{30,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/i,
  /\b(?:password|passwort|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|token)\b\s*[:=]\s*["']?[^\s"']{6,}/i,
];

/** True when the text matches a known credential shape. */
export function looksLikeSecret(text: string | undefined): boolean {
  if (!text) return false;
  return SECRET_PATTERNS.some((re) => re.test(text));
}
