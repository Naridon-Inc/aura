// menuSurface — the ONE Medusa-style flyout recipe every dropdown in the app
// shares. Before this, three menu families had drifted apart: the Radix
// DropdownMenu (calm elevated flyout), the ContextMenu (still raw shadcn with a
// blue accent-wash on hover), and a dozen hand-rolled popovers each with their
// own padding/radius/colours. Exporting the class recipes from one place makes
// that drift structurally impossible — a menu either uses these constants (and
// looks like every other menu) or it is an obvious outlier in review.
//
// The look: a genuinely elevated surface (bg-float + hairline line-soft ring +
// layered --shadow-flyout), 6px radius, 6px panel padding; rows are single-line
// at the ladder's base size, full-strength text-1, lifting under a transparent
// wash (accent is reserved for the ✓/● indicators — this is chrome, not a
// primary affordance). Leading glyphs are normalised to 16px so every row's
// icon column lines up.
//
// Consumers: the Radix wrappers (dropdown-menu / context-menu) append MENU_ANIM
// for the open/close transitions; hand-rolled <button> menus use the same
// MENU_ROW (its hover: variants cover them, the data-[highlighted]: variants
// cover Radix). Positioning stays the caller's job.

/** Radix open/close + slide-by-side transitions. Append to MENU_PANEL on Radix
 *  content; omit for statically-positioned hand-rolled panels. */
export const MENU_ANIM =
  "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 " +
  "data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 " +
  "data-[side=bottom]:slide-in-from-top-1 data-[side=left]:slide-in-from-right-1 data-[side=right]:slide-in-from-left-1 data-[side=top]:slide-in-from-bottom-1";

/** The floating panel surface — elevated bg-float, hairline ring, 8px radius,
 *  6px padding, flyout shadow. Caller adds width + positioning.
 *
 *  This used to be bg-1, which is the *chrome* colour and the darkest surface
 *  in the app — so every dropdown opened over the content area (bg-0) was
 *  darker than the thing it floated above, and sank into the page instead of
 *  rising off it. A panel that casts a shadow has to be lighter than its
 *  ground, or the shadow is arguing with the fill. */
export const MENU_PANEL =
  "z-50 min-w-[9rem] overflow-hidden rounded-lg border border-line-soft bg-bg-float p-1.5 text-text-1 shadow-[var(--shadow-flyout)]";

/** One row: 36px tall, full-strength label, a transparent lift on hover /
 *  keyboard highlight, 16px leading glyphs. Works for both Radix items
 *  (data-[highlighted]) and hand-rolled <button> rows (hover:).
 *
 *  The hover is state-hover, not bg-2. bg-2 is a fixed colour, so it only ever
 *  looked right on one panel — it was a lift on the old bg-1 panel and would be
 *  a *dip* on the elevated bg-float one. Lifting whatever is underneath by a
 *  fixed amount means the row reads the same on every surface it lands on,
 *  including the five themes that repaint the panel entirely.
 *
 *  The label is text-1 at rest, not text-2. A menu is a list of things you can
 *  do, all of them equally available until one is disabled — dimming every row
 *  until the pointer arrives made the panel read as waiting rather than
 *  offering, and put the only legible row wherever the mouse happened to be. */
export const MENU_ROW =
  "relative flex min-h-9 w-full cursor-default select-none items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-base leading-5 text-text-1 outline-none transition-colors " +
  "hover:bg-state-hover focus:bg-state-hover data-[highlighted]:bg-state-hover " +
  "disabled:pointer-events-none disabled:opacity-50 data-[disabled]:pointer-events-none data-[disabled]:opacity-50 " +
  "[&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0";

/** Row padding for anything that reserves the indicator gutter — checkbox and
 *  radio items, and `inset` items that have to line up beneath them. 36px clears
 *  a 14px indicator with real air on both sides, and is the single number that
 *  decides where every label in every menu starts. */
export const MENU_ROW_INDICATED = "pl-9 pr-2";

/** The absolutely-positioned indicator slot itself, centred in the gutter that
 *  MENU_ROW_INDICATED reserves. Exported so the ✓ and the ● can never drift
 *  apart from the padding that makes room for them. */
export const MENU_INDICATOR =
  "absolute left-3 flex h-3.5 w-3.5 items-center justify-center";

/** Destructive row tint — inks the label red and reddens the hover wash. Append
 *  after MENU_ROW. */
export const MENU_ROW_DANGER =
  "text-red hover:bg-red/10 hover:text-red focus:bg-red/10 focus:text-red data-[highlighted]:bg-red/10 data-[highlighted]:text-red";

/** Uppercase section caption. */
export const MENU_LABEL =
  "px-2 py-1.5 text-2xs font-semibold uppercase tracking-wider text-text-4";

/** Hairline rule, bled full-width past the panel's 6px padding. */
export const MENU_SEP = "-mx-1.5 my-1 h-px bg-line-soft";

/** Right-aligned keyboard-shortcut hint. */
export const MENU_SHORTCUT = "ml-auto text-xs tracking-wider text-text-4";
