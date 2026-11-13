// PrFileMentionPicker — "@" in a review comment, over the files this pull
// request changed.
//
// Same idea as the collab composer's people picker: the "@word" the caret is
// in becomes a query, arrow keys move, Enter/Tab picks, Esc closes. That
// picker's rows are people (face, presence, hand-over), so a file row needs
// its own list — but the caret/query logic (`mentionQueryAt`) and the
// composer's suggestions panel are the shared ones, imported, not copied.
// Picking a file inserts the path in backticks so it reads as code on GitHub.

import { useEffect, useMemo, useState } from "react";
import type { JSX } from "react";

import { cn } from "../../lib/utils";
import { MENU_LABEL } from "../ui/menuSurface";
import { LoadingState } from "../ui/state";
import "../ui/file-mentions.css";

/** Rank the PR's files against what was typed after the "@". Basename hits
 *  first (that is what people remember), then any path substring; no query
 *  shows the whole list in PR order. PURE for the sake of the test. */
export function rankFileMentions(files: readonly string[], query: string, limit = 8): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return files.slice(0, limit);
  const base: string[] = [];
  const path: string[] = [];
  for (const f of files) {
    const lower = f.toLowerCase();
    const name = lower.slice(lower.lastIndexOf("/") + 1);
    if (name.includes(q)) base.push(f);
    else if (lower.includes(q)) path.push(f);
  }
  return [...base, ...path].slice(0, limit);
}

/** The text a picked file becomes in the comment: the backticked path plus
 *  a trailing space so typing continues naturally. */
export function fileMentionText(path: string): string {
  return `\`${path}\` `;
}

export type PrFileMentionPickerProps = {
  /** Paths the pull request changed, PR order. */
  files: readonly string[];
  /** Text typed after the "@". */
  query: string;
  onPick: (path: string) => void;
  onClose: () => void;
  /** File list still arriving from `gh`. */
  loading?: boolean;
  className?: string;
};

export function PrFileMentionPicker({
  files,
  query,
  onPick,
  onClose,
  loading = false,
  className,
}: PrFileMentionPickerProps): JSX.Element {
  const matches = useMemo(() => rankFileMentions(files, query), [files, query]);

  const [active, setActive] = useState(0);
  useEffect(() => {
    setActive(0);
  }, [query]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      if (matches.length === 0) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive((i) => (i + 1) % matches.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive((i) => (i - 1 + matches.length) % matches.length);
      } else if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        e.stopPropagation();
        const f = matches[Math.min(active, matches.length - 1)];
        if (f) onPick(f);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [matches, active, onPick, onClose]);

  return (
    <div
      role="listbox"
      aria-label="Mention a file this pull request changed"
      className={cn("ui-composer-suggestions ui-file-mentions", className)}
    >
      {loading && files.length === 0 ? (
        <LoadingState
          label="Loading the files this pull request changed…"
          className="ui-file-mentions-state"
        />
      ) : matches.length === 0 ? (
        <div className="ui-file-mentions-state">
          {files.length === 0
            ? "This pull request has no changed files to mention."
            : `No changed file matches “${query}”.`}
        </div>
      ) : (
        <>
          <div className={MENU_LABEL}>Files in this pull request</div>
          {matches.map((f, i) => {
            const cut = f.lastIndexOf("/");
            return (
              <button
                key={f}
                type="button"
                role="option"
                aria-selected={i === active}
                tabIndex={-1}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => {
                  // Keep the textarea focused so the insert lands at the caret.
                  e.preventDefault();
                  onPick(f);
                }}
              >
                <span>{f.slice(cut + 1)}</span>
                {cut > 0 && <small>{f.slice(0, cut)}</small>}
              </button>
            );
          })}
        </>
      )}
      <div className="ui-file-mentions-hint">Enter to insert the path · Esc to close</div>
    </div>
  );
}
