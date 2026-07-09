// Slack-style rendered canvas for per-channel and team notes.
//
// Backing store: a plain markdown file (`.aura/team/channels/<ch>.notes.md`
// or `.aura/team/notes.md`) edited line-by-line and saved by the parent
// (ChannelNotesPanel). The view stays git-friendly:
//
//   • The first `# heading` line is rendered as the doc title.
//   • Lines that match `- [ ] task` / `- [x] task` render as checkboxes
//     and toggle in-place by rewriting the `[ ]` / `[x]` marker.
//   • Lines that match `- bullet` render as plain bullets.
//   • Any other non-empty line is rendered as a paragraph row.
//   • Blank lines are preserved as vertical gaps.
//
// Inline editing is line-scoped: clicking a row swaps in a textarea
// scoped to that single line; Enter commits, Esc discards. The
// composer at the bottom appends a new `- [ ] ` task and immediately
// opens it for editing. All mutations call back through `onChange`
// with the full updated body — the parent debounces and persists.
//
// @mentions are rendered inline as chips inside both task and
// paragraph rows so the same `@handle` tokens used elsewhere in the
// app stay visually consistent.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

type Props = {
  value: string;
  onChange: (next: string) => void;
  selfHandle?: string;
  placeholder?: string;
};

type Line =
  | { kind: "title"; text: string }
  | { kind: "task"; checked: boolean; text: string; indent: number }
  | { kind: "bullet"; text: string; indent: number }
  | { kind: "para"; text: string }
  | { kind: "blank" };

type Row = { line: Line; index: number };

type Chunk = { kind: "text"; value: string } | { kind: "mention"; handle: string };

// ── markdown line classification ────────────────────────────────────────

const TITLE_RE = /^#\s+(.*)$/;
const TASK_RE = /^(\s*)[-*]\s+\[( |x|X)\]\s+(.*)$/;
const BULLET_RE = /^(\s*)[-*]\s+(.*)$/;

function parseLine(raw: string): Line {
  if (raw.trim() === "") return { kind: "blank" };
  const title = TITLE_RE.exec(raw);
  if (title) return { kind: "title", text: title[1] };
  const task = TASK_RE.exec(raw);
  if (task) {
    return {
      kind: "task",
      checked: task[2].toLowerCase() === "x",
      indent: task[1].length,
      text: task[3],
    };
  }
  const bullet = BULLET_RE.exec(raw);
  if (bullet) {
    return { kind: "bullet", indent: bullet[1].length, text: bullet[2] };
  }
  return { kind: "para", text: raw };
}

function stringifyLine(line: Line): string {
  switch (line.kind) {
    case "title":
      return `# ${line.text}`;
    case "task": {
      const pad = " ".repeat(line.indent);
      return `${pad}- [${line.checked ? "x" : " "}] ${line.text}`;
    }
    case "bullet": {
      const pad = " ".repeat(line.indent);
      return `${pad}- ${line.text}`;
    }
    case "para":
      return line.text;
    case "blank":
      return "";
  }
}

// Reconstruct the full markdown body by replacing/inserting/removing a
// single line at `index`. Passing `null` removes the line.
function replaceLine(body: string, index: number, next: Line | null): string {
  const lines = body.split("\n");
  if (next === null) {
    lines.splice(index, 1);
  } else {
    lines[index] = stringifyLine(next);
  }
  return lines.join("\n");
}

function appendLine(body: string, next: Line): { body: string; index: number } {
  const lines = body.split("\n");
  // If the file ends without a trailing newline / blank, just push.
  // Otherwise we'd insert a "" then the new line, which doesn't read well.
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    const idx = lines.length - 1;
    lines[idx] = stringifyLine(next);
    lines.push("");
  } else {
    if (lines.length > 0) lines.push("");
    lines.push(stringifyLine(next));
  }
  return { body: lines.join("\n"), index: lines.length - 1 };
}

function ensureTitle(body: string, title: string): string {
  const lines = body.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const parsed = parseLine(lines[i]);
    if (parsed.kind === "title") {
      lines[i] = `# ${title}`;
      return lines.join("\n");
    }
    if (parsed.kind !== "blank") break;
  }
  // No title yet — prepend.
  return [`# ${title}`, "", ...lines].join("\n");
}

// Split text around `@mentions` for chip rendering (same boundary rules
// as the feed renderer in ChannelNotesPanel).
function chunkBody(body: string): Chunk[] {
  const out: Chunk[] = [];
  let i = 0;
  let buf = "";
  const flushText = () => {
    if (buf) {
      out.push({ kind: "text", value: buf });
      buf = "";
    }
  };
  while (i < body.length) {
    const ch = body[i];
    if (ch === "@") {
      const prev = i === 0 ? " " : body[i - 1];
      const boundary = /\s|\(|\[/.test(prev) || i === 0;
      if (boundary) {
        let j = i + 1;
        while (j < body.length && /[A-Za-z0-9_\-.]/.test(body[j])) j++;
        if (j > i + 1) {
          flushText();
          out.push({ kind: "mention", handle: body.slice(i + 1, j) });
          i = j;
          continue;
        }
      }
    }
    buf += ch;
    i++;
  }
  flushText();
  return out;
}

// ── component ──────────────────────────────────────────────────────────

export function ChannelCanvasView({ value, onChange, selfHandle, placeholder }: Props) {
  // Parse the body into structured rows. We keep `index` (the position
  // in the line array) so edits can target the exact source line.
  const rows: Row[] = useMemo(() => {
    return value.split("\n").map((raw, index) => ({
      line: parseLine(raw),
      index,
    }));
  }, [value]);

  // Find the first title row (or null) and the index of where to insert
  // a title if one doesn't exist yet.
  const titleRow = rows.find((r) => r.line.kind === "title") ?? null;

  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [titleEditing, setTitleEditing] = useState(false);

  // ── handlers ─────────────────────────────────────────────────────────

  const handleToggleTask = useCallback(
    (index: number) => {
      const line = parseLine(value.split("\n")[index] ?? "");
      if (line.kind !== "task") return;
      onChange(replaceLine(value, index, { ...line, checked: !line.checked }));
    },
    [value, onChange],
  );

  const handleEditLine = useCallback(
    (index: number, nextText: string) => {
      const lines = value.split("\n");
      const current = parseLine(lines[index] ?? "");
      if (nextText.trim() === "") {
        // Empty edit deletes the row (except title — title stays editable).
        if (current.kind === "title") {
          onChange(replaceLine(value, index, { kind: "title", text: "" }));
        } else {
          onChange(replaceLine(value, index, null));
        }
        setEditingIndex(null);
        return;
      }
      let next: Line;
      switch (current.kind) {
        case "title":
          next = { kind: "title", text: nextText };
          break;
        case "task":
          next = { ...current, text: nextText };
          break;
        case "bullet":
          next = { ...current, text: nextText };
          break;
        default:
          next = { kind: "para", text: nextText };
      }
      onChange(replaceLine(value, index, next));
      setEditingIndex(null);
    },
    [value, onChange],
  );

  const handleEditTitle = useCallback(
    (nextText: string) => {
      if (titleRow) {
        onChange(replaceLine(value, titleRow.index, { kind: "title", text: nextText }));
      } else {
        onChange(ensureTitle(value, nextText));
      }
      setTitleEditing(false);
    },
    [value, onChange, titleRow],
  );

  const handleAddLine = useCallback(() => {
    const { body, index } = appendLine(value, { kind: "para", text: "" });
    onChange(body);
    setEditingIndex(index);
  }, [value, onChange]);

  // Rows below the title; we render the title above all of them so it
  // gets the big header treatment.
  const bodyRows = useMemo(
    () => rows.filter((r) => !(r === titleRow)),
    [rows, titleRow],
  );

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto px-6 py-5">
        {/* Title */}
        <div className="mb-4">
          {titleEditing ? (
            <InlineEditor
              initial={titleRow?.line.kind === "title" ? titleRow.line.text : ""}
              placeholder="Untitled"
              big
              onCommit={handleEditTitle}
              onCancel={() => setTitleEditing(false)}
            />
          ) : (
            <button
              type="button"
              onClick={() => setTitleEditing(true)}
              className="block w-full rounded px-1 py-0.5 text-left text-[22px] font-semibold leading-tight text-text-1 hover:bg-bg-2/40"
              title="Click to edit title"
            >
              {titleRow?.line.kind === "title" && titleRow.line.text
                ? titleRow.line.text
                : <span className="text-text-4">Untitled</span>}
            </button>
          )}
        </div>

        {/* Body rows */}
        <div className="flex flex-col gap-0.5">
          {bodyRows.map((row) => (
            <CanvasRow
              key={row.index}
              row={row}
              editing={editingIndex === row.index}
              selfHandle={selfHandle}
              onStartEdit={() => setEditingIndex(row.index)}
              onCancelEdit={() => setEditingIndex(null)}
              onCommit={(text) => handleEditLine(row.index, text)}
              onToggleTask={() => handleToggleTask(row.index)}
            />
          ))}

          {/* Always-present click target for adding a new line */}
          <button
            type="button"
            onClick={handleAddLine}
            className="mt-1 block w-full rounded px-1 py-1 text-left text-[13px] leading-relaxed text-text-5 hover:bg-bg-2/40 hover:text-text-3"
            title="Click to start typing"
          >
            {bodyRows.length === 0 && !titleRow
              ? (placeholder ?? "Start typing…")
              : " "}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── row rendering ──────────────────────────────────────────────────────

function CanvasRow({
  row,
  editing,
  selfHandle,
  onStartEdit,
  onCancelEdit,
  onCommit,
  onToggleTask,
}: {
  row: Row;
  editing: boolean;
  selfHandle?: string;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onCommit: (text: string) => void;
  onToggleTask: () => void;
}) {
  const { line } = row;
  if (line.kind === "blank") {
    return <div className="h-2" aria-hidden />;
  }

  const indentPx = "indent" in line ? line.indent * 6 : 0;

  if (line.kind === "task") {
    return (
      <div
        className="group flex items-start gap-2 rounded px-1 py-1 hover:bg-bg-2/40"
        style={{ paddingLeft: indentPx + 4 }}
      >
        <button
          type="button"
          onClick={onToggleTask}
          className={`mt-[3px] flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
            line.checked
              ? "border-accent-blue bg-accent-blue text-white"
              : "border-line-soft bg-bg-1 hover:border-accent-blue"
          }`}
          aria-pressed={line.checked}
          aria-label={line.checked ? "Mark task incomplete" : "Mark task complete"}
        >
          {line.checked && (
            <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
              <path
                d="M2.5 6.5l2.5 2.5 4.5-5"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          )}
        </button>
        <div className="min-w-0 flex-1">
          {editing ? (
            <InlineEditor
              initial={line.text}
              onCommit={onCommit}
              onCancel={onCancelEdit}
            />
          ) : (
            <button
              type="button"
              onClick={onStartEdit}
              className={`block w-full rounded text-left text-[13px] leading-snug ${
                line.checked ? "text-text-4 line-through" : "text-text-1"
              }`}
              title="Click to edit"
            >
              {line.text.trim() === "" ? (
                <span className="italic text-text-4">empty task — click to edit</span>
              ) : (
                <InlineText text={line.text} selfHandle={selfHandle} />
              )}
            </button>
          )}
        </div>
      </div>
    );
  }

  if (line.kind === "bullet") {
    return (
      <div
        className="group flex items-start gap-2 rounded px-1 py-1 hover:bg-bg-2/40"
        style={{ paddingLeft: indentPx + 4 }}
      >
        <span className="mt-[6px] inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-text-3" aria-hidden />
        <div className="min-w-0 flex-1">
          {editing ? (
            <InlineEditor
              initial={line.text}
              onCommit={onCommit}
              onCancel={onCancelEdit}
            />
          ) : (
            <button
              type="button"
              onClick={onStartEdit}
              className="block w-full rounded text-left text-[13px] leading-snug text-text-1"
              title="Click to edit"
            >
              {line.text.trim() === "" ? (
                <span className="italic text-text-4">empty bullet — click to edit</span>
              ) : (
                <InlineText text={line.text} selfHandle={selfHandle} />
              )}
            </button>
          )}
        </div>
      </div>
    );
  }

  // paragraph
  return (
    <div className="group rounded px-1 py-1 hover:bg-bg-2/40">
      {editing ? (
        <InlineEditor
          initial={line.text}
          onCommit={onCommit}
          onCancel={onCancelEdit}
        />
      ) : (
        <button
          type="button"
          onClick={onStartEdit}
          className="block w-full rounded text-left text-[13px] leading-relaxed text-text-1"
          title="Click to edit"
        >
          <InlineText text={line.text} selfHandle={selfHandle} />
        </button>
      )}
    </div>
  );
}

function InlineText({ text, selfHandle }: { text: string; selfHandle?: string }) {
  const chunks = useMemo(() => chunkBody(text), [text]);
  return (
    <span className="whitespace-pre-wrap break-words">
      {chunks.map((c, i) =>
        c.kind === "text" ? (
          <span key={i}>{c.value}</span>
        ) : (
          <span
            key={i}
            className={`rounded px-1 ${
              selfHandle && c.handle.toLowerCase() === selfHandle.toLowerCase()
                ? "bg-amber-500/20 text-amber-300"
                : "bg-accent-blue/20 text-accent-blue"
            }`}
          >
            @{c.handle}
          </span>
        ),
      )}
    </span>
  );
}

function InlineEditor({
  initial,
  placeholder,
  big,
  onCommit,
  onCancel,
}: {
  initial: string;
  placeholder?: string;
  big?: boolean;
  onCommit: (text: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLTextAreaElement | null>(null);

  // Focus + select-all when the editor mounts.
  useLayoutEffect(() => {
    const ta = ref.current;
    if (!ta) return;
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
    autosize(ta);
  }, []);

  // Re-autosize whenever value changes.
  useEffect(() => {
    if (ref.current) autosize(ref.current);
  }, [value]);

  const commit = () => onCommit(value);

  return (
    <textarea
      ref={ref}
      value={value}
      rows={1}
      placeholder={placeholder}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          commit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
      }}
      className={`w-full resize-none rounded border border-accent-blue/60 bg-bg-1 px-1.5 py-1 leading-snug text-text-1 placeholder:text-text-4 focus:outline-none ${
        big ? "text-[22px] font-semibold" : "text-[13px]"
      }`}
    />
  );
}

// Grow a textarea to fit its content (no scroll bars in inline edit).
function autosize(ta: HTMLTextAreaElement) {
  ta.style.height = "auto";
  ta.style.height = `${ta.scrollHeight}px`;
}
