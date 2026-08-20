// WorkingDiffPane — the right side of the Changes tab when a file is picked.
// Shows that one file's uncommitted diff so you review a change without leaving
// the Git view, plus an "Open in editor" door for the full editor. Two ways to
// read it: the calm inline (unified) view, or side-by-side (split) — the same
// shared SplitDiff every git surface uses, with the choice persisted so it
// matches the Trace Changes pane. The plain-language caption names the file in
// human terms; the line counts come straight from the diff git produced — real
// data only.

import { useEffect, useMemo, useState } from "react";
import { ArrowUpRight, FileText } from "lucide-react";

import { api } from "../../lib/api";
import { Button } from "../ui/button";
import { UnifiedDiff } from "../diff/UnifiedDiff";
import { SplitDiff, materializeSides } from "../diff/SplitDiff";
import { Churn } from "../diff/Churn";
import { AsciiSpinner } from "../ui/ascii-spinner";
import {
  getDiffView,
  setDiffView,
  subscribeDiffView,
  type DiffView,
} from "../../lib/diffViewPref";
import {
  getIgnoreWhitespace,
  setIgnoreWhitespace,
  subscribeIgnoreWhitespace,
} from "../../lib/ignoreWhitespacePref";

export function WorkingDiffPane({
  repoRoot,
  path,
  onOpenInEditor,
}: {
  repoRoot: string;
  path: string;
  onOpenInEditor: () => void;
}) {
  const [diff, setDiff] = useState<string | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  // Split/unified is the one shared, persisted preference, in sync with the
  // Trace Changes pane and surviving reloads.
  const [mode, setMode] = useState<DiffView>(getDiffView);
  useEffect(() => subscribeDiffView(setMode), []);
  // Whitespace-hiding shares one persisted toggle across all diff panes.
  const [ignoreWs, setIgnoreWs] = useState(getIgnoreWhitespace);
  useEffect(() => subscribeIgnoreWhitespace(setIgnoreWs), []);

  useEffect(() => {
    let alive = true;
    setState("loading");
    setDiff(null);
    // Listen for the post-commit / post-checkout signal so a save or branch
    // switch re-reads this file's working diff instead of keeping a stale one.
    const reload = () => {
      api
        .gitDiff(repoRoot, path)
        .then((d) => {
          if (!alive) return;
          setDiff(d);
          setState("ready");
        })
        .catch(() => {
          if (alive) setState("error");
        });
    };
    reload();
    window.addEventListener("aura:git-changed", reload);
    return () => {
      alive = false;
      window.removeEventListener("aura:git-changed", reload);
    };
  }, [repoRoot, path]);

  const stats = useMemo(() => countDiff(diff ?? ""), [diff]);
  const name = baseName(path);
  const dir = path.slice(0, path.length - name.length).replace(/\/$/, "");

  const hasDiff = !!diff && diff.trim().length > 0;
  // A one-sided diff (a brand-new or deleted file) has nothing to compare in a
  // split, so the toggle hides and we render unified.
  const sides = useMemo(
    () => (hasDiff ? materializeSides(diff as string) : null),
    [hasDiff, diff],
  );
  const splitDisabled = sides?.oneSided ?? false;
  const effectiveMode: DiffView = splitDisabled ? "unified" : mode;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-2.5 border-b border-line-soft px-4 py-2.5">
        <FileText size={14} className="shrink-0 text-text-3" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-base font-medium text-text-1" title={path}>
            {name}
          </div>
          {dir && (
            <div className="truncate text-xs text-text-4" title={path}>
              {dir}
            </div>
          )}
        </div>
        <Churn additions={stats.add} deletions={stats.del} />
        {hasDiff && !splitDisabled && (
          <span className="inline-flex shrink-0 items-center overflow-hidden rounded border border-line-soft">
            <button
              type="button"
              onClick={() => setDiffView("split")}
              className={
                "h-5 px-1.5 text-xs " +
                (effectiveMode === "split"
                  ? "bg-bg-2 text-text-1"
                  : "text-text-3 hover:text-text-1")
              }
              title="Side-by-side"
            >
              Split
            </button>
            <span className="h-3 w-px bg-line-soft" />
            <button
              type="button"
              onClick={() => setDiffView("unified")}
              className={
                "h-5 px-1.5 text-xs " +
                (effectiveMode === "unified"
                  ? "bg-bg-2 text-text-1"
                  : "text-text-3 hover:text-text-1")
              }
              title="Inline (unified)"
            >
              Inline
            </button>
          </span>
        )}
        {hasDiff && (
          <button
            type="button"
            onClick={() => setIgnoreWhitespace(!ignoreWs)}
            aria-pressed={ignoreWs}
            title={ignoreWs ? "Whitespace-only changes hidden" : "Hide whitespace-only changes"}
            className={
              "h-5 shrink-0 rounded border px-1.5 text-xs " +
              (ignoreWs
                ? "border-[var(--color-accent)] bg-bg-2 text-[var(--color-accent)]"
                : "border-line-soft text-text-3 hover:text-text-1")
            }
          >
            WS
          </button>
        )}
        <Button size="xs" variant="subtle" onClick={onOpenInEditor}>
          Open in editor
          <ArrowUpRight size={12} />
        </Button>
      </header>

      <div className="flex-1 min-h-0 overflow-hidden">
        {state === "loading" ? (
          <div className="flex items-center gap-1.5 px-4 py-4 text-sm text-text-4">
            <AsciiSpinner className="text-2xs" />
            <span>Reading this change…</span>
          </div>
        ) : state === "error" ? (
          <div className="px-4 py-4 text-sm text-text-4">
            Couldn’t read this file’s changes.
          </div>
        ) : !hasDiff ? (
          <div className="px-4 py-6 text-base leading-relaxed text-text-4">
            No line-by-line changes to show here. This file is new or already
            staged whole. Open it in the editor to see its contents.
          </div>
        ) : effectiveMode === "split" ? (
          <div className="h-full min-h-0">
            <SplitDiff diff={diff as string} path={path} />
          </div>
        ) : (
          <div className="h-full overflow-y-auto">
            <UnifiedDiff diff={diff as string} />
          </div>
        )}
      </div>
    </div>
  );
}

/** Count added/removed lines from a unified diff, ignoring the +++/--- file
 *  headers so the tally matches what the reader sees. */
function countDiff(diff: string): { add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) add++;
    else if (line.startsWith("-")) del++;
  }
  return { add, del };
}

function baseName(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? p : p.slice(i + 1);
}
