// The letters in an avatar when there is no picture — one answer, app-wide.
//
// There were eight, under four names (`initials` ×4, `initialsOf`, `initialOf`,
// `Monogram`, plus seven more written inline as `.charAt(0).toUpperCase()`),
// and no two of them agreed about the same person. Fed the same eight names,
// every single one produced between two and four different answers:
//
//   name                  → distinct answers across the app
//   "Ada Lovelace"          A  · AL                          2
//   "Ada Byron Lovelace"    A  · AB · AL                      3
//   "ashiq"                 A  · AS                           2
//   "mo@touchstage.com"     M  · MO · MC                      3
//   "ada.lovelace"          A  · AD · AL                      3
//   "ashiq@cursor"          A  · AS · AC                      3
//   "🎯 Launch week"        LW · <broken glyph> ×5            4
//   ""  (no name at all)    ?  · ·  · ·· · <empty circle> ×2  4
//
// A monogram exists so you recognise a person at a glance. It cannot do that
// job if the same person is "A" in the assignee picker and "AS" in the crew
// roster, in the same window.
//
// Three of those rows are not just disagreement, they are defects:
//
//   the broken glyph   `"🎯".charAt(0)` is half a surrogate pair. Five of the
//                      eight sliced by code UNIT, so a name that opens with an
//                      emoji rendered "�" — a replacement box — inside the
//                      circle. Array.from splits by code point and fixes it.
//   the empty circle   Two returned "" for a blank name, so the avatar drew a
//                      ring with nothing in it rather than saying "unknown".
//   "MC"               syncFormat replaced every non-alphanumeric with a space
//                      before splitting, so "mo@touchstage.com" became three
//                      words and it took M from "mo" and C from "com". An email
//                      address identifies a person by the part before the host.
//
// Two shapes are genuinely different and both survive:
//
//   · monogram   — up to two characters, for a PERSON. First + last initial,
//                  because that is what a person's initials are: given name and
//                  family name, not the first two words. A single-word name
//                  falls back to its first two letters ("ashiq" → "AS") so the
//                  circle is never half-empty next to a two-letter neighbour.
//   · letterMark — exactly one character, for a THING: an agent tile, a project
//                  square, an org chip. That slot is where a logo goes when we
//                  have one, so its fallback is a single-letter mark, like a
//                  favicon. AgentIcon learned this the hard way — it used to
//                  render the whole label, and "AIDER" overflowed a 22px tile
//                  into the row's own name beside it.
//
// Everything else — where the letters come from, what a blank name prints — is
// the same for both, because a reader should not have to work out whether the
// "A" and the "AS" they are looking at are the same teammate.

export type MonogramOptions = {
  /** What to show when there is no usable name. Defaults to "?" — the circle
   *  should say "we don't know who this is", not stand empty. */
  empty?: string;
};

const UNKNOWN = "?";

/** Split by code POINT. `"🎯".charAt(0)` and `"🎯"[0]` each return half a
 *  surrogate pair, which renders as a replacement box. */
function codePoints(s: string): string[] {
  return Array.from(s);
}

/** The name reduced to the word-parts a monogram can be built from.
 *
 *  Drops an "@host" suffix first: an email ("mo@touchstage.com") and a radar
 *  actor id ("ashiq@cursor") both identify a person by what comes before the
 *  "@". Then splits on the separators handles actually use — whitespace, dot,
 *  underscore, hyphen, slash — and throws away any character that isn't a
 *  letter or a number, which is what makes "🎯 Launch week" read "LW" rather
 *  than opening with a broken glyph. */
function nameParts(raw: string | null | undefined): string[] {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return [];
  const at = trimmed.indexOf("@");
  const base = at > 0 ? trimmed.slice(0, at) : trimmed;
  return base
    .split(/[\s._\-/\\]+/)
    .map((part) =>
      codePoints(part)
        .filter((c) => /[\p{L}\p{N}]/u.test(c))
        .join(""),
    )
    .filter(Boolean);
}

/** Up to two characters standing for a PERSON — "Ada Lovelace" → "AL",
 *  "ashiq" → "AS", "mo@touchstage.com" → "MO". */
export function monogram(
  name: string | null | undefined,
  opts: MonogramOptions = {},
): string {
  const parts = nameParts(name);
  if (parts.length === 0) return opts.empty ?? UNKNOWN;
  const letters =
    parts.length === 1
      ? codePoints(parts[0]).slice(0, 2)
      : [codePoints(parts[0])[0], codePoints(parts[parts.length - 1])[0]];
  // Uppercasing can lengthen a character in some scripts (ß → SS), so clamp
  // after the fact rather than trusting the input to stay two wide.
  return codePoints(letters.join("").toUpperCase()).slice(0, 2).join("");
}

/** Exactly one character standing for a THING — an agent, a project, an org.
 *  This is the slot a logo occupies when we have one, so the fallback is a
 *  single-letter mark rather than a person's initials. */
export function letterMark(
  name: string | null | undefined,
  opts: MonogramOptions = {},
): string {
  const parts = nameParts(name);
  if (parts.length === 0) return opts.empty ?? UNKNOWN;
  return codePoints(codePoints(parts[0])[0]!.toUpperCase())[0]!;
}
