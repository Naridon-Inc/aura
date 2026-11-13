// What the workspace list draws, worked out before any of it is drawn: the
// repositories in order (pinned first, archived set aside), each repository's
// workspaces split into the ones always shown and the ones behind "Show more",
// the workspaces pinned above every repository or archived below them, and
// the ⌘1–⌘9 order. A repository's main checkout is where the repository
// lives, not a workspace: it is listed only while work is on it, and its
// repository's row is the way to it otherwise. Pure, so the number a row
// shows is computed in the same pass, from the same order, as the rows
// themselves.

import type { Workspace, WorktreeRef } from "../../../lib/workspaceRef";
import type { WorktreeBadge } from "../../../lib/useWorktreeBadges";
import { splitCopies, touchedAt } from "../../../lib/rosterCopies";
import { humanizeWorkspaceName } from "../../../lib/workspaceLabel";
import { relativeAgeFromSecs } from "../../../lib/relativeTime";
import type { Customization } from "./rosterTypes";
import { reposOf, sectionKey, type RosterSectionDef } from "./sections/sectionModel";

/** How each repository's workspaces are ordered, chosen from the heading's
 *  "Sort by": newest change first, or newest made first. */
export type RosterSort = "updated" | "created";

/** The fold key for the "Pinned" section. Repository keys are absolute paths,
 *  so a key that does not start with "/" can never collide with one. */
export const PINNED_KEY = ":pinned";

/** A repository's workspaces in "Sort by" order: "updated" puts the one
 *  that changed last (its newest commit, or the day it was made) first;
 *  "created" the one made last. Ties keep git's own order. */
export function sortRows(rows: WorktreeRef[], sort: RosterSort): WorktreeRef[] {
  const key = sort === "created" ? (w: WorktreeRef) => w.created_at ?? 0 : touchedAt;
  return [...rows].sort((a, b) => key(b) - key(a));
}

export type RepositoryLayout = {
  ws: Workspace;
  name: string;
  /** The icon the user chose for this repository, when they chose one. */
  emoji?: string;
  /** The workspaces listed under it: every copy, and the main checkout only
   *  while it is in use (see `mainInUse`). */
  rows: WorktreeRef[];
  /** Always shown: the active workspace, live ones, recent ones, and the
   *  `aura work` sessions after them. */
  shown: WorktreeRef[];
  /** Behind the "Show N more" row. */
  inactive: WorktreeRef[];
  /** The repository's main checkout, which a click on its name opens. */
  homePath: string;
  /** An agent or Aura chat is mid-turn in one of this repository's workspaces. */
  working: boolean;
  /** …and that workspace is not on screen, so the header has to say it. */
  workingHidden: boolean;
  /** Since the newest commit on any of its workspaces. */
  age: string;
  collapsed: boolean;
  showInactive: boolean;
};

export type RosterLayoutInput = {
  workspaces: Workspace[];
  sort: RosterSort;
  /** "Filter by project": the one repository listed, or null for all. */
  repoFilter?: string | null;
  custom: Customization;
  activePath: string;
  now: number;
  agentCount: (path: string) => number;
  badgeByPath?: Record<string, WorktreeBadge>;
  visited: Record<string, number>;
  collapsed: Record<string, boolean>;
  expanded: Record<string, boolean>;
  workingRoots: ReadonlySet<string>;
  /** A chat is waiting for you in the workspace at this path, read from its
   *  saved tabs when it is not the one in front. */
  unreadAt?: (path: string) => boolean;
  /** The sections you made, in order, each naming the workspaces it holds. */
  sections?: readonly RosterSectionDef[];
};

/** A workspace listed away from its repository: pinned at the top of the
 *  list, put in a section, or archived at its foot. */
export type PlacedRow = { w: WorktreeRef; repo: RepositoryLayout };

/** A section as drawn: its workspaces that are still on the list, then the
 *  repositories filed under it whole, each in the section's own order. */
export type SectionLayout = {
  section: RosterSectionDef;
  rows: PlacedRow[];
  repos: RepositoryLayout[];
  collapsed: boolean;
};

export type RosterLayout = {
  /** Pinned workspaces, in "Sort by" order, above the pinned repositories. */
  pinnedRows: PlacedRow[];
  pinned: RepositoryLayout[];
  /** Between "Pinned" and the repositories. */
  sections: SectionLayout[];
  /** The repositories in no section and not pinned. */
  rest: RepositoryLayout[];
  /** Newest archive first. */
  archived: Workspace[];
  /** Archived workspaces of the repositories still listed, newest first. */
  archivedRows: PlacedRow[];
  /** Paths ⌘1–⌘9 jump to, top to bottom as painted. */
  switchPaths: string[];
};

const bare = (p: string) => p.replace(/\/+$/, "");

// A repository's own checkout shares its key with the repository, so it is
// pinned and archived as the repository, never as a row of its own.
const archivedRow = (w: WorktreeRef, custom: Customization) =>
  !w.is_main && typeof custom[w.path]?.archived === "number";
const pinnedRow = (w: WorktreeRef, custom: Customization) =>
  !w.is_main && !!custom[w.path]?.pinned && !archivedRow(w, custom);
// Pinned wins over a section, so a workspace is listed once.
const sectionedRow = (w: WorktreeRef, custom: Customization, sectioned: ReadonlySet<string>) =>
  !w.is_main && sectioned.has(w.path) && !pinnedRow(w, custom) && !archivedRow(w, custom);

/** What a section paints: its rows, then each of its repositories' own; only
 *  the open row while folded. */
export function sectionPainted(s: SectionLayout, activePath: string): WorktreeRef[] {
  if (s.collapsed) return s.rows.filter((row) => row.w.path === activePath).map((row) => row.w);
  return [...s.rows.map((row) => row.w), ...s.repos.flatMap(repoPainted)];
}

/** A repository with no sibling worktrees is still one workspace: its own
 *  checkout. */
function rowsOf(ws: Workspace): WorktreeRef[] {
  const worktrees = ws.worktrees ?? [];
  if (worktrees.length > 0) return worktrees;
  return [{ path: ws.id, branch: "", head: "", is_main: true, locked: false }];
}

/** Whether work is on a main checkout, so it is listed as a workspace: it is
 *  the one in front, it has edits not yet committed, a chat is running on it
 *  or waiting for you, or a machine elsewhere is working its branch. Clean
 *  and idle, it is left off the list, as the Dashboard leaves it off the
 *  board. */
export function mainInUse(w: WorktreeRef, input: RosterLayoutInput): boolean {
  const badge = input.badgeByPath?.[w.path];
  return (
    w.path === input.activePath ||
    input.agentCount(w.path) > 0 ||
    input.workingRoots.has(bare(w.path)) ||
    !!input.unreadAt?.(w.path) ||
    (!!badge && (badge.added > 0 || badge.removed > 0 || badge.changedFiles > 0 || !!badge.cloud))
  );
}

function layoutRepository(
  ws: Workspace,
  input: RosterLayoutInput,
  sectioned: ReadonlySet<string>,
): RepositoryLayout {
  const { custom, activePath, workingRoots } = input;
  const all = rowsOf(ws);
  const rows = all.filter(
    (w) =>
      !pinnedRow(w, custom) &&
      !archivedRow(w, custom) &&
      !sectionedRow(w, custom, sectioned) &&
      (!w.is_main || mainInUse(w, input)),
  );
  const { primary, workSessions, inactive } = splitCopies({
    rows,
    activePath,
    now: Date.now(),
    agentCount: input.agentCount,
    badgeByPath: input.badgeByPath,
    visited: input.visited,
  });
  const shown = [...sortRows(primary, input.sort), ...sortRows(workSessions, input.sort)];
  const showInactive = !!input.expanded[ws.id];
  const collapsed = !!input.collapsed[ws.id];
  const isWorking = (w: WorktreeRef) => workingRoots.has(bare(w.path));
  const working = workingRoots.has(bare(ws.id)) || all.some(isWorking);
  const visible = collapsed ? [] : showInactive ? rows : shown;
  return {
    ws,
    name: humanizeWorkspaceName(ws.id),
    emoji: custom[ws.id]?.emoji ?? ws.emoji,
    rows,
    shown,
    inactive,
    homePath: all.find((w) => w.is_main)?.path ?? ws.id,
    working,
    workingHidden:
      working &&
      !visible.some(isWorking) &&
      !all.some(
        (w) => (pinnedRow(w, custom) || sectionedRow(w, custom, sectioned)) && isWorking(w),
      ),
    age: relativeAgeFromSecs(
      all.reduce((max, w) => Math.max(max, w.head_committed_at ?? 0), 0),
      { style: "compact", now: input.now, empty: "" },
    ),
    collapsed,
    showInactive,
  };
}

/** What a repository paints: nothing folded, its shown workspaces, and the
 *  rest too once "Show more" is open. */
export const repoPainted = (repo: RepositoryLayout): WorktreeRef[] =>
  repo.collapsed ? [] : repo.showInactive ? [...repo.shown, ...repo.inactive] : repo.shown;

export function layoutRoster(input: RosterLayoutInput): RosterLayout {
  const { custom } = input;
  // A filter naming a repository that is gone (removed, or on another
  // computer) lists everything rather than nothing.
  const filter = input.repoFilter;
  const ordered =
    filter && input.workspaces.some((ws) => ws.id === filter)
      ? input.workspaces.filter((ws) => ws.id === filter)
      : input.workspaces;
  const isArchived = (ws: Workspace) => typeof custom[ws.id]?.archived === "number";
  const archived = ordered
    .filter(isArchived)
    .sort((a, b) => (custom[b.id]?.archived ?? 0) - (custom[a.id]?.archived ?? 0));
  const live = ordered.filter((ws) => !isArchived(ws));
  const defs = input.sections ?? [];
  const sectioned = new Set(defs.flatMap((s) => s.paths));
  const lay = (ws: Workspace) => layoutRepository(ws, input, sectioned);
  // A repository is listed once: pinned wins over a section, as it does for
  // a workspace, and a filed one leaves "My workspaces".
  const isPinned = (ws: Workspace) => !!custom[ws.id]?.pinned;
  const filedIn = new Map<string, string>();
  for (const def of defs) {
    for (const id of reposOf(def)) if (!filedIn.has(id)) filedIn.set(id, def.id);
  }
  const pinned = live.filter(isPinned).map(lay);
  const filed = new Map(
    live
      .filter((ws) => !isPinned(ws) && filedIn.has(ws.id))
      .map((ws) => [ws.id, lay(ws)] as const),
  );
  const rest = live.filter((ws) => !isPinned(ws) && !filedIn.has(ws.id)).map(lay);

  const placed = (keep: (w: WorktreeRef) => boolean): PlacedRow[] =>
    [...pinned, ...filed.values(), ...rest].flatMap((repo) =>
      rowsOf(repo.ws)
        .filter(keep)
        .map((w) => ({ w, repo })),
    );
  const pinnedPlaced = placed((w) => pinnedRow(w, custom));
  const byPath = new Map(pinnedPlaced.map((row) => [row.w.path, row] as const));
  const pinnedRows = sortRows(
    pinnedPlaced.map((row) => row.w),
    input.sort,
  ).map((w) => byPath.get(w.path)!);
  const inSections = new Map(
    placed((w) => sectionedRow(w, custom, sectioned)).map((row) => [row.w.path, row] as const),
  );
  const sections = defs.map(
    (section): SectionLayout => ({
      section,
      rows: section.paths.flatMap((p) => inSections.get(p) ?? []),
      repos: reposOf(section).flatMap((id) =>
        filedIn.get(id) === section.id ? (filed.get(id) ?? []) : [],
      ),
      collapsed: !!input.collapsed[sectionKey(section.id)],
    }),
  );
  const archivedRows = placed((w) => archivedRow(w, custom)).sort(
    (a, b) => (custom[b.w.path]?.archived ?? 0) - (custom[a.w.path]?.archived ?? 0),
  );

  const switchPaths: string[] = [];
  const pinnedOpen = !input.collapsed[PINNED_KEY];
  const painted = [
    ...(pinnedOpen ? pinnedRows.map((row) => row.w) : []),
    ...(pinnedOpen ? pinned : []).flatMap(repoPainted),
    ...sections.flatMap((s) => sectionPainted(s, input.activePath)),
    ...rest.flatMap(repoPainted),
  ];
  for (const w of painted.slice(0, 9)) switchPaths.push(w.path);
  return { pinnedRows, pinned, sections, rest, archived, archivedRows, switchPaths };
}
