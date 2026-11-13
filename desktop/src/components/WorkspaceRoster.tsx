// The sidebar's workspace list: every repository you have open, each a
// navigation section listing the places it is checked out (workspaces on this
// computer, machines connected for it, and cloud work running on them).
//
// Pinned workspaces and repositories come first under their own heading, then
// the sections you made; archived repositories and workspaces sit at the foot.
// Workspaces are dragged between them (nav/roster/sections).
// Every row's actions are offered twice, on right-click and from its hover
// "…" button, from one list (see nav/roster/rosterMenu).
//
// The pieces live under nav/roster/: what is drawn is worked out by
// `layoutRoster` before any of it is drawn, so the ⌘1–⌘9 numbers on screen
// come from the same pass as the rows.

import { useEditorStore, workspaceUnreadCount } from "../lib/editorStore";
import { agentsOnCopy } from "../lib/agentsOnCopy";
import { useLivePtySessionIds } from "../lib/useLiveAgentSessions";
import { useMinuteTick } from "../lib/useMinuteTick";
import { useWorkingRoots } from "../lib/useFleetActivity";
import { useWorkspaceCustomization } from "../lib/workspaceCustomization";
import { humanizeWorkspaceName } from "../lib/workspaceLabel";
import { usePlaceScope } from "../lib/placeScope";
import { useWorkspaceStagePins } from "../lib/workspaceStage";
import type { WorktreeBadge } from "../lib/useWorktreeBadges";
import type { Workspace } from "../lib/workspaceRef";
import { PINNED_KEY, layoutRoster, type RepositoryLayout } from "./nav/roster/rosterLayout";
import type { LaneAgent, RosterEnv } from "./nav/roster/rosterTypes";
import { useRosterState } from "./nav/roster/useRosterState";
import { useRosterPlaces } from "./nav/roster/useRosterPlaces";
import { useRosterPick } from "./nav/roster/useRosterPick";
import { useEmojiPick } from "./nav/roster/useEmojiPick";
import { RosterGroupHeader } from "./nav/roster/RosterGroupHeader";
import { STATUS_ORDER, layoutStatusGroups, statusKey } from "./nav/roster/rosterStatusLayout";
import { RosterStatusGroups } from "./nav/roster/RosterStatusGroups";
import { RepositoryGroup } from "./nav/roster/RepositoryGroup";
import { WorkspaceRow } from "./nav/roster/WorkspaceRow";
import { ArchivedRepositories, RosterSection } from "./nav/roster/RosterSections";
import {
  MachinePlaceRoster,
  arrangeMachineSections,
  machineSections,
} from "./nav/roster/MachinePlaceRoster";
import { AddProjectFirst } from "./nav/roster/SidebarFirstWorkspace";
import { useRosterSections } from "./nav/roster/sections/sectionStore";
import { MAIN_DROP, PINNED_DROP, useSectionDrag } from "./nav/roster/sections/useSectionDrag";
import { RosterCustomSection } from "./nav/roster/sections/RosterCustomSection";
import { SectionDialog } from "./nav/roster/sections/SectionDialog";
import {
  moveRepoToSectionEntry,
  moveToSectionEntry,
} from "./nav/roster/sections/sectionMenus";
import { openSectionDialog } from "./nav/roster/sections/sectionDialogState";
import { useSectionCreateFiling } from "./nav/roster/sections/sectionCreate";
import "./nav/roster/roster.css";

type WorkspaceRosterProps = {
  workspaces: Workspace[];
  /** The open workspace's path: the row whose path matches is lit. */
  activePath: string;
  /** Home, Dashboard or Trace fills the window: no row is lit, the way the
   *  sidebar's own Home row takes the highlight while you are there. */
  pageUp?: boolean;
  /** Diff + PR badges keyed by worktree path (from useWorktreeBadges). */
  badgeByPath?: Record<string, WorktreeBadge>;
  onSelectProject?: (id: string) => void;
  onOpenWorktree?: (path: string) => void;
  /** Take a repository off the list. Omit to hide "Remove repository". */
  onCloseProject?: (id: string) => void;
  /** Permanently remove one workspace's checkout from disk, passed
   *  (repository root, workspace path). Omit to hide "Remove workspace…".
   *  Never offered for the repository's own checkout or the open one. */
  onRemoveWorktree?: (root: string, path: string) => void;
  /** Open the Workspaces view, scoped to one repository. */
  onOpenAllCopies?: (projectId?: string) => void;
  /** Add a repository to the list (open a folder). Omit to hide the header's
   *  "Add repository" control. */
  onAddProject?: () => void;
  /** Open the recovery dialog for checkouts that fell off `git worktree
   *  list` while their folders still exist on disk. */
  onFindWorktrees?: (root: string) => void;
};

export function WorkspaceRoster({
  workspaces,
  activePath,
  pageUp = false,
  badgeByPath,
  onSelectProject,
  onOpenWorktree,
  onCloseProject,
  onRemoveWorktree,
  onOpenAllCopies,
  onAddProject,
  onFindWorktrees,
}: WorkspaceRosterProps) {
  const editor = useEditorStore();
  const custom = useWorkspaceCustomization();
  const stagePins = useWorkspaceStagePins();
  const workingRoots = useWorkingRoots();
  // One clock for every age in the list, so two rows can never land on
  // opposite sides of a minute and disagree about the same commit.
  const now = useMinuteTick();
  const pick = useRosterPick();
  const state = useRosterState({ activePath, custom, onOpenWorktree });
  const places = useRosterPlaces({ workspaces, custom, now });
  // The list shows the place you are in and nothing else: this computer's
  // checkouts and copies, or the machine in front. The account menu's place
  // switcher is the way across. (The cloud has its own sidebar.)
  const scope = usePlaceScope();
  const onMachine = scope.kind === "machine" ? scope.machineId : null;
  const machineAll = onMachine
    ? machineSections(onMachine, places.placesByRoot, places.unplacedPlaces)
    : [];
  // The heading's filter and sort reach a machine's list too.
  const machineRows = arrangeMachineSections(machineAll, state.sort, state.repoFilter);
  // The conversation you came onto this machine through is one of its rows.
  const machineThreads = onMachine
    ? [...places.cloudThreadsByRoot.values()]
        .flat()
        .concat(places.orphanCloudThreads)
        .filter((t) => t.key === places.activeThreadKey)
    : [];
  const { pickIcon, captureProps } = useEmojiPick();
  // Sections belong to this computer's list; a machine's list has its own.
  const sections = useRosterSections();
  useSectionCreateFiling();
  const sectionDrag = useSectionDrag(sections, "workspace-roster");
  const { drag, carryingWorkspace, carriedRepo } = sectionDrag;
  // Something that can land in "Pinned", a section or "My workspaces" is
  // being carried: a workspace row, or a whole repository by its header.
  const carrying = carryingWorkspace || carriedRepo !== null;

  // Which terminal sessions are still running, across every repository: the
  // only evidence an agent in a workspace you aren't looking at is real.
  // Resolved once per path per render; the ordering and the rows both ask.
  const livePtyIds = useLivePtySessionIds(true);
  const agentCache = new Map<string, LaneAgent[]>();
  const agentsForPath = (path: string): LaneAgent[] => {
    let agents = agentCache.get(path);
    if (!agents) {
      agents = agentsOnCopy(path, editor.agentTabs, livePtyIds);
      agentCache.set(path, agents);
    }
    return agents;
  };

  // A main checkout with a chat waiting stays listed even while another
  // workspace is in front, and any row with one wears the dot; only its saved
  // tabs know.
  const unreadAt = (path: string) => workspaceUnreadCount(path) > 0;
  const layout = layoutRoster({
    workspaces,
    sort: state.sort,
    repoFilter: state.repoFilter,
    custom,
    activePath,
    now,
    agentCount: (path) => agentsForPath(path).length,
    badgeByPath,
    visited: state.visited,
    collapsed: state.collapsed,
    expanded: state.expanded,
    workingRoots,
    unreadAt,
    sections: onMachine ? [] : sections,
  });
  // Grouped by status, the repositories below "Pinned" give their workspaces
  // up to one section per stage.
  const byStatus =
    state.groupBy === "status" && !onMachine
      ? layoutStatusGroups({
          layout,
          sort: state.sort,
          activePath,
          badgeByPath,
          stagePins,
          collapsed: state.collapsed,
        })
      : null;
  const switchPaths = byStatus?.switchPaths ?? layout.switchPaths;
  // The shortcut fires the path at the number the row shows.
  state.switchPathsRef.current = switchPaths;
  const switchNoByPath = new Map(switchPaths.map((path, i) => [path, i + 1] as const));

  // The repositories drawn with their own header: pinned, filed in a
  // section, then the rest.
  const filed = layout.sections.flatMap((s) => s.repos);
  const visible = [...layout.pinned, ...filed, ...layout.rest];
  // The headings "My workspaces" folds and unfolds: the repositories (or the
  // stages) here, or the machine's sections there. A stage folds by default,
  // so unfolding one is written down, not forgotten.
  const folds: { key: string; folded: boolean; byDefault: boolean }[] = onMachine
    ? machineRows.map((m) => ({ key: m.key, folded: !!state.collapsed[m.key], byDefault: false }))
    : [
        ...(byStatus ? [...layout.pinned, ...filed] : visible).map((repo) => ({
          key: repo.ws.id,
          folded: repo.collapsed,
          byDefault: false,
        })),
        ...(byStatus?.groups ?? []).map((g) => ({
          key: statusKey(g.stage),
          folded: g.collapsed,
          byDefault: true,
        })),
      ];
  const anyExpanded = folds.some((f) => !f.folded);
  const toggleAll = () => {
    const next = { ...state.collapsed };
    for (const f of folds) {
      if (anyExpanded) next[f.key] = true;
      else if (f.byDefault) next[f.key] = false;
      else delete next[f.key];
    }
    state.setCollapsed(next);
  };
  const chooseGroupBy = (g: typeof state.groupBy) =>
    state.chooseGroupBy(
      g,
      g === "status" ? STATUS_ORDER.map(statusKey) : workspaces.map((ws) => ws.id),
    );

  const env: RosterEnv = {
    now,
    activePath,
    activeMachineId: places.activeMachineId,
    pageUp,
    activeThreadKey: places.activeThreadKey,
    heldMachineIds: places.heldMachineIds,
    heldThreadKeys: places.heldThreadKeys,
    badgeByPath,
    custom,
    workingRoots,
    cmdHeld: state.cmdHeld,
    switchNoByPath,
    agentsForPath,
    unreadAt,
    stagePins,
    renaming: state.renaming,
    startRename: state.startRename,
    setRenameValue: state.setRenameValue,
    commitRename: state.commitRename,
    cancelRename: state.cancelRename,
    pickIcon,
    toggleCollapsed: state.toggleCollapsed,
    toggleExpanded: state.toggleExpanded,
    dragRow: onMachine ? undefined : (path) => drag.source({ kind: "workspace", path }),
    moveToSection: onMachine ? undefined : (path) => moveToSectionEntry(path, sections),
    dragRepo: onMachine ? undefined : (id) => drag.source({ kind: "repo", id }),
    moveRepoToSection: onMachine ? undefined : (id) => moveRepoToSectionEntry(id, sections),
    carriedRepo,
    actions: {
      onSelectProject,
      onOpenWorktree,
      onCloseProject,
      onRemoveWorktree,
      onOpenAllCopies,
      onAddProject,
      onFindWorktrees,
    },
  };

  const group = (repo: RepositoryLayout) => (
    <RepositoryGroup
      key={repo.ws.id}
      repo={repo}
      env={env}
      pick={pick}
    />
  );

  return (
    <div className="ui-sidebar-group" data-kind="section">
      <RosterGroupHeader
        anyExpanded={anyExpanded}
        onToggleAll={toggleAll}
        groupBy={state.groupBy}
        onGroupBy={onMachine ? undefined : chooseGroupBy}
        sort={state.sort}
        onSort={state.chooseSort}
        repos={
          onMachine
            ? machineAll.flatMap((m) =>
                m.root
                  ? [{ id: m.root, name: custom[m.root]?.name || humanizeWorkspaceName(m.root) }]
                  : [],
              )
            : workspaces
                .filter((ws) => typeof custom[ws.id]?.archived !== "number")
                .map((ws) => ({ id: ws.id, name: humanizeWorkspaceName(ws.id) }))
        }
        repoFilter={state.repoFilter}
        onRepoFilter={state.chooseRepoFilter}
        // Adding a project and sections belong to this computer's list.
        onAddProject={onMachine ? undefined : onAddProject}
        onNewSection={onMachine ? undefined : () => openSectionDialog({ mode: "new" })}
      />
      <nav className="ui-navigation-groups ui-roster" aria-label="Workspaces">
        {onMachine ? (
          <MachinePlaceRoster
            machineId={onMachine}
            loading={places.machinesLoading}
            sections={machineRows}
            threads={machineThreads}
            collapsed={state.collapsed}
            onToggle={state.toggleCollapsed}
            onCreate={() =>
              window.dispatchEvent(
                new CustomEvent("aura:new-workspace", { detail: { createFrom: true } }),
              )
            }
            env={env}
            pick={pick}
          />
        ) : (
          <>
        {visible.length === 0 && <AddProjectFirst />}
        {/* While a workspace or a repository is carried, "Pinned" is there
            to drop it on even when nothing is pinned yet. */}
        {(layout.pinnedRows.length + layout.pinned.length > 0 || carrying) && (
          <RosterSection
            kind="pinned"
            title="Pinned"
            count={layout.pinnedRows.length + layout.pinned.length}
            collapsed={!!state.collapsed[PINNED_KEY]}
            onToggle={() => state.toggleCollapsed(PINNED_KEY)}
            drop={drag.target(PINNED_DROP)}
            dropOver={carrying && drag.over === PINNED_DROP}
          >
            {layout.pinnedRows.map(({ w, repo }) => (
              <WorkspaceRow key={w.path} w={w} repo={repo} env={env} pick={pick} placement="pinned" />
            ))}
            {layout.pinned.map(group)}
          </RosterSection>
        )}
        {layout.sections.map((s) => (
          <RosterCustomSection
            key={s.section.id}
            layout={s}
            env={env}
            pick={pick}
            drag={drag}
            line={sectionDrag.line}
            carryingWorkspace={carryingWorkspace}
            carriedRepo={carriedRepo}
            draggedSection={sectionDrag.draggedSection}
          />
        ))}
        {/* Everything in no section; a workspace dropped here leaves its
            section (or "Pinned") for its repository, and a repository
            dropped here leaves its section (or "Pinned") for this list. */}
        <div
          className="ui-roster-drop-zone"
          data-carrying={carrying || undefined}
          data-drop-over={(carrying && drag.over === MAIN_DROP) || undefined}
          {...drag.target(MAIN_DROP)}
        >
          {byStatus ? (
            <RosterStatusGroups
              groups={byStatus.groups}
              env={env}
              pick={pick}
              showRepository={!state.repoFilter}
              onToggle={(g) => state.setFold(statusKey(g.stage), !g.collapsed)}
            />
          ) : (
            layout.rest.map(group)
          )}
        </div>
        <ArchivedRepositories
          archived={layout.archived}
          rows={layout.archivedRows}
          pick={pick}
          open={state.showArchived}
          onToggle={() => state.setShowArchived(!state.showArchived)}
          env={env}
        />
          </>
        )}
      </nav>
      {/* Where the system emoji picker's glyph lands for "Change icon". Kept
          mounted so focus lands at once. */}
      <input {...captureProps} />
      <SectionDialog sections={sections} />
    </div>
  );
}
