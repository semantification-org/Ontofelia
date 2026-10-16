/**
 * Compare two ISO-8601 timestamps as instants, ascending.
 *
 * The triplestore returns `xsd:dateTime` values with the trailing zeros of the
 * fraction trimmed ("...41.4Z" for .400), so such strings do not sort as time:
 * "41.4Z" > "41.431Z" because "Z" > "3". Always compare store timestamps with
 * this function (or on `Date.parse`), never with `<` / `>` on the strings.
 *
 * A value that does not parse sorts before every valid one; two unparseable
 * values fall back to string order so the result stays a total order.
 */
export function compareIso(a: string, b: string): number {
  const x = Date.parse(a);
  const y = Date.parse(b);
  const xv = !Number.isNaN(x);
  const yv = !Number.isNaN(y);
  if (xv && yv) return x < y ? -1 : x > y ? 1 : 0;
  if (xv !== yv) return xv ? 1 : -1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Descending counterpart of {@link compareIso}: newest first. */
export function compareIsoDesc(a: string, b: string): number {
  return compareIso(b, a);
}
