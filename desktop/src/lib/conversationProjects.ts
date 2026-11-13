//! Which projects a conversation in a history list is about.
//!
//! Aura's panel lists every conversation, not just one workspace's, so a row
//! that doesn't say where it belongs is a row you have to open to find out.
//! The list row carries every bound root (`projects`) on current builds; an
//! older backend sends only the first (`repo_root`) and a count, which still
//! says "this one, plus N others" honestly.

import type { ManagerSummary } from "./api";

type ProjectsOf = Pick<ManagerSummary, "repo_root" | "project_count" | "projects">;

function rootName(root: string): string {
  return root.split("/").filter(Boolean).pop() || root;
}

/** The project roots a conversation is bound to, first one first. */
export function conversationProjects(s: ProjectsOf): string[] {
  const listed = (s.projects ?? []).filter((r) => r.trim() !== "");
  if (listed.length > 0) return listed;
  return s.repo_root ? [s.repo_root] : [];
}

/** A short caption for a history row: the first project's folder name, and
 *  "+N" for the rest. Empty when the conversation is bound to no project. */
export function projectsCaption(s: ProjectsOf): string {
  const roots = conversationProjects(s);
  if (roots.length === 0) return "";
  const total = Math.max(roots.length, s.project_count ?? 0);
  const more = total - 1;
  return more > 0 ? `${rootName(roots[0])} +${more}` : rootName(roots[0]);
}

/** The full list, for a row's tooltip — the caption shortens, this doesn't. */
export function projectsTooltip(s: ProjectsOf): string {
  const roots = conversationProjects(s);
  const total = Math.max(roots.length, s.project_count ?? 0);
  const unnamed = total - roots.length;
  const lines = roots.slice();
  if (unnamed > 0) lines.push(`and ${unnamed} more`);
  return lines.join("\n");
}
