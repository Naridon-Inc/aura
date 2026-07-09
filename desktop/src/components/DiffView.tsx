// Side-by-side diff via Monaco's DiffEditor. Left pane = HEAD's version
// (from the daemon's git), right pane = the editor's current buffer.
// Both panes are read-only — the right buffer re-syncs from the live
// editor as the user types, so chunks live-update.
//
// When git can't produce a HEAD blob (untracked file, no repo) we fall
// back to baseline-vs-current — still useful for unsaved edits.
//
// Replaces the CodeMirror @codemirror/merge MergeView. Same DiffViewProps
// shape so call sites swap without churn.

import { useEffect, useMemo, useRef, useState } from "react";
import { DiffEditor, type DiffOnMount, type Monaco } from "@monaco-editor/react";
import type { editor } from "monaco-editor";

import { installMonacoEnvironment } from "../lib/monacoEnv";
import { languageSlugForPath } from "../lib/monacoLanguage";
import { configureMonacoDiagnostics } from "../lib/monacoDiagnostics";
import { useResolvedTheme, useThemeVariant } from "../lib/themeStore";
import { auraThemeName, ensureAuraThemes } from "../lib/monacoTheme";
import {
  getIgnoreWhitespace,
  setIgnoreWhitespace,
  subscribeIgnoreWhitespace,
} from "../lib/ignoreWhitespacePref";

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
  const [original, setOriginal] = useState<string | null>(null);
  const resolvedTheme = useResolvedTheme();
  const variant = useThemeVariant();
  const isDark = resolvedTheme !== "light";
  // Shared whitespace-hiding toggle — flips every open diff pane at once.
  const [ignoreWs, setIgnoreWs] = useState(getIgnoreWhitespace);
  useEffect(() => subscribeIgnoreWhitespace(setIgnoreWs), []);

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
  };

  // Re-read tokens + reapply the Aura theme on runtime theme/variant change.
  useEffect(() => {
    const monaco = monacoRef.current;
    if (!monaco) return;
    ensureAuraThemes(monaco);
    monaco.editor.setTheme(auraThemeName(isDark));
  }, [isDark, variant]);

  // Keep the right (modified) buffer in sync with the live editor text.
  // Monaco re-runs the diff incrementally so this is cheap.
  useEffect(() => {
    const ed = editorRef.current;
    if (!ed) return;
    const modified = ed.getModel()?.modified;
    if (!modified) return;
    if (modified.getValue() === current) return;
    modified.setValue(current);
  }, [current]);

  // Push original (HEAD) updates into the left model. Path change forces
  // a full remount via React's key, but a same-path original re-fetch
  // (rare) should also flow through.
  useEffect(() => {
    const ed = editorRef.current;
    if (!ed || original == null) return;
    const orig = ed.getModel()?.original;
    if (!orig) return;
    if (orig.getValue() === original) return;
    orig.setValue(original);
  }, [original]);

  const stats = useMemo(
    () => quickLineDelta(original ?? baseline, current),
    [original, baseline, current],
  );

  if (original == null) {
    return (
      <div className="h-full w-full bg-bg-content flex items-center justify-center text-[12px] text-text-4">
        Loading diff…
      </div>
    );
  }

  return (
    <div className="h-full w-full overflow-hidden bg-bg-content flex flex-col">
      <div className="h-8 px-3 flex items-center gap-3 border-b border-line-soft bg-bg-1 text-[11px]">
        <span className="text-text-3 font-mono truncate">{path}</span>
        <span className="text-accent-green">+{stats.added}</span>
        <span className="text-red">−{stats.removed}</span>
        <button
          type="button"
          onClick={() => setIgnoreWhitespace(!ignoreWs)}
          aria-pressed={ignoreWs}
          title={ignoreWs ? "Showing whitespace changes off" : "Hide whitespace-only changes"}
          className={`ml-auto h-5 px-1.5 rounded border text-[10.5px] transition-colors ${
            ignoreWs
              ? "border-[var(--color-accent)] text-[var(--color-accent)] bg-bg-2"
              : "border-line-soft text-text-3 hover:text-text-1"
          }`}
        >
          Ignore whitespace
        </button>
        <span className="text-text-4">Last commit ↔ Now</span>
      </div>
      <div className="flex-1 min-h-0 w-full">
        <DiffEditor
          // Path-keyed so switching files rebuilds the models cleanly —
          // matches the previous MergeView behaviour.
          key={path}
          original={original}
          modified={current}
          language={language}
          theme={auraThemeName(isDark)}
          beforeMount={(monaco) => {
            ensureAuraThemes(monaco);
            configureMonacoDiagnostics(monaco);
          }}
          onMount={onMount}
          options={{
            readOnly: true,
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
