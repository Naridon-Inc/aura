// A2A task tree ↔ markdown serializer.
//
// We store plans as human-readable markdown under
// `<repoRoot>/.aura/plans/<planId>.md` so:
//   • Users (and other tooling like Cursor's "Plans" lookbook) can open
//     them as ordinary files.
//   • Checkbox state on each task line round-trips back to A2A status
//     via the file's HTML-comment task id tag.
//
// Format example:
//
//   # Plan title
//
//   > status: working · assignee: ashiq@…
//
//   ## Wave 1 — Wave title
//
//   - [x] Task title  <!-- task:abc123 -->
//     - [ ] Subtask title  <!-- task:def456 -->
//
// The HTML comment is the source of truth for matching markdown lines
// back to A2A task ids; we never parse titles. Editing the title in
// markdown is a future round-trip (v2). For v1, title edits are not
// pushed back — title is owned by A2A.

import type { PendingPlan } from "./api";

/** Stable note id for a plan's persisted Page. Plans persist into the
 *  Pages library under team scope with a deterministic id derived from
 *  `plan.id`, so re-presenting the same plan updates one page instead
 *  of spawning duplicates (notes_write upserts on an explicit id). */
export function planPageId(planId: string): string {
  const slug = planId
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return `plan-${slug || "untitled"}`;
}

/** Serialize a freshly-proposed `PendingPlan` envelope into durable
 *  markdown for the Pages library. Unlike {@link planTreeToMarkdown}
 *  (which serializes a BUILT a2a task tree), this renders the proposal
 *  exactly as it is presented in chat: title, summary, objective,
 *  baseline, an architecture mermaid block, phases with file refs,
 *  deliverables, tests, and the todo checklist. Only sections with
 *  content are emitted so a minimal title/summary/todos plan still
 *  reads cleanly. */
export function pendingPlanToMarkdown(plan: PendingPlan): string {
  const lines: string[] = [];
  lines.push(`# ${plan.title?.trim() || "Untitled plan"}`);
  lines.push("");
  if (plan.summary?.trim()) {
    lines.push(plan.summary.trim());
    lines.push("");
  }

  const section = (heading: string, body: string | undefined) => {
    if (!body?.trim()) return;
    lines.push(`## ${heading}`);
    lines.push("");
    lines.push(body.trim());
    lines.push("");
  };
  section("Objective", plan.objective);
  section("Baseline", plan.baseline);

  if (plan.architecture_mermaid?.trim()) {
    lines.push("## Architecture");
    lines.push("");
    lines.push("```mermaid");
    lines.push(plan.architecture_mermaid.trim());
    lines.push("```");
    lines.push("");
  }

  if (plan.phases && plan.phases.length > 0) {
    lines.push("## Phases");
    lines.push("");
    for (const [i, phase] of plan.phases.entries()) {
      lines.push(`### Phase ${i + 1} — ${phase.title}`);
      lines.push("");
      if (phase.body?.trim()) {
        lines.push(phase.body.trim());
        lines.push("");
      }
      for (const ref of phase.file_refs ?? []) {
        lines.push(`- \`${ref}\``);
      }
      if ((phase.file_refs ?? []).length > 0) lines.push("");
    }
  }

  const bulletList = (heading: string, items: string[] | undefined) => {
    if (!items || items.length === 0) return;
    lines.push(`## ${heading}`);
    lines.push("");
    for (const item of items) lines.push(`- ${item}`);
    lines.push("");
  };
  bulletList("Deliverables", plan.deliverables);
  bulletList("Tests", plan.tests);

  if (plan.todos && plan.todos.length > 0) {
    lines.push("## Tasks");
    lines.push("");
    for (const todo of plan.todos) {
      const who = todo.agent ? ` _(${todo.agent})_` : "";
      lines.push(`- [ ] ${todo.description}${who}`);
      for (const ref of todo.file_refs ?? []) {
        lines.push(`  - \`${ref}\``);
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}

export type A2aRow = {
  id: string;
  status: string;
  task_kind?: string;
  parent_task_id?: string | null;
  input?: { description?: string; title?: string } | string | null;
  input_text?: string | null;
  assignee_user_id?: string | null;
  acceptance_criteria?: string | null;
  metadata?: Record<string, unknown> | null;
  input_metadata?: Record<string, unknown> | null;
};

function metaBag(row: A2aRow): Record<string, unknown> {
  const m = (row.input_metadata ?? row.metadata) as
    | Record<string, unknown>
    | null
    | undefined;
  return m && typeof m === "object" ? m : {};
}

function metaStr(row: A2aRow, key: string): string | null {
  const v = metaBag(row)[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

function kindOf(row: A2aRow): string {
  return row.task_kind ?? metaStr(row, "task_kind") ?? "task";
}

function parentOf(row: A2aRow): string | null {
  return row.parent_task_id ?? metaStr(row, "parent_task_id");
}

function acOf(row: A2aRow): string | null {
  return row.acceptance_criteria ?? metaStr(row, "acceptance_criteria");
}

type Node = { row: A2aRow; children: Node[] };

function titleOf(row: A2aRow): string {
  if (typeof row.input === "string") return row.input;
  if (row.input && typeof row.input === "object") {
    return row.input.description ?? row.input.title ?? row.id;
  }
  if (row.input_text) return row.input_text;
  return row.id;
}

function buildTree(rows: A2aRow[], rootId: string): Node | null {
  const byId = new Map<string, Node>();
  for (const row of rows) byId.set(row.id, { row, children: [] });
  for (const node of byId.values()) {
    const parent = parentOf(node.row);
    if (parent && byId.has(parent)) {
      byId.get(parent)!.children.push(node);
    }
  }
  return byId.get(rootId) ?? null;
}

const DONE_STATUSES = new Set(["completed"]);

function checkbox(status: string): string {
  return DONE_STATUSES.has(status) ? "[x]" : "[ ]";
}

/** Serialize one plan (rooted at `planId`) plus all of its descendants
 *  into the markdown form documented at the top of the file. Tasks /
 *  subtasks not reachable from `planId` are skipped — callers should
 *  pass the slice they want serialized. */
export function planTreeToMarkdown(
  rows: A2aRow[],
  planId: string,
): string {
  const root = buildTree(rows, planId);
  if (!root) return `<!-- plan ${planId} not found -->\n`;
  const lines: string[] = [];
  lines.push(`# ${titleOf(root.row)}`);
  lines.push("");
  const meta: string[] = [];
  meta.push(`status: ${root.row.status}`);
  if (root.row.assignee_user_id) meta.push(`assignee: ${root.row.assignee_user_id}`);
  lines.push(`> ${meta.join(" · ")}  <!-- task:${root.row.id} -->`);
  lines.push("");
  const rootAc = acOf(root.row);
  if (rootAc) {
    lines.push(rootAc.trim());
    lines.push("");
  }

  // Waves are the first level under the plan. Anything not a wave at
  // root level (e.g. a stray task pinned directly to the plan) gets
  // grouped under an implicit "Unscoped" heading at the bottom.
  const waves = root.children.filter((c) => kindOf(c.row) === "wave");
  const unscoped = root.children.filter((c) => kindOf(c.row) !== "wave");

  for (const [i, wave] of waves.entries()) {
    lines.push(`## Wave ${i + 1} — ${titleOf(wave.row)}  <!-- task:${wave.row.id} -->`);
    lines.push("");
    const waveAc = acOf(wave.row);
    if (waveAc) {
      lines.push(`> ${waveAc.trim().replace(/\n/g, " ")}`);
      lines.push("");
    }
    writeTaskList(lines, wave.children, 0);
    lines.push("");
  }

  if (unscoped.length > 0) {
    lines.push(`## Unscoped`);
    lines.push("");
    writeTaskList(lines, unscoped, 0);
    lines.push("");
  }

  return lines.join("\n");
}

function writeTaskList(out: string[], nodes: Node[], depth: number) {
  for (const node of nodes) {
    const indent = "  ".repeat(depth);
    out.push(
      `${indent}- ${checkbox(node.row.status)} ${titleOf(node.row)}  <!-- task:${node.row.id} -->`,
    );
    if (node.children.length > 0) {
      writeTaskList(out, node.children, depth + 1);
    }
  }
}

// ─── round-trip parsing ─────────────────────────────────────────────

const TASK_ID_RE = /<!--\s*task:([^\s]+)\s*-->/;
const CHECKBOX_RE = /^\s*-\s*\[([ xX])\]\s+/;

export type ParsedCheckbox = {
  taskId: string;
  checked: boolean;
  /** Original markdown line — caller can substitute back when patching. */
  line: string;
  /** Zero-based line number in the source file. */
  lineNo: number;
};

/** Walk every line of a plan markdown and extract task-id + checked
 *  status for every `- [ ] / - [x]` row that has a `<!-- task:id -->`
 *  tag. Callers diff this snapshot against the previous one to learn
 *  which tasks the user just toggled. */
export function parsePlanCheckboxes(md: string): ParsedCheckbox[] {
  const out: ParsedCheckbox[] = [];
  const lines = md.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const cm = line.match(CHECKBOX_RE);
    if (!cm) continue;
    const tm = line.match(TASK_ID_RE);
    if (!tm) continue;
    out.push({
      taskId: tm[1],
      checked: cm[1].toLowerCase() === "x",
      line,
      lineNo: i,
    });
  }
  return out;
}
