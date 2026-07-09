// Open a plan as a Plans/<planId>.md tab.
//
// Workflow:
//   1. Read the current task tree from `aura a2a-task list --repo …`.
//   2. Generate markdown for the requested plan via `planTreeToMarkdown`.
//   3. Write to `<repoRoot>/.aura/plans/<planId>.md` (creating the
//      directory tree if missing).
//   4. Hand the canonical path to `editorStore.openFile` — the file
//      tab plumbing takes over from there, and WorkSurface routes the
//      file through `PlanMarkdownTab` because of `isPlanMarkdownPath`.
//
// We re-generate the markdown on every open so the file reflects the
// latest A2A state. Subsequent saves from the markdown tab persist
// user-authored notes (the file is a real editable file), and the next
// open call will overwrite — that's the documented trade-off for v1.
// A "preserve human edits between opens" pass is a later wave.

import { api } from "./api";
import { openFileImperative, planMarkdownPath } from "./editorStore";
import { pushPlanContextToManager } from "./managerContextSync";
import { planTreeToMarkdown, type A2aRow } from "./planMarkdown";
import { repoSlugFor } from "./repoSlug";

export async function openPlanMarkdownTab(
  repoRoot: string,
  planId: string,
): Promise<void> {
  const path = planMarkdownPath(repoRoot, planId);
  const rows = await fetchPlanRows(repoRoot);
  const md = planTreeToMarkdown(rows, planId);
  await ensureDir(repoRoot);
  await api.writeFile(path, md);
  await openFileImperative(path);
  // P6 — push a compact plan summary into the active Manager session
  // so the chat agent can answer "what's next" without re-fetching.
  // Fire-and-forget: the tab is already visible by the time this runs.
  void pushPlanContextToManager(repoRoot, planId);
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

async function ensureDir(repoRoot: string): Promise<void> {
  // Tauri's writeFile creates the file but not parent dirs on some
  // platforms. We shell `mkdir -p` via auraCli so we don't need a
  // separate Tauri command. Idempotent + safe.
  try {
    await api.auraCli(repoRoot, ["fs", "mkdir-p", ".aura/plans"]);
  } catch {
    // Best-effort. If aura doesn't expose mkdir-p, writeFile will still
    // succeed in the common case (directory already exists because
    // other Aura subsystems create it).
  }
}
