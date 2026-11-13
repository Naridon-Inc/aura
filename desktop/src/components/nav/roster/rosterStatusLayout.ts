// The workspace list grouped by where the work stands instead of by
// repository: one section per stage, the stage being the one the Dashboard
// shows (the pull request's, unless the card was moved by hand; see
// lib/workspaceStage). Pure, like `layoutRoster`, so the ⌘1–⌘9 numbers come
// from the same pass as the sections they are painted in.

import type { WorktreeRef } from "../../../lib/workspaceRef";
import type { WorktreeBadge } from "../../../lib/useWorktreeBadges";
import { effectiveStage, type StagePins } from "../../../lib/workspaceStage";
import { copyStage } from "../../workspaces/workspacesOverview";
import type { WorkspaceStage } from "../../ui/workspace-preview-card";
import {
  PINNED_KEY,
  repoPainted,
  sectionPainted,
  sortRows,
  type PlacedRow,
  type RosterLayout,
  type RosterSort,
} from "./rosterLayout";

/** "Group by" in the list heading: a section per repository, or per stage. */
export type RosterGroupBy = "repo" | "status";

/** Finished work first, then what is waiting on review, then what is being
 *  worked, then what is parked, then what went nowhere. */
export const STATUS_ORDER: readonly WorkspaceStage[] = [
  "done",
  "in-review",
  "in-progress",
  "backlog",
  "canceled",
];

/** The fold key for a stage's section. Repository keys are absolute paths, so
 *  a key that does not start with "/" can never collide with one. */
export const statusKey = (stage: WorkspaceStage) => `status-${stage}`;

/** Where the pull request alone puts a workspace. */
export function derivedRowStage(badge: WorktreeBadge | undefined): WorkspaceStage {
  return copyStage(
    badge?.pr ? { number: badge.pr.number, state: badge.pr.state.toLowerCase() } : null,
  );
}

/** The stage a workspace is listed under: the Dashboard's. */
export function rowStage(
  path: string,
  badgeByPath: Record<string, WorktreeBadge> | undefined,
  stagePins: StagePins,
): WorkspaceStage {
  return effectiveStage(stagePins[path], derivedRowStage(badgeByPath?.[path]));
}

export type StatusGroup = {
  stage: WorkspaceStage;
  rows: PlacedRow[];
  collapsed: boolean;
};

export function layoutStatusGroups(input: {
  layout: RosterLayout;
  sort: RosterSort;
  activePath: string;
  badgeByPath?: Record<string, WorktreeBadge>;
  stagePins: StagePins;
  /** Folds set by hand. A stage nobody folded or unfolded starts folded,
   *  unless the workspace you are in is under it. */
  collapsed: Record<string, boolean>;
}): { groups: StatusGroup[]; switchPaths: string[] } {
  const { layout } = input;
  // Pinned repositories keep their place under "Pinned"; the rest of the
  // list's workspaces are what gets sorted into stages.
  const placed = layout.rest.flatMap((repo) => repo.rows.map((w) => ({ w, repo })));
  const byPath = new Map(placed.map((row) => [row.w.path, row] as const));
  const sorted = sortRows(
    placed.map((row) => row.w),
    input.sort,
  ).map((w: WorktreeRef) => byPath.get(w.path)!);
  const groups = STATUS_ORDER.map((stage): StatusGroup => {
    const rows = sorted.filter(
      (row) => rowStage(row.w.path, input.badgeByPath, input.stagePins) === stage,
    );
    const set = input.collapsed[statusKey(stage)];
    return {
      stage,
      rows,
      collapsed: set ?? !rows.some((row) => row.w.path === input.activePath),
    };
  });
  const pinnedOpen = !input.collapsed[PINNED_KEY];
  const painted = [
    ...(pinnedOpen ? layout.pinnedRows.map((row) => row.w) : []),
    ...(pinnedOpen ? layout.pinned : []).flatMap(repoPainted),
    ...layout.sections.flatMap((s) => sectionPainted(s, input.activePath)),
    ...groups.flatMap((g) => (g.collapsed ? [] : g.rows.map((row) => row.w))),
  ];
  return { groups, switchPaths: painted.slice(0, 9).map((w) => w.path) };
}
