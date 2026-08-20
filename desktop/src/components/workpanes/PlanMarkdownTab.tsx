// Plan-as-markdown work surface.
//
// Renders `<repoRoot>/.aura/plans/<planId>.md` with a breadcrumb header
// ("Plans › <title>") and live checkboxes that round-trip to A2A task
// state. The markdown body is parsed with `parsePlanCheckboxes` to find
// every line tagged `<!-- task:<id> -->`; clicking the checkbox patches
// the A2A task and rewrites the local file buffer so the file syncs
// on save.
//
// The "Edit raw" toggle drops into the standard CodeMirror editor for
// users who want to hand-edit headings or notes. Checkbox edits made
// in raw mode are still picked up by the parser on switch-back, since
// the source of truth is the markdown text in the open buffer.

import { useMemo, useState } from "react";
import { MonacoEditor as Editor } from "../MonacoEditor";
import {
  parsePlanCheckboxes,
  type ParsedCheckbox,
} from "../../lib/planMarkdown";
import { api } from "../../lib/api";
import { planIdFromMarkdownPath } from "../../lib/editorStore";
import { Button } from "../ui/button";

type Props = {
  filePath: string;
  buffer: string;
  language: string;
  onChange: (text: string) => void;
  repoRoot: string;
  /** Optional: surface to refresh after a checkbox toggle persists. */
  onTaskPatched?: (taskId: string, newStatus: string) => void;
};

const TASK_ID_RE = /<!--\s*task:[^\s]+\s*-->/;

export function PlanMarkdownTab({
  filePath,
  buffer,
  language,
  onChange,
  repoRoot,
  onTaskPatched,
}: Props) {
  const [raw, setRaw] = useState(false);
  const planId = planIdFromMarkdownPath(filePath);
  const parsed = useMemo(() => parsePlanCheckboxes(buffer), [buffer]);
  const title = useMemo(() => extractTitle(buffer) ?? planId ?? "Plan", [buffer, planId]);
  const groups = useMemo(() => groupByHeading(buffer, parsed), [buffer, parsed]);

  async function toggle(c: ParsedCheckbox) {
    const nextChecked = !c.checked;
    // Optimistic local buffer rewrite — flip the `[ ]` ↔ `[x]` on that
    // line. The A2A patch happens in the background; if it fails we
    // leave the buffer in the "user wanted this state" form so they
    // can retry by saving.
    const lines = buffer.split("\n");
    if (lines[c.lineNo]) {
      lines[c.lineNo] = lines[c.lineNo].replace(
        /\[([ xX])\]/,
        nextChecked ? "[x]" : "[ ]",
      );
      onChange(lines.join("\n"));
    }
    try {
      const newStatus = nextChecked ? "completed" : "submitted";
      await api.auraCli(repoRoot, [
        "a2a-task",
        "patch",
        "--id",
        c.taskId,
        "--status",
        newStatus,
      ]);
      onTaskPatched?.(c.taskId, newStatus);
    } catch {
      // Silent — the local buffer already reflects the user's intent.
      // A future "Plan sync failed" toast goes here.
    }
  }

  return (
    <div className="h-full w-full flex flex-col bg-bg-content">
      <div className="h-9 px-3 border-b border-line-soft bg-bg-chrome flex items-center gap-2 flex-shrink-0">
        <div className="min-w-0 flex-1 flex items-baseline gap-1.5">
          <span className="text-text-5 text-2xs font-mono">Plans</span>
          <span className="text-text-5 text-2xs">›</span>
          <span className="text-text-2 text-sm font-medium truncate">
            {title}
          </span>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={() => setRaw((v) => !v)}
          className="text-xs text-text-4 hover:text-text-1"
        >
          {raw ? "Rendered" : "Edit raw"}
        </Button>
      </div>
      <div className="flex-1 min-h-0 overflow-hidden">
        {raw ? (
          <Editor
            value={buffer}
            language={language}
            onChange={onChange}
            filePath={filePath}
          />
        ) : (
          <RenderedPlan groups={groups} onToggle={toggle} />
        )}
      </div>
    </div>
  );
}

// ─── rendered markdown ─────────────────────────────────────────────

type HeadingGroup = {
  heading: string | null;
  level: number;
  body: string[];
  checkboxes: ParsedCheckbox[];
};

function groupByHeading(md: string, parsed: ParsedCheckbox[]): HeadingGroup[] {
  const lines = md.split("\n");
  const groups: HeadingGroup[] = [];
  let current: HeadingGroup = {
    heading: null,
    level: 0,
    body: [],
    checkboxes: [],
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const hm = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (hm) {
      // Strip task-id comment from the heading title (e.g. "## Wave 1 — X  <!-- task:abc -->")
      const titleRaw = hm[2].replace(TASK_ID_RE, "").trim();
      groups.push(current);
      current = {
        heading: titleRaw,
        level: hm[1].length,
        body: [],
        checkboxes: [],
      };
      continue;
    }
    current.body.push(line);
    const cb = parsed.find((c) => c.lineNo === i);
    if (cb) current.checkboxes.push(cb);
  }
  groups.push(current);
  return groups.filter((g) => g.heading || g.body.some((l) => l.trim().length > 0));
}

function stripTaskComment(s: string): string {
  return s.replace(TASK_ID_RE, "").trimEnd();
}

function checkboxIndent(line: string): number {
  const m = line.match(/^(\s*)-\s*\[[ xX]\]/);
  if (!m) return 0;
  return Math.floor(m[1].length / 2);
}

function RenderedPlan({
  groups,
  onToggle,
}: {
  groups: HeadingGroup[];
  onToggle: (c: ParsedCheckbox) => void;
}) {
  return (
    <div className="h-full w-full overflow-y-auto px-4 py-4 text-md leading-6 text-text-2">
      {groups.map((g, idx) => (
        <div key={idx} className="mb-4">
          {g.heading && (
            <Heading level={g.level} text={g.heading} />
          )}
          {g.body.map((line, i) => {
            const cb = g.checkboxes.find((c) => c.line === line);
            if (cb) {
              const indent = checkboxIndent(line);
              const label = line
                .replace(/^\s*-\s*\[[ xX]\]\s+/, "")
                .replace(TASK_ID_RE, "")
                .trimEnd();
              return (
                <label
                  key={i}
                  className={`flex items-baseline gap-2 py-0.5 cursor-pointer hover:bg-state-hover rounded px-1 -mx-1`}
                  style={{ paddingLeft: 6 + indent * 18 }}
                >
                  <input
                    type="checkbox"
                    checked={cb.checked}
                    onChange={() => onToggle(cb)}
                    className="mt-0.5"
                  />
                  <span
                    className={
                      cb.checked
                        ? "text-text-4 line-through"
                        : "text-text-2"
                    }
                  >
                    {label}
                  </span>
                </label>
              );
            }
            if (line.trim() === "") {
              return <div key={i} className="h-2" />;
            }
            if (line.startsWith(">")) {
              return (
                <div
                  key={i}
                  className="text-text-4 italic border-l-2 border-line-soft pl-2 my-1"
                >
                  {stripTaskComment(line.replace(/^>\s*/, ""))}
                </div>
              );
            }
            return (
              <div key={i} className="text-text-3">
                {stripTaskComment(line)}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function Heading({ level, text }: { level: number; text: string }) {
  if (level === 1) {
    return (
      <div className="text-xl font-semibold text-text-1 mb-2 mt-1">
        {text}
      </div>
    );
  }
  if (level === 2) {
    return (
      <div className="text-md font-semibold text-text-1 mt-3 mb-1">
        {text}
      </div>
    );
  }
  return (
    <div className="text-base font-medium text-text-2 mt-2 mb-1">
      {text}
    </div>
  );
}

function extractTitle(md: string): string | null {
  const lines = md.split("\n");
  for (const line of lines) {
    const m = line.match(/^#\s+(.+?)\s*$/);
    if (m) return m[1].replace(TASK_ID_RE, "").trim();
  }
  return null;
}
