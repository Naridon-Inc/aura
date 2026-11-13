// Plan-as-markdown work surface.
//
// Renders `<repoRoot>/.aura/plans/<planId>.md` with a breadcrumb header
// ("Plans › <title>") and live checkboxes that round-trip to A2A task
// state. The markdown body is parsed with `parsePlanCheckboxes` to find
// every line tagged `<!-- task:<id> -->`; clicking the checkbox patches
// the A2A task and rewrites the local file buffer so the file syncs
// on save.
//
// Drawn as the shared file view. Its Preview / Edit / Split switch drops
// into the editor for users who want to hand-edit headings or notes.
// Checkbox edits made in Edit are still picked up by the parser on
// switch-back, since the source of truth is the open buffer.

import { useMemo, useState } from "react";
import { MonacoEditor as Editor } from "../MonacoEditor";
import {
  parsePlanCheckboxes,
  type ParsedCheckbox,
} from "../../lib/planMarkdown";
import { api } from "../../lib/api";
import { planIdFromMarkdownPath, type OpenFile } from "../../lib/editorStore";
import { Checkbox } from "../ui/checkbox";
import { FileModeSwitch, TextFileView, type MdView } from "./FileTabView";
import "../ui/file-tab.css";

type Props = {
  file: OpenFile;
  dirty: boolean;
  onSave: () => Promise<void>;
  onChange: (text: string) => void;
  repoRoot: string;
  /** Optional: surface to refresh after a checkbox toggle persists. */
  onTaskPatched?: (taskId: string, newStatus: string) => void;
};

const TASK_ID_RE = /<!--\s*task:[^\s]+\s*-->/;

export function PlanMarkdownTab({ file, dirty, onSave, onChange, repoRoot, onTaskPatched }: Props) {
  // A plan opens read: its items are the point, the markdown is the source.
  const [view, setView] = useState<MdView>("rendered");
  const buffer = file.current;
  const planId = planIdFromMarkdownPath(file.path);
  const parsed = useMemo(() => parsePlanCheckboxes(buffer), [buffer]);
  const title = useMemo(() => extractTitle(buffer) ?? planId ?? "Plan", [buffer, planId]);
  const groups = useMemo(() => groupByHeading(buffer, parsed), [buffer, parsed]);

  async function toggle(c: ParsedCheckbox) {
    const nextChecked = !c.checked;
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
      // The buffer already shows the tick; the task store catches up on the
      // next save of the plan, so a failed patch isn't worth an alert.
    }
  }

  const editor = (
    <Editor
      key={file.path}
      value={buffer}
      language={file.language}
      onChange={onChange}
      filePath={file.path}
    />
  );
  const rendered = <RenderedPlan groups={groups} onToggle={toggle} />;

  return (
    <TextFileView
      file={file}
      label={`Plans › ${title}`}
      dirty={dirty}
      onSave={onSave}
      actions={<FileModeSwitch value={view} onChange={setView} />}
    >
      {view === "raw" ? (
        editor
      ) : view === "split" ? (
        <div className="ui-file-split">
          <div>{editor}</div>
          <div>{rendered}</div>
        </div>
      ) : (
        rendered
      )}
    </TextFileView>
  );
}

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
    <div className="ui-file-markdown">
      <div className="ui-message-markdown">
        {groups.map((g, idx) => (
          <section key={idx}>
            {g.heading && <Heading level={g.level} text={g.heading} />}
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
                    className="ui-plan-item"
                    data-done={cb.checked || undefined}
                    style={{ paddingLeft: 4 + indent * 18 }}
                  >
                    <Checkbox checked={cb.checked} onCheckedChange={() => onToggle(cb)} />
                    <span>{label}</span>
                  </label>
                );
              }
              if (line.trim() === "") return <div key={i} style={{ height: 8 }} />;
              if (line.startsWith(">")) {
                return (
                  <blockquote key={i}>{stripTaskComment(line.replace(/^>\s*/, ""))}</blockquote>
                );
              }
              return <div key={i}>{stripTaskComment(line)}</div>;
            })}
          </section>
        ))}
      </div>
    </div>
  );
}

function Heading({ level, text }: { level: number; text: string }) {
  if (level === 1) return <h1>{text}</h1>;
  if (level === 2) return <h2>{text}</h2>;
  if (level === 3) return <h3>{text}</h3>;
  return <h4>{text}</h4>;
}

function extractTitle(md: string): string | null {
  const lines = md.split("\n");
  for (const line of lines) {
    const m = line.match(/^#\s+(.+?)\s*$/);
    if (m) return m[1].replace(TASK_ID_RE, "").trim();
  }
  return null;
}
