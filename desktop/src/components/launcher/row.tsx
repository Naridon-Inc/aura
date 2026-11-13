// The launcher's row — one shape for everything the launcher can put in a pane.
//
// It sits in its own file because there is now more than one source of rows:
// what you can start, what is already open or running, and the sessions you
// ran here before. They share a list, a search, a cursor and one Enter key, so
// they have to share a shape; a second list with its own keyboard model is how
// "↑↓ then Enter" quietly stops working halfway down a panel.

import type { ReactNode } from "react";

import { CommandGroup, CommandItem } from "../ui/command";
import "../ui/command-palette.css";
import "../ui/launcher.css";

/** One pickable row — something to start, something already open or running
 *  that moves into the pane, or a past session to resume. */
export type Row = {
  key: string;
  label: string;
  /** Right-hand detail: the project a row comes from, the folder for a file,
   *  how long ago a session last spoke. */
  sub: string;
  /** What kind of thing this is, in the reader's words. Part of the search
   *  haystack, which is how one search box replaced the kind chips. */
  kind: string;
  icon: ReactNode;
  /** A live agent with no tab here yet; picking it adopts the session. */
  running?: boolean;
  onPick: () => void;
};

export function Group({ label, children }: { label: string; children: ReactNode }) {
  return <CommandGroup heading={label}>{children}</CommandGroup>;
}

/** A row in the shared command list. The list owns the cursor, ↑↓ and Enter,
 *  so every source of rows moves under the same keys. */
export function PickRow({ row }: { row: Row }) {
  return (
    <CommandItem
      value={row.key}
      onSelect={row.onPick}
      className="ui-launcher-row"
      title={row.running ? `Running now in ${row.sub}` : row.sub || undefined}
    >
      <span className="ui-launcher-row-icon">{row.icon}</span>
      <span className="ui-command-palette-label">{row.label}</span>
      {row.sub ? (
        <span className="ui-command-palette-detail ui-launcher-row-sub">
          {/* A live agent's dot, not the word "running": the project it runs
              in is the fact this row can't do without — cross-project listing
              is the whole reason it exists — and both don't fit. */}
          {row.running ? (
            <span role="img" aria-label="Running now" className="ui-launcher-live" />
          ) : null}
          <span>{row.sub}</span>
        </span>
      ) : null}
    </CommandItem>
  );
}
