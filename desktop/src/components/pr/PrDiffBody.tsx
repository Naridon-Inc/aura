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
import ReactMarkdown from "react-markdown";
import { monogram } from "../../lib/monogram";
import remarkGfm from "remark-gfm";

import { installMonacoEnvironment } from "../../lib/monacoEnv";
import { languageSlugForPath } from "../../lib/monacoLanguage";
import { configureMonacoDiagnostics } from "../../lib/monacoDiagnostics";
import { useResolvedTheme, useThemeVariant } from "../../lib/themeStore";
import { auraThemeName, ensureAuraThemes } from "../../lib/monacoTheme";
import {
  api,
  type PrComment,
  type PrCommentReaction,
  type ReactionContent,
} from "../../lib/api";
import { usePrThreadActive } from "./PrThreadColumn";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { Button } from "../ui/button";
import { FixWithAgentButton } from "../agent/FixWithAgentButton";
import { relativeAgeFromIso } from "../../lib/relativeTime";
import { useDismiss } from "../../lib/useDismiss";

installMonacoEnvironment();

// Seed prompt for the "Fix with agent" handoff — bakes the file, line, and
// the review-comment text into a focused instruction so the chosen agent
// opens already knowing what to address. W4 review loop (cross-agent).
function buildCommentFixPrompt(root: PrComment): string {
  const where = !root.path
    ? "this pull request"
    : root.start_line && root.start_line !== root.line
      ? `${root.path} (lines ${root.start_line}–${root.line})`
      : root.line
        ? `${root.path} (line ${root.line})`
        : root.path;
  return [
    `Address this code-review comment in ${where}.`,
    "",
    "Comment:",
    root.body.trim(),
    "",
    "Open the file, make the fix, and briefly explain what you changed. If the comment is a question or isn't actionable, reply with your answer instead of editing.",
  ].join("\n");
}

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
   *  to match GitHub / Graphite. The header toolbar inside the editor
   *  exposes the toggle. */
  initialRenderMode?: "side-by-side" | "inline";
  /** v0.2.12 — when true, mount immediately. When false, wait for an
   *  IntersectionObserver hit before mounting Monaco. PrFilesSection
   *  flips this to false for the 6th+ file in a long PR. */
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

/** Maximum number of editors PrFilesSection mounts eagerly. Files past
 *  this index render a placeholder card that mounts on first viewport
 *  intersection. Centralised here so callers can stay numeric-free. */
export const PR_DIFF_EAGER_MOUNT_LIMIT = 5;

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
  // thread can highlight the whole block (Graphite parity).
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
  // FloatingThreadCard at the right vertical position. The actual
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
      // through multiple lines and post a single ranged review comment
      // (Graphite parity). Selection endpoints can arrive in either
      // order, so we normalise low→high.
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
      const c = await api.prCommentPost(
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
        className="w-full h-[240px] flex items-center justify-center gap-1.5 bg-bg-content text-sm text-text-4"
      >
        <AsciiSpinner className="text-2xs" />
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
    <div className="w-full relative" data-pr-diff-body={filePath}>
      <div className="flex w-full">
        <div className="flex-1 min-w-0 relative">
          {/* Per-file toolbar — render mode toggle + action bar */}
          <div className="flex items-center gap-2 px-3 h-7 border-b border-line-soft/60 bg-bg-1/30 text-xs">
            <span className="font-mono text-text-3 truncate">{filePath}</span>
            {oneSidedFile ? (
              <span className="section-label ml-auto">
                {sides.original.length === 0 ? "new file" : "deleted"}
              </span>
            ) : (
              <span className="ml-auto inline-flex items-center rounded border border-line-soft overflow-hidden">
                <Button
                  variant={renderSideBySide ? "secondary" : "ghost"}
                  size="xs"
                  onClick={() => setRenderSideBySide(true)}
                  className="h-5 rounded-none border-0 text-xs"
                  title="Side-by-side diff"
                >
                  Split
                </Button>
                <span className="w-px h-3 bg-line-soft" />
                <Button
                  variant={!renderSideBySide ? "secondary" : "ghost"}
                  size="xs"
                  onClick={() => setRenderSideBySide(false)}
                  className="h-5 rounded-none border-0 text-xs"
                  title="Unified (inline) diff"
                >
                  Unified
                </Button>
              </span>
            )}
            {selectedRange != null && !composer && (
              <span className="inline-flex items-center gap-1 ml-2">
                <span className="text-text-4">
                  {selectedRange.start === selectedRange.end
                    ? `line ${selectedRange.start}`
                    : `lines ${selectedRange.start}–${selectedRange.end}`}
                </span>
                <Button
                  variant="subtle"
                  size="xs"
                  onClick={startComment}
                  className="h-5 gap-1 text-xs"
                >
                  <CommentIcon /> Comment
                </Button>
                <Button
                  variant="subtle"
                  size="xs"
                  onClick={startSuggestion}
                  className="h-5 gap-1 text-xs"
                >
                  <SuggestIcon /> Suggest
                </Button>
              </span>
            )}
          </div>

          {/* Editor + anchor layer share the same parent so anchor
           *  coordinates can use the layer as their reference frame. */}
          <div className="relative" style={{ height: editorHeight }}>
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
              className="absolute inset-0 pointer-events-none"
              aria-hidden
            />
          </div>
        </div>

        {hasInlineThreads && (
          <div className="w-[320px] flex-shrink-0 relative border-l border-line-soft bg-bg-1/30">
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
  start,
  end,
  kind,
  onSubmit,
  onCancel,
  error,
}: {
  start: number;
  end: number;
  kind: "comment" | "suggestion";
  onSubmit: (body: string) => Promise<void>;
  onCancel: () => void;
  error?: string | null;
}) {
  const target = start === end ? `line ${start}` : `lines ${start}–${end}`;
  return (
    <div className="border-t border-line-soft bg-bg-1 px-3 py-2.5 sticky bottom-0">
      <div className="section-label mb-1.5">
        {kind === "suggestion"
          ? `Suggest a change on ${target}`
          : `Add a review comment on ${target}`}
      </div>
      <ComposerBody
        kind={kind}
        onSubmit={onSubmit}
        onCancel={onCancel}
        error={error ?? null}
      />
    </div>
  );
}

function ComposerBody({
  kind,
  onSubmit,
  onCancel,
  error,
}: {
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
    <div className="space-y-1.5">
      {error ? (
        <div className="rounded-md border border-red/40 bg-red/10 px-2.5 py-1.5 text-xs text-red font-mono whitespace-pre-wrap break-all">
          Post failed: {error}
        </div>
      ) : null}
      <Toolbar
        onWrap={(prefix, suffix) => wrap(ref.current, prefix, suffix, setText)}
      />
      <textarea
        ref={ref}
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={4}
        placeholder={
          kind === "suggestion"
            ? "Explain the change (the anchored line will be appended as a suggestion block)…"
            : "Leave a review comment…"
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
        className="w-full bg-bg-content border border-line-soft rounded-md p-2 text-sm text-text-1 placeholder:text-text-4 outline-none focus:ring-1 focus:ring-accent font-mono resize-y"
      />
      <div className="flex items-center gap-2 text-xs text-text-4">
        <span>⌘ + Enter to submit · markdown supported</span>
        <div className="flex-1" />
        <Button variant="ghost" size="xs" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          variant="accentSoft"
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
    </div>
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
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="w-7 h-6 rounded text-text-3 hover:text-text-1 hover:bg-state-hover flex items-center justify-center text-sm"
    >
      {children}
    </button>
  );
  return (
    <div className="inline-flex items-center gap-0.5 bg-bg-content border border-line-soft rounded-md px-1 py-0.5">
      <Btn title="Bold (⌘B)" onClick={() => onWrap("**", "**")}>
        <b>B</b>
      </Btn>
      <Btn title="Italic (⌘I)" onClick={() => onWrap("_", "_")}>
        <i>I</i>
      </Btn>
      <Btn title="Strikethrough" onClick={() => onWrap("~~", "~~")}>
        <span className="line-through">S</span>
      </Btn>
      <span className="w-px h-3 bg-line-soft mx-0.5" />
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
      <span className="w-px h-3 bg-line-soft mx-0.5" />
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

// ── inline-mode thread card (legacy compatibility) ────────────────

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
    <div className="border-b border-line-soft/60 last:border-b-0">
      <FloatingThreadCard
        top={0}
        thread={thread}
        repoRoot={repoRoot}
        prNumber={prNumber}
        onPosted={onPosted}
        embed
      />
    </div>
  );
}

// ── floating threads (preserved exports — consumed by
//    PrFilesSection + PrThreadColumn) ──────────────────────────────

export type ThreadGroup = {
  root: PrComment;
  replies: PrComment[];
};

export function groupThreads(comments: PrComment[]): ThreadGroup[] {
  const byId = new Map<number, PrComment>();
  for (const c of comments) byId.set(c.id, c);
  const roots: PrComment[] = [];
  const repliesByRoot = new Map<number, PrComment[]>();
  for (const c of comments) {
    if (c.is_issue_comment) continue;
    if (c.line == null) continue;
    if (c.in_reply_to == null) {
      roots.push(c);
      continue;
    }
    let rootId = c.in_reply_to;
    let guard = 0;
    while (guard++ < 16) {
      const parent = byId.get(rootId);
      if (!parent || parent.in_reply_to == null) break;
      rootId = parent.in_reply_to;
    }
    const arr = repliesByRoot.get(rootId) ?? [];
    arr.push(c);
    repliesByRoot.set(rootId, arr);
  }
  roots.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
  return roots.map((root) => ({
    root,
    replies: (repliesByRoot.get(root.id) ?? []).sort((a, b) =>
      a.created_at.localeCompare(b.created_at),
    ),
  }));
}

export function FloatingThreadCard({
  top,
  thread,
  repoRoot,
  prNumber,
  onPosted,
  embed = false,
}: {
  top: number;
  thread: ThreadGroup;
  repoRoot: string;
  prNumber: number;
  onPosted?: (c: PrComment) => void;
  embed?: boolean;
}) {
  const [replying, setReplying] = useState(false);
  const [replyText, setReplyText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [resolved, setResolved] = useState(thread.root.thread_resolved);

  const submitReply = async () => {
    if (!replyText.trim()) return;
    setSubmitting(true);
    try {
      const c = await api.prCommentReply(
        repoRoot,
        prNumber,
        thread.root.id,
        replyText,
      );
      onPosted?.(c);
      setReplyText("");
      setReplying(false);
    } catch (e) {
      console.error("reply failed", e);
    } finally {
      setSubmitting(false);
    }
  };

  const toggleResolve = async () => {
    if (!thread.root.thread_node_id) return;
    setResolving(true);
    try {
      await api.prCommentResolve(repoRoot, thread.root.thread_node_id);
      setResolved((v) => !v);
    } catch (e) {
      console.error("resolve toggle failed", e);
    } finally {
      setResolving(false);
    }
  };

  const quickReact = async (target: PrComment, content: ReactionContent) => {
    const existing = target.reactions.find((r) => r.content === content);
    try {
      if (existing?.viewer_reacted) {
        await api.prReactionRemove(repoRoot, target.node_id, content);
      } else {
        await api.prReactionAdd(repoRoot, target.node_id, content);
      }
      onPosted?.(thread.root);
    } catch (e) {
      console.error("reaction toggle failed", e);
    }
  };

  const [repliesOpen, setRepliesOpen] = useState(false);
  const replyCount = thread.replies.length;

  const card = (
    <div
      className={`rounded-lg border bg-bg-1/90 backdrop-blur-sm overflow-hidden transition-opacity ${
        resolved
          ? "border-line-soft opacity-60"
          : "border-line-soft hover:border-line-strong"
      }`}
      style={{ boxShadow: "0 1px 2px rgba(0,0,0,0.25), 0 4px 16px rgba(0,0,0,0.18)" }}
    >
      <ThreadComment
        c={thread.root}
        repoRoot={repoRoot}
        onChanged={() => onPosted?.(thread.root)}
        actions={
          <div className="flex items-center gap-0.5">
            <FixWithAgentButton
              iconOnly
              label="Fix with agent…"
              prompt={buildCommentFixPrompt(thread.root)}
            />
            <ThreadActions
              resolved={resolved}
              resolving={resolving}
              hasNode={!!thread.root.thread_node_id}
              onResolve={toggleResolve}
              onReply={() => setReplying(true)}
              onReact={(content) => quickReact(thread.root, content)}
            />
          </div>
        }
      />
      {replyCount > 0 && (
        <button
          type="button"
          onClick={() => setRepliesOpen((v) => !v)}
          className="w-full flex items-center gap-1.5 px-3 py-1 text-xs text-text-3 hover:text-text-1 hover:bg-state-hover border-t border-line-soft/60"
        >
          <ChevronGlyph open={repliesOpen} />
          {repliesOpen ? "Hide" : "Show"} {replyCount}{" "}
          {replyCount === 1 ? "reply" : "replies"}
        </button>
      )}
      {repliesOpen &&
        thread.replies.map((r) => (
          <ThreadComment
            key={r.id}
            c={r}
            repoRoot={repoRoot}
            onChanged={() => onPosted?.(thread.root)}
            onReact={(content) => quickReact(r, content)}
            reply
          />
        ))}
      {replying && (
        <div className="px-3 pb-2.5 pt-2 border-t border-line-soft/60 space-y-1.5">
          <textarea
            autoFocus
            value={replyText}
            onChange={(e) => setReplyText(e.target.value)}
            rows={3}
            placeholder="Write a reply…"
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                void submitReply();
              }
            }}
            className="w-full bg-bg-content border border-line-soft rounded p-2 text-sm text-text-1 placeholder:text-text-4 outline-none focus:ring-1 focus:ring-accent resize-y"
          />
          <div className="flex items-center justify-end gap-2">
            <Button
              variant="ghost"
              size="xs"
              onClick={() => {
                setReplying(false);
                setReplyText("");
              }}
            >
              Cancel
            </Button>
            <Button
              variant="accentSoft"
              size="xs"
              onClick={submitReply}
              disabled={submitting || !replyText.trim()}
            >
              {submitting ? "…" : "Reply"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );

  if (embed) return card;
  return (
    <div className="absolute left-3 right-3" style={{ top: Math.max(top, 0) }}>
      {card}
    </div>
  );
}

function ThreadActions({
  resolved,
  resolving,
  hasNode,
  onResolve,
  onReply,
  onReact,
}: {
  resolved: boolean;
  resolving: boolean;
  hasNode: boolean;
  onResolve: () => void;
  onReply: () => void;
  onReact?: (content: ReactionContent) => void;
}) {
  return (
    <div className="flex items-center gap-0.5 -mr-1">
      {onReact && <ReactionPickerButton onPick={onReact} />}
      {hasNode && (
        <button
          type="button"
          onClick={onResolve}
          disabled={resolving}
          title={resolved ? "Unresolve thread" : "Resolve thread"}
          className={`w-6 h-6 rounded flex items-center justify-center transition-colors disabled:opacity-40 hover:bg-state-hover ${
            resolved ? "" : "text-text-4 hover:text-text-1"
          }`}
          style={resolved ? { color: "var(--color-accent-green)" } : undefined}
        >
          <CheckGlyph />
        </button>
      )}
      <button
        type="button"
        onClick={onReply}
        title="Reply"
        className="w-6 h-6 rounded flex items-center justify-center text-text-4 hover:text-text-1 hover:bg-state-hover transition-colors"
      >
        <ReplyGlyph />
      </button>
    </div>
  );
}

const REACTIONS: { content: ReactionContent; emoji: string; label: string }[] =
  [
    { content: "THUMBS_UP", emoji: "\u{1F44D}", label: "+1" },
    { content: "THUMBS_DOWN", emoji: "\u{1F44E}", label: "-1" },
    { content: "LAUGH", emoji: "\u{1F604}", label: "laugh" },
    { content: "HOORAY", emoji: "\u{1F389}", label: "hooray" },
    { content: "CONFUSED", emoji: "\u{1F615}", label: "confused" },
    { content: "HEART", emoji: "\u{2764}\u{FE0F}", label: "heart" },
    { content: "ROCKET", emoji: "\u{1F680}", label: "rocket" },
    { content: "EYES", emoji: "\u{1F440}", label: "eyes" },
  ];

function ReactionPickerButton({
  onPick,
}: {
  onPick: (content: ReactionContent) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  useDismiss(open, () => setOpen(false), wrapRef);
  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        title="Add reaction"
        className="w-6 h-6 rounded flex items-center justify-center text-text-4 hover:text-text-1 hover:bg-state-hover transition-colors"
      >
        <SmileyGlyph />
      </button>
      {open && (
        <div
          className="absolute right-0 top-full mt-1 z-30 flex items-center gap-0.5 px-1.5 py-1 rounded-lg border border-line-strong bg-bg-1 shadow-sm"
          onClick={(e) => e.stopPropagation()}
        >
          {REACTIONS.map((r) => (
            <button
              key={r.content}
              type="button"
              onClick={() => {
                onPick(r.content);
                setOpen(false);
              }}
              title={r.label}
              className="w-7 h-7 rounded flex items-center justify-center text-lg hover:bg-state-hover transition-colors"
            >
              {r.emoji}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ReactionBar({
  reactions,
  onToggle,
}: {
  reactions: PrCommentReaction[];
  onToggle: (content: ReactionContent) => void;
}) {
  const visible = reactions.filter((r) => r.count > 0);
  if (visible.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1 mt-1.5 pl-7">
      {visible.map((r) => {
        const meta = REACTIONS.find((x) => x.content === r.content);
        return (
          <button
            key={r.content}
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onToggle(r.content);
            }}
            title={meta?.label ?? r.content}
            className={`inline-flex items-center gap-1 h-5 px-1.5 rounded-full text-xs border transition-colors ${
              r.viewer_reacted
                ? ""
                : "bg-bg-2 border-line-soft text-text-2 hover:border-line-strong"
            }`}
            style={
              r.viewer_reacted
                ? {
                    background:
                      "color-mix(in srgb, var(--color-blue) 15%, transparent)",
                    borderColor:
                      "color-mix(in srgb, var(--color-blue) 60%, transparent)",
                    color: "var(--color-blue)",
                  }
                : undefined
            }
          >
            <span className="text-sm leading-none">
              {meta?.emoji ?? "?"}
            </span>
            <span className="font-medium tabular-nums">{r.count}</span>
          </button>
        );
      })}
    </div>
  );
}

function ThreadComment({
  c,
  reply,
  actions,
  onReact,
}: {
  c: PrComment;
  reply?: boolean;
  actions?: React.ReactNode;
  repoRoot?: string;
  onChanged?: () => void;
  onReact?: (content: ReactionContent) => void;
}) {
  // One monogram for the whole app — see lib/monogram.
  const initial = monogram(c.author);
  return (
    <div
      className={`px-3 py-2.5 ${reply ? "border-t border-line-soft/50" : ""}`}
    >
      <div className="flex items-start gap-2 mb-1">
        <span className="w-5 h-5 rounded-full bg-violet/30 text-violet flex items-center justify-center text-2xs font-bold flex-shrink-0">
          {initial}
        </span>
        <div className="flex items-baseline gap-2 min-w-0 flex-1">
          <span className="text-sm font-semibold text-text-1 truncate">
            {c.author}
          </span>
          <span className="text-xs text-text-4 flex-shrink-0">
            {relTime(c.created_at)}
          </span>
        </div>
        {actions}
      </div>
      <div className="pl-7 text-sm text-text-2 leading-[1.55] break-words [&_p]:my-0 [&_p+p]:mt-2 [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_code]:bg-bg-2 [&_code]:text-sm [&_pre]:my-1.5 [&_pre]:p-2 [&_pre]:rounded [&_pre]:bg-bg-2 [&_pre]:overflow-x-auto [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_strong]:text-text-1 [&_strong]:font-semibold [&_a]:text-accent [&_a:hover]:underline [&_ul]:list-disc [&_ul]:pl-4 [&_ol]:list-decimal [&_ol]:pl-4 [&_li]:my-0.5">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{c.body}</ReactMarkdown>
      </div>
      {onReact && <ReactionBar reactions={c.reactions} onToggle={onReact} />}
    </div>
  );
}

function ChevronGlyph({ open }: { open: boolean }) {
  return (
    <svg
      width="9"
      height="9"
      viewBox="0 0 10 10"
      className={`transition-transform ${open ? "" : "-rotate-90"}`}
    >
      <path d="M2 4l3 3 3-3" stroke="currentColor" strokeWidth="1.4" fill="none" />
    </svg>
  );
}

function CheckGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
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

function ReplyGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
      <path
        d="M7 4L3 8l4 4M3 8h7a3 3 0 013 3v1"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SmileyGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="6" cy="7" r="0.9" fill="currentColor" />
      <circle cx="10" cy="7" r="0.9" fill="currentColor" />
      <path
        d="M5.5 10c.7 1 1.6 1.5 2.5 1.5S9.8 11 10.5 10"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}

function relTime(iso: string): string {
  // One ladder for the whole app — see lib/relativeTime.
  return relativeAgeFromIso(iso, { style: "compact" });
}
