// menuSurface — the ONE Medusa-style flyout recipe every dropdown in the app
// shares. Before this, three menu families had drifted apart: the Radix
// DropdownMenu (calm elevated flyout), the ContextMenu (still raw shadcn with a
// blue accent-wash on hover), and a dozen hand-rolled popovers each with their
// own padding/radius/colours. Exporting the class recipes from one place makes
// that drift structurally impossible — a menu either uses these constants (and
// looks like every other menu) or it is an obvious outlier in review.
//
// The look, straight from @medusajs/ui's DropdownMenu: a slightly-elevated
// surface (bg-1 + hairline line-soft ring + layered --shadow-flyout), 8px
// radius, tight 4px panel padding; rows are single-line, 13px, quiet text-2 that
// lifts to text-1 over a neutral bg-2 wash (accent is reserved for the ✓/●
// indicators — this is chrome, not a primary affordance). Leading glyphs are
// normalised to 16px so every row's icon column lines up.
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

/** The floating panel surface — elevated bg-1, hairline ring, 8px radius, tight
 *  4px padding, flyout shadow. Caller adds width + positioning. */
export const MENU_PANEL =
  "z-50 min-w-[9rem] overflow-hidden rounded-lg border border-line-soft bg-bg-1 p-1 text-text-1 shadow-[var(--shadow-flyout)]";

/** One compact row: 13px, quiet by default, neutral bg-2 wash on hover / keyboard
 *  highlight, 16px leading glyphs. Works for both Radix items (data-[highlighted])
 *  and hand-rolled <button> rows (hover:). */
export const MENU_ROW =
  "relative flex w-full cursor-default select-none items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[13px] leading-5 text-text-2 outline-none transition-colors " +
  "hover:bg-bg-2 hover:text-text-1 focus:bg-bg-2 focus:text-text-1 data-[highlighted]:bg-bg-2 data-[highlighted]:text-text-1 " +
  "disabled:pointer-events-none disabled:opacity-50 data-[disabled]:pointer-events-none data-[disabled]:opacity-50 " +
  "[&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0";

/** Destructive row tint — inks the label red and reddens the hover wash. Append
 *  after MENU_ROW. */
export const MENU_ROW_DANGER =
  "text-red hover:bg-red/10 hover:text-red focus:bg-red/10 focus:text-red data-[highlighted]:bg-red/10 data-[highlighted]:text-red";

/** Uppercase section caption. */
export const MENU_LABEL =
  "px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-text-4";

/** Hairline rule, bled full-width past the panel's 4px padding. */
export const MENU_SEP = "-mx-1 my-1 h-px bg-line-soft";

/** Right-aligned keyboard-shortcut hint. */
export const MENU_SHORTCUT = "ml-auto text-[11px] tracking-wider text-text-4";
