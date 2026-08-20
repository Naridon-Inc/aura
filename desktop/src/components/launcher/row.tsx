// The launcher's row — one shape for everything the launcher can put in a pane.
//
// It sits in its own file because there is now more than one source of rows:
// what you can start, what is already open or running, and the sessions you
// ran here before. They share a list, a search, a cursor and one Enter key, so
// they have to share a shape; a second list with its own keyboard model is how
// "↑↓ then Enter" quietly stops working halfway down a panel.

import { useEffect, useRef, type ReactNode } from "react";

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
  return (
    <div className="py-1">
      <div className="px-3 pb-0.5 pt-1 section-label">{label}</div>
      {children}
    </div>
  );
}

export function PickRow({ row, active }: { row: Row; active: boolean }) {
  const el = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (active) el.current?.scrollIntoView({ block: "nearest" });
  }, [active]);
  return (
    <button
      ref={el}
      type="button"
      onClick={row.onPick}
      title={row.running ? `Running now in ${row.sub}` : row.sub || undefined}
      className={`w-full flex items-center gap-2 px-3 h-8 text-left transition-colors ${
        active ? "bg-state-selected" : "hover:bg-state-hover"
      }`}
    >
      <span className="w-4 h-4 flex items-center justify-center flex-shrink-0 text-text-3">
        {row.icon}
      </span>
      <span className="text-sm text-text-1 truncate">{row.label}</span>
      {row.sub ? (
        <span className="ml-auto flex items-center gap-1.5 flex-shrink-0 text-2xs text-text-5">
          {/* A live agent's dot, not the word "running": the project it runs in
              is the fact this row can't do without — cross-project listing is
              the whole reason it exists — and both don't fit. Green = status,
              per the app's colour rules; never the accent. */}
          {row.running ? (
            <span
              role="img"
              aria-label="Running now"
              className="size-1.5 rounded-full bg-accent-green"
            />
          ) : null}
          <span className="truncate max-w-[110px]">{row.sub}</span>
        </span>
      ) : null}
    </button>
  );
}
