// "1 file" or "5 files" — one answer, app-wide.
//
// Four functions were called `plural`, and they did not agree on what a call to
// `plural` means. Three took the count first, one took the noun first — and of
// the three that agreed on the argument order, two disagreed on the answer:
//
//   reviewState.ts    plural(n, one, many)  →  "commits"      the word alone
//   supportLabels.ts  plural(n, one, many)  →  "5 languages"  the count too
//   TurnActivity.tsx  plural(n, one, many)  →  "5 files"      the count too
//   SplitDiffHeader   plural(noun, n)       →  "functions"    the word alone
//
// So the first three are indistinguishable at the call site and two of them
// silently include a number the third does not. Move a line from the review
// rail into the turn summary and it reads "Behind by 3 3 commits"; move one the
// other way and the number vanishes. Nothing warns you: same name, same arity,
// same types.
//
// The fix is not one function — it is two functions whose names say which one
// you are getting:
//
//   plural(n, one)   → "file"  | "files"      the word
//   countOf(n, one)  → "1 file" | "5 files"   the number and the word
//
// ── Why there is a default plural at all ─────────────────────────────────
//
// Because both of this app's plural bugs were nouns nobody could see.
//
// 108 places write the plural inline — `${n} file${n === 1 ? "" : "s"}` — with
// the noun sitting directly against its own "s". Every one of those 108 is
// correct, checked; a regular noun and a visible "s" is hard to get wrong, and
// they are left exactly as they are. Both defects were in the two places where
// the noun and the "s" were NOT next to each other in the source:
//
//   · settings/IntegrationsTab put them in separate JSX expressions on separate
//     lines, and appended a bare "s" to "dependency" — "linked 5 dependencys".
//   · SplitDiffHeader's noun arrived from a function, so its rule read only the
//     final letter. "enum" is spelled out for the non-engineer as "set of
//     options", which ends in "s", so its `-es` branch fired: two changed enums
//     summarised as "Reworked 2 set of optionses."
//
// The author could not see the word in either case, so the rule has to know
// what the author could not check by eye.

/** Sibilants take `-es`: search → searches, class → classes, box → boxes. */
const SIBILANT = /(?:[sxz]|ch|sh)$/i;

/** A consonant before a final `y` turns it into `-ies`: dependency →
 *  dependencies. A vowel does not — "day" is "days", not "daies". */
const CONSONANT_Y = /[^aeiou]y$/i;

/** The plural of a regular English noun.
 *
 *  Covers every noun this app pluralises. It is deliberately not clever: an
 *  irregular noun ("person", or a phrase like "set of options" where the head
 *  word takes the s) passes its plural explicitly rather than hoping a rule
 *  guesses right. */
function regularPlural(one: string): string {
  if (CONSONANT_Y.test(one)) return `${one.slice(0, -1)}ies`;
  if (SIBILANT.test(one)) return `${one}es`;
  return `${one}s`;
}

/** The right form of a noun for a count — the WORD, with no number.
 *
 *  `plural(1, "file")` → "file", `plural(5, "file")` → "files". Pass `many`
 *  when the noun is irregular or is a phrase whose head takes the s. */
export function plural(n: number, one: string, many?: string): string {
  return n === 1 ? one : (many ?? regularPlural(one));
}

/** A count and its noun together — `countOf(5, "file")` → "5 files".
 *
 *  The other half of the pair, named differently on purpose: the two used to
 *  share the name `plural` and differ only in whether the number came back
 *  with the word. */
export function countOf(n: number, one: string, many?: string): string {
  return `${n} ${plural(n, one, many)}`;
}
