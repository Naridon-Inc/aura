//! Inline side-by-side file diff for edit/write tool calls.
//!
//! Generic tool cards render the registry's unified-diff string as tinted
//! hunks — fine for a glance, but an actual code edit reads far better as a
//! real before/after view with syntax highlighting. This card detects
//! edit/write tool calls, extracts their old/new content straight from the
//! tool input, and mounts the same Monaco `DiffEditor` engine the ChangesView
//! and PR diff use (via the shared `monacoTheme` / `monacoLanguage` /
//! `monacoEnv` helpers — no diff logic duplicated). It is a step row,
//! closed by default so a burst of edits doesn't flood the timeline; opening
//! it shows the side-by-side (folding to inline on a narrow pane).
//!
//! A write with no prior content renders as a "new file" — the left pane is
//! empty, the right is the full body. When old/new can't be extracted at all
//! the caller falls back to the plain `ToolCard`, so this is only ever
//! mounted when there's a real diff to show.

import { Suspense, lazy, useMemo } from "react";
import { AsciiSpinner } from "../../ui/ascii-spinner";

import { languageSlugForPath } from "../../../lib/monacoLanguage";
import { configureMonacoDiagnostics } from "../../../lib/monacoDiagnostics";
import { auraThemeName, ensureAuraThemes } from "../../../lib/monacoTheme";
import { installMonacoEnvironment } from "../../../lib/monacoEnv";
import { useResolvedTheme } from "../../../lib/themeStore";
import { ToolCall } from "../../ui/message";
import { toolCallStatus } from "./ToolDetail";
import "../../ui/chat-tool-detail.css";
import { toolStatus, type ToolResult } from "./types";
import { basename } from "../../../lib/paths";

installMonacoEnvironment();

// Lazy so Monaco's DiffEditor chunk only loads when a diff card actually
// expands — the chat opens without paying for it.
const DiffEditor = lazy(() =>
  import("@monaco-editor/react").then((m) => ({ default: m.DiffEditor })),
);

/** Normalized edit/write payload — the three things the diff view needs. */
export type FileDiffData = {
  path: string;
  oldContent: string;
  newContent: string;
  /** True when there was no prior content (a fresh write). */
  isNew: boolean;
};

/** Lowercased, separator-stripped tool name — `edit_file` / `EditFile` /
 *  `edit` all collapse to one key, matching the registry's normalization. */
function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[_-]/g, "");
}

/** Extract `{ path, oldContent, newContent }` from an edit/write tool input.
 *  Returns null for tools that aren't edit/write, or when neither old nor new
 *  content is present (nothing to diff — fall back to the generic card). */
export function fileDiffData(name: string, input: unknown): FileDiffData | null {
  const key = normalizeName(name);
  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const path = String(obj.file_path ?? obj.path ?? "");

  if (key === "write" || key === "writefile") {
    const content =
      obj.content !== undefined
        ? String(obj.content)
        : obj.contents !== undefined
          ? String(obj.contents)
          : undefined;
    if (content === undefined) return null;
    return { path, oldContent: "", newContent: content, isNew: true };
  }

  if (key === "edit" || key === "editfile") {
    const oldStr = obj.old_string ?? obj.oldText ?? obj.old;
    const newStr = obj.new_string ?? obj.newText ?? obj.new;
    if (oldStr === undefined && newStr === undefined) return null;
    return {
      path,
      oldContent: oldStr === undefined ? "" : String(oldStr),
      newContent: newStr === undefined ? "" : String(newStr),
      isNew: false,
    };
  }

  return null;
}

/** Whether a tool call should render as a `FileDiffTool` rather than a generic
 *  `ToolCard`. True only when it's an edit/write with extractable content. */
export function isFileDiffTool(name: string, input: unknown): boolean {
  return fileDiffData(name, input) !== null;
}

/** One edit/write tool call as a step row whose content is the before/after
 *  diff. The Monaco editor only mounts while the row is open, so a burst of
 *  edits costs nothing until one is read. */
export function FileDiffTool({
  name,
  input,
  result,
}: {
  name: string;
  input: unknown;
  result?: ToolResult;
}) {
  const data = useMemo(() => fileDiffData(name, input), [name, input]);
  if (!data) return null;
  const status = toolStatus(result);
  const verb =
    status === "running"
      ? data.isNew
        ? "Writing"
        : "Editing"
      : status === "ok"
        ? data.isNew
          ? "Wrote"
          : "Edited"
        : status === "cancelled"
          ? "Cancelled"
          : status === "unknown"
            ? "No result"
            : "Failed";
  const label = basename(data.path) || data.path || "file";
  return (
    <ToolCall title={`${verb} ${label}`} status={toolCallStatus(status)}>
      <FileDiffBody data={data} />
    </ToolCall>
  );
}

/** The open row: the full path with the line counts, then the diff. */
function FileDiffBody({ data }: { data: FileDiffData }) {
  const resolvedTheme = useResolvedTheme();
  const isDark = resolvedTheme !== "light";
  // languageSlugForPath already resolves to a Monaco language id (full grammar
  // coverage), falling back to plaintext.
  const language = useMemo(() => languageSlugForPath(data.path), [data.path]);
  const stats = useMemo(
    () => quickLineDelta(data.oldContent, data.newContent),
    [data.oldContent, data.newContent],
  );
  return (
    <>
      <p className="ui-tool-meta">
        <span title={data.path}>{data.path || "file"}</span>
        {data.isNew && <span>New file</span>}
        {(stats.added > 0 || stats.removed > 0) && (
          <span className="ui-diff-count">
            <span>+{stats.added}</span>
            <span>−{stats.removed}</span>
          </span>
        )}
      </p>
      <section className="ui-file-diff ui-file-diff-editor">
        <Suspense fallback={<DiffLoading />}>
          <DiffEditor
            original={data.oldContent}
            modified={data.newContent}
            language={language}
            theme={auraThemeName(isDark)}
            beforeMount={(monaco) => {
              ensureAuraThemes(monaco);
              configureMonacoDiagnostics(monaco);
            }}
            options={{
              readOnly: true,
              originalEditable: false,
              renderSideBySide: true,
              useInlineViewWhenSpaceIsLimited: true,
              renderSideBySideInlineBreakpoint: 620,
              fontFamily: "var(--font-mono), Menlo, Monaco, monospace",
              fontSize: 12,
              lineHeight: 18,
              wordWrap: "on",
              scrollBeyondLastLine: false,
              renderLineHighlight: "none",
              minimap: { enabled: false },
              hideUnchangedRegions: {
                enabled: true,
                minimumLineCount: 3,
                contextLineCount: 2,
              },
              renderOverviewRuler: false,
              ignoreTrimWhitespace: false,
              automaticLayout: true,
            }}
          />
        </Suspense>
      </section>
    </>
  );
}

function DiffLoading() {
  return (
    <p className="ui-file-diff-loading">
      <AsciiSpinner />
      Loading the changes…
    </p>
  );
}

// Cheap +/- line counter — shared-prefix/suffix walk, good enough for the
// line counts (mirrors DiffView's quickLineDelta; not worth a Myers pass).
function quickLineDelta(a: string, b: string): { added: number; removed: number } {
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
