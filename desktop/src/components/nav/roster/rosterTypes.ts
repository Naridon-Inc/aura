// Shapes shared by the workspace list's modules: the actions the app hands the
// list, the per-row environment the list hands each row, and the in-row rename.

import type { WorktreeBadge } from "../../../lib/useWorktreeBadges";
import type { useWorkspaceCustomization } from "../../../lib/workspaceCustomization";
import type { StagePins } from "../../../lib/workspaceStage";
import type { PointerEvent } from "react";
import type { MenuEntry } from "./rosterMenu";

/** Per-path name / icon / pin / archive overrides, as the store hands them out. */
export type Customization = ReturnType<typeof useWorkspaceCustomization>;

/** What the app lets the list do. Every one is optional: an action the app
 *  does not wire is an action the list does not offer. */
export type RosterActions = {
  onSelectProject?: (id: string) => void;
  onOpenWorktree?: (path: string) => void;
  /** Take a repository off the list. Its checkout stays on disk. */
  onCloseProject?: (id: string) => void;
  /** Delete one workspace's checkout from disk. Never offered for the
   *  repository's own checkout or for the workspace you are in. */
  onRemoveWorktree?: (root: string, path: string) => void;
  /** Open the full Workspaces view, scoped to one repository. */
  onOpenAllCopies?: (projectId?: string) => void;
  onAddProject?: () => void;
  /** Open the recovery dialog for checkouts that fell off the worktree list. */
  onFindWorktrees?: (root: string) => void;
};

/** One agent standing in a workspace: a live tab, or a persisted one whose
 *  terminal is still running. */
export type LaneAgent = {
  sessionId: string;
  agentId: string;
  agentLabel: string;
  attention: boolean;
};

/** The row being renamed in place, and the text typed so far. A repository and
 *  its own checkout share one key, so the row kind says which one is editing. */
export type Renaming = {
  key: string;
  value: string;
  at: "repository" | "workspace";
};

/** Everything a row reads that is the same for every row in the list. Built
 *  once per render of the list and handed down, so two rows can never
 *  disagree about what time it is or which machine you are on. */
export type RosterEnv = {
  now: number;
  activePath: string;
  activeMachineId: string | null;
  /** Home, Dashboard or Trace fills the window. You have stepped out of the
   *  workspace you were in, so no row is lit until you go back into one. */
  pageUp: boolean;
  activeThreadKey: string | null;
  heldMachineIds: ReadonlySet<string>;
  heldThreadKeys: ReadonlySet<string>;
  badgeByPath?: Record<string, WorktreeBadge>;
  custom: Customization;
  workingRoots: ReadonlySet<string>;
  /** Command is held: rows show their quick-switch number. */
  cmdHeld: boolean;
  switchNoByPath: ReadonlyMap<string, number>;
  agentsForPath: (path: string) => LaneAgent[];
  /** A chat is waiting in the workspace at this path, read from its saved
   *  tabs, for a workspace that is not the one in front. */
  unreadAt: (path: string) => boolean;
  /** Stages set by hand, from the Dashboard or a row's "Set status". */
  stagePins: StagePins;
  renaming: Renaming | null;
  startRename: (key: string, at: Renaming["at"]) => void;
  setRenameValue: (value: string) => void;
  commitRename: () => void;
  cancelRename: () => void;
  pickIcon: (id: string) => void;
  toggleCollapsed: (id: string) => void;
  toggleExpanded: (id: string) => void;
  actions: RosterActions;
  /** Where a drag of the workspace at this path starts (into a section, onto
   *  "Pinned", back to "My workspaces"). Absent where rows don't move. */
  dragRow?: (path: string) => { onPointerDown: (event: PointerEvent<HTMLElement>) => void };
  /** The row menu's "Move to section" for the workspace at this path. */
  moveToSection?: (path: string) => MenuEntry;
  /** Where a drag of the repository with this id starts, from its header: a
   *  whole repository into a section, onto "Pinned", or back to "My
   *  workspaces". Absent where repositories don't move. */
  dragRepo?: (id: string) => { onPointerDown: (event: PointerEvent<HTMLElement>) => void };
  /** The repository menu's "Move to section" for the repository with this id. */
  moveRepoToSection?: (id: string) => MenuEntry;
  /** The repository being carried by its header, drawn faded where it was. */
  carriedRepo?: string | null;
};
