/**
 * Helpers for interpolating untrusted values into SPARQL text.
 *
 * Literals are escaped, IRIs are validated (never "repaired"): a value that
 * cannot be written safely is rejected with an Error.
 */

// SPARQL 1.1 ECHAR set: \t \b \n \r \f \" \' \\
const ECHAR: Record<string, string> = {
  '\\': '\\\\',
  '"': '\\"',
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
  '\b': '\\b',
  '\f': '\\f',
};

/**
 * Returns `value` as a complete double-quoted SPARQL string literal ("...").
 *
 * - Backslash, double quote, LF, CR, TAB, BS and FF use the ECHAR escapes.
 * - Every other C0 control character (U+0000-U+001F) and every lone UTF-16
 *   surrogate is replaced with U+FFFD. `\uXXXX` is deliberately not used:
 *   in SPARQL it is a pre-parse substitution, not a string escape, so it
 *   would not be a faithful, parser-independent encoding of the character.
 *   Such characters therefore do not round-trip; all other text does.
 */
export function sparqlStringLiteral(value: string): string {
  const s = String(value);
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    const code = s.charCodeAt(i);
    if (ECHAR[ch] !== undefined) {
      out += ECHAR[ch];
    } else if (code < 0x20) {
      out += '�';
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += ch + s[i + 1];
        i++;
      } else {
        out += '�';
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      out += '�';
    } else {
      out += ch;
    }
  }
  return out + '"';
}

// IRIREF excludes <>"{}|^`\ and U+0000-U+0020; DEL and C1 controls are
// rejected too.
const FORBIDDEN_IRI_CHARS = /[<>"{}|^`\\\u0000- \u007f-\u009f]/;

/**
 * Returns `<iri>` after verifying the IRI contains no character that could
 * end or alter the IRIREF token. Throws on an empty or unsafe value.
 */
export function sparqlIri(iri: string): string {
  if (typeof iri !== 'string' || iri.length === 0 || FORBIDDEN_IRI_CHARS.test(iri)) {
    throw new Error(`Invalid IRI for SPARQL: ${JSON.stringify(String(iri).slice(0, 80))}`);
  }
  return `<${iri}>`;
}
