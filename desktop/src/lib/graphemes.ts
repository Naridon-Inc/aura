// Text as people see it: one "character" can be several code points (skin
// tones, joined families, flags), so these count graphemes, not code units.

/** The first user-perceived character. Emoji are often several code points
 *  (skin tones, joined families, flags), so this segments by grapheme rather
 *  than taking `str[0]`. */
export function firstGrapheme(s: string): string {
  const trimmed = s.trim();
  if (!trimmed) return "";
  // Intl.Segmenter is not in this project's TS lib target; it is present in
  // the app's WebKit runtime, so it is reached through a narrow typed shim.
  const SegmenterCtor = (
    Intl as unknown as {
      Segmenter?: new (
        locales?: string | string[],
        options?: { granularity?: "grapheme" | "word" | "sentence" },
      ) => { segment: (input: string) => Iterable<{ segment: string }> };
    }
  ).Segmenter;
  if (SegmenterCtor) {
    try {
      const seg = new SegmenterCtor(undefined, { granularity: "grapheme" });
      const first = seg.segment(trimmed)[Symbol.iterator]().next();
      if (!first.done) return first.value.segment;
    } catch {
      /* fall through to the code-point split */
    }
  }
  return Array.from(trimmed)[0] ?? "";
}
