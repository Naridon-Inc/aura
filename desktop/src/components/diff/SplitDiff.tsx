// SplitDiff — a side-by-side (split) diff renderer, shared by every git surface
// that wants the two-column view: the Trace Changes pane and the working-file
// diff pane. It takes a unified diff string, rebuilds the original/modified
// sides from it, and mounts a read-only Monaco DiffEditor that themes itself to
// the app and folds to inline when the pane gets narrow.
//
// Extracted out of ChangesView so the same view powers both surfaces with no
// drift. `materializeSides` is exported too — callers use it to decide whether
// a diff is one-sided (a brand-new or deleted file), which has no meaningful
// split and should fall back to the unified view.

import { useEffect, useMemo, useRef, useState } from "react";
import { DiffEditor, type DiffOnMount, type Monaco } from "@monaco-editor/react";

import { installMonacoEnvironment } from "../../lib/monacoEnv";
import { languageSlugForPath } from "../../lib/monacoLanguage";
import { configureMonacoDiagnostics } from "../../lib/monacoDiagnostics";
import { useResolvedTheme, useThemeVariant } from "../../lib/themeStore";
import { auraThemeName, ensureAuraThemes } from "../../lib/monacoTheme";
import { getIgnoreWhitespace, subscribeIgnoreWhitespace } from "../../lib/ignoreWhitespacePref";

installMonacoEnvironment();

export type DiffSides = { original: string; modified: string; oneSided: boolean };

const HUNK_RE = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/;

/** Rebuild the two file sides from a unified diff so Monaco's split view has
 *  real `original` / `modified` buffers. File/hunk headers are dropped; `+`
 *  lines land only on the right, `-` only on the left, context on both.
 *  `oneSided` flags an add-only or delete-only diff (a new/removed file) — the
 *  split has nothing to compare there, so callers fall back to unified. */
export function materializeSides(diff: string): DiffSides {
  const left: string[] = [];
  const right: string[] = [];
  for (const raw of diff.split("\n")) {
    if (
      raw.startsWith("diff --git") ||
      raw.startsWith("index ") ||
      raw.startsWith("--- ") ||
      raw.startsWith("+++ ") ||
      raw.startsWith("new file mode") ||
      raw.startsWith("deleted file mode") ||
      raw.startsWith("similarity index") ||
      raw.startsWith("rename ") ||
      raw.startsWith("old mode") ||
      raw.startsWith("new mode") ||
      raw.startsWith("\\")
    ) {
      continue;
    }
    if (HUNK_RE.test(raw)) continue;
    const lead = raw.charAt(0);
    if (lead === "+") {
      right.push(raw.slice(1));
    } else if (lead === "-") {
      left.push(raw.slice(1));
    } else {
      const body = lead === " " ? raw.slice(1) : raw;
      left.push(body);
      right.push(body);
    }
  }
  return {
    original: left.join("\n"),
    modified: right.join("\n"),
    oneSided: left.length === 0 || right.length === 0,
  };
}

export function SplitDiff({ diff, path }: { diff: string; path: string }) {
  const sides = useMemo(() => materializeSides(diff), [diff]);
  // languageSlugForPath already resolves to a Monaco language id (full grammar
  // coverage), falling back to plaintext.
  const language = useMemo(() => languageSlugForPath(path), [path]);
  const resolvedTheme = useResolvedTheme();
  const variant = useThemeVariant();
  const isDark = resolvedTheme !== "light";
  // Shared with every diff pane: flip whitespace-hiding once, all panes follow.
  const [ignoreWs, setIgnoreWs] = useState(getIgnoreWhitespace);
  useEffect(() => subscribeIgnoreWhitespace(setIgnoreWs), []);
  const monacoRef = useRef<Monaco | null>(null);
  const editorRef = useRef<Parameters<DiffOnMount>[0] | null>(null);
  const onMount: DiffOnMount = (editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;
  };
  // Switching files reuses the SAME editor (no `key`-forced remount below), so
  // Monaco carries the previous scroll position onto the next file. Reset both
  // sides to the top on a path change to match the fresh-view UX a remount used
  // to give — WITHOUT the remount, whose model dispose fires the "TextModel got
  // disposed before DiffEditorWidget model got reset" teardown race on every
  // file switch. (True unmount still disposes; that path is guarded in
  // AppErrorBoundary.)
  useEffect(() => {
    const ed = editorRef.current;
    if (!ed) return;
    try {
      ed.getOriginalEditor()?.setScrollTop(0);
      ed.getModifiedEditor()?.setScrollTop(0);
    } catch {
      /* editor mid-teardown — nothing to reset */
    }
  }, [path, diff]);
  // Re-read tokens + reapply when the app theme/variant flips at runtime.
  useEffect(() => {
    const monaco = monacoRef.current;
    if (!monaco) return;
    ensureAuraThemes(monaco);
    monaco.editor.setTheme(auraThemeName(isDark));
  }, [isDark, variant]);
  return (
    <DiffEditor
      original={sides.original}
      modified={sides.modified}
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
        renderSideBySide: !sides.oneSided,
        // Let Monaco fold side-by-side → inline itself when the pane gets
        // narrow, so the split never squishes into an unreadable two-column
        // sliver on resize.
        useInlineViewWhenSpaceIsLimited: true,
        renderSideBySideInlineBreakpoint: 700,
        fontFamily: "var(--font-mono), Menlo, Monaco, monospace",
        fontSize: 12,
        lineHeight: 20,
        wordWrap: "off",
        scrollBeyondLastLine: false,
        smoothScrolling: true,
        renderLineHighlight: "all",
        minimap: { enabled: false },
        hideUnchangedRegions: {
          enabled: true,
          minimumLineCount: 4,
          contextLineCount: 3,
        },
        automaticLayout: true,
        ignoreTrimWhitespace: ignoreWs,
      }}
    />
  );
}
