// Side-by-side diff via Monaco's DiffEditor. Left pane = HEAD's version
// (from the daemon's git), right pane = the editor's current buffer.
// The left pane is read-only. The right pane can be typed into ("Edit in
// diff", the default) and ⌘S writes it to disk; the editor tab's own buffer
// then follows via the workspace watcher, so the two never disagree. While
// there are unsaved edits the right buffer holds still — a re-read of the
// file shows "Changed on disk" with a Reload instead of overwriting typing.
//
// When git can't produce a HEAD blob (untracked file, no repo) we fall
// back to baseline-vs-current — still useful for unsaved edits.
//
// Both sides carry review comments: a ＋ in the gutter opens one on a line.
//
// Replaces the CodeMirror @codemirror/merge MergeView. Same DiffViewProps
// shape so call sites swap without churn.

import { useEffect, useMemo, useRef, useState } from "react";
import { DiffEditor, type DiffOnMount, type Monaco } from "@monaco-editor/react";
import type { editor } from "monaco-editor";

import { useEditableDiff } from "./diff/useEditableDiff";
import { useDiffReview } from "./diff/review/useDiffReview";
import { useMonacoReview } from "./diff/review/useMonacoReview";
import { CommentNav } from "./diff/review/CommentNav";
import { monacoNavSource } from "./diff/review/navSources";
import { DiskChangedNotice, EditToggle, UnsavedMark } from "./diff/DiffSaveState";
import { DiffCount } from "./ui/sidebar";
import { LoadingState } from "./ui/state";
import { Toggle } from "./ui/toggle";
import { installMonacoEnvironment } from "../lib/monacoEnv";
import { languageSlugForPath } from "../lib/monacoLanguage";
import { workspacePath } from "../lib/diffReview/reviewComments";
import { configureMonacoDiagnostics } from "../lib/monacoDiagnostics";
import { useResolvedTheme, useThemeVariant } from "../lib/themeStore";
import { auraThemeName, ensureAuraThemes } from "../lib/monacoTheme";
import {
  getIgnoreWhitespace,
  setIgnoreWhitespace,
  subscribeIgnoreWhitespace,
} from "../lib/ignoreWhitespacePref";
import {
  getEditableDiffs,
  setEditableDiffs,
  subscribeEditableDiffs,
} from "../lib/diffViewPref";

installMonacoEnvironment();

type DiffViewProps = {
  repoRoot: string;
  path: string;
  /** Editor's current text. Right side updates live as user types. */
  current: string;
  /** Pre-edit baseline (file as last read from disk). Used as fallback. */
  baseline: string;
  /** Resolves the original blob — usually `git show HEAD:<rel>`. */
  loadOriginal: (repoRoot: string, path: string) => Promise<string>;
};

export function DiffView({
  repoRoot,
  path,
  current,
  baseline,
  loadOriginal,
}: DiffViewProps) {
  const editorRef = useRef<editor.IStandaloneDiffEditor | null>(null);
  const monacoRef = useRef<Monaco | null>(null);
  // Set once the editor exists, so the review hooks get its two sides.
  const [mounted, setMounted] = useState<editor.IStandaloneDiffEditor | null>(null);
  const [original, setOriginal] = useState<string | null>(null);
  const resolvedTheme = useResolvedTheme();
  const variant = useThemeVariant();
  const isDark = resolvedTheme !== "light";
  // Shared whitespace-hiding toggle — flips every open diff pane at once.
  const [ignoreWs, setIgnoreWs] = useState(getIgnoreWhitespace);
  useEffect(() => subscribeIgnoreWhitespace(setIgnoreWs), []);
  // "Edit in diff" / "Read only" — the same shared, persisted choice every
  // diff pane reads.
  const [editPref, setEditPref] = useState(getEditableDiffs);
  useEffect(() => subscribeEditableDiffs(setEditPref), []);
  // The right pane's text and its save handle. `current` is the editor tab's
  // buffer, which is what disk holds whenever that tab is clean — so it is
  // the "disk text" here, and a save lands back in it through the watcher.
  const edit = useEditableDiff({ absPath: path, diskText: current });

  // Pull HEAD copy whenever the file changes. If git fails we fall back
  // to the in-memory baseline so the diff is still useful for unsaved
  // edits in the current session.
  useEffect(() => {
    let cancelled = false;
    loadOriginal(repoRoot, path)
      .then((text) => {
        if (cancelled) return;
        setOriginal(text || baseline);
      })
      .catch(() => {
        if (cancelled) return;
        setOriginal(baseline);
      });
    return () => {
      cancelled = true;
    };
  }, [repoRoot, path, baseline, loadOriginal]);

  // languageSlugForPath already resolves to a Monaco language id (full grammar
  // coverage), falling back to plaintext.
  const language = useMemo(() => languageSlugForPath(path), [path]);

  const onMount: DiffOnMount = (editorInstance, monaco) => {
    editorRef.current = editorInstance;
    monacoRef.current = monaco;
    // Dirty tracking + ⌘S, scoped to this editor instance.
    edit.attach(editorInstance, monaco);
    setMounted(editorInstance);
  };

  // Both buffers hold whole files, so their lines are the file's own.
  const review = useDiffReview(repoRoot, workspacePath(repoRoot, path));
  const reviewOld = useMonacoReview(
    mounted?.getOriginalEditor() ?? null,
    monacoRef.current,
    "deletions",
    review,
  );
  const reviewNew = useMonacoReview(
    mounted?.getModifiedEditor() ?? null,
    monacoRef.current,
    "additions",
    review,
  );

  const nav = useMemo(
    () => (mounted && monacoRef.current ? monacoNavSource(mounted, monacoRef.current) : null),
    [mounted],
  );

  // Re-read tokens + reapply the Aura theme on runtime theme/variant change.
  useEffect(() => {
    const monaco = monacoRef.current;
    if (!monaco) return;
    ensureAuraThemes(monaco);
    monaco.editor.setTheme(auraThemeName(isDark));
  }, [isDark, variant]);

  // The right (modified) buffer follows `edit.modified`, which tracks the live
  // editor text while clean and holds still while there are unsaved edits —
  // the DiffEditor wrapper applies it to the model on change, so no manual
  // sync is needed (and a manual one would overwrite typing).

  // Push original (HEAD) updates into the left model. The editor is reused
  // across files (no `key`-forced remount below), so both a path switch and a
  // same-path original re-fetch flow through here via setValue.
  useEffect(() => {
    const ed = editorRef.current;
    if (!ed || original == null) return;
    const orig = ed.getModel()?.original;
    if (!orig) return;
    if (orig.getValue() === original) return;
    orig.setValue(original);
  }, [original]);

  // Reset both sides to the top when the file changes. A `key`-forced remount
  // used to give this for free, but its model dispose fired the "TextModel got
  // disposed before DiffEditorWidget model got reset" teardown race on every
  // file switch — so we reuse the editor and just scroll it home instead.
  useEffect(() => {
    const ed = editorRef.current;
    if (!ed) return;
    try {
      ed.getOriginalEditor()?.setScrollTop(0);
      ed.getModifiedEditor()?.setScrollTop(0);
    } catch {
      /* editor mid-teardown — nothing to reset */
    }
  }, [path]);

  const stats = useMemo(
    () => quickLineDelta(original ?? baseline, current),
    [original, baseline, current],
  );

  if (original == null) {
    return (
      <div className="ui-diff-view">
        <LoadingState label="Reading this change…" size="md" />
      </div>
    );
  }

  return (
    <div className="ui-diff-view">
      {reviewOld}
      {reviewNew}
      {/* The file view above already names the file; this bar only says
          what is compared and carries the diff's own switches. */}
      <div className="ui-diff-view-bar">
        <span>Last commit ↔ Now</span>
        <DiffCount added={stats.added} removed={stats.removed} />
        <UnsavedMark edit={edit} />
        <DiskChangedNotice edit={edit} />
        <span className="ui-diff-view-tools">
          <EditToggle on={editPref} onChange={setEditableDiffs} />
          <Toggle
            size="sm"
            pressed={ignoreWs}
            onPressedChange={setIgnoreWhitespace}
            title={ignoreWs ? "Whitespace-only changes hidden" : "Hide whitespace-only changes"}
          >
            Hide whitespace
          </Toggle>
        </span>
      </div>
      <div className="ui-diff-view-body">
        <CommentNav source={nav} comments={review.comments} />
        <DiffEditor
          // Intentionally NOT `key`-remounted per file: reusing the editor and
          // updating the models in place (see effects above) avoids the Monaco
          // diff teardown race that a per-file dispose triggers.
          original={original}
          modified={edit.modified}
          language={language}
          theme={auraThemeName(isDark)}
          beforeMount={(monaco) => {
            ensureAuraThemes(monaco);
            configureMonacoDiagnostics(monaco);
          }}
          onMount={onMount}
          options={{
            // Right side opens to typing under "Edit in diff"; the left
            // (last commit) is what the change is measured against and
            // stays read-only always.
            readOnly: !editPref,
            originalEditable: false,
            renderSideBySide: true,
            // Fold to inline when the pane is too narrow for two columns so the
            // split never breaks on resize.
            useInlineViewWhenSpaceIsLimited: true,
            renderSideBySideInlineBreakpoint: 700,
            // Mirror the MonacoEditor visual defaults.
            fontFamily: "var(--font-mono), Menlo, Monaco, monospace",
            fontSize: 13,
            lineHeight: 20,
            wordWrap: "on",
            scrollBeyondLastLine: false,
            smoothScrolling: true,
            renderLineHighlight: "all",
            minimap: { enabled: false },
            // Collapse runs of unchanged lines (Monaco built-in).
            hideUnchangedRegions: {
              enabled: true,
              minimumLineCount: 4,
              contextLineCount: 3,
            },
            // Compact gutter; the surrounding chrome already has the
            // header strip so we don't need redundant labels here.
            renderOverviewRuler: true,
            // Room for the ＋ that opens a review comment on a line.
            glyphMargin: true,
            ignoreTrimWhitespace: ignoreWs,
            automaticLayout: true,
          }}
        />
      </div>
    </div>
  );
}

// Cheap +/- line counter. Walks both sides line-by-line through the
// shared prefix + suffix and reports the middle delta — good enough for
// the header chip; we don't need true Myers for a summary number.
function quickLineDelta(
  a: string,
  b: string,
): { added: number; removed: number } {
  if (a === b) return { added: 0, removed: 0 };
  const la = a.split("\n");
  const lb = b.split("\n");
  let i = 0;
  while (i < la.length && i < lb.length && la[i] === lb[i]) i++;
  let ja = la.length - 1;
  let jb = lb.length - 1;
  while (ja >= i && jb >= i && la[ja] === lb[jb]) {
    ja--;
    jb--;
  }
  return {
    removed: Math.max(0, ja - i + 1),
    added: Math.max(0, jb - i + 1),
  };
}
