// Find-in-terminal overlay (VS Code parity). A small floating box pinned
// to the top-right of the terminal body: a query field, a live "N of M"
// match readout, prev/next navigation, and Aa / .* / W toggles for
// case-sensitive / regex / whole-word. Esc closes it.
//
// It drives the live xterm SearchAddon through the exported helpers in
// `Terminal.tsx`, keyed by the active terminal's `termId`. The highlight and
// active-match colors are the SearchAddon decorations declared in
// `Terminal.tsx` — those live inside the terminal canvas and are part of its
// own palette, not the app's design tokens.

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUp, ArrowDown, X } from "lucide-react";
import {
  terminalFindNext,
  terminalFindPrevious,
  clearTerminalFind,
  onTerminalFindResults,
  type TerminalFindOptions,
} from "../Terminal";

type Props = {
  /** The terminal the search runs against. When it changes the query is
   *  re-run so the highlight follows the focused pane. */
  termId: string | null;
  onClose: () => void;
};

export function TerminalFindWidget({ termId, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [opts, setOpts] = useState<TerminalFindOptions>({});
  const [count, setCount] = useState<{ index: number; total: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus the field as soon as the widget mounts so the user can type
  // straight after ⌘F.
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  // Subscribe to the addon's result-count stream for the live "N of M".
  // The addon reports a 0-based resultIndex (or -1 when nothing matches).
  useEffect(() => {
    if (!termId) return;
    const off = onTerminalFindResults(termId, ({ resultIndex, resultCount }) => {
      setCount(
        resultCount > 0
          ? { index: resultIndex >= 0 ? resultIndex + 1 : 0, total: resultCount }
          : null,
      );
    });
    return off;
  }, [termId]);

  const runNext = useCallback(
    (back = false) => {
      if (!termId) return;
      if (!query) {
        clearTerminalFind(termId);
        setCount(null);
        return;
      }
      if (back) terminalFindPrevious(termId, query, opts);
      else terminalFindNext(termId, query, opts);
    },
    [termId, query, opts],
  );

  // Re-run on query / option / target change so the highlight stays live
  // as the user types or flips a toggle.
  useEffect(() => {
    runNext(false);
  }, [runNext]);

  function close() {
    if (termId) clearTerminalFind(termId);
    onClose();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "Enter") {
      e.preventDefault();
      runNext(e.shiftKey);
    }
  }

  return (
    <div
      className="absolute top-1.5 right-2 z-20 flex items-center gap-1 rounded-lg bg-bg-1 border border-line-soft px-1.5 py-1 shadow-[var(--shadow-flyout)]"
      onKeyDown={onKeyDown}
    >
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Find"
        spellCheck={false}
        className="h-6 w-44 rounded bg-bg-content px-2 text-sm text-text-1 placeholder:text-text-4 outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent/50"
      />
      <span className="w-20 shrink-0 truncate text-center text-xs tabular-nums text-text-4">
        {query ? (count ? `${count.index} of ${count.total}` : "No results") : ""}
      </span>
      <Toggle active={!!opts.caseSensitive} label="Match Case" onClick={() => setOpts((o) => ({ ...o, caseSensitive: !o.caseSensitive }))}>
        Aa
      </Toggle>
      <Toggle active={!!opts.wholeWord} label="Match Whole Word" onClick={() => setOpts((o) => ({ ...o, wholeWord: !o.wholeWord }))}>
        W
      </Toggle>
      <Toggle active={!!opts.regex} label="Match a pattern" onClick={() => setOpts((o) => ({ ...o, regex: !o.regex }))}>
        .*
      </Toggle>
      <FindBtn label="Previous Match" onClick={() => runNext(true)}>
        <ArrowUp className="h-3.5 w-3.5" />
      </FindBtn>
      <FindBtn label="Next Match" onClick={() => runNext(false)}>
        <ArrowDown className="h-3.5 w-3.5" />
      </FindBtn>
      <FindBtn label="Close" onClick={close}>
        <X className="h-3.5 w-3.5" />
      </FindBtn>
    </div>
  );
}

function FindBtn({
  children,
  label,
  onClick,
}: {
  children: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className="h-6 w-6 grid place-items-center rounded text-text-4 transition-colors hover:text-text-2 hover:bg-state-hover"
    >
      {children}
    </button>
  );
}

function Toggle({
  children,
  label,
  active,
  onClick,
}: {
  children: React.ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      className={[
        "h-6 min-w-6 px-1 grid place-items-center rounded text-xs font-medium leading-none transition-colors",
        active
          ? "bg-accent/10 text-accent hover:bg-accent/15"
          : "text-text-4 hover:text-text-2 hover:bg-state-hover",
      ].join(" ")}
    >
      {children}
    </button>
  );
}
