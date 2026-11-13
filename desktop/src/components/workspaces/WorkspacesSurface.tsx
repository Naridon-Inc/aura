// Workspaces — Home. Every copy of every open repository in one list, beside
// the work sent to other machines, so the sidebar can stay a curated few.
//
// The page is `WorkspaceHome` itself: its 40px toolbar (search, repository
// filter, archived, sort, display, Create) and its 44px rows with the hover
// preview. This file only turns what the app already knows into those rows —
// see `workspacesOverview` for what each field says and why — and hands each
// row's buttons to the action that already does that job elsewhere.

import { useCallback, useMemo, type ReactNode } from "react";

import { FullscreenOverlay } from "../FullscreenOverlay";
import { ProjectAvatar } from "../ProjectAvatar";
import { WorkspaceHome } from "../ui/workspace-home";
import { WorkspacesPage } from "../ui/workspaces-page";
import type { GitWorkflowAction } from "../ui/git-workflow";
import { openCloudThread } from "../../lib/editorStore";
import { filterToScope, usePlaceScope, type WorkspaceHome as PlaceHome } from "../../lib/placeScope";
import type { WorktreeRef } from "../../lib/workspaceRef";
import type { WorktreeBadge } from "../../lib/useWorktreeBadges";
import type { ProjectMeta } from "./workspacesModel";
import { CLOUD_ROW_PREFIX } from "./workspacesOverview";
import { activeRepository, useWorkspaceRows, type WorkspaceRowSource } from "./useWorkspaceRows";
import { runWorkspaceAction } from "./fleetActions";
import { openCreateWorkspace } from "../workspace/createWorkspaceEvents";

export type WorkspacesSurfaceProps = {
  onClose: () => void;
  projects: ProjectMeta[];
  worktreesByRoot: Record<string, WorktreeRef[]>;
  badgeByPath: Record<string, WorktreeBadge>;
  activePath: string;
  /** Opened from one repository's group: the list starts filtered to it,
   *  and the cloud work read is that repository's alone. */
  initialProjectId?: string | null;
  /** Jump into a copy (checkout path). Closes the surface. */
  onOpen: (path: string) => void;
  /** Open the folder picker to add a repository. Create falls back to it
   *  when no repository is open to make a workspace in. */
  onAddWorkspace?: () => void;
  /** Render as a page in the content area rather than as a modal above the
   *  shell. The app mounts it as a page; the modal form serves popped-out
   *  windows. */
  asPage?: boolean;
  /** Drawn at the toolbar's left edge — the show-sidebar button when the
   *  sidebar is hidden. */
  leading?: ReactNode;
  /** Drawn at the toolbar's right end, after Create — the Aura toggle. */
  toolbarTrailing?: ReactNode;
};

/** Where a row's workspace lives: a cloud job is the cloud's, everything else
 *  is a checkout or copy on this computer. */
function homeOf(source: WorkspaceRowSource | undefined): PlaceHome {
  return source?.kind === "cloud" ? { cloud: true } : {};
}

export function WorkspacesSurface({
  onClose,
  projects,
  worktreesByRoot,
  badgeByPath,
  activePath,
  initialProjectId = null,
  onOpen,
  onAddWorkspace,
  asPage = false,
  leading,
  toolbarTrailing,
}: WorkspacesSurfaceProps) {
  // The page lists the place the window stands in: on this computer, its
  // checkouts and copies; in the cloud, the cloud's work — account-wide unless
  // the page was opened on one repository, since a cloud job belongs to
  // whoever sent it, not to whichever repositories happen to be open today.
  // Outside the cloud the cloud's work isn't read at all.
  const scope = usePlaceScope();
  const inCloud = scope.kind === "cloud";
  const cloudRoots = useMemo(
    () => (inCloud ? (initialProjectId ? [initialProjectId] : null) : false),
    [inCloud, initialProjectId],
  );
  const { rows: all, sources } = useWorkspaceRows({
    projects,
    worktreesByRoot,
    badgeByPath,
    activePath,
    cloudRoots,
  });
  const rows = useMemo(
    () => filterToScope(scope, all, (row) => homeOf(sources.get(row.id))),
    [scope, all, sources],
  );

  const open = useCallback(
    (id: string) => {
      const src = sources.get(id);
      if (src?.kind === "cloud") {
        openCloudThread(src.thread.key, src.thread.repoRoot);
      } else if (!id.startsWith(CLOUD_ROW_PREFIX)) {
        onOpen(id);
      }
      onClose();
    },
    [sources, onOpen, onClose],
  );

  const onAction = useCallback(
    (id: string, action: GitWorkflowAction) => {
      const src = sources.get(id);
      if (src?.kind !== "copy") return;
      void runWorkspaceAction({ copy: src.copy, pr: src.pr, action, onOpen: open });
    },
    [sources, open],
  );

  // Create makes a new workspace in the repository you are standing in. With
  // no repository open there is nothing to make one in, so it asks for one.
  const activeRoot = activeRepository(projects, worktreesByRoot, activePath);
  const onCreate = () => {
    if (activeRoot) openCreateWorkspace(activeRoot);
    else onAddWorkspace?.();
  };

  const home = (
    <WorkspaceHome
      leading={leading}
      trailing={toolbarTrailing}
      workspaces={rows}
      onOpen={open}
      onCreate={onCreate}
      onAction={onAction}
      repositoryIcon={(id, name) => <ProjectAvatar root={id} name={name} size={14} />}
    />
  );

  if (asPage) {
    return (
      <WorkspacesPage label="Workspaces" onClose={onClose}>
        {home}
      </WorkspacesPage>
    );
  }
  return (
    <FullscreenOverlay onClose={onClose}>
      <WorkspacesPage label="Workspaces">{home}</WorkspacesPage>
    </FullscreenOverlay>
  );
}
