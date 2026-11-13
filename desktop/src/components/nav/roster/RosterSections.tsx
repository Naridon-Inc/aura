// The list's own groupings around the repositories: pinned workspaces and
// repositories under a "Pinned" heading, and archived ones at the foot.

import type { ReactNode } from "react";
import { ArchiveRestore, ChevronDown } from "lucide-react";
import { Button } from "../../ui/button";
import { SidebarItem } from "../../ui/sidebar";
import { ProjectAvatar } from "../../ProjectAvatar";
import { setWorkspaceArchived } from "../../../lib/workspaceCustomization";
import { humanizeWorkspaceName } from "../../../lib/workspaceLabel";
import type { Workspace } from "../../../lib/workspaceRef";
import { RosterActionsMenu, RosterContextMenu } from "./rosterMenu";
import { repositoryMenu } from "./rosterMenus";
import type { PlacedRow } from "./rosterLayout";
import type { RosterEnv } from "./rosterTypes";
import type { RosterPick } from "./useRosterPick";
import { WorkspaceRow } from "./WorkspaceRow";

/** A plain titled group, the library's non-repository section. */
export function RosterSection({
  kind,
  title,
  count,
  collapsed,
  onToggle,
  drop,
  dropOver,
  children,
}: {
  kind: "pinned" | "custom";
  title: string;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
  /** Marks the section as a place a dragged workspace can land. */
  drop?: Record<string, string>;
  /** A dragged workspace is over it. */
  dropOver?: boolean;
  children: ReactNode;
}) {
  return (
    <section
      className="ui-navigation-section ui-roster-drop-zone"
      data-kind={kind}
      data-drop-over={dropOver || undefined}
      {...drop}
    >
      <header>
        <button
          type="button"
          className="ui-navigation-title"
          aria-expanded={!collapsed}
          onClick={onToggle}
        >
          <span>{title}</span>
          {collapsed && <small>{count}</small>}
          <ChevronDown size={12} className="ui-section-chevron" data-collapsed={collapsed} />
        </button>
      </header>
      {!collapsed && children}
    </section>
  );
}

/** Hidden from the list above, gathered here: repositories, then single
 *  workspaces. Archiving never touches the branch or files on disk;
 *  restoring brings one straight back. */
export function ArchivedRepositories({
  archived,
  rows,
  pick,
  open,
  onToggle,
  env,
}: {
  archived: readonly Workspace[];
  rows: readonly PlacedRow[];
  pick: RosterPick;
  open: boolean;
  onToggle: () => void;
  env: RosterEnv;
}) {
  if (archived.length + rows.length === 0) return null;
  return (
    <RosterSection
      kind="custom"
      title="Archived"
      count={archived.length + rows.length}
      collapsed={!open}
      onToggle={onToggle}
    >
      {archived.map((ws) => {
        const name = humanizeWorkspaceName(ws.id);
        const emoji = env.custom[ws.id]?.emoji ?? ws.emoji;
        const entries = () =>
          repositoryMenu({
            id: ws.id,
            name,
            custom: env.custom,
            actions: env.actions,
            startRename: env.startRename,
            pickIcon: env.pickIcon,
          });
        const restore = () => setWorkspaceArchived(ws.id, false);
        return (
          <RosterContextMenu key={ws.id} entries={entries}>
            <div className="ui-roster-row" data-archived title={`${ws.id}. Restore to your list`}>
              <SidebarItem
                label={name}
                icon={<ProjectAvatar root={ws.id} name={name} emoji={emoji ?? null} />}
                onClick={restore}
                actions={
                  <>
                    <Button
                      size="iconXs"
                      variant="ghost"
                      aria-label="Restore repository"
                      title="Restore. Bring this repository back to your list"
                      onClick={restore}
                    >
                      <ArchiveRestore />
                    </Button>
                    <RosterActionsMenu aria-label={`Actions for ${name}`} entries={entries} />
                  </>
                }
              />
            </div>
          </RosterContextMenu>
        );
      })}
      {rows.map(({ w, repo }) => (
        <WorkspaceRow key={w.path} w={w} repo={repo} env={env} pick={pick} placement="archived" />
      ))}
    </RosterSection>
  );
}
