//! Inline side-by-side file diff for edit/write tool calls.
//!
//! Generic tool cards render the registry's unified-diff string as tinted
//! hunks — fine for a glance, but an actual code edit reads far better as a
//! real before/after view with syntax highlighting. This card detects
//! edit/write tool calls, extracts their old/new content straight from the
//! tool input, and mounts the same Monaco `DiffEditor` engine the ChangesView
//! and PR diff use (via the shared `monacoTheme` / `monacoLanguage` /
//! `monacoEnv` helpers — no diff logic duplicated). It's collapsed by default
//! to a compact header so a burst of edits doesn't flood the timeline; one
//! click expands the side-by-side (folding to inline on a narrow pane).
//!
//! A write with no prior content renders as a "new file" — the left pane is
//! empty, the right is the full body. When old/new can't be extracted at all
//! the caller falls back to the generic `ToolCard`, so this is only ever
//! mounted when there's a real diff to show.

import { Suspense, lazy, useMemo, useState } from "react";
import { AsciiSpinner } from "../../ui/ascii-spinner";

import { languageSlugForPath } from "../../../lib/monacoLanguage";
import { configureMonacoDiagnostics } from "../../../lib/monacoDiagnostics";
import { auraThemeName, ensureAuraThemes } from "../../../lib/monacoTheme";
import { installMonacoEnvironment } from "../../../lib/monacoEnv";
import { useResolvedTheme } from "../../../lib/themeStore";
import { basename } from "./toolDescribe";
import { StatusPip } from "./StatusLine";
import type { ToolResult, ToolStatus } from "./types";

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

/** One edit/write tool call as an inline before/after diff. Collapsed to a
 *  header by default; expands to the Monaco side-by-side. */
export function FileDiffTool({
  name,
  input,
  result,
}: {
  name: string;
  input: unknown;
  result?: ToolResult;
}) {
  const [open, setOpen] = useState(false);
  const resolvedTheme = useResolvedTheme();
  const isDark = resolvedTheme !== "light";

  const data = useMemo(() => fileDiffData(name, input), [name, input]);
  // languageSlugForPath already resolves to a Monaco language id (full grammar
  // coverage), falling back to plaintext.
  const language = useMemo(
    () => languageSlugForPath(data?.path ?? ""),
    [data?.path],
  );
  const stats = useMemo(
    () => (data ? quickLineDelta(data.oldContent, data.newContent) : { added: 0, removed: 0 }),
    [data],
  );

  if (!data) return null;
  const status: ToolStatus = !result ? "running" : result.is_error ? "error" : "ok";
  const verb = data.isNew ? "Writing" : "Editing";
  const label = basename(data.path) || data.path || "file";

  // Collapsed — a flat uniform row matching the read/edit tool lines: a fixed
  // leading column (status pip), the verb, the mono path, a "new" tag for a
  // fresh write, then the +/− diffstat and chevron pushed right. Same
  // `.aura-tool-row`/`.aura-tool-glyph` skeleton so an inline diff sits in the
  // same vertical list as every other step, not as a taller card.
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="aura-tool-row"
        title={data.path}
      >
        <span className="aura-tool-glyph">
          <StatusPip status={status} />
        </span>
        <span className="aura-tool-chip-verb">{verb}</span>
        <span className="aura-tool-chip-subject font-mono" title={data.path}>
          {label}
        </span>
        {data.isNew && (
          <span
            className="shrink-0 t-2xs px-1 rounded"
            style={{
              background: "color-mix(in srgb, var(--color-accent) 14%, transparent)",
              color: "var(--color-accent)",
            }}
          >
            new
          </span>
        )}
        <span
          className="shrink-0 tabular-nums text-[10.5px] flex items-center gap-1.5"
          style={{ fontFamily: "var(--font-mono)" }}
        >
          {stats.added > 0 && (
            <span style={{ color: "var(--color-accent-green)" }}>+{stats.added}</span>
          )}
          {stats.removed > 0 && (
            <span style={{ color: "var(--color-red)" }}>−{stats.removed}</span>
          )}
          <Chevron dir="down" />
        </span>
      </button>
    );
  }

  // Expanded — the bordered card carrying the same one-line header (now
  // collapsible) above the Monaco side-by-side panel.
  return (
    <div
      className="group overflow-hidden text-[12px]"
      style={{
        background: "var(--color-bg-1)",
        border: "1px solid var(--color-line)",
        borderRadius: "var(--radius-md)",
      }}
    >
      <button
        type="button"
        onClick={() => setOpen(false)}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-left min-w-0 transition-colors hover:bg-[color-mix(in_srgb,var(--color-text-3)_6%,transparent)]"
        title={data.path}
      >
        <StatusPip status={status} />
        <span className="aura-block-label shrink-0">{verb}</span>
        <span
          className="min-w-0 truncate font-mono text-[11px]"
          style={{ color: "var(--color-text-1)" }}
        >
          {label}
        </span>
        {data.isNew && (
          <span
            className="shrink-0 t-2xs px-1 rounded"
            style={{
              background: "color-mix(in srgb, var(--color-accent) 14%, transparent)",
              color: "var(--color-accent)",
            }}
          >
            new
          </span>
        )}
        <span
          className="ml-auto shrink-0 tabular-nums text-[10.5px] flex items-center gap-1.5"
          style={{ fontFamily: "var(--font-mono)" }}
        >
          {stats.added > 0 && (
            <span style={{ color: "var(--color-accent-green)" }}>+{stats.added}</span>
          )}
          {stats.removed > 0 && (
            <span style={{ color: "var(--color-red)" }}>−{stats.removed}</span>
          )}
          <Chevron dir="up" />
        </span>
      </button>
      <div
        className="border-t"
        style={{ borderColor: "var(--color-line-soft)", height: 280 }}
      >
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
      </div>
    </div>
  );
}

function DiffLoading() {
  return (
    <div className="h-full w-full flex items-center justify-center gap-1.5 text-[11px] text-text-4">
      <AsciiSpinner />
      Loading the changes…
    </div>
  );
}

// Cheap +/- line counter — shared-prefix/suffix walk, good enough for the
// header chip (mirrors DiffView's quickLineDelta; not worth a Myers pass).
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

function Chevron({ dir }: { dir: "up" | "down" }) {
  return (
    <svg
      width={11}
      height={11}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{
        transform: dir === "up" ? "rotate(180deg)" : undefined,
        transition: "transform var(--motion-fast)",
        color: "var(--color-text-3)",
      }}
      aria-hidden
    >
      <path d="M4 6l4 4 4-4" />
    </svg>
  );
}
