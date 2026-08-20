// One ladder for shortening a big number — "1.5k", "412k", "2.3M".
//
// Before this file the app had fourteen of these, under eight names
// (`compactCount` ×3, `compactNum` ×2, `compactTokens`, `formatSavedTokens`,
// `formatTokens` ×3, `fmtTokens` ×3, `fmtChars`), and they disagreed on
// screen: 2,300,000 rendered as "2.3M" in Settings, "2.3m" on a workspace
// row, and "2300.0k" under an agent's reply — three different answers to the
// same number, in one window. 12,400 was "12k" in some places and "12.4k" in
// others.
//
// The rule here is the one the majority of those already used, so nothing
// familiar changed shape: exact below a thousand, one decimal until the next
// rung is comfortably clear, whole numbers after that. A trailing ".0" is
// dropped, because "1.0k" is a number nobody writes.
//
//   999 → "999"      1000 → "1k"       1500 → "1.5k"
//   12400 → "12k"    412000 → "412k"   2300000 → "2.3M"   4.2e9 → "4.2B"
//
// Bytes are a different ladder (1024, not 1000) and stay with their own
// formatters. Ages are `lib/relativeTime`.

/** Shorten a count for display. Negative and non-finite inputs are handled so
 *  a bad number never renders as "NaNk". */
export function compactNumber(n: number): string {
  const v = Number.isFinite(n) ? Math.abs(n) : 0;
  const sign = Number.isFinite(n) && n < 0 ? "-" : "";
  if (v < 1000) return `${sign}${Math.round(v)}`;
  for (const [unit, scale] of RUNGS) {
    const scaled = v / scale;
    if (scaled < 1000) {
      const text = trim(scaled);
      // Rounding can push a value up onto the next rung — 999,500 wants to
      // read "1M", not "1000k". Fall through and let the next one take it.
      if (text !== "1000") return `${sign}${text}${unit}`;
    }
  }
  return `${sign}${trim(v / 1e12)}T`;
}

const RUNGS: ReadonlyArray<readonly [string, number]> = [
  ["k", 1e3],
  ["M", 1e6],
  ["B", 1e9],
];

/** One decimal below ten, whole numbers above — "1.5", "9.9", "12" — with a
 *  bare ".0" dropped so 2000 reads "2k" rather than "2.0k". */
function trim(x: number): string {
  return x < 10 ? String(Number(x.toFixed(1))) : String(Math.round(x));
}
