// Project model for the HUD's switcher — resolved from backend truth so it's
// correct across every window/worktree, not just the main window's tabs.
//
// The user's mental model is PROJECTS, not the machine worktrees Aura spins up
// for parallel agents. A path like `~/.aura/worktrees/p-2daf…/zagreb` is the
// managed layout `<store>/<projectId>/<branch>` — `zagreb`/`granada` are just
// branch instances of ONE project ("New Git"). So the switcher lists distinct
// projects (from the `~/.aura/projects.json` registry, which already excludes
// worktrees), each with a live agent count, and lets you drill into a project's
// worktree instances to switch between them.
//
// Sources (all global custom commands, callable from the HUD window):
//   • api.projectsList()    → real repos + human labels (registry)
//   • api.ptyListAlive()    → live agent PTYs across windows + the pty-daemon
//   • api.gitWorktreeList() → a project's worktree instances (lazy, on expand)

import { api } from "./api";
import type { LivePtySession, ProjectEntry, WorktreeEntry } from "./api";

/** A worktree instance of a project (the main checkout, or a parallel copy). */
export type HudInstance = {
  /** Absolute worktree root — the value handed to `loadProjectAt` on switch. */
  root: string;
  /** Short label: "Main" for the primary checkout, else the branch/city. */
  label: string;
  isMain: boolean;
  /** Live agents in this exact worktree. */
  running: number;
};

/** A distinct project (a real repo), aggregating all its worktree instances. */
export type HudProjectGroup = {
  /** `p-<hex>` project id (the segment a managed worktree path embeds). */
  id: string;
  /** Human project name from the registry ("New Git"). */
  label: string;
  /** Original repo root. */
  root: string;
  /** Live agents across ALL of this project's worktree instances. */
  running: number;
};

export type HudModel = {
  projects: HudProjectGroup[];
  activeProjectId: string | null;
};

// A machine-created worktree of any agent CLI. Substring match (matches the
// managed `<store>/<projectId>/<branch>` layout too) — mirrors App.tsx's
// `isManagedWorktree`. Note: workspaceLabel's `isWorktreeRoot` does NOT, since
// its regex only allows a single segment after `worktrees/`.
const MANAGED_WT_RE = /\/\.(?:claude|gemini|aura)\/worktrees\//;
// The `p-<hex>` project id embedded right after `worktrees/` in a managed root.
const MANAGED_ID_RE = /\/worktrees\/(p-[0-9a-f]+)(?:\/|$)/i;

export function isManagedWorktreeRoot(root: string): boolean {
  return MANAGED_WT_RE.test(root);
}

function normRoot(p: string): string {
  return p.length > 1 ? p.replace(/\/+$/, "") : p;
}

export function sameRoot(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return normRoot(a) === normRoot(b);
}

/** The project id for a root: parsed straight from a managed worktree path
 *  (JS can't recompute the SipHash), else matched against the registry by the
 *  original repo root. */
export function projectIdForRoot(
  root: string,
  projects: ProjectEntry[],
): string | null {
  // Managed layout `<store>/p-<id>/<branch>` embeds the project id directly.
  const m = root.match(MANAGED_ID_RE);
  if (m) return m[1];
  // Sibling layout `<repo>/.aura/worktrees/<name>` (e.g. crew's per-agent
  // worktrees): the project IS the parent repo, so match THAT against the
  // registry — the worktree root itself is in no registry.
  const sib = root.match(/^(.*)\/\.(?:claude|gemini|aura)\/worktrees\//);
  const n = normRoot(sib ? sib[1] : root);
  return projects.find((p) => normRoot(p.root) === n)?.id ?? null;
}

function countByProject(
  alive: LivePtySession[],
  projects: ProjectEntry[],
): Map<string, number> {
  const by = new Map<string, number>();
  for (const s of alive) {
    const pid = projectIdForRoot(s.repo_root, projects);
    if (!pid) continue;
    by.set(pid, (by.get(pid) ?? 0) + 1);
  }
  return by;
}

/** Distinct projects + their live agent counts. The active project is pinned
 *  first; the rest keep the registry's most-recently-opened order. Capped so
 *  the little menu stays glanceable. */
export async function loadHudModel(activeRoot: string | null): Promise<HudModel> {
  const [projects, alive] = await Promise.all([
    api.projectsList().catch(() => [] as ProjectEntry[]),
    api.ptyListAlive().catch(() => [] as LivePtySession[]),
  ]);

  const counts = countByProject(alive, projects);
  const activeProjectId = activeRoot ? projectIdForRoot(activeRoot, projects) : null;

  const groups: HudProjectGroup[] = projects.map((p) => ({
    id: p.id,
    label: p.label,
    root: p.root,
    running: counts.get(p.id) ?? 0,
  }));

  const active = groups.find((g) => g.id === activeProjectId);
  const rest = groups.filter((g) => g.id !== activeProjectId);
  const ordered = (active ? [active, ...rest] : rest).slice(0, 8);

  return { projects: ordered, activeProjectId };
}

/** Humanize a worktree leaf/branch into a short label. Crew's per-agent
 *  worktrees are named `agent-<long-hex>` — show "Agent <short>" instead of a
 *  20-char hash. */
export function prettyLeaf(leaf: string): string {
  const agent = leaf.match(/^(?:worktree-)?agent[-_/](.+)$/i);
  if (agent) return `Agent ${agent[1].replace(/[-_/]+/g, "").slice(0, 6)}`;
  const pretty = leaf
    .replace(/^(?:worktree-)?(?:lane|work)[-_/]/i, "")
    .replace(/[-_/]+/g, " ")
    .trim();
  return pretty ? pretty.charAt(0).toUpperCase() + pretty.slice(1) : "Copy";
}

function instanceLabel(w: WorktreeEntry): string {
  if (w.is_main) return "Main";
  return prettyLeaf(w.branch || w.path.split("/").filter(Boolean).pop() || "copy");
}

/** A project's worktree instances (main + parallel copies) with per-instance
 *  live agent counts. Fetched lazily when a project is expanded. Pass `alive`
 *  to reuse a counts snapshot; omit to fetch a fresh one. */
export async function loadInstances(
  project: HudProjectGroup,
  alive?: LivePtySession[],
): Promise<HudInstance[]> {
  const [wts, live] = await Promise.all([
    api.gitWorktreeList(project.root).catch(() => [] as WorktreeEntry[]),
    alive ?? api.ptyListAlive().catch(() => [] as LivePtySession[]),
  ]);

  const byRoot = new Map<string, number>();
  for (const s of live) {
    const r = normRoot(s.repo_root);
    byRoot.set(r, (byRoot.get(r) ?? 0) + 1);
  }

  const out: HudInstance[] = wts.map((w) => ({
    root: w.path,
    label: instanceLabel(w),
    isMain: w.is_main,
    running: byRoot.get(normRoot(w.path)) ?? 0,
  }));

  // Always offer at least the main checkout, even if `git worktree list` came
  // back empty (e.g. the repo moved) — so switching to the project still works.
  if (out.length === 0) {
    out.push({
      root: project.root,
      label: "Main",
      isMain: true,
      running: byRoot.get(normRoot(project.root)) ?? 0,
    });
  }
  // Main first, then busiest copies, then the rest alphabetically.
  out.sort((a, b) => {
    if (a.isMain !== b.isMain) return a.isMain ? -1 : 1;
    if (a.running !== b.running) return b.running - a.running;
    return a.label.localeCompare(b.label);
  });
  return out;
}
