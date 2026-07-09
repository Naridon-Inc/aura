// The Arc-Search-style start / search surface (the reference's "Tap Browse for
// Me" screen). Shown for a fresh tab or when the user taps the query pill: a
// big search field on top, then a suggestion list where every row offers both
// a plain search (tap the text) and an agentic "Browse for me" (tap the pill).
//
// Lives ABOVE the native webview hole — while it's mounted the hole isn't
// rendered, so the rail's reconcile hides the webview and this React surface
// owns the panel.

import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Glasses, Mic, Search, Sparkles } from "lucide-react";

export function ArcSearchOverlay({
  recents,
  engine,
  canClose,
  onSearch,
  onBrowseForMe,
  onClose,
}: {
  recents: string[];
  engine: "aura" | "google";
  canClose: boolean;
  onSearch: (query: string) => void;
  onBrowseForMe: (query: string) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const typed = q.trim();
  // The typed query leads the list; recents fill the rest (minus an exact dupe).
  const suggestions = typed
    ? [typed, ...recents.filter((r) => r.toLowerCase() !== typed.toLowerCase())]
    : recents;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!typed) return;
    if (engine === "aura") onBrowseForMe(typed);
    else onSearch(typed);
  };

  return (
    <div className="absolute inset-0 flex flex-col bg-bg-1">
      {/* Header: back (only when a page exists to return to) + hint. */}
      <div className="flex items-center gap-2 h-10 px-2 flex-shrink-0">
        {canClose && (
          <button
            type="button"
            onClick={onClose}
            title="Back to page"
            aria-label="Back to page"
            className="flex items-center justify-center w-7 h-7 rounded-full text-text-3 hover:text-text-1 hover:bg-bg-3 transition-colors"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
        )}
        <div className="flex items-center gap-1.5 text-[11px] text-text-3">
          <Sparkles className="h-3 w-3 text-accent" />
          Tap <span className="font-semibold text-text-2">Browse for me</span> for a faster answer
        </div>
      </div>

      {/* Search pill. */}
      <form onSubmit={submit} className="px-3 pt-1 pb-3 flex-shrink-0">
        <div className="flex items-center gap-2 h-11 px-3.5 rounded-2xl bg-bg-2 border border-line-soft focus-within:ring-1 focus-within:ring-accent transition-shadow">
          <Search className="h-4 w-4 text-text-4 flex-shrink-0" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search…"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            className="flex-1 min-w-0 bg-transparent text-[14px] text-text-1 placeholder:text-text-4 outline-none"
          />
          <Mic className="h-4 w-4 text-text-4 flex-shrink-0" />
          <Glasses className="h-4 w-4 text-text-4 flex-shrink-0" />
        </div>
      </form>

      {/* Suggestions. */}
      <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-3">
        {suggestions.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-2 px-6 text-center">
            <Search className="h-7 w-7 text-text-4" strokeWidth={1.5} />
            <div className="text-[12px] text-text-3">Search the web or ask anything</div>
          </div>
        ) : (
          suggestions.map((s, i) => (
            <SuggestionRow
              key={`${s}-${i}`}
              query={s}
              primary={i === 0 && typed.length > 0}
              onSearch={() => onSearch(s)}
              onBrowse={() => onBrowseForMe(s)}
            />
          ))
        )}
      </div>
    </div>
  );
}

function SuggestionRow({
  query,
  primary,
  onSearch,
  onBrowse,
}: {
  query: string;
  primary: boolean;
  onSearch: () => void;
  onBrowse: () => void;
}) {
  return (
    <div className="group flex items-center gap-2 pl-2.5 pr-1.5 py-1 rounded-xl hover:bg-bg-2 transition-colors">
      <button
        type="button"
        onClick={onSearch}
        className="flex items-center gap-2.5 flex-1 min-w-0 py-1.5 text-left"
      >
        <Search className="h-4 w-4 flex-shrink-0 text-text-4" />
        <span className="text-[13.5px] text-text-1 truncate">{query}</span>
      </button>
      <button
        type="button"
        onClick={onBrowse}
        className={`flex-shrink-0 h-7 px-3 rounded-full text-[11px] font-medium transition-colors ${
          primary
            ? "bg-accent text-white hover:bg-accent/90"
            : "bg-bg-3 text-text-2 hover:text-text-1 hover:bg-bg-3/80"
        }`}
      >
        Browse for me
      </button>
    </div>
  );
}
