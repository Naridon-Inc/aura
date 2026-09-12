// menuSurface — the ONE flyout recipe every dropdown in the app shares, and
// it is the console's recipe: the class strings come from
// aura-shared/ui/FinderList (FINDER), the panel every picker and menu in the
// web console drops out of its sidebar on. A Radix DropdownMenu or ContextMenu
// here and a FinderMenu there are one look by construction.
//
// The look: Medusa Popover's surface (bg-ui-bg-base + elevation-flyout, 6px
// radius), no panel padding — rows run edge to edge at 12.5px with 6px
// vertical rhythm, text-2 at rest lifting to text-1 under a translucent
// state-hover wash; hairline rules bleed full width; section captions are
// 10.5px uppercase; the accent is reserved for the ✓/● indicators. Leading
// glyphs are normalised to 13px so every row's icon column lines up.
//
// Consumers: the Radix wrappers (dropdown-menu / context-menu) append MENU_ANIM
// for the open/close transitions; hand-rolled <button> menus use the same
// MENU_ROW (its hover: variants cover them, the data-[highlighted]: variants
// cover Radix). Positioning stays the caller's job.

import { FINDER } from "@shared/ui/FinderList";

/** Radix open/close + slide-by-side transitions. Append to MENU_PANEL on Radix
 *  content; omit for statically-positioned hand-rolled panels. */
export const MENU_ANIM =
  "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 " +
  "data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 " +
  "data-[side=bottom]:slide-in-from-top-1 data-[side=left]:slide-in-from-right-1 data-[side=right]:slide-in-from-left-1 data-[side=top]:slide-in-from-bottom-1";

/** The floating panel: the Medusa Popover surface the console's finder panels
 *  sit on, with 4px of vertical air and no horizontal padding, so rows and
 *  rules run to the edge as they do there. Caller adds width + positioning. */
export const MENU_PANEL =
  "z-50 min-w-[10rem] overflow-hidden rounded-lg bg-ui-bg-base py-1 text-text-1 shadow-elevation-flyout";

/** One row, the finder row: works for Radix items (data-[highlighted]) and
 *  hand-rolled <button> rows (hover:) alike. */
export const MENU_ROW =
  `relative ${FINDER.row} cursor-default select-none ` +
  "hover:bg-state-hover hover:text-text-1 focus:bg-state-hover focus:text-text-1 data-[highlighted]:bg-state-hover data-[highlighted]:text-text-1 " +
  "disabled:pointer-events-none disabled:opacity-50 data-[disabled]:pointer-events-none data-[disabled]:opacity-50 " +
  "[&_svg]:pointer-events-none [&_svg]:size-[13px] [&_svg]:shrink-0 [&_svg]:text-text-4";

/** Row padding for anything that reserves the indicator gutter — checkbox and
 *  radio items, and `inset` items that have to line up beneath them. 30px
 *  clears a 14px indicator and is the single number that decides where every
 *  label in every menu starts. */
export const MENU_ROW_INDICATED = "pl-[30px] pr-2.5";

/** The absolutely-positioned indicator slot itself, centred in the gutter that
 *  MENU_ROW_INDICATED reserves. Exported so the ✓ and the ● can never drift
 *  apart from the padding that makes room for them. */
export const MENU_INDICATOR =
  "absolute left-2.5 flex h-3.5 w-3.5 items-center justify-center";

/** Destructive row tint — inks the label red and keeps it red under the wash.
 *  Append after MENU_ROW. */
export const MENU_ROW_DANGER =
  `${FINDER.rowDanger} hover:text-red focus:text-red data-[highlighted]:text-red [&_svg]:text-red`;

/** Uppercase section caption. */
export const MENU_LABEL = FINDER.label;

/** Hairline rule, full width — the panel has no horizontal padding to bleed past. */
export const MENU_SEP = FINDER.sep;

/** Right-aligned keyboard-shortcut hint. */
export const MENU_SHORTCUT = `ml-auto ${FINDER.trailing}`;
