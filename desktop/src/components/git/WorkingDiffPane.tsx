// WorkingDiffPane — the right side of the Changes tab when a file is picked,
// in a local workspace and a cloud one alike. Shows that one file's
// uncommitted diff in the shared file view, so you review a change without
// leaving the Git view. The header carries the diff's tools (Discard changes,
// Unified / Split, whitespace, wrapping — see DiffPaneTools), the file view's
// own Copy, which copies the file as it is now, and an "Open in editor" door.
// The line counts come straight from the diff git produced — real data only.

import { useEffect, useMemo, useState } from "react";
import { ArrowUpRight, Pilcrow } from "lucide-react";

import * as work from "../../lib/place/workApi";
import { materializeSides } from "../../lib/diffSides";
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
import { getWrapLines, setWrapLines, subscribeWrapLines } from "../../lib/wrapLinesPref";
import { SplitDiff } from "../diff/SplitDiff";
import { UnifiedDiff } from "../diff/UnifiedDiff";
import { CommentNav } from "../diff/review/CommentNav";
import { EntireFileView } from "../diff/review/EntireFileView";
import { tableNavSource } from "../diff/review/navSources";
import { useDiffReview, useViewed } from "../diff/review/useDiffReview";
import { useUnifiedReview } from "../diff/review/useUnifiedReview";
import { ViewedToggle } from "../diff/review/ViewedToggle";
import { DiscardChangesDialog } from "../rightrail/DiscardChangesDialog";
import { Button } from "../ui/button";
import { FilePreview } from "../ui/file-preview";
import { DiffCount } from "../ui/sidebar";
import { DiffPaneTools, type PaneView } from "./DiffPaneTools";
import { diffEmptyState } from "./diffEmptyState";
import { hasHunks, useWhitespaceHiddenDiff } from "./useWhitespaceHiddenDiff";
import "../ui/file-tab.css";

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
  // Bumped by "Try again" to re-read the same file.
  const [attempt, setAttempt] = useState(0);
  // Split/unified is the one shared, persisted preference, in sync with the
  // Trace Changes pane and surviving reloads.
  const [mode, setMode] = useState<DiffView>(getDiffView);
  useEffect(() => subscribeDiffView(setMode), []);
  // Whitespace-hiding shares one persisted toggle across all diff panes.
  const [ignoreWs, setIgnoreWs] = useState(getIgnoreWhitespace);
  useEffect(() => subscribeIgnoreWhitespace(setIgnoreWs), []);
  const [wrap, setWrap] = useState(getWrapLines);
  useEffect(() => subscribeWrapLines(setWrap), []);
  // The file as it is now, for Copy; until it is read (or when it can't be,
  // a deleted file), Copy takes the diff.
  const [text, setText] = useState<string | null>(null);
  // Entire file is chosen per pane and not remembered, like the diff layouts'
  // own preference is.
  const [raw, setRaw] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [discardError, setDiscardError] = useState("");

  useEffect(() => {
    let alive = true;
    setState("loading");
    setDiff(null);
    setText(null);
    setDiscardError("");
    // Listen for the post-commit / post-checkout signal so a save or branch
    // switch re-reads this file's working diff instead of keeping a stale one.
    const reload = () => {
      work
        .readFile(`${repoRoot.replace(/\/$/, "")}/${path}`)
        .then((f) => alive && setText(f.status === "ok" ? f.text : null))
        .catch(() => alive && setText(null));
      work
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
  }, [repoRoot, path, attempt]);

  const stats = useMemo(() => countDiff(diff ?? ""), [diff]);
  const hasDiff = !!diff && diff.trim().length > 0;
  // A one-sided diff (a brand-new or deleted file) has nothing to compare in a
  // split, so the switch hides and we render unified.
  const sides = useMemo(
    () => (hasDiff ? materializeSides(diff as string) : null),
    [hasDiff, diff],
  );
  const splitDisabled = sides?.oneSided ?? false;
  const effectiveMode: DiffView = splitDisabled ? "unified" : mode;
  // A file git added whole (`git add -N`) has no committed version to go
  // back to; discarding it deletes it.
  const isNew = /^new file mode/m.test(diff ?? "");
  const view: PaneView = raw && text !== null ? "raw" : effectiveMode;
  // The unified table has no whitespace switch of its own, so with whitespace
  // hidden it is given git's `-w` read of the file instead.
  const hideWsUnified = ignoreWs && view === "unified" && hasDiff;
  const wsDiff = useWhitespaceHiddenDiff(repoRoot, path, hideWsUnified, diff);
  const shown = hideWsUnified && wsDiff !== null ? wsDiff : (diff ?? "");
  // "Only whitespace changed": split goes by its editor's rule (each line
  // trimmed); unified by whether git's `-w` read has a hunk left.
  const empty = hideWsUnified
    ? (diffEmptyState(diff ?? "", false) ??
      (wsDiff !== null && !hasHunks(wsDiff) ? "whitespace" : null))
    : diffEmptyState(diff ?? "", ignoreWs && view !== "raw");
  const review = useDiffReview(repoRoot, path);
  const unifiedReview = useUnifiedReview(shown, review);
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const tableNav = useMemo(() => (scroller ? tableNavSource(scroller) : null), [scroller]);
  const { viewed, toggle: toggleViewed } = useViewed(repoRoot, path, diff ?? "");
  const pickView = (v: PaneView) => {
    setRaw(v === "raw");
    if (v !== "raw") setDiffView(v);
  };

  const discard = async () => {
    setConfirmDiscard(false);
    try {
      await work.gitDiscard(repoRoot, [path]);
      setDiscardError("");
      window.dispatchEvent(new CustomEvent("aura:git-changed"));
    } catch (e) {
      setDiscardError(String(e).replace(/^Error:\s*/i, "").split("\n")[0]);
    }
  };

  return (
    <FilePreview
      name={path}
      kind="text"
      content={text ?? diff ?? ""}
      loading={state === "loading"}
      error={state === "error" ? "Couldn’t read this file’s changes." : undefined}
      onReload={() => setAttempt((n) => n + 1)}
      actions={
        <div className="ui-file-view-actions">
          {hasDiff && empty !== "binary" && <DiffCount added={stats.add} removed={stats.del} />}
          {hasDiff && (
            <DiffPaneTools
              view={view}
              onView={pickView}
              canSplit={!splitDisabled}
              canRaw={text !== null}
              hideWhitespace={ignoreWs}
              onHideWhitespace={setIgnoreWhitespace}
              wrapLines={wrap}
              onWrapLines={setWrapLines}
              onDiscard={() => setConfirmDiscard(true)}
            />
          )}
          <Button size="xs" variant="ghost" onClick={onOpenInEditor}>
            Open in editor
            <ArrowUpRight />
          </Button>
          {hasDiff && <ViewedToggle viewed={viewed} onToggle={toggleViewed} />}
        </div>
      }
    >
      {discardError && (
        <div className="ui-session-banner" role="alert">
          Couldn’t discard the changes: {discardError}
        </div>
      )}
      {!hasDiff ? (
        <div className="ui-pattern-empty">
          No line-by-line changes to show here. This file is new or already
          staged whole. Open it in the editor to see its contents.
        </div>
      ) : empty === "binary" ? (
        <div className="ui-pattern-empty">Binary file changed</div>
      ) : view === "raw" ? (
        <div className="ui-file-tab-body">
          <div className="ui-file-diff">
            <EntireFileView text={text ?? ""} path={path} review={review} />
          </div>
        </div>
      ) : empty === "whitespace" ? (
        <div className="ui-pattern-empty">
          <Pilcrow size={20} strokeWidth={1.5} />
          <span>Only whitespace changes found</span>
          <Button variant="link" size="xs" onClick={() => setIgnoreWhitespace(false)}>
            Show whitespace changes
          </Button>
        </div>
      ) : (
        <div className="ui-file-tab-body">
          {effectiveMode === "split" ? (
            <div className="ui-file-diff">
              <SplitDiff diff={diff as string} path={path} review={review} />
            </div>
          ) : (
            <>
              <div className="ui-file-diff" data-scroll="" ref={setScroller}>
                <UnifiedDiff diff={shown} {...unifiedReview} />
              </div>
              <CommentNav source={tableNav} comments={review.comments} />
            </>
          )}
        </div>
      )}
      <DiscardChangesDialog
        target={confirmDiscard ? { path, untracked: isNew } : null}
        onCancel={() => setConfirmDiscard(false)}
        onConfirm={() => void discard()}
      />
    </FilePreview>
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
