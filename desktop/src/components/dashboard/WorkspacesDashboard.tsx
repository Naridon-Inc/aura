// The Dashboard: every workspace — the main checkout and each parallel copy of
// every open repository — on the library's stage board, drawn as it is: the
// repository tabs along the top, the five stages side by side, a card per
// workspace. Opening a card goes to that workspace.
//
// A card's stage is its pull request's (see `copyStage`) until you drag it
// somewhere else; the move is kept until the pull request changes (see
// lib/workspaceStage). The rows are Home's own (see useWorkspaceRows), so a
// copy reads the same on both pages.
//
// A repository's main checkout shows only while work is happening on it, under
// the repository's name (see dashboardCards).
//
// The board holds the place the window is in and nothing else (see
// lib/placeScope): on this computer, its checkouts and copies; cloud work has
// its own board in the cloud place, and is fetched only when you are there.
//
// The header's "Pull requests" view swaps the board for every pull request
// of the repository you are standing in (see PullRequestList): one workspace
// is one pull request, and its own lives in that workspace's Checks tab, so
// this is the one place that lists them all.

import type { JSX } from "react";
import { useCallback, useState } from "react";
import { GitPullRequest } from "lucide-react";

import { ProjectAvatar } from "../ProjectAvatar";
import type { GitWorkflowAction } from "../ui/git-workflow";
import { EmptyState } from "../ui/state";
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group";
import { WorkspaceDashboard } from "../ui/workspace-dashboard";
import type { WorkspaceStage } from "../ui/workspace-preview-card";
import { WorkspacesPage, WorkspacesPageHeader } from "../ui/workspaces-page";
import type { PrSummary } from "../../lib/api";
import { workspaceUnreadCount } from "../../lib/editorStore";
import { prStartSelection } from "../../lib/prStartPoint";
import { filterToScope, usePlaceScope, type WorkspaceHome } from "../../lib/placeScope";
import { effectiveStage, setWorkspaceStage, useWorkspaceStagePins } from "../../lib/workspaceStage";
import type { WorktreeRef } from "../../lib/workspaceRef";
import type { WorktreeBadge } from "../../lib/useWorktreeBadges";
import { openCreateWorkspace } from "../workspace/createWorkspaceEvents";
import { runWorkspaceAction } from "../workspaces/fleetActions";
import type { ProjectMeta } from "../workspaces/workspacesModel";
import {
  activeRepository,
  useWorkspaceRows,
  type WorkspaceRowSource,
} from "../workspaces/useWorkspaceRows";
import { dashboardCards } from "./dashboardCards";
import { PullRequestList } from "./PullRequestList";

/** What the Dashboard shows: the stage board, or the repository's pull
 *  requests. Kept per viewer, so the page opens the way it was left. */
export type DashboardView = "workspaces" | "pulls";
const VIEW_KEY = "aura.dashboard.view";

function readView(): DashboardView {
  try {
    return localStorage.getItem(VIEW_KEY) === "pulls" ? "pulls" : "workspaces";
  } catch {
    return "workspaces";
  }
}

function keepView(view: DashboardView): void {
  try {
    localStorage.setItem(VIEW_KEY, view);
  } catch {
    /* storage refused — the choice lasts until the page closes */
  }
}

export type WorkspacesDashboardProps = {
  projects: ProjectMeta[];
  worktreesByRoot: Record<string, WorktreeRef[]>;
  badgeByPath: Record<string, WorktreeBadge>;
  /** The checkout open now. */
  activePath: string;
  /** Go to a workspace (its checkout path). */
  onOpen: (path: string) => void;
  /** Ask for a repository when there is none to make a workspace in. */
  onAddWorkspace?: () => void;
  onClose: () => void;
};

/** Where a row's workspace lives: a checkout or copy is on this disk, a cloud
 *  thread is in the cloud. */
function homeOf(source: WorkspaceRowSource | undefined): WorkspaceHome {
  return source?.kind === "cloud" ? { cloud: true } : {};
}

export function WorkspacesDashboard({
  projects,
  worktreesByRoot,
  badgeByPath,
  activePath,
  onOpen,
  onAddWorkspace,
  onClose,
}: WorkspacesDashboardProps): JSX.Element {
  const scope = usePlaceScope();
  const [view, setView] = useState<DashboardView>(readView);
  const chooseView = (next: DashboardView) => {
    setView(next);
    keepView(next);
  };
  const { rows: all, sources } = useWorkspaceRows({
    projects,
    worktreesByRoot,
    badgeByPath,
    activePath,
    cloudRoots: scope.kind === "cloud" ? null : false,
  });
  // Worked out on every render, not memoised: a chat waiting in a workspace
  // that is not in front lives only in that workspace's saved tabs, and the
  // one thing that announces it is the editor store's repaint, which
  // useWorkspaceRows already re-renders this page on.
  const rows = dashboardCards(
    filterToScope(scope, all, (row) => homeOf(sources.get(row.id))),
    (id) => sources.get(id),
    (path) => workspaceUnreadCount(path) > 0,
  );

  const pins = useWorkspaceStagePins();
  const cards = rows.map((row) => {
    const stage = effectiveStage(pins[row.id], row.stage);
    return stage === row.stage ? row : { ...row, stage };
  });

  // A move remembers the stage git gave the card, so the pull request moving
  // on can take the card with it.
  const move = useCallback(
    (id: string, stage: WorkspaceStage) => {
      const row = rows.find((r) => r.id === id);
      if (row) setWorkspaceStage(id, stage, row.stage);
    },
    [rows],
  );

  const open = useCallback(
    (id: string) => {
      onOpen(id);
      onClose();
    },
    [onOpen, onClose],
  );

  const onAction = useCallback(
    (id: string, action: GitWorkflowAction) => {
      const src = sources.get(id);
      if (src?.kind !== "copy") return;
      void runWorkspaceAction({ copy: src.copy, pr: src.pr, action, onOpen: open });
    },
    [sources, open],
  );

  // New workspace makes one in the repository you are standing in, and asks
  // for a repository when none is open.
  const root = activeRepository(projects, worktreesByRoot, activePath);
  const onCreate = () => {
    if (root) openCreateWorkspace(root);
    else onAddWorkspace?.();
  };

  // A pull request with no workspace yet opens the Create dialog already
  // starting from it, so the workspace begins from what was reviewed.
  const openAsWorkspace = useCallback(
    (pr: PrSummary) => {
      if (!root) return;
      openCreateWorkspace(root, {
        from: prStartSelection(pr),
      });
    },
    [root],
  );

  return (
    <WorkspacesPage label="Dashboard" onClose={onClose}>
      <WorkspacesPageHeader
        title="Dashboard"
        actions={
          <ToggleGroup
            type="single"
            size="sm"
            aria-label="What the Dashboard shows"
            value={view}
            onValueChange={(v) => v && chooseView(v as DashboardView)}
          >
            <ToggleGroupItem value="workspaces">Workspaces</ToggleGroupItem>
            <ToggleGroupItem value="pulls">Pull requests</ToggleGroupItem>
          </ToggleGroup>
        }
      />
      {view === "workspaces" ? (
        <WorkspaceDashboard
          workspaces={cards}
          onOpen={open}
          onMove={move}
          onAction={onAction}
          onCreate={onCreate}
          repositoryIcon={(id, name) => <ProjectAvatar root={id} name={name} size={14} />}
        />
      ) : root ? (
        <PullRequestList
          key={root}
          repoRoot={root}
          repositoryName={projects.find((p) => p.id === root)?.name}
          worktrees={worktreesByRoot[root] ?? []}
          onOpenedPr={onClose}
          onGoToWorkspace={open}
          onOpenAsWorkspace={openAsWorkspace}
        />
      ) : (
        <EmptyState
          icon={GitPullRequest}
          title="No repository open"
          body="Open a repository to see its pull requests."
        />
      )}
    </WorkspacesPage>
  );
}
