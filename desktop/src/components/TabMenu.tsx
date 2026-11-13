// What you can do to a tab, and the two ways to reach it.
//
// Every tab kind gets the same declarative item list — split, move, rename,
// close, plus whatever the live surface behind it contributes — and this file
// owns the list's type and both of its renderers: the right-click menu and the
// visible ⋯ button.
//
// It exists because there were three copies of the type (one here-named in
// Tabs.tsx, one called AgentTabMenuItem in AgentSurface.tsx, and the structural
// twin the per-pane strip typed its own builder against) and two copies of the
// right-click renderer, while the ⋯ button had exactly one caller — the global
// strip, which is not the strip most people are looking at.

import type { ReactNode } from "react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "./ui/dropdown-menu";
import { ContextMenuItem, ContextMenuSeparator } from "./ui/context-menu";
import "./ui/new-tab.css";

export type TabMenuItem =
  | { kind: "separator" }
  | {
      kind: "item";
      label: string;
      onSelect: () => void;
      disabled?: boolean;
      tone?: "danger";
      /** The chord that does the same thing, printed at the row's right
       *  edge the way the library's tab menu prints ⌘W. */
      shortcut?: string;
    };

/** The item list rendered as right-click menu children. Returns the nodes, not
 *  a `ContextMenuContent`, so a caller can set its own width/alignment. */
export function tabContextItems(items: TabMenuItem[]): ReactNode {
  return items.map((item, i) =>
    item.kind === "separator" ? (
      <ContextMenuSeparator key={`sep-${i}`} />
    ) : (
      <ContextMenuItem
        key={`${item.label}-${i}`}
        disabled={item.disabled}
        variant={item.tone === "danger" ? "destructive" : "default"}
        onSelect={item.onSelect}
      >
        {item.label}
        {item.shortcut && <span className="ui-menu-shortcut">{item.shortcut}</span>}
      </ContextMenuItem>
    ),
  );
}

/** Visible per-tab "⋯ more" button. Sits just before the tab's close ×
 *  (hover-revealed, same as the ×) and opens the tab's FULL action list on
 *  CLICK — splits, move to pane, rename, the agent·manager pane actions,
 *  close.
 *
 *  Why a click button and not just right-click: the pane header bar that used
 *  to carry these was dropped (bccf3b49), leaving right-click as the only path
 *  — and while these tabs were HTML5-draggable the webview could swallow that
 *  menu, so it was both invisible AND unreliable. The per-pane strip had
 *  *only* that path until this button reached it. Same item list either way.
 *
 *  Stops propagation on mousedown so opening it never activates / drags the
 *  tab. Renders nothing when the only action would be Close — the × already
 *  covers that. */
export function TabMoreButton({
  items,
  reserveSpace = true,
}: {
  items: TabMenuItem[];
  /** Whether the button holds its 16px whether or not you are hovering.
   *  True on the roomy global strip. False where tabs are tight: the
   *  per-pane strip already reserves a slot for the × and a slot for the live
   *  status mark, and a third permanent 16px of nothing pushed a whole tab off
   *  the end of the row. Costs nothing at rest, grows the hovered tab. */
  reserveSpace?: boolean;
}) {
  if (items.filter((it) => it.kind === "item").length <= 1) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          onMouseDown={(e) => e.stopPropagation()}
          className={`w-4 h-4 items-center justify-center rounded text-text-4 hover:text-text-1 hover:bg-state-hover flex-shrink-0 ${
            reserveSpace
              ? "flex opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100"
              : "hidden group-hover:flex data-[state=open]:flex"
          }`}
          title="Tab actions. Split, move, rename, close"
        >
          <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
            <circle cx="4" cy="8" r="1.3" />
            <circle cx="8" cy="8" r="1.3" />
            <circle cx="12" cy="8" r="1.3" />
          </svg>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="ui-tab-menu">
        {items.map((item, i) =>
          item.kind === "separator" ? (
            <DropdownMenuSeparator key={`sep-${i}`} />
          ) : (
            <DropdownMenuItem
              key={`${item.label}-${i}`}
              disabled={item.disabled}
              onSelect={item.onSelect}
              variant={item.tone === "danger" ? "destructive" : "default"}
            >
              {item.label}
              {item.shortcut && <span className="ui-menu-shortcut">{item.shortcut}</span>}
            </DropdownMenuItem>
          ),
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
