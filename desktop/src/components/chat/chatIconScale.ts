// The chat transcript's icon scale, in numbers an SVG attribute can take.
//
// The sizes also live as `--chat-icon` / `--chat-icon-action` on `.aura-chat`
// in styles.css, because the leading column, the hit targets and the gaps are
// laid out in CSS and have to agree with the glyphs that sit in them. SVG
// `width`/`height`/`stroke-width` are attributes, not styleable properties, so
// the same numbers have to exist on this side too. `chatRedesign.test.ts`
// reads both and fails if they drift.
//
// Why these numbers: they are the ink boxes the spec calls for, measured off
// the capture at 2x and halved back to logical points.
//
//   roll-up terminal mark   ink 10.5 x 9pt
//   roll-up magnifier       ink 11.5 x 11.5pt
//   roll-up chevron         ink 5 x 8pt
//   footer copy             ink 14.5pt square
//   footer ellipsis         span 11.5pt, dots 2.5pt
//
// A lucide path's ink in a 24 viewBox scales as (inkUnits + strokeWidth) / 24
// * size. Terminal is 16 ink units, so 14 * 18/24 = 10.5. Search is 18, so
// 14 * 20/24 = 11.67. Copy is 20, so 16 * 22/24 = 14.67. All three invert to
// the same two sizes, and a column probe through the magnifier's ring reads a
// 2.0-2.3px stroke at 2x — 1.0 to 1.15pt — against the 1.167 lucide draws at
// 14/2. Hence strokeWidth 2, everywhere.
//
// The spec's own glyphs are SF Symbols; ours are lucide. What is pinned is the
// rendered ink box and the stroke weight, which is what the eye reads — not
// the letterforms or the joinery, which are a different family's and stay so.

/** Anything in the activity stream: tool glyphs, chevrons, status marks. */
export const CHAT_ICON = 14;

/** Anything in a turn footer: copy, more, the elision marker. */
export const CHAT_ICON_ACTION = 16;

/** One stroke weight for the whole transcript, in lucide's 24 viewBox. */
export const CHAT_ICON_STROKE = 2;

/** The same weight expressed for a hand-drawn glyph on a 16 viewBox. Our tool
 *  glyphs are drawn at 16 rather than 24 — equal ink needs a proportionally
 *  smaller number, or a 16-box glyph renders a third heavier than the lucide
 *  icon sitting next to it in the same row. */
export const CHAT_ICON_STROKE_16 = (CHAT_ICON_STROKE * 16) / 24;

/** And on a 12 viewBox, for the tick/cross status marks. */
export const CHAT_ICON_STROKE_12 = (CHAT_ICON_STROKE * 12) / 24;
