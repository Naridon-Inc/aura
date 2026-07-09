// When the user opens a plan markdown tab, push a compact summary of
// the plan (title, waves, tasks with status + assignee) into whatever
// Manager session is currently active. The summary lands as a user
// turn prefixed with `[context]` so the brain treats it as
// out-of-band signal — when the user follows up with "what's next?"
// the agent already knows the structure without re-fetching.
//
// Honest about scope:
//   - We use `managerChat` (a user turn) instead of `aura_handover`
//     because there's no dedicated "inject system note" entry point
//     yet. Marking the message clearly keeps the chat readable.
//   - If no Manager is active we no-op silently. Opening a plan tab
//     should not spawn a chat the user didn't ask for.
//   - We swallow errors. The plan tab opens whether or not the brain
//     accepts the context push (cloud-off, brain busy, etc.).

import { api } from "./api";
import { getActiveManagerSessionId } from "./editorStore";
import { effectiveAgent, effectiveAssignee } from "./taskPreferences";
import { repoSlugFor } from "./repoSlug";

type A2aRow = {
  id: string;
  status: string;
  task_kind?: string;
  parent_task_id?: string | null;
  branch?: string | null;
  assignee_user_id?: string | null;
  metadata?: Record<string, unknown> | null;
  input_metadata?: Record<string, unknown> | null;
  input?: { description?: string; title?: string } | string | null;
  input_text?: string | null;
};

function metaBag(r: A2aRow): Record<string, unknown> {
  const m = (r.input_metadata ?? r.metadata) as
    | Record<string, unknown>
    | null
    | undefined;
  return m && typeof m === "object" ? m : {};
}

function metaStr(r: A2aRow, key: string): string | null {
  const v = metaBag(r)[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

function parentOf(r: A2aRow): string | null {
  return r.parent_task_id ?? metaStr(r, "parent_task_id");
}

export async function pushPlanContextToManager(
  repoRoot: string,
  planId: string,
): Promise<void> {
  const sessionId = getActiveManagerSessionId();
  if (!sessionId) return;
  try {
    const rows = await fetchPlanRows(repoRoot);
    const summary = renderPlanSummary(rows, planId);
    if (!summary) return;
    await api.managerChat(sessionId, summary);
  } catch {
    // Best-effort — never block tab open on context push.
  }
}

async function fetchPlanRows(repoRoot: string): Promise<A2aRow[]> {
  const slug = await repoSlugFor(repoRoot);
  const args = ["a2a-task", "list", "--limit", "500", "--json"];
  if (slug) args.push("--repo", slug);
  const r = await api.auraCli(repoRoot, args);
  if (r.status !== 0) return [];
  const text = r.stdout.trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    const arr = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.tasks)
        ? parsed.tasks
        : [];
    return arr as A2aRow[];
  } catch {
    return [];
  }
}

function renderPlanSummary(rows: A2aRow[], planId: string): string | null {
  const byId = new Map<string, A2aRow>();
  for (const r of rows) byId.set(r.id, r);
  const plan = byId.get(planId);
  if (!plan) return null;

  const lines: string[] = [];
  lines.push(`[context] plan opened: ${titleOf(plan)} (id ${planId})`);

  const waves = rows.filter(
    (r) => parentOf(r) === planId && kindOf(r) === "wave",
  );
  const orphanTasks = rows.filter(
    (r) =>
      parentOf(r) === planId &&
      (kindOf(r) === "task" || kindOf(r) === "subtask"),
  );

  if (waves.length === 0 && orphanTasks.length === 0) {
    lines.push("(no waves or tasks yet)");
  } else {
    for (const w of waves) {
      lines.push(`- wave: ${titleOf(w)} — ${w.status}`);
      const tasks = rows.filter((r) => parentOf(r) === w.id);
      for (const t of tasks) lines.push(`  - ${formatTask(t)}`);
    }
    for (const t of orphanTasks) lines.push(`- ${formatTask(t)}`);
  }

  return lines.join("\n");
}

function formatTask(r: A2aRow): string {
  const assignee = effectiveAssignee(
    r.id,
    r.assignee_user_id,
    metaStr(r, "assignee"),
  );
  const agent = effectiveAgent(r.id, kindOf(r));
  const bits = [titleOf(r), `status=${r.status}`, `agent=${agent}`];
  if (assignee) bits.push(`assignee=${assignee}`);
  return bits.join(" · ");
}

function kindOf(r: A2aRow): string {
  return r.task_kind ?? metaStr(r, "task_kind") ?? "task";
}

function titleOf(r: A2aRow): string {
  if (typeof r.input === "string") return r.input;
  if (r.input && typeof r.input === "object") {
    return r.input.description ?? r.input.title ?? r.id;
  }
  if (r.input_text) return r.input_text;
  return r.id;
}
