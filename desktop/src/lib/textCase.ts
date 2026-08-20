// Which letters are capital — one answer, app-wide.
//
// Eighteen implementations, under six names plus a dozen written inline. Fed
// the same strings they actually receive, they split four ways:
//
//   input            answers across the app
//   "in progress"    In progress (12×) · In Progress (6×)
//   "sender for"     Sender for  (12×) · Sender For  (6×)
//   "cursor-agent"   Cursor-agent (10×) · Cursor-Agent (4×) · Cursor Agent (3×)
//                    · Cursor agent (1×)
//   "GitHub"         GitHub (15×) · Github (3×)
//   "MCP"            MCP (15×) · Mcp (3×)
//
// `cursor-agent` is a real agent id with a real icon in this app. So the same
// agent is "Cursor Agent" in the launcher's session list, "Cursor-agent lane"
// in the lane switcher, and "Cursor-agent" on the permission card that asks you
// whether to let it run — three names for one thing, in one session.
//
// Two shapes are genuinely different and both survive:
//
//   · sentenceCase   — capital on the first letter, everything else left
//                      exactly as it was. The house style: it is what
//                      lib/taskStatus, lib/goalVerdict and lib/workState
//                      already speak ("In progress", "Not yet", "Needs you"),
//                      and leaving the tail alone is what keeps "GitHub",
//                      "MCP" and "OpenAI" intact.
//   · titleCaseName  — capital on every word, for a PROPER NOUN recovered from
//                      a slug: an agent id, a model id, a product handle.
//                      "cursor-agent" → "Cursor Agent". Only for names — a
//                      status, a heading or a phrase takes sentenceCase.
//
// ── Two things this replaces that were not just style ────────────────────
//
// The `\b\w` title-caser. Five copies uppercased every character following a
// word boundary, and an apostrophe is a word boundary: "don't stop" came back
// "Don'T Stop". Nothing free-typed reaches those five today — they take review
// decisions, code identifiers and model slugs — so this removes a hazard
// rather than fixing a live bug. titleCaseName splits on whitespace and the
// separators a slug actually uses, so an apostrophe cannot open a word.
//
// Lowercasing the tail. Three copies did `s.slice(1).toLowerCase()`, which is
// right for the one thing it was written for — a word left Capitalised by a
// camelCase split, where "filePath" becomes "file Path" and wants to read
// "File path" — and wrong for every brand that arrives already cased. It is a
// per-word question, not a per-string one, so `camelSplitTail` below asks it
// per word: a word shaped `Path` is a split artefact and comes down; `GitHub`,
// `MCP` and `OpenAI` are not, and are left alone.
//
// ── Where the casing was shared but the answer still differed ────────────
//
// Three surfaces render a code identifier as plain words, and all three call
// the same humanizer, lib/prove's humanizeIdentifier. Two of them then wrote
// their own casing step on top and produced a different string — and said in
// their own doc comments that they had not:
//
//   ChangeNoteCard  "using the SAME humanizer the Goals and split-diff
//                    surfaces use, so the whole app reads the same"  → Sender For
//   SplitDiffHeader "from the SAME humanizer the Goals surface uses"  → Sender For
//   the Goals surface itself                                         → Sender for
//
// Sharing the function that produces the words is not the same as sharing the
// answer. The casing is the last step, and it was the step nobody shared.

/** A word left Capitalised by a camelCase split — `Path` out of `filePath`.
 *  Deliberately narrow: exactly one capital, then lowercase letters. `GitHub`
 *  has a capital in the middle, `MCP` has no lowercase at all, and neither is
 *  an artefact of splitting, so neither matches. */
const CAMEL_SPLIT_WORD = /^[A-Z][a-z]*$/;

/** The separators a slug uses between words — space, dot, underscore, hyphen,
 *  slash. Shared with lib/monogram's reading of the same handles.
 *
 *  A dot between two digits is excepted: it is a decimal point, not a word
 *  break. Without that, the model id "Claude-Opus-4.7" — one of the ids this
 *  repo's own intent log actually carries — read "Claude Opus 4 7". */
const SLUG_SEPARATORS = /(?:(?!(?<=\d)\.(?=\d))[\s._\-/\\])+/;

/** Capital on the first letter; the rest untouched.
 *
 *  "in progress" → "In progress", and "GitHub" → "GitHub" rather than
 *  "Github", because the tail is never touched. The app's default: a status, a
 *  heading, a label, a sentence.
 *
 *  Splits by code point, so a string opening with an emoji keeps its emoji
 *  whole instead of being cut through a surrogate pair. */
export function sentenceCase(s: string | null | undefined): string {
  const str = s ?? "";
  if (!str) return "";
  const [head, ...tail] = Array.from(str);
  return head!.toUpperCase() + tail.join("");
}

/** Capital on every word — for a PROPER NOUN recovered from a slug.
 *
 *  "cursor-agent" → "Cursor Agent", "deepseek_coder" → "Deepseek Coder". The
 *  separators become spaces, because a hyphen in an id is a word break, not
 *  punctuation the reader was meant to see.
 *
 *  Use it for a name. A status, a heading or any phrase takes sentenceCase —
 *  Title Case On Every Word is a habit from column headings, and most of the
 *  strings that reach a person here are not column headings. */
export function titleCaseName(s: string | null | undefined): string {
  return (s ?? "")
    .split(SLUG_SEPARATORS)
    .filter(Boolean)
    .map((w) => sentenceCase(w))
    .join(" ");
}

/** Bring a word down only if it is a camelCase split artefact.
 *
 *  For turning an identifier into a phrase: `filePath` splits to "file Path",
 *  and "Path" should read "path" — but "GitHub", "MCP" and "OpenAI" arrive
 *  cased on purpose and must survive. Ask per word, not per string. */
export function camelSplitTail(word: string): string {
  return CAMEL_SPLIT_WORD.test(word) ? word.toLowerCase() : word;
}
