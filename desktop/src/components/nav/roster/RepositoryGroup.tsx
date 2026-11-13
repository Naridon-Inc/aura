// One repository and its workspaces, as a library navigation section. The
// header's name opens the repository's main checkout; its icon (which turns
// into a chevron on hover) folds the list. The rows under it are this
// computer's workspaces of the repository, then the quiet ones behind "Show N
// more". The main checkout is one of them only while work is on it.
//
// The header is also what you drag to file the whole repository in a section
// (or onto "Pinned", or back to "My workspaces"). The drag starts on the
// header's own button, so a press on its name still opens the repository and
// a press on the "+" or the "…" beside it never starts one.

import type { KeyboardEvent, MouseEvent } from "react";
import { ChevronDown, ChevronRight, Plus } from "lucide-react";
import { Button } from "../../ui/button";
import { SidebarItem } from "../../ui/sidebar";
import { AsciiSpinner } from "../../ui/ascii-spinner";
import { ProjectAvatar } from "../../ProjectAvatar";
import { RosterActionsMenu, RosterContextMenu } from "./rosterMenu";
import { newWorkspace, repositoryMenu } from "./rosterMenus";
import { RosterRename } from "./RosterRename";
import { WorkspaceRow } from "./WorkspaceRow";
import type { RepositoryLayout } from "./rosterLayout";
import type { RosterEnv } from "./rosterTypes";
import type { RosterPick } from "./useRosterPick";

export function RepositoryGroup({
  repo,
  env,
  pick,
  placement,
}: {
  repo: RepositoryLayout;
  env: RosterEnv;
  pick: RosterPick;
  /** Drawn inside a section you made, where a dragged repository measures
   *  the gap it lands in against the others filed there. */
  placement?: "section";
}) {
  const id = repo.ws.id;
  const entries = () =>
    repositoryMenu({
      id,
      name: repo.name,
      custom: env.custom,
      actions: env.actions,
      startRename: env.startRename,
      pickIcon: env.pickIcon,
      moveTo: env.moveRepoToSection?.(id),
    });
  const renaming = env.renaming?.key === id && env.renaming.at === "repository";
  const drag = !pick.picking ? env.dragRepo?.(id) : undefined;
  const count = repo.rows.length;
  const foldLabel = repo.collapsed ? "Show workspaces" : "Hide workspaces";

  const onTitleClick = (e: MouseEvent<HTMLButtonElement>) => {
    if ((e.target as HTMLElement).closest(".ui-repository-icon")) env.toggleCollapsed(id);
    else env.actions.onOpenWorktree?.(repo.homePath);
  };
  const onTitleKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if ((e.key === "ArrowLeft" && !repo.collapsed) || (e.key === "ArrowRight" && repo.collapsed)) {
      e.preventDefault();
      env.toggleCollapsed(id);
    }
  };

  return (
    <section
      className="ui-navigation-section"
      data-kind="repository"
      data-working={repo.working || undefined}
      data-section-repo={placement === "section" ? id : undefined}
      data-dragging={env.carriedRepo === id || undefined}
    >
      <RosterContextMenu entries={entries}>
        <header>
          {renaming ? (
            <RosterRename env={env} placeholder={repo.name} label="Repository name" />
          ) : (
            <button
              type="button"
              className="ui-navigation-title"
              aria-expanded={!repo.collapsed}
              title={`${id}. Open the main checkout${repo.collapsed && repo.age ? ` · last commit ${repo.age} ago` : ""}`}
              onClick={onTitleClick}
              onKeyDown={onTitleKey}
              {...drag}
            >
              <span className="ui-repository-icon" title={foldLabel} aria-label={foldLabel}>
                <i className="ui-repository-mark" aria-hidden>
                  <ProjectAvatar root={id} name={repo.name} emoji={repo.emoji ?? null} />
                </i>
                <span>{repo.collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}</span>
              </span>
              <span>{repo.name}</span>
              {/* Something in this repository is mid-turn and its row is not
                  on screen (folded away, or a chat running against the
                  repository root), so the header has to say it. */}
              {repo.workingHidden && <AsciiSpinner size={12} />}
              {repo.collapsed && <small>{count}</small>}
            </button>
          )}
          <Button
            size="iconXs"
            variant="ghost"
            aria-label={`New workspace in ${repo.name}`}
            title={`New workspace in ${repo.name}`}
            onClick={() => newWorkspace(id)}
          >
            <Plus />
          </Button>
          <RosterActionsMenu aria-label={`Actions for ${repo.name}`} entries={entries} />
        </header>
      </RosterContextMenu>
      {!repo.collapsed && (
        <>
          {repo.shown.map((w) => (
            <WorkspaceRow key={w.path} w={w} repo={repo} env={env} pick={pick} />
          ))}
          {repo.inactive.length > 0 && (
            <div className="ui-roster-row" data-disclosure>
              <SidebarItem
                label={repo.showInactive ? "Show fewer" : `Show ${repo.inactive.length} more`}
                icon={repo.showInactive ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                onClick={() => env.toggleExpanded(id)}
              />
            </div>
          )}
          {repo.showInactive &&
            repo.inactive.map((w) => (
              <WorkspaceRow key={w.path} w={w} repo={repo} env={env} pick={pick} />
            ))}
        </>
      )}
    </section>
  );
}
