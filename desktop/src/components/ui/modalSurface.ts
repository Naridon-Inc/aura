// modalSurface — the ONE centred-card recipe every hand-rolled overlay shares,
// the same trick `menuSurface` plays for flyouts.
//
// Most modals in the app go through `components/Dialog` (15 of them), which
// already fixes their shell. But a handful are deliberately bespoke — the ⌘/
// cheat-sheet, the What's-new moment, the phone-pairing QR, the small confirm
// prompts inside Settings — and each had drifted: three backdrop recipes
// (rgba(5,5,5,0.55)+blur(4px), +blur(3px), black/80+blur-sm), three radii
// (lg / xl / 8px), three shadows (shadow-xl / shadow-2xl / a raw box-shadow)
// and body padding anywhere from py-2 to py-5. Two of them back to back read as
// two different products.
//
// These constants ARE `components/Dialog`'s numbers: a bg-1 card with a hairline
// --color-line border, 8px radius, `--shadow-modal`, a px-4/py-2.5 header, a
// px-4/py-3 body and a px-4/py-2.5 right-aligned footer. A bespoke overlay
// either wears them (and matches every other dialog) or is an obvious outlier
// in review.
//
// Positioning, portalling and focus stay the caller's job — this is surface
// only.

/** Full-viewport dim behind a centred card. Add the flex/placement classes and
 *  a z-index; those differ per surface by design. */
export const MODAL_BACKDROP = "fixed inset-0 bg-black/55 backdrop-blur-[3px]";

/** The card itself. Caller adds its max-width. */
export const MODAL_PANEL =
  "w-full overflow-hidden rounded-lg border border-line bg-bg-1 shadow-[var(--shadow-modal)]";

/** Title row. 12.5px semibold title on the left, close affordance on the right. */
export const MODAL_HEADER =
  "flex items-center gap-2 border-b border-line-soft px-4 py-2.5";

/** The title itself — matches `Dialog`'s `txt-compact-small-plus`. */
export const MODAL_TITLE = "text-[12.5px] font-semibold text-text-1";

/** Scrollable content region. */
export const MODAL_BODY = "px-4 py-3";

/** Right-aligned action bar: secondary buttons first, the single primary last. */
export const MODAL_FOOTER =
  "flex items-center justify-end gap-2 border-t border-line-soft px-4 py-2.5";

/** Quiet "esc" hint that sits at the left of a footer (pair with MODAL_FOOTER's
 *  `justify-end` by giving the hint `mr-auto`). */
export const MODAL_ESC_HINT = "mr-auto text-[11px] text-text-4";
