// PrDiffBody — v0.2.12 S.1b. Monaco-powered PR diff renderer.
//
// Replaces the legacy row-by-row unified-diff renderer with Monaco's
// built-in DiffEditor. We keep PrDiffBody's prop shape stable so the
// surrounding cards (PrFileDiffCard, PRDetailPane) don't change.
//
// Substrate decisions:
//
//   * Original / modified content is synthesized from the unified-diff
//     body (already parsed by parseDiff). We don't fetch blobs from the
//     daemon — the diff text contains everything we need to recreate
//     the two sides as Monaco sees them. Pure-removal blocks reveal
//     "before"; pure-addition blocks reveal "after"; context shows in
//     both. This matches GitHub's web UI for diff-only previews and
//     avoids a network round-trip per file.
//
//   * Language is inferred from the file extension via the shared
//     languageSlugForPath → monacoLanguageId helpers (also used by
//     DiffView and MonacoEditor). Theme follows the app theme via
//     useResolvedTheme — vs-dark in dark mode, vs in light mode.
//
//   * Render mode (side-by-side ↔ inline) is a per-file toggle in the
//     top-right header of the editor. Defaults to side-by-side.
//
//   * Lazy mount: any file beyond the first MAX_EAGER_EDITORS uses an
//     IntersectionObserver to defer the DiffEditor mount until the
//     placeholder card scrolls into view. Large PRs don't pay to mount
//     50 editors at once.
//
//   * Comment composer + line anchors are preserved. We listen to
//     Monaco's onMouseDown on the modified pane, capture the clicked
//     line number (treated as `rightLine`, matching the legacy
//     contract), and surface the same Comment / Suggest action bar as
//     before. The composer body and submit flow are unchanged.
//
//   * onRegisterRow (fluid-mode anchors used by PrThreadColumn): when
//     supplied, we synthesize an invisible anchor <div> per right-line
//     thread inside the modified pane's bounding box. The anchor's
//     `top` is pulled from Monaco's getTopForLineNumber(), then
//     refreshed on layout + scroll changes. Each anchor is emitted via
//     onRegisterRow with the same (rightLine, HTMLElement) contract so
//     PrThreadColumn's measure pass keeps working unchanged. When
//     onRegisterRow is null (inline-threads legacy mode), we fall back
//     to the legacy floating thread column rendered next to the diff.
//
// Followups (not blocking this swap):
//
//   - Inline-thread legacy mode (`fluidMode === false`) currently
//     stacks thread cards by line index using the synthesized anchor's
//     measured top; the visual cadence is correct but a long thread can
//     overlap the next anchor. All current call sites use fluidMode, so
//     this is a tail concern.
//   - The Aura review highlight (`activeKey` ring) lives in PrFileDiffCard
//     and continues to operate on the anchor <div>; the diff body
//     itself doesn't draw a row ring (Monaco owns line styling). If
//     stronger feedback is wanted we can add a Monaco lineDecoration
//     keyed to activeKey in a followup.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { DiffEditor, type DiffOnMount, type Monaco } from "@monaco-editor/react";
import type { editor } from "monaco-editor";

import { installMonacoEnvironment } from "../../lib/monacoEnv";
import { languageSlugForPath } from "../../lib/monacoLanguage";
import { configureMonacoDiagnostics } from "../../lib/monacoDiagnostics";
import { useResolvedTheme, useThemeVariant } from "../../lib/themeStore";
import { auraThemeName, ensureAuraThemes } from "../../lib/monacoTheme";
import type { PrComment } from "../../lib/api";
import { prCommentPost } from "../../lib/prApi";
import { usePrThreadActive } from "./PrThreadColumn";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { Button } from "../ui/button";
import { Alert, AlertDescription } from "../ui/alert";
import { Separator } from "../ui/separator";
import { Textarea } from "../ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group";
import "../ui/pr-files.css";
import "../ui/pr-thread.css";
import "../ui/pr-diff-composer.css";
import { mentionQueryAt } from "../collab/MentionPicker";
import { fetchPrDetail, getPrDetailCached } from "../../lib/prDetailCache";
import { PrFileMentionPicker, fileMentionText } from "./PrFileMentionPicker";
import { PrThreadCard } from "./thread/PrThreadCard";
import { groupThreads, type ThreadGroup } from "./thread/prThreads";

installMonacoEnvironment();

type Props = {
  repoRoot: string;
  prNumber: number;
  /** RIGHT-side path the diff body belongs to. Comments post against
   *  this path; suggestion blocks copy lines from the new side. */
  filePath: string;
  /** Raw unified diff body (`gh pr diff <num>` chunk for this file). */
  body: string;
  /** Called after a successful post so the parent can refresh
   *  `pr_comments_list`. */
  onPosted?: (c: PrComment) => void;
  /** Stage 8G — file-scoped comments. Only used when `onRegisterRow` is
   *  not provided (legacy inline-threads mode). When `onRegisterRow` is
   *  supplied, the parent owns thread rendering and we just emit row
   *  anchors upward (Stage 8I — fluid right rail / overflow threads). */
  comments?: PrComment[];
  /** Stage 8I — fluid layout: when set, the diff body emits an
   *  HTMLElement anchor for each right-side line that has a thread, so
   *  the parent can render thread bubbles in an absolute overflow
   *  column outside the file card boundary (visually aligned with the
   *  right rail). Receiving this prop disables the inline thread
   *  column. */
  onRegisterRow?: (rightLine: number, el: HTMLElement | null) => void;
  /** v0.2.12 — preferred initial render mode. Defaults to side-by-side
   *  — the layout most review tools open with. The toolbar over the
   *  patch exposes the toggle. */
  initialRenderMode?: "side-by-side" | "inline";
  /** v0.2.12 — when true, mount immediately. When false, wait for an
   *  IntersectionObserver hit before mounting Monaco — for a caller
   *  rendering many files at once. */
  mountEagerly?: boolean;
};

type Line = {
  /** Original raw line text (no transformation). */
  raw: string;
  /** "context" | "add" | "remove" | "meta" | "hunk". */
  kind: "context" | "add" | "remove" | "meta" | "hunk";
  /** Line number on the right side of the diff (1-based). null for
   *  meta/hunk/remove lines (removes have no right-side anchor). */
  rightLine: number | null;
  /** Line number on the left side of the diff (for completeness +
   *  range anchoring). */
  leftLine: number | null;
};


export function PrDiffBody({
  repoRoot,
  prNumber,
  filePath,
  body,
  onPosted,
  comments,
  onRegisterRow,
  initialRenderMode = "side-by-side",
  mountEagerly = true,
}: Props) {
  const lines = useMemo(() => parseDiff(body), [body]);
  const sides = useMemo(() => buildSides(lines), [lines]);
  // New / deleted files have nothing on one side; Monaco's split view
  // collapses to a single pane in that case, so we hide the Split
  // toggle (it would look broken: "Split" highlighted but visually
  // unified). User can still read the one populated side normally.
  const oneSidedFile = sides.original.length === 0 || sides.modified.length === 0;
  // languageSlugForPath already resolves to a Monaco language id (full grammar
  // coverage), falling back to plaintext.
  const language = useMemo(() => languageSlugForPath(filePath), [filePath]);
  const resolvedTheme = useResolvedTheme();
  const variant = useThemeVariant();
  const isDark = resolvedTheme !== "light";
  const theme = auraThemeName(isDark);

  const fluidMode = !!onRegisterRow;

  const [renderSideBySide, setRenderSideBySide] = useState<boolean>(
    initialRenderMode !== "inline",
  );
  const [mounted, setMounted] = useState<boolean>(mountEagerly);
  const placeholderRef = useRef<HTMLDivElement | null>(null);

  // Lazy mount via IntersectionObserver — only used when mountEagerly is
  // false. Once visible we flip mounted=true and never go back; mounting
  // is expensive but unmount churn would be worse.
  useEffect(() => {
    if (mounted || mountEagerly) return;
    const el = placeholderRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            setMounted(true);
            io.disconnect();
            break;
          }
        }
      },
      { rootMargin: "200px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [mounted, mountEagerly]);

  // SS.3 — activate the floating thread card for the clicked line when
  // the user lands on a row that has a thread, and read activeKey
  // back to paint the matching code line with a Monaco lineDecoration
  // so it reads as a real code selection (not the 1px-anchor stripe).
  // No-op outside the PrThreadProvider (e.g. inline-mode usage), since
  // the hook returns a stub setter and null key then.
  const { activeKey, setActiveKey } = usePrThreadActive();

  // Composer state — anchored on a right-side line range. `start === end`
  // for a single-line click; shift-click or text selection across rows
  // extends to a range, which GitHub stores as start_line + line so the
  // thread can highlight the whole block.
  const [selectedRange, setSelectedRange] = useState<{
    start: number;
    end: number;
  } | null>(null);
  const [composer, setComposer] = useState<
    | { kind: "comment"; start: number; end: number }
    | { kind: "suggestion"; start: number; end: number }
    | null
  >(null);
  const [postError, setPostError] = useState<string | null>(null);

  // Monaco editor + anchor bookkeeping.
  const diffEditorRef = useRef<editor.IStandaloneDiffEditor | null>(null);
  const monacoRef = useRef<Monaco | null>(null);
  // Re-read tokens + reapply the Aura theme on runtime theme/variant change.
  useEffect(() => {
    const monaco = monacoRef.current;
    if (!monaco) return;
    ensureAuraThemes(monaco);
    monaco.editor.setTheme(auraThemeName(isDark));
  }, [isDark, variant]);
  const anchorLayerRef = useRef<HTMLDivElement | null>(null);
  const anchorNodesRef = useRef<Map<number, HTMLDivElement>>(new Map());
  // Tracks which lines we've already announced upward so we don't fire
  // duplicate onRegisterRow callbacks on every layout tick.
  const announcedAnchorsRef = useRef<Set<number>>(new Set());
  // SS.3 — readable inside the stable onMount closure so onMouseDown
  // can activate the matching floating thread card without re-binding
  // the Monaco listener whenever comments change.
  const anchorLinesSetRef = useRef<Set<number>>(new Set());
  // SS.3.2 — clicked-line → anchor-line, so a click anywhere inside a
  // multi-line range (e.g. line 17 of a 14..20 comment) activates the
  // single canonical anchor (14) instead of registering as "no thread".
  const anchorByLineRef = useRef<Map<number, number>>(new Map());
  // SS.3.2 — anchor-line → {startLine, endLine}, so the decoration
  // effect can paint the full row range when the active comment spans
  // multiple lines.
  const rangeByAnchorRef = useRef<
    Map<number, { startLine: number; endLine: number }>
  >(new Map());
  // SS.3 — Monaco decoration ids for the active-thread line highlight.
  // Stored so we can clear them when activeKey changes.
  const activeDecorationsRef = useRef<string[]>([]);

  // Reset composer / selection when the file changes.
  useEffect(() => {
    setSelectedRange(null);
    setPostError(null);
    setComposer(null);
  }, [filePath]);

  // Inline-mode threads (parent didn't opt into fluid layout). Group
  // and render alongside the diff.
  const threads = useMemo(
    () => (fluidMode ? [] : groupThreads(comments ?? [])),
    [comments, fluidMode],
  );

  // SS.3.2 — derive range info from comments. Each thread root has a
  // single anchor (the START of its range — `start_line` if present,
  // otherwise `line`). The map's value records the full {start, end}
  // span so the active-row highlight can paint every line in the range.
  // `anchorByLine` reverses that: every line covered by any range maps
  // back to its anchor, which lets onMouseDown register a click in the
  // middle of a multi-line comment as a hit on the canonical anchor
  // (otherwise lines 15..19 of a 14..20 range would read as "no thread").
  const rangeInfo = useMemo(() => {
    const byAnchor = new Map<number, { startLine: number; endLine: number }>();
    const anchorByLine = new Map<number, number>();
    type Anchorable = {
      is_issue_comment: boolean;
      in_reply_to: number | null;
      line: number | null;
      start_line: number | null;
      path: string | null;
    };
    const list: Anchorable[] = fluidMode
      ? (comments ?? [])
      : threads.map((t) => t.root);
    for (const c of list) {
      if (c.is_issue_comment) continue;
      if (c.in_reply_to != null) continue;
      if (c.line == null) continue;
      if (fluidMode && c.path !== filePath) continue;
      const endLine = c.line;
      const startLine = c.start_line ?? c.line;
      const anchor = startLine;
      byAnchor.set(anchor, { startLine, endLine });
      for (let i = startLine; i <= endLine; i++) {
        anchorByLine.set(i, anchor);
      }
    }
    return { byAnchor, anchorByLine };
  }, [fluidMode, comments, threads, filePath]);

  // Right-side anchor lines that get a thread (used to synthesize
  // anchors in fluid mode AND to lay out the inline-mode column).
  // SS.3.2 — these are the START of each range, so floating cards line
  // up with the first highlighted row instead of the last.
  const anchorLines = useMemo(
    () => Array.from(rangeInfo.byAnchor.keys()).sort((a, b) => a - b),
    [rangeInfo],
  );

  // Map anchor (start) line → thread (inline mode only).
  const threadByLine = useMemo(() => {
    const m = new Map<number, ThreadGroup>();
    for (const t of threads) {
      const anchor = t.root.start_line ?? t.root.line;
      if (anchor != null) m.set(anchor, t);
    }
    return m;
  }, [threads]);

  // SS.3 — mirror anchor maps into refs so the stable Monaco
  // onMouseDown closure can ask "is this line inside any thread range?"
  // without re-binding on every comments change.
  useEffect(() => {
    anchorLinesSetRef.current = new Set(rangeInfo.anchorByLine.keys());
    anchorByLineRef.current = rangeInfo.anchorByLine;
    rangeByAnchorRef.current = rangeInfo.byAnchor;
  }, [rangeInfo]);

  // SS.3.1 — paint the active-thread line with a Monaco
  // lineDecoration. Without this the only highlight was the 1px-tall
  // anchor div's ring, which read as "a stripe" instead of "the code
  // is selected". isWholeLine makes the row background extend across
  // the full editor width, matching real text-selection feel.
  useEffect(() => {
    const ed = diffEditorRef.current;
    if (!ed) return;
    const modifiedEditor = ed.getModifiedEditor();
    const prevIds = activeDecorationsRef.current;
    let nextIds: string[] = [];
    if (activeKey) {
      const [path, lineStr] = activeKey.split("@");
      const anchor = Number(lineStr);
      if (path === filePath && Number.isFinite(anchor) && anchor > 0) {
        // SS.3.2 — multi-line ranges paint every covered row, not just
        // the anchor. Falls back to the anchor line for single-line
        // comments (or if the range info hasn't been resynced yet).
        const range = rangeByAnchorRef.current.get(anchor) ?? {
          startLine: anchor,
          endLine: anchor,
        };
        nextIds = modifiedEditor.deltaDecorations(prevIds, [
          {
            range: {
              startLineNumber: range.startLine,
              endLineNumber: range.endLine,
              startColumn: 1,
              endColumn: 1,
            },
            options: {
              isWholeLine: true,
              className: "aura-pr-active-line",
              linesDecorationsClassName: "aura-pr-active-line-margin",
            },
          },
        ]);
      } else {
        nextIds = modifiedEditor.deltaDecorations(prevIds, []);
      }
    } else {
      nextIds = modifiedEditor.deltaDecorations(prevIds, []);
    }
    activeDecorationsRef.current = nextIds;
    // rangeInfo is in the deps so a comment landing after activate
    // (optimistic post → server confirm) repaints the correct range.
  }, [activeKey, filePath, mounted, rangeInfo]);

  // ── anchor synthesis ──────────────────────────────────────────────
  //
  // For every line in `anchorLines` we lazily create a zero-height
  // <div> inside `anchorLayerRef`. The div's top is updated whenever
  // Monaco re-lays-out (content, theme, mode toggle, scroll). We pass
  // each anchor up via onRegisterRow so PrThreadColumn can attach a
  // PrThreadCard at the right vertical position. The actual
  // bubble itself lives in PrThreadColumn — we're just a positioner.

  const layoutAnchors = useCallback(() => {
    const ed = diffEditorRef.current;
    const layer = anchorLayerRef.current;
    if (!ed || !layer) return;
    const modifiedEditor = ed.getModifiedEditor();
    const modifiedDom = modifiedEditor.getDomNode();
    if (!modifiedDom) return;
    const layerRect = layer.getBoundingClientRect();
    const modifiedRect = modifiedDom.getBoundingClientRect();
    // Offset from the layer's top to the modified pane's top — anchors
    // are absolutely positioned inside the layer, and Monaco's
    // getTopForLineNumber is relative to the modified pane's content.
    const modifiedOffset = modifiedRect.top - layerRect.top;
    const scrollTop = modifiedEditor.getScrollTop();

    const wanted = new Set<number>();
    for (const line of anchorLines) {
      wanted.add(line);
      const top = modifiedEditor.getTopForLineNumber(line) - scrollTop;
      let node = anchorNodesRef.current.get(line);
      if (!node) {
        node = document.createElement("div");
        node.dataset.prDiffAnchor = String(line);
        // 1px high, full width — invisible but with a real layout box so
        // measurement (getBoundingClientRect) works for PrThreadColumn.
        node.style.position = "absolute";
        node.style.left = "0";
        node.style.right = "0";
        node.style.height = "1px";
        node.style.pointerEvents = "none";
        layer.appendChild(node);
        anchorNodesRef.current.set(line, node);
      }
      node.style.top = `${modifiedOffset + top}px`;

      if (onRegisterRow && !announcedAnchorsRef.current.has(line)) {
        announcedAnchorsRef.current.add(line);
        onRegisterRow(line, node);
      }
    }

    // Tear down anchors for lines that no longer have threads.
    for (const [line, node] of anchorNodesRef.current) {
      if (wanted.has(line)) continue;
      anchorNodesRef.current.delete(line);
      announcedAnchorsRef.current.delete(line);
      if (onRegisterRow) onRegisterRow(line, null);
      node.remove();
    }
  }, [anchorLines, onRegisterRow]);

  // Re-run layout whenever the set of anchor lines changes (new
  // comment posted) or the editor mounts.
  useLayoutEffect(() => {
    layoutAnchors();
  }, [layoutAnchors, mounted, renderSideBySide]);

  // Cleanup on unmount: detach every anchor we ever announced so the
  // parent registry drops them.
  useEffect(() => {
    return () => {
      if (onRegisterRow) {
        for (const line of announcedAnchorsRef.current) {
          onRegisterRow(line, null);
        }
      }
      announcedAnchorsRef.current.clear();
      for (const node of anchorNodesRef.current.values()) node.remove();
      anchorNodesRef.current.clear();
    };
    // onRegisterRow is a stable callback per parent; intentionally not
    // listed as a dep so we don't tear down anchors mid-session if the
    // parent re-creates the function.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── editor mount + listeners ──────────────────────────────────────

  const onMount: DiffOnMount = useCallback(
    (editorInstance, monaco) => {
      diffEditorRef.current = editorInstance;
      monacoRef.current = monaco;

      const modifiedEditor = editorInstance.getModifiedEditor();
      const originalEditor = editorInstance.getOriginalEditor();

      // Click in the modified pane → seed a single-line selection (the
      // action bar surfaces immediately, matching legacy UX). Range
      // extension is handled by the cursor-selection listener below.
      // SS.3 — if the clicked line has a thread, also activate its
      // floating card so the comment pops out next to the line.
      modifiedEditor.onMouseDown((e) => {
        const line = e.target?.position?.lineNumber;
        if (typeof line === "number" && line > 0) {
          setSelectedRange({ start: line, end: line });
          // SS.3.2 — clicks anywhere inside a multi-line range resolve
          // to that range's anchor (start) line, so the matching
          // floating card activates regardless of where in the block
          // the user clicked.
          const anchor = anchorByLineRef.current.get(line);
          if (anchor != null) {
            setActiveKey(`${filePath}@${anchor}`);
          } else {
            setActiveKey(null);
          }
        }
      });

      // Track text selection across rows so users can drag/shift-click
      // through multiple lines and post a single ranged review comment.
      // Selection endpoints can arrive in either order, so we normalise
      // low→high.
      modifiedEditor.onDidChangeCursorSelection((e) => {
        const s = e.selection;
        if (!s) return;
        const a = s.startLineNumber;
        const b = s.endLineNumber;
        if (typeof a !== "number" || typeof b !== "number") return;
        const start = Math.min(a, b);
        const end = Math.max(a, b);
        setSelectedRange({ start, end });
      });

      // Click in the original pane is treated as a removal-side select.
      // We don't post comments against the left side (GitHub REST
      // requires a RIGHT-side anchor for inline comments unless we
      // switch to the multi-line shape), so we clear the selection
      // instead of trying to map it to a right-side line.
      originalEditor.onMouseDown(() => {
        setSelectedRange(null);
      });

      // Re-position anchors whenever Monaco's layout changes — content
      // height swaps, scroll, font load, splitter drag, theme switch
      // (rare but the css changes line heights), and the inline-vs-
      // side-by-side toggle.
      modifiedEditor.onDidScrollChange(() => layoutAnchors());
      modifiedEditor.onDidLayoutChange(() => layoutAnchors());
      modifiedEditor.onDidContentSizeChange(() => layoutAnchors());
      editorInstance.onDidUpdateDiff(() => layoutAnchors());
      editorInstance.onDidChangeModel(() => layoutAnchors());

      // First layout after mount — Monaco's models settle async.
      requestAnimationFrame(() => layoutAnchors());
    },
    [layoutAnchors, filePath, setActiveKey],
  );

  // ── composer plumbing ─────────────────────────────────────────────

  const startComment = () => {
    if (!selectedRange) return;
    setPostError(null);
    setComposer({
      kind: "comment",
      start: selectedRange.start,
      end: selectedRange.end,
    });
  };

  const startSuggestion = () => {
    if (!selectedRange) return;
    setPostError(null);
    setComposer({
      kind: "suggestion",
      start: selectedRange.start,
      end: selectedRange.end,
    });
  };

  // Submit. Throws on failure so ComposerHost / ComposerBody can render
  // the error inline + keep the textarea contents intact for retry. We
  // also mirror the error to local `postError` so callers (action bar,
  // future toast) can react.
  const onSubmit = async (text: string) => {
    if (!composer) return;
    let postBody = text;
    if (composer.kind === "suggestion") {
      // Suggestion fence covers EVERY line in the selected range, so a
      // multi-line suggestion can rewrite a whole block — not just the
      // anchor line. Single-line selection keeps the legacy shape.
      const modLines = sides.modified.split("\n");
      const block: string[] = [];
      for (let i = composer.start; i <= composer.end; i++) {
        block.push(modLines[i - 1] ?? "");
      }
      postBody = `${text.trim()}\n\n\`\`\`suggestion\n${block.join("\n")}\n\`\`\``.trim();
    }
    try {
      setPostError(null);
      const c = await prCommentPost(
        repoRoot,
        prNumber,
        filePath,
        composer.end,
        postBody,
        "RIGHT",
        composer.start !== composer.end ? composer.start : undefined,
      );
      onPosted?.(c);
      setComposer(null);
      setSelectedRange(null);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("comment post failed", e);
      setPostError(msg);
      throw e instanceof Error ? e : new Error(msg);
    }
  };

  const hasInlineThreads = !fluidMode && threads.length > 0;

  // ── render ────────────────────────────────────────────────────────

  // Lazy placeholder. Renders a stable "loading…" panel that the
  // IntersectionObserver in the useEffect above is watching.
  if (!mounted) {
    return (
      <div
        ref={placeholderRef}
        className="ui-pr-diff-loading"
      >
        <AsciiSpinner size={12} />
        <span>Reading this change…</span>
      </div>
    );
  }

  // Editor height: estimated from the larger of the two sides, capped
  // so a 5,000-line file doesn't blow out the page. The user can scroll
  // inside the editor for anything taller than this.
  const lineCount = Math.max(
    sides.modified.split("\n").length,
    sides.original.split("\n").length,
    1,
  );
  const editorHeight = Math.min(
    Math.max(lineCount * 20 + 32, 200),
    640,
  );

  return (
    <div className="ui-pr-diff-body" data-pr-diff-body={filePath}>
      <div className="ui-pr-diff-main">
        <div className="ui-pr-diff-editor">
          {/* The patch's own toolbar: what a selected range can do, and how
              to lay the two sides out. The file's path sits in the bar above. */}
          <div className="ui-pr-diff-toolbar">
            {selectedRange != null && !composer && (
              <span className="ui-pr-diff-range">
                <span className="ui-pr-diff-range-label">
                  {selectedRange.start === selectedRange.end
                    ? `Line ${selectedRange.start}`
                    : `Lines ${selectedRange.start}–${selectedRange.end}`}
                </span>
                <Button variant="secondary" size="xs" onClick={startComment}>
                  <CommentIcon /> Comment
                </Button>
                <Button variant="secondary" size="xs" onClick={startSuggestion}>
                  <SuggestIcon /> Suggest
                </Button>
              </span>
            )}
            {oneSidedFile ? (
              <span className="ui-pr-diff-side">
                {sides.original.length === 0 ? "New file" : "Deleted"}
              </span>
            ) : (
              <ToggleGroup
                type="single"
                variant="outline"
                size="sm"
                className="ui-pr-diff-layout"
                aria-label="Diff layout"
                value={renderSideBySide ? "split" : "unified"}
                // A single group reports "" when the pressed item is pressed
                // again; the patch always has a layout.
                onValueChange={(next) => {
                  if (next) setRenderSideBySide(next === "split");
                }}
              >
                <ToggleGroupItem value="split" title="Previous and new side by side">
                  Split
                </ToggleGroupItem>
                <ToggleGroupItem value="unified" title="One column, removed lines above added">
                  Unified
                </ToggleGroupItem>
              </ToggleGroup>
            )}
          </div>

          {/* Editor + anchor layer share the same parent so anchor
           *  coordinates can use the layer as their reference frame. */}
          <div className="ui-pr-diff-canvas" style={{ height: editorHeight }}>
            <DiffEditor
              key={`${filePath}:${!oneSidedFile && renderSideBySide ? "split" : "unified"}`}
              original={sides.original}
              modified={sides.modified}
              language={language}
              theme={theme}
              beforeMount={(monaco) => {
                ensureAuraThemes(monaco);
                configureMonacoDiagnostics(monaco);
              }}
              onMount={onMount}
              options={{
                readOnly: true,
                originalEditable: false,
                renderSideBySide: !oneSidedFile && renderSideBySide,
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
                ignoreTrimWhitespace: false,
              }}
            />
            <div
              ref={anchorLayerRef}
              className="ui-pr-diff-anchors"
              aria-hidden
            />
          </div>
        </div>

        {hasInlineThreads && (
          <div className="ui-pr-diff-rail">
            {anchorLines.map((line) => {
              const t = threadByLine.get(line);
              if (!t) return null;
              return (
                <InlineThreadCard
                  key={t.root.id}
                  thread={t}
                  repoRoot={repoRoot}
                  prNumber={prNumber}
                  onPosted={onPosted}
                />
              );
            })}
          </div>
        )}
      </div>

      {composer && (
        <ComposerHost
          repoRoot={repoRoot}
          prNumber={prNumber}
          start={composer.start}
          end={composer.end}
          kind={composer.kind}
          onSubmit={onSubmit}
          onCancel={() => {
            setComposer(null);
            setPostError(null);
          }}
          error={postError}
        />
      )}
    </div>
  );
}

// ── unified-diff → two-buffer materialisation ──────────────────────

type Sides = { original: string; modified: string };

/** Rebuild the left (original) and right (modified) text from the
 *  parsed diff lines so Monaco's DiffEditor has something to diff.
 *  Context lines appear in both buffers; removals only in original;
 *  additions only in modified. Hunk markers and meta lines are
 *  ignored — they'd corrupt either pane. */
function buildSides(lines: Line[]): Sides {
  const left: string[] = [];
  const right: string[] = [];
  for (const l of lines) {
    if (l.kind === "meta" || l.kind === "hunk") continue;
    const text = l.raw.length > 0 ? l.raw.slice(1) : "";
    if (l.kind === "add") {
      right.push(text);
    } else if (l.kind === "remove") {
      left.push(text);
    } else {
      // context
      left.push(text);
      right.push(text);
    }
  }
  return { original: left.join("\n"), modified: right.join("\n") };
}

// ── composer ───────────────────────────────────────────────────────

function ComposerHost({
  repoRoot,
  prNumber,
  start,
  end,
  kind,
  onSubmit,
  onCancel,
  error,
}: {
  repoRoot: string;
  prNumber: number;
  start: number;
  end: number;
  kind: "comment" | "suggestion";
  onSubmit: (body: string) => Promise<void>;
  onCancel: () => void;
  error?: string | null;
}) {
  const target = start === end ? `line ${start}` : `lines ${start}–${end}`;
  return (
    <div className="ui-pr-thread-reply ui-pr-diff-composer">
      <div className="ui-pr-diff-composer-label">
        {kind === "suggestion"
          ? `Suggest a change on ${target}`
          : `Add a review comment on ${target}`}
      </div>
      <ComposerBody
        repoRoot={repoRoot}
        prNumber={prNumber}
        kind={kind}
        onSubmit={onSubmit}
        onCancel={onCancel}
        error={error ?? null}
      />
    </div>
  );
}

/** The paths this PR changed, for "@" mentions in the composer. Instant
 *  from the detail cache when the PR has been opened (it always has — the
 *  diff being commented on came from the same detail), refreshed in the
 *  background otherwise. */
function usePrChangedFiles(repoRoot: string, prNumber: number) {
  const [files, setFiles] = useState<string[]>(
    () => getPrDetailCached(repoRoot, prNumber)?.files.map((f) => f.path) ?? [],
  );
  const [loading, setLoading] = useState(files.length === 0);
  useEffect(() => {
    let alive = true;
    fetchPrDetail(repoRoot, prNumber)
      .then((d) => {
        if (alive) setFiles(d.files.map((f) => f.path));
      })
      .catch(() => {
        // Keep whatever the cache gave us; the picker says "no files"
        // honestly when that is nothing.
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [repoRoot, prNumber]);
  return { files, loading };
}

function ComposerBody({
  repoRoot,
  prNumber,
  kind,
  onSubmit,
  onCancel,
  error,
}: {
  repoRoot: string;
  prNumber: number;
  kind: "comment" | "suggestion";
  onSubmit: (body: string) => Promise<void>;
  onCancel: () => void;
  error?: string | null;
}) {
  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);

  // "@" mentions over the PR's changed files. `mention` is the "@word" the
  // caret sits in (offset of the "@" + what follows), recomputed on every
  // edit and caret move; null closes the picker. Picking replaces exactly
  // that span with the backticked path.
  const { files: prFiles, loading: prFilesLoading } = usePrChangedFiles(repoRoot, prNumber);
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [mentionDismissed, setMentionDismissed] = useState<number | null>(null);
  const syncMention = (el: HTMLTextAreaElement | null) => {
    if (!el) return;
    const m = mentionQueryAt(el.value, el.selectionStart ?? el.value.length);
    // Esc closed the picker for THIS "@"; it stays closed until a new one.
    if (m && mentionDismissed === m.start) {
      setMention(null);
      return;
    }
    setMention(m);
  };
  const pickFile = (path: string) => {
    const el = ref.current;
    if (!el || !mention) return;
    const caret = el.selectionStart ?? el.value.length;
    const before = el.value.slice(0, mention.start);
    const after = el.value.slice(caret);
    const inserted = fileMentionText(path);
    const next = `${before}${inserted}${after}`;
    setText(next);
    setMention(null);
    requestAnimationFrame(() => {
      el.focus();
      const at = before.length + inserted.length;
      el.setSelectionRange(at, at);
    });
  };
  const submit = async () => {
    if (!text.trim() && kind === "comment") return;
    setSubmitting(true);
    try {
      await onSubmit(text);
    } catch {
      // Parent surfaces the error via the `error` prop; the throw is
      // there so we can keep the textarea contents intact for retry
      // instead of clearing on a hidden failure.
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <>
      {error ? (
        <Alert variant="destructive" className="ui-pr-diff-composer-error">
          <AlertDescription>Post failed: {error}</AlertDescription>
        </Alert>
      ) : null}
      <Toolbar
        onWrap={(prefix, suffix) => wrap(ref.current, prefix, suffix, setText)}
      />
      <div className="ui-pr-diff-composer-field">
        {mention && (
          <PrFileMentionPicker
            files={prFiles}
            query={mention.query}
            loading={prFilesLoading}
            onPick={pickFile}
            onClose={() => {
              setMentionDismissed(mention.start);
              setMention(null);
            }}
            className="ui-pr-diff-mention"
          />
        )}
      <Textarea
        ref={ref}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setMentionDismissed(null);
          syncMention(e.target);
        }}
        onKeyUp={(e) => syncMention(e.currentTarget)}
        onClick={(e) => syncMention(e.currentTarget)}
        onBlur={() => setMention(null)}
        rows={4}
        placeholder={
          kind === "suggestion"
            ? "Explain the change (the anchored line will be appended as a suggestion block)…"
            : "Leave a review comment… Type @ to mention a changed file"
        }
        onKeyDown={(e) => {
          const meta = e.metaKey || e.ctrlKey;
          if (meta && e.key === "Enter") {
            e.preventDefault();
            void submit();
            return;
          }
          // The toolbar above says "Bold (⌘B)" and "Italic (⌘I)". Until now
          // neither key did that: ⌘I was unbound and ⌘B reached the global
          // keymap, which collapsed the sidebar mid-sentence.
          if (meta && !e.shiftKey && !e.altKey) {
            const k = e.key.toLowerCase();
            if (k === "b" || k === "i") {
              e.preventDefault();
              const mark = k === "b" ? "**" : "_";
              wrap(ref.current, mark, mark, setText);
            }
          }
        }}
        className="ui-pr-diff-composer-input"
      />
      </div>
      <div className="ui-pr-thread-reply-actions">
        <span className="ui-pr-diff-composer-hint">
          ⌘ + Enter to submit · markdown supported · @ mentions a file
        </span>
        <Button variant="ghost" size="xs" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size="xs"
          onClick={submit}
          disabled={submitting || (!text.trim() && kind === "comment")}
        >
          {submitting
            ? "Posting…"
            : kind === "suggestion"
              ? "Add suggestion"
              : "Comment"}
        </Button>
      </div>
    </>
  );
}

// ── toolbar ────────────────────────────────────────────────────────

function Toolbar({
  onWrap,
}: {
  onWrap: (prefix: string, suffix: string) => void;
}) {
  const Btn = ({
    onClick,
    title,
    children,
  }: {
    onClick: () => void;
    title: string;
    children: React.ReactNode;
  }) => (
    <Button
      type="button"
      variant="ghost"
      size="iconXs"
      onClick={onClick}
      title={title}
      aria-label={title}
    >
      {children}
    </Button>
  );
  return (
    <div className="ui-pr-diff-format" role="toolbar" aria-label="Formatting">
      <Btn title="Bold (⌘B)" onClick={() => onWrap("**", "**")}>
        <b>B</b>
      </Btn>
      <Btn title="Italic (⌘I)" onClick={() => onWrap("_", "_")}>
        <i>I</i>
      </Btn>
      <Btn title="Strikethrough" onClick={() => onWrap("~~", "~~")}>
        <s>S</s>
      </Btn>
      <Separator orientation="vertical" />
      <Btn title="Inline code" onClick={() => onWrap("`", "`")}>
        {"‹›"}
      </Btn>
      <Btn
        title="Code block"
        onClick={() => onWrap("\n```\n", "\n```\n")}
      >
        {"▤"}
      </Btn>
      <Btn title="Link" onClick={() => onWrap("[", "](url)")}>
        ↗
      </Btn>
      <Separator orientation="vertical" />
      <Btn title="Bulleted list" onClick={() => onWrap("\n- ", "")}>
        •
      </Btn>
      <Btn title="Numbered list" onClick={() => onWrap("\n1. ", "")}>
        1.
      </Btn>
    </div>
  );
}

function wrap(
  el: HTMLTextAreaElement | null,
  prefix: string,
  suffix: string,
  setText: React.Dispatch<React.SetStateAction<string>>,
) {
  if (!el) return;
  const { selectionStart, selectionEnd, value } = el;
  const before = value.slice(0, selectionStart);
  const sel = value.slice(selectionStart, selectionEnd);
  const after = value.slice(selectionEnd);
  const next = `${before}${prefix}${sel}${suffix}${after}`;
  setText(next);
  requestAnimationFrame(() => {
    el.focus();
    const at = before.length + prefix.length + sel.length;
    el.setSelectionRange(at, at);
  });
}

// ── icons ──────────────────────────────────────────────────────────

function CommentIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
      <path
        d="M2 3h12v8H6l-3 3v-3H2V3z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SuggestIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
      <path
        d="M3 8l3 3 7-7"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// ── parsing ────────────────────────────────────────────────────────

function parseDiff(body: string): Line[] {
  const out: Line[] = [];
  let leftCur = 0;
  let rightCur = 0;
  for (const raw of body.split("\n")) {
    if (
      raw.startsWith("diff --git") ||
      raw.startsWith("index ") ||
      raw.startsWith("--- ") ||
      raw.startsWith("+++ ")
    ) {
      out.push({ raw, kind: "meta", leftLine: null, rightLine: null });
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      leftCur = parseInt(hunk[1], 10);
      rightCur = parseInt(hunk[2], 10);
      out.push({ raw, kind: "hunk", leftLine: null, rightLine: null });
      continue;
    }
    if (raw.startsWith("+")) {
      out.push({
        raw,
        kind: "add",
        leftLine: null,
        rightLine: rightCur,
      });
      rightCur += 1;
      continue;
    }
    if (raw.startsWith("-")) {
      out.push({
        raw,
        kind: "remove",
        leftLine: leftCur,
        rightLine: null,
      });
      leftCur += 1;
      continue;
    }
    // Context or empty
    out.push({
      raw,
      kind: "context",
      leftLine: leftCur,
      rightLine: rightCur,
    });
    leftCur += 1;
    rightCur += 1;
  }
  return out;
}

// ── threads drawn beside this diff, one under another ─────────────

function InlineThreadCard({
  thread,
  repoRoot,
  prNumber,
  onPosted,
}: {
  thread: ThreadGroup;
  repoRoot: string;
  prNumber: number;
  onPosted?: (c: PrComment) => void;
}) {
  return (
    <div className="ui-pr-thread-inline">
      <PrThreadCard thread={thread} repoRoot={repoRoot} prNumber={prNumber} onPosted={onPosted} />
    </div>
  );
}
