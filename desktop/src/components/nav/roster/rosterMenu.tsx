// One menu, two doors. Every row in the workspace list offers its actions both
// on right-click (a ContextMenu on the row) and from the hover "…" button (a
// DropdownMenu in the row's actions slot). Each menu is written once, as a list
// of entries, and drawn by whichever door was used, so the two can never offer
// different things.
//
// Entries are built lazily, when a menu opens, not for every row on every
// render of the list. An item with a `key` also answers to that letter while
// its menu is open (R marks read, P pins), as its shortcut column says.

import type { KeyboardEvent, ReactElement, ReactNode } from "react";
import { Check, MoreHorizontal } from "lucide-react";
import { useAfterMenuClose, type AfterMenuClose } from "../../ui/after-menu-close";
import { Button } from "../../ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "../../ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "../../ui/dropdown-menu";

export type MenuEntry =
  | {
      kind: "item";
      label: string;
      icon: ReactNode;
      onSelect: () => void;
      shortcut?: string;
      title?: string;
      destructive?: boolean;
      disabled?: boolean;
      /** Printed under a disabled item: a greyed row with no reason reads as
       *  broken, and nobody hovers a thing they were told they can't use. */
      note?: string | null;
      /** The action moves focus somewhere of its own (an in-row rename field,
       *  a dialog, the emoji capture input), so it runs once the menu has
       *  closed, in place of the menu handing focus back to its trigger. */
      keepFocus?: boolean;
      /** The letter that picks this item while the menu is open. */
      key?: string;
      /** The current choice in a list of choices: drawn with a check. */
      checked?: boolean;
    }
  | { kind: "sub"; label: string; icon: ReactNode; entries: MenuEntry[] }
  | { kind: "separator" }
  | { kind: "label"; text: string; title?: string };

export type MenuEntries = () => MenuEntry[];

type ItemEntry = Extract<MenuEntry, { kind: "item" }>;

/** A plain letter picks the item that carries it, as a click would. Only in
 *  the menu itself, not in a submenu open beside it. */
function pickByKey(e: KeyboardEvent<HTMLElement>) {
  if (e.metaKey || e.ctrlKey || e.altKey || e.key.length !== 1) return;
  if (!e.currentTarget.contains(e.target as Node)) return;
  const hit = e.currentTarget.querySelector<HTMLElement>(
    `[data-menu-key="${e.key.toLowerCase()}"]:not([data-disabled])`,
  );
  if (!hit) return;
  e.preventDefault();
  e.stopPropagation();
  hit.click();
}

function ItemBody({ entry }: { entry: ItemEntry }) {
  return (
    <>
      {entry.icon}
      {entry.label}
      {entry.checked && <Check className="ui-roster-menu-check" aria-label="Current" />}
    </>
  );
}

function select(entry: ItemEntry, after: AfterMenuClose) {
  return () => (entry.keepFocus ? after.defer(entry.onSelect) : entry.onSelect());
}

function ContextEntries({ entries, after }: { entries: MenuEntries; after: AfterMenuClose }) {
  return (
    <>
      {entries().map((entry, i) => {
        if (entry.kind === "separator") return <ContextMenuSeparator key={i} />;
        if (entry.kind === "label")
          return (
            <ContextMenuLabel key={i} title={entry.title}>
              {entry.text}
            </ContextMenuLabel>
          );
        if (entry.kind === "sub")
          return (
            <ContextMenuSub key={i}>
              <ContextMenuSubTrigger>
                {entry.icon}
                {entry.label}
              </ContextMenuSubTrigger>
              <ContextMenuSubContent className="ui-roster-menu">
                <ContextEntries entries={() => entry.entries} after={after} />
              </ContextMenuSubContent>
            </ContextMenuSub>
          );
        return <ContextItem key={i} entry={entry} after={after} />;
      })}
    </>
  );
}

function ContextItem({ entry, after }: { entry: ItemEntry; after: AfterMenuClose }) {
  return (
    <>
      <ContextMenuItem
        variant={entry.destructive ? "destructive" : "default"}
        disabled={entry.disabled}
        title={entry.title}
        data-menu-key={entry.key}
        onSelect={select(entry, after)}
      >
        <ItemBody entry={entry} />
        {entry.shortcut && <ContextMenuShortcut>{entry.shortcut}</ContextMenuShortcut>}
      </ContextMenuItem>
      {entry.disabled && entry.note && <p className="ui-roster-menu-note">{entry.note}</p>}
    </>
  );
}

function DropdownEntries({ entries, after }: { entries: MenuEntries; after: AfterMenuClose }) {
  return (
    <>
      {entries().map((entry, i) => {
        if (entry.kind === "separator") return <DropdownMenuSeparator key={i} />;
        if (entry.kind === "label")
          return (
            <DropdownMenuLabel key={i} title={entry.title}>
              {entry.text}
            </DropdownMenuLabel>
          );
        if (entry.kind === "sub")
          return (
            <DropdownMenuSub key={i}>
              <DropdownMenuSubTrigger>
                {entry.icon}
                {entry.label}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="ui-roster-menu">
                <DropdownEntries entries={() => entry.entries} after={after} />
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          );
        return <DropdownItem key={i} entry={entry} after={after} />;
      })}
    </>
  );
}

function DropdownItem({ entry, after }: { entry: ItemEntry; after: AfterMenuClose }) {
  return (
    <>
      <DropdownMenuItem
        variant={entry.destructive ? "destructive" : "default"}
        disabled={entry.disabled}
        title={entry.title}
        data-menu-key={entry.key}
        onSelect={select(entry, after)}
      >
        <ItemBody entry={entry} />
        {entry.shortcut && <DropdownMenuShortcut>{entry.shortcut}</DropdownMenuShortcut>}
      </DropdownMenuItem>
      {entry.disabled && entry.note && <p className="ui-roster-menu-note">{entry.note}</p>}
    </>
  );
}

/** The right-click sheet on its own, for a row that composes its trigger with
 *  another one (the workspace row is also a hover-card trigger). */
export function RosterContextMenuContent({ entries }: { entries: MenuEntries }) {
  const after = useAfterMenuClose();
  return (
    <ContextMenuContent
      className="ui-roster-menu"
      onCloseAutoFocus={after.onCloseAutoFocus}
      onKeyDown={pickByKey}
    >
      <ContextEntries entries={entries} after={after} />
    </ContextMenuContent>
  );
}

/** Right-click on `children` opens the menu. `children` must be one element
 *  that takes a ref (the row's own wrapper). */
export function RosterContextMenu({
  entries,
  children,
}: {
  entries: MenuEntries;
  children: ReactElement;
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <RosterContextMenuContent entries={entries} />
    </ContextMenu>
  );
}

/** The hover "…" button in a row's actions slot or a section header. */
export function RosterActionsMenu({
  entries,
  "aria-label": label,
  align = "start",
}: {
  entries: MenuEntries;
  "aria-label": string;
  align?: "start" | "end";
}) {
  const after = useAfterMenuClose();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="iconXs" variant="ghost" aria-label={label}>
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        className="ui-roster-menu"
        align={align}
        onCloseAutoFocus={after.onCloseAutoFocus}
        onKeyDown={pickByKey}
      >
        <DropdownEntries entries={entries} after={after} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
