// What the "Link workspaces" dialog lists, and which agents can use a link.
//
// The links themselves are stored with the rest of a workspace's settings
// (workspaceCustomization.ts). This file reads the workspaces they can point
// at — every checkout of every other project — and groups and filters them
// the way the dialog shows them.

import { api, type ProjectEntry, type WorktreeEntry } from "./api";
import { humanizeCopyTitle, worktreeParentRoot } from "./workspaceLabel";
import { isWorkspaceArchived } from "./workspaceCustomization";

/** One workspace another workspace can be linked to. */
export interface LinkableWorkspace {
  /** The checkout's root. A link stores this. */
  id: string;
  /** What the sidebar calls it. */
  name: string;
  /** The checkout's folder name. */
  directoryName: string;
  branch: string | null;
  /** The project (repository) it belongs to, by its main checkout's root. */
  repoId: string;
  repoName: string;
  /** Hidden from the sidebar. A link to it is not handed to agents. */
  archived: boolean;
  /** Linked, but no project lists it any more (its copy was deleted). */
  gone?: boolean;
}

/** Linked but not usable: archived, or gone. Shown as missing. */
export function isMissing(ws: LinkableWorkspace): boolean {
  return ws.archived || !!ws.gone;
}

/** The project heading for a workspace whose project can't be found. */
export const UNKNOWN_REPOSITORY = "Unknown Repository";

/** `workspaces` plus one row for each linked workspace no project lists. */
export function withGoneLinks(
  workspaces: readonly LinkableWorkspace[],
  linkedIds: readonly string[],
): LinkableWorkspace[] {
  const known = new Set(workspaces.map((w) => w.id));
  const gone = linkedIds
    .filter((id) => !known.has(id))
    .map((id) => ({
      id,
      name: baseName(id),
      directoryName: baseName(id),
      branch: null,
      repoId: "",
      repoName: UNKNOWN_REPOSITORY,
      archived: false,
      gone: true,
    }));
  return [...workspaces, ...gone];
}

/** Agents with a real flag for reading extra folders. Kept in step with
 *  `linked_dirs.rs`, which builds the flags. */
export const LINKED_DIR_AGENTS = ["claude", "codex", "gemini", "kimi", "antigravity"] as const;

const ALIASES: Record<string, string> = {
  cc: "claude",
  claude_code: "claude",
  "claude-code": "claude",
  claudecode: "claude",
  gem: "gemini",
  cx: "codex",
  agy: "antigravity",
};

function canonicalAgentId(id: string): string {
  const key = id.trim().toLowerCase();
  return ALIASES[key] ?? key;
}

/** Whether the engine behind this id is handed linked folders: a terminal
 *  agent by its id, or a chat brain wrapping one (`cli_wrapper:<agent>`).
 *  A chat brain that runs its own tools (an API key, ACP) is not. */
export function agentReadsLinkedDirs(id: string | null | undefined): boolean {
  if (!id) return false;
  const wrapped = id.startsWith("cli_wrapper:") ? id.slice("cli_wrapper:".length) : id;
  if (wrapped.includes(":")) return false;
  return (LINKED_DIR_AGENTS as readonly string[]).includes(canonicalAgentId(wrapped));
}

export function baseName(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

export interface LinkableGroup {
  repoId: string;
  repoName: string;
  rows: LinkableWorkspace[];
}

/** Other projects' workspaces, grouped by project in the order they came,
 *  narrowed to those whose folder, branch or project name contains `query`.
 *  An archived or gone workspace is listed only while it is linked, so the
 *  link can be seen and undone. */
export function groupLinkable(
  workspaces: readonly LinkableWorkspace[],
  currentRepoId: string | null,
  query: string,
  linked: ReadonlySet<string> = new Set(),
): LinkableGroup[] {
  const q = query.trim().toLowerCase();
  const groups = new Map<string, LinkableGroup>();
  for (const ws of workspaces) {
    if (ws.repoId === currentRepoId) continue;
    if (isMissing(ws) && !linked.has(ws.id)) continue;
    if (
      q &&
      !ws.directoryName.toLowerCase().includes(q) &&
      !(ws.branch ?? "").toLowerCase().includes(q) &&
      !ws.repoName.toLowerCase().includes(q)
    ) {
      continue;
    }
    const group = groups.get(ws.repoId) ?? { repoId: ws.repoId, repoName: ws.repoName, rows: [] };
    group.rows.push(ws);
    groups.set(ws.repoId, group);
  }
  return Array.from(groups.values());
}

function toLinkable(project: ProjectEntry, wt: WorktreeEntry): LinkableWorkspace {
  return {
    id: wt.path,
    name: humanizeCopyTitle(wt.branch, wt.is_main, wt.path),
    directoryName: baseName(wt.path),
    branch: wt.branch || null,
    repoId: project.root,
    repoName: project.label || baseName(project.root),
    archived: isWorkspaceArchived(wt.path),
  };
}

/** Every checkout of every project this app knows, and which project the
 *  workspace at `currentRoot` belongs to. A project whose checkouts can't be
 *  read still offers its main one. */
export async function loadLinkableWorkspaces(currentRoot: string): Promise<{
  workspaces: LinkableWorkspace[];
  currentRepoId: string | null;
}> {
  const projects = await api.projectsList();
  const lists = await Promise.all(
    projects.map((p) =>
      api.gitWorktreeList(p.root).catch((): WorktreeEntry[] => [
        { path: p.root, branch: "", head: "", is_main: true, locked: false },
      ]),
    ),
  );
  const workspaces: LinkableWorkspace[] = [];
  let currentRepoId: string | null = null;
  projects.forEach((project, i) => {
    const checkouts = lists[i].length > 0 ? lists[i] : [
      { path: project.root, branch: "", head: "", is_main: true, locked: false },
    ];
    for (const wt of checkouts) {
      if (wt.path === currentRoot || project.root === currentRoot) currentRepoId = project.root;
      if (workspaces.some((w) => w.id === wt.path)) continue;
      workspaces.push(toLinkable(project, wt));
    }
  });
  return {
    workspaces,
    currentRepoId: currentRepoId ?? worktreeParentRoot(currentRoot) ?? currentRoot,
  };
}
