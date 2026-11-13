// The workspace rows the ⌘K palette lists, whichever place they come from,
// and the rules it lists them by: a row matches when every word typed is in
// its name, branch, folder or repository; the recent ones are the latest five
// still active, not counting the one in front; the Workspaces tab narrows by
// owner, repository and archived state.

import type { WorkspaceStage } from "../ui/workspace-preview-card";

export type PaletteWorkspace = {
  id: string;
  title: string;
  branch: string;
  /** The repository's name, and the key it is filtered by. */
  project: string;
  projectId: string;
  stage: WorkspaceStage;
  updatedAt: number;
  timeLabel: string;
  archived: boolean;
  unread: boolean;
  /** An agent is working in it now. */
  live: boolean;
  /** Its repository's picture: a folder here, a hosted repository in the cloud. */
  repo: { kind: "local"; root: string } | { kind: "cloud"; fullName: string | null } | null;
  /** The cloud's short id for the row, printed in its own column there. */
  number?: string;
  /** The member who opened it, in the cloud. */
  owner?: string;
  /** Everything a query is matched against. */
  fields: string[];
};

/** Every word typed is somewhere in the row. */
export function workspaceMatches(row: PaletteWorkspace, query: string): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = row.fields.join(" ").toLowerCase();
  return words.every((w) => hay.includes(w));
}

/** At most this many rows in any one list. */
export const WORKSPACE_LIMIT = 50;

const byActivity = (a: PaletteWorkspace, b: PaletteWorkspace) => b.updatedAt - a.updatedAt;

/** The latest active workspaces, leaving out the one already in front. */
export function recentWorkspaces(
  rows: readonly PaletteWorkspace[],
  activeId: string | null,
  count = 5,
): PaletteWorkspace[] {
  return rows
    .filter((r) => !r.archived && r.id !== activeId)
    .sort(byActivity)
    .slice(0, count);
}

/** The matches for a query, active first then archived, latest first. */
export function searchWorkspaces(
  rows: readonly PaletteWorkspace[],
  query: string,
): { active: PaletteWorkspace[]; archived: PaletteWorkspace[] } {
  const hits = rows.filter((r) => workspaceMatches(r, query)).sort(byActivity);
  return {
    active: hits.filter((r) => !r.archived).slice(0, WORKSPACE_LIMIT),
    archived: hits.filter((r) => r.archived).slice(0, WORKSPACE_LIMIT),
  };
}

export type ArchiveFilter = "active" | "all" | "archived";

export const ARCHIVE_FILTER_LABEL: Record<ArchiveFilter, string> = {
  active: "Hiding archived",
  all: "Showing all",
  archived: "Only archived",
};

export type WorkspaceFilters = {
  owners: string[];
  projects: string[];
  archive: ArchiveFilter;
};

export const DEFAULT_WORKSPACE_FILTERS: WorkspaceFilters = { owners: [], projects: [], archive: "active" };
export const CLEARED_WORKSPACE_FILTERS: WorkspaceFilters = { owners: [], projects: [], archive: "all" };

/** A filter narrows the list (the default hides archived, which counts). */
export function filtersActive(f: WorkspaceFilters): boolean {
  return f.owners.length > 0 || f.projects.length > 0 || f.archive !== "all";
}

/** The Workspaces tab's rows: filtered, matched, latest first, then split. */
export function filterWorkspaces(
  rows: readonly PaletteWorkspace[],
  query: string,
  f: WorkspaceFilters,
): { active: PaletteWorkspace[]; archived: PaletteWorkspace[]; total: number } {
  const kept = rows
    .filter((r) => {
      if (f.archive === "active" && r.archived) return false;
      if (f.archive === "archived" && !r.archived) return false;
      if (f.projects.length && !f.projects.includes(r.projectId)) return false;
      if (f.owners.length && !(r.owner && f.owners.includes(r.owner))) return false;
      return workspaceMatches(r, query);
    })
    .sort(byActivity)
    .slice(0, WORKSPACE_LIMIT);
  return {
    active: kept.filter((r) => !r.archived),
    archived: kept.filter((r) => r.archived),
    total: kept.length,
  };
}

/** The repositories the rows belong to, once each, by name. */
export function repositoriesOf(
  rows: readonly PaletteWorkspace[],
): { id: string; name: string; repo: PaletteWorkspace["repo"] }[] {
  const seen = new Map<string, { id: string; name: string; repo: PaletteWorkspace["repo"] }>();
  for (const r of rows) if (!seen.has(r.projectId)) seen.set(r.projectId, { id: r.projectId, name: r.project, repo: r.repo });
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Toggle one id in a multi-pick. */
export function toggleId(ids: readonly string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
}
