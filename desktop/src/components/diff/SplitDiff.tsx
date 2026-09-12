// SplitDiff — a side-by-side (split) diff renderer, shared by every git surface
// that wants the two-column view: the Trace Changes pane and the working-file
// diff pane. It takes a unified diff string, rebuilds the original/modified
// sides from it, and mounts a Monaco DiffEditor that themes itself to the app
// and folds to inline when the pane gets narrow.
//
// Extracted out of ChangesView so the same view powers both surfaces with no
// drift. The rebuild itself now lives in ../../lib/diffSides, because it is
// also what maps a changed PIECE onto the lines it occupies — see `focus`.
//
// FOCUS: when the reader clicks a piece in the header above ("Previous was
// this" / "New is this"), that piece's lines are highlighted here and its
// plain-language line is pinned directly over them. The plain words and the
// code stop being two separate readings of the same change.
//
// EDITING: a working-tree diff can hand in the WHOLE file for both sides
// (`sides`) and an `edit` handle; the current side then accepts typing and ⌘S
// saves it (see useEditableDiff). Committed and PR diffs never pass these and
// stay exactly as read-only as they were.

import { useEffect, useMemo, useRef, useState } from "react";
import { DiffEditor, type DiffOnMount, type Monaco } from "@monaco-editor/react";

import { installMonacoEnvironment } from "../../lib/monacoEnv";
import { languageSlugForPath } from "../../lib/monacoLanguage";
import { configureMonacoDiagnostics } from "../../lib/monacoDiagnostics";
import { useResolvedTheme, useThemeVariant } from "../../lib/themeStore";
import { auraThemeName, ensureAuraThemes } from "../../lib/monacoTheme";
import { getIgnoreWhitespace, subscribeIgnoreWhitespace } from "../../lib/ignoreWhitespacePref";
import { materializeSides, materializedSpan, type DiffFocus } from "../../lib/diffSides";
import type { EditableDiffHandle } from "./useEditableDiff";

installMonacoEnvironment();

/** Both sides as complete files, in the file's own line numbers. Given by a
 *  host that read the working-tree file from disk (and rebuilt the original
 *  from the patch), so a save writes a whole file back. */
export type FullSides = { original: string; modified: string };

/** How a host lets the current side be typed into. `readOnly` follows the
 *  "Edit in diff" / "Read only" preference; `attach` is the save handle. */
export type SplitDiffEdit = {
  readOnly: boolean;
  attach: EditableDiffHandle["attach"];
};

/** The pinned plain-language line, sitting on the code it describes.
 *
 *  It reads as part of the diff, not a caption above it: same ground, a rail in
 *  the accent that also marks the lines below. When the piece can't be located
 *  in the visible diff it says so — pointing at a neighbouring function would
 *  be worse than admitting the lines aren't on screen. */
function FocusStrip({
  focus,
  located,
  onClear,
}: {
  focus: DiffFocus;
  located: boolean;
  onClear?: () => void;
}) {
  return (
    <div className="flex shrink-0 items-start gap-2 border-b border-line-soft bg-bg-1/60 px-3 py-1.5">
      <span aria-hidden className="mt-0.5 w-0.5 self-stretch rounded bg-[var(--color-accent)]" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-1.5">
          <span className="text-sm font-medium text-text-1">{focus.title}</span>
          <span className="font-mono text-2xs text-text-5">{focus.identifier}</span>
        </div>
        <div className="text-xs leading-snug text-text-3">
          {focus.meaning ||
            (located
              ? "Highlighted below. The plain-language line for this piece is still being written."
              : "")}
        </div>
        {!located ? (
          <div className="text-xs leading-snug text-text-4">
            These lines aren&rsquo;t in the part of the file this diff shows, so
            there&rsquo;s nothing to highlight.
          </div>
        ) : null}
      </div>
      {onClear ? (
        <button
          type="button"
          onClick={onClear}
          className="shrink-0 rounded px-1.5 py-px text-xs text-text-4 hover:bg-state-hover hover:text-text-2"
          title="Stop highlighting this piece"
        >
          Clear
        </button>
      ) : null}
    </div>
  );
}

export function SplitDiff({
  diff,
  path,
  /** The piece to single out, when the reader picked one above. */
  focus,
  onClearFocus,
  sides: fullSides,
  inline = false,
  edit = null,
}: {
  diff: string;
  path: string;
  focus?: DiffFocus | null;
  onClearFocus?: () => void;
  /** Whole-file text for both sides. When absent the sides are rebuilt from
   *  the patch alone (changed lines plus context), as every read-only diff is. */
  sides?: FullSides | null;
  /** One column (the unified look) instead of two. Used when the reader
   *  prefers inline but the diff must stay a Monaco editor to be editable. */
  inline?: boolean;
  /** Lets the current side be typed into. Absent → hard read-only. */
  edit?: SplitDiffEdit | null;
}) {
  const materialized = useMemo(() => materializeSides(diff), [diff]);
  const sides = useMemo(
    () =>
      fullSides
        ? {
            ...materialized,
            original: fullSides.original,
            modified: fullSides.modified,
            oneSided: fullSides.original === "" || fullSides.modified === "",
          }
        : materialized,
    [materialized, fullSides],
  );
  const editable = !!edit && !edit.readOnly;
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
  const origDecoRef = useRef<ReturnType<
    ReturnType<Parameters<DiffOnMount>[0]["getOriginalEditor"]>["createDecorationsCollection"]
  > | null>(null);
  const modDecoRef = useRef<typeof origDecoRef.current>(null);
  // Flips once the editor exists, so the focus effect below re-runs against a
  // real editor when the reader clicked a piece before Monaco finished loading.
  const [mounted, setMounted] = useState(false);
  const onMount: DiffOnMount = (editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;
    origDecoRef.current = editor.getOriginalEditor().createDecorationsCollection([]);
    modDecoRef.current = editor.getModifiedEditor().createDecorationsCollection([]);
    setMounted(true);
  };
  // Hand the mounted editor to the edit handle once: it wires dirty tracking
  // and ⌘S on the modified side. `attach` is stable per host, so this runs a
  // single time per mount rather than on every render.
  const attach = edit?.attach ?? null;
  useEffect(() => {
    const ed = editorRef.current;
    const monaco = monacoRef.current;
    if (!mounted || !ed || !monaco || !attach) return;
    attach(ed, monaco);
  }, [mounted, attach]);
  // Switching files reuses the SAME editor (no `key`-forced remount below), so
  // Monaco carries the previous scroll position onto the next file. Reset both
  // sides to the top on a path change to match the fresh-view UX a remount used
  // to give — WITHOUT the remount, whose model dispose fires the "TextModel got
  // disposed before DiffEditorWidget model got reset" teardown race on every
  // file switch. (True unmount still disposes; that path is guarded in
  // AppErrorBoundary.)
  //
  // While the diff is editable a save refreshes `diff` in place; that is the
  // same file, and the reader's cursor should stay where it is — so only a
  // path change scrolls home then.
  const scrollKey = editable ? path : `${path}\0${diff}`;
  useEffect(() => {
    const ed = editorRef.current;
    if (!ed) return;
    try {
      ed.getOriginalEditor()?.setScrollTop(0);
      ed.getModifiedEditor()?.setScrollTop(0);
    } catch {
      /* editor mid-teardown — nothing to reset */
    }
  }, [scrollKey]);
  // Re-read tokens + reapply when the app theme/variant flips at runtime.
  useEffect(() => {
    const monaco = monacoRef.current;
    if (!monaco) return;
    ensureAuraThemes(monaco);
    monaco.editor.setTheme(auraThemeName(isDark));
  }, [isDark, variant]);

  // Monaco's models ARE the materialized buffers, so the piece's real file
  // lines have to be translated into this buffer's own numbering — the two
  // differ by every line the other side owns, plus every hunk header dropped.
  // With whole files on both sides the buffer's numbering IS the file's, and
  // the span applies as recorded.
  const target = useMemo(() => {
    if (!focus?.span) return null;
    if (fullSides) return { startLine: focus.span.startLine, endLine: focus.span.endLine };
    return materializedSpan(sides, focus.span);
  }, [sides, focus, fullSides]);

  // Paint the highlight and scroll it into view. Decorations rather than a view
  // zone: a zone on one side only would push that pane out of alignment with
  // the other, which is the whole point of a split view.
  useEffect(() => {
    const monaco = monacoRef.current;
    const ed = editorRef.current;
    origDecoRef.current?.set([]);
    modDecoRef.current?.set([]);
    if (!monaco || !ed || !focus?.span || !target) return;
    const onOriginal = focus.span.side === "original";
    const collection = onOriginal ? origDecoRef.current : modDecoRef.current;
    const pane = onOriginal ? ed.getOriginalEditor() : ed.getModifiedEditor();
    if (!collection || !pane) return;
    const range = new monaco.Range(target.startLine, 1, target.endLine, 1);
    collection.set([
      {
        range,
        options: {
          isWholeLine: true,
          className: "aura-focus-lines",
          marginClassName: "aura-focus-margin",
          // A concrete colour: the ruler is a canvas and never resolves a CSS
          // variable. This is Aura's own green.
          overviewRuler: {
            color: "#4dc1a4",
            position: monaco.editor.OverviewRulerLane.Full,
          },
        },
      },
    ]);
    try {
      pane.revealRangeInCenterIfOutsideViewport(range, monaco.editor.ScrollType.Smooth);
    } catch {
      /* editor mid-teardown — the highlight still lands, the scroll doesn't */
    }
  }, [focus, target, mounted, diff]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {focus ? (
        <FocusStrip focus={focus} located={!!target} onClear={onClearFocus} />
      ) : null}
      <div className="min-h-0 flex-1">
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
            // Only the current side ever opens up, and only for a working-tree
            // file whose host handed in an edit handle. The original is what
            // the change is measured against and stays read-only always.
            readOnly: !editable,
            originalEditable: false,
            renderSideBySide: !inline && !sides.oneSided,
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
      </div>
    </div>
  );
}
