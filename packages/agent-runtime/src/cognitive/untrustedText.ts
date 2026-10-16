/**
 * Neutralisation of untrusted text before it is spliced into the system prompt.
 *
 * Shared by the "while you were away" digest and the recalled block of the
 * prompt assembler: both quote text that came from outside the agent (relayed
 * notifications, earlier user messages) and must stay inert single-line data.
 */

/**
 * Collapse `message` to one inert line:
 *  - control characters (newlines, tabs) and runs of whitespace become one space,
 *    so nothing can start a new markdown line or heading,
 *  - leading markdown structure characters (`#`, `>`, `-`, `*`, `` ` ``, `|`,
 *    `=`, `~`, `+`) are stripped,
 *  - the result is cut to `max` characters (with an ellipsis).
 */
export function neutraliseLine(message: string, max: number): string {
  const oneLine = String(message ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ') // control chars incl. newlines/tabs
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[#>\-*`|=~+]+\s*/, '')
    .trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max - 1).trimEnd()}…`;
}

/**
 * {@link neutraliseLine} plus two further rules for text quoted inside a fenced
 * block of the prompt:
 *  - anything that looks like one of our section headers (`[Self]`,
 *    `[Active goal]`, `[Recalled]`, …) loses its square brackets, so quoted
 *    text can never pose as a block of the prompt;
 *  - runs of three or more `<` / `>` are removed, so quoted text can never close
 *    (or open) the fence that delimits it.
 */
export function neutraliseQuoted(message: string, max: number): string {
  let stripped = String(message ?? '');
  // Repeat until stable: removing an inner pair can complete an outer one.
  for (let prev = ''; prev !== stripped; ) {
    prev = stripped;
    stripped = stripped.replace(/\[([A-Za-z][^\][\n]{0,80})\]/g, '($1)').replace(/[<>]{3,}/g, ' ');
  }
  return neutraliseLine(stripped, max);
}
