// Shortening a string that is too long — one answer, app-wide.
//
// Eleven places cut a string and add an ellipsis. All eleven agree on the
// character — "…", one character, not three dots — and ten of the eleven get
// the arithmetic wrong, in one of two directions:
//
//   site                        guard    slice    result    vs its own budget
//   team/messageModel:368       > 240      237      238      2 short
//   team/Bubble:947             >  60       57       58      2 short
//   lib/auraRelay:158,189       >  80       77       78      2 short
//   lib/permissionStore:130     > 100       97       98      2 short
//   agent/ResumeDialog:374      > 160      157      158      2 short
//   manager/…DashboardSurface   >  30       27       28      2 short
//   App:2664                    >  24       24       25      1 over
//   manager/DagView:247         > 240      240      241      1 over
//   lib/planXml:114             >  60       60       61      1 over
//   workpanes/WorkspaceSetupFeed >  32       31       32      right
//
// The seven "2 short" sites reserve three characters, which is exactly right
// for "..." — the ellipsis this app used to write. The character was unified
// to "…" and the arithmetic was never revisited, so every one of them now
// returns two characters less than it means to. The three "1 over" sites
// reserve nothing and overrun by the ellipsis itself.
//
// ── Why this is not only arithmetic ──────────────────────────────────────
//
// `String.slice` cuts by UTF-16 code unit. An emoji is two code units, a flag
// is four, and a family emoji is more; cutting inside one leaves a broken
// replacement glyph in the output. Six of these eleven truncate free-typed
// text — a chat line, a PR subject, a handover summary, a shell command — so
// the input genuinely contains emoji, and the character limit lands wherever
// the sentence happens to put it.
//
// This counts grapheme clusters, so "🇬🇧" and "👨‍👩‍👧" are each one unit and
// are never cut through. `Intl.Segmenter` is the tool for that; where it is
// missing (older WebKitGTK on Linux) this falls back to code points, which
// still keeps a surrogate pair whole.

/** The one part of `Intl.Segmenter` this file uses.
 *
 *  Declared here rather than taken from the standard library because this
 *  app compiles against ES2020 and `Intl.Segmenter` is an ES2022 type. The
 *  question of whether it EXISTS is a runtime one — WebKitGTK on Linux is the
 *  case that answers no — and the feature test below is what asks it. Widening
 *  the whole app's `lib` to claim ES2022 would let unrelated code assume APIs
 *  we have not checked for. */
type GraphemeSegmenter = { segment(input: string): Iterable<{ segment: string }> };

type SegmenterCtor = new (
  locales?: string | string[],
  options?: { granularity?: "grapheme" | "word" | "sentence" },
) => GraphemeSegmenter;

/** Grapheme splitter, resolved once. Undefined where Intl.Segmenter is not
 *  available — the fallback below splits by code point instead. */
const SEGMENTER: GraphemeSegmenter | undefined = (() => {
  const ctor = (Intl as unknown as { Segmenter?: SegmenterCtor }).Segmenter;
  return ctor ? new ctor(undefined, { granularity: "grapheme" }) : undefined;
})();

/** A string as the units a reader sees: whole emoji, whole flags, whole
 *  accented letters. */
function units(s: string): string[] {
  if (SEGMENTER) return [...SEGMENTER.segment(s)].map((g) => g.segment);
  return Array.from(s);
}

/** The ellipsis this app writes. One character, never three dots. */
export const ELLIPSIS = "…";

export type TruncateOptions = {
  /** Character to end a shortened string with. Defaults to "…". Pass "" for a
   *  hard cut with no marker. */
  ellipsis?: string;
};

/** Shorten `s` to at most `limit` characters, ellipsis included.
 *
 *  A string that already fits comes back untouched. One that does not is cut
 *  to `limit - 1` and given a "…", so the result is exactly `limit` — which is
 *  what every call site here believed it was already doing.
 *
 *  Cuts on grapheme boundaries, so an emoji at the limit is dropped whole
 *  rather than left as half a surrogate pair. Trailing whitespace is trimmed
 *  before the ellipsis, so a cut at a space reads "the thing…" and not
 *  "the thing …". */
export function truncate(
  s: string | null | undefined,
  limit: number,
  opts?: TruncateOptions,
): string {
  const str = s ?? "";
  if (!str || limit <= 0) return "";
  const mark = opts?.ellipsis ?? ELLIPSIS;
  const chars = units(str);
  if (chars.length <= limit) return str;
  const room = limit - units(mark).length;
  if (room <= 0) return mark.slice(0, limit);
  return chars.slice(0, room).join("").replace(/\s+$/, "") + mark;
}
