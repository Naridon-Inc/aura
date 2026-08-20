//! Clickable `AURA-{n}` task chips for the agent transcript.
//!
//! When an agent mentions a board task — in prose, or by creating one through
//! the `aura_task_*` MCP tools — the handle (`AURA-42`) renders as a chip that
//! drills straight into that task's detail pane, wiring the agent's chatter to
//! the same task system the human and the Aura desktop board share. The handle
//! is the user-facing `sequence_id`; we resolve it to the task's real id via
//! `tasksList` (the board fetch the detail pane itself uses) before opening,
//! so the chip lands on the exact task, not a guess.

import { useCallback, type ReactNode } from "react";

import { fetchTasks } from "../../../lib/tasksCache";
import { useEditorStore } from "../../../lib/editorStore";

const HANDLE_RE = /\bAURA-(\d+)\b/g;

/** Open the board task whose `sequence_id` matches `n`. Resolves the handle to
 *  the task's uuid first; if the lookup fails (task not on this repo's board)
 *  we fall back to opening the board itself rather than a dead pane. */
export async function openTaskByNumber(
  n: number,
  repoRoot: string,
  open: (taskId: string, repoRoot: string) => void,
): Promise<void> {
  try {
    const rows = await fetchTasks(repoRoot);
    const match = rows.find((t) => t.sequence_id === n);
    if (match) {
      open(match.id, repoRoot);
      return;
    }
  } catch {
    /* fall through to the board */
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event("aura:open-tasks"));
  }
}

/** One `AURA-{n}` chip. */
export function TaskChip({ n, repoRoot }: { n: number; repoRoot: string }) {
  const editor = useEditorStore();
  const onClick = useCallback(() => {
    void openTaskByNumber(n, repoRoot, editor.openTaskDetail);
  }, [n, repoRoot, editor]);
  return (
    <button
      type="button"
      onClick={onClick}
      title={`Open AURA-${n} on the board`}
      className="inline-flex items-center gap-1 px-1.5 h-[18px] rounded align-middle text-xs font-medium font-mono transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/50"
      style={{
        background: "color-mix(in srgb, var(--color-accent) 14%, transparent)",
        color: "var(--color-accent)",
        border: "1px solid color-mix(in srgb, var(--color-accent) 32%, transparent)",
      }}
    >
      AURA-{n}
    </button>
  );
}

/** Render plain text with every `AURA-{n}` handle turned into a `TaskChip`.
 *  Non-handle spans pass through verbatim. Used for short single-line strings
 *  (a tool subject, a result line) — multi-paragraph prose still goes through
 *  Markdown; this is the lightweight inline linkifier. */
export function LinkifiedText({
  text,
  repoRoot,
}: {
  text: string;
  repoRoot: string;
}) {
  const parts: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  HANDLE_RE.lastIndex = 0;
  let key = 0;
  while ((m = HANDLE_RE.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push(
      <TaskChip key={`chip:${key++}`} n={Number(m[1])} repoRoot={repoRoot} />,
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}

/** Does this string carry at least one `AURA-{n}` handle? Lets a caller skip
 *  the linkifier (and its array work) for the common no-handle line. */
export function hasTaskRef(text: string): boolean {
  HANDLE_RE.lastIndex = 0;
  return HANDLE_RE.test(text);
}
