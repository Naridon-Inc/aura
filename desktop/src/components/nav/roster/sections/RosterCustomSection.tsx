// One section you made: a heading (its emoji, its name, the count while
// folded) that folds on a click and is dragged to reorder, its menu on
// right-click and from the hover "…", its workspaces in the order you put
// them, then the repositories filed under it whole, each with its own header,
// fold, "+" and "Show N more". An empty section asks for a workspace or a
// project to be dragged in.

import { ChevronDown, ChevronRight, Inbox } from "lucide-react";
import type { PointerDrag } from "../../../ui/use-pointer-drag";
import { RosterActionsMenu, RosterContextMenu } from "../rosterMenu";
import type { SectionLayout } from "../rosterLayout";
import type { RosterEnv } from "../rosterTypes";
import type { RosterPick } from "../useRosterPick";
import { RepositoryGroup } from "../RepositoryGroup";
import { WorkspaceRow } from "../WorkspaceRow";
import { sectionKey } from "./sectionModel";
import { sectionMenu } from "./sectionMenus";
import { sectionDrop, type Carried, type DropLine } from "./useSectionDrag";
import "./sections.css";

export function RosterCustomSection({
  layout,
  env,
  pick,
  drag,
  line,
  carryingWorkspace,
  carriedRepo,
  draggedSection,
}: {
  layout: SectionLayout;
  env: RosterEnv;
  pick: RosterPick;
  drag: PointerDrag<Carried>;
  line: DropLine | null;
  carryingWorkspace: boolean;
  /** The repository being carried by its header, if one is. */
  carriedRepo: string | null;
  draggedSection: string | null;
}) {
  const { section, rows, repos, collapsed } = layout;
  const key = sectionDrop(section.id);
  // Folded, the workspace you are in stays in sight.
  const shown = collapsed ? rows.filter((row) => row.w.path === env.activePath) : rows;
  const entries = () => sectionMenu(section);
  const lit =
    drag.over === key &&
    (carryingWorkspace ||
      carriedRepo !== null ||
      (draggedSection !== null && draggedSection !== section.id));
  // Lit whole when there is no gap to draw a line in: no rows for a
  // workspace, no repositories (other than the one carried) for a repository.
  const nowhere =
    carriedRepo !== null
      ? repos.every((r) => r.ws.id === carriedRepo)
      : rows.length === 0;
  const empty = rows.length === 0 && repos.length === 0;
  return (
    <section
      className="ui-roster-custom-section"
      aria-label={section.name}
      data-section-id={section.id}
      data-dragging={draggedSection === section.id || undefined}
      data-drop-over={(lit && nowhere) || undefined}
      {...drag.target(key)}
    >
      {line?.key === key && (
        <span className="ui-section-drop-line" style={{ top: line.top }} aria-hidden />
      )}
      <RosterContextMenu entries={entries}>
        <div className="ui-section-header">
          <button
            type="button"
            className="ui-section-header-button"
            aria-expanded={!collapsed}
            title={collapsed ? `Show ${section.name}` : `Hide ${section.name}`}
            onClick={() => env.toggleCollapsed(sectionKey(section.id))}
            {...drag.source({ kind: "section", id: section.id })}
          >
            <span className="ui-section-emoji" aria-hidden>
              {section.emoji}
            </span>
            <span className="ui-section-name">{section.name}</span>
            {collapsed && (
              <span className="ui-section-count">{rows.length + repos.length}</span>
            )}
            <span className="ui-section-spacer" aria-hidden />
            {collapsed ? (
              <ChevronRight size={12} className="ui-section-fold" />
            ) : (
              <ChevronDown size={12} className="ui-section-fold" data-hover-only />
            )}
          </button>
          <span className="ui-section-actions">
            <RosterActionsMenu aria-label={`Actions for ${section.name}`} entries={entries} />
          </span>
        </div>
      </RosterContextMenu>
      {!collapsed && empty && (
        <div className="ui-section-empty">
          <Inbox size={14} aria-hidden />
          <span>Drag a workspace or project here</span>
        </div>
      )}
      {shown.map(({ w, repo }) => (
        <WorkspaceRow key={w.path} w={w} repo={repo} env={env} pick={pick} placement="section" />
      ))}
      {!collapsed &&
        repos.map((repo) => (
          <RepositoryGroup
            key={repo.ws.id}
            repo={repo}
            env={env}
            pick={pick}
            placement="section"
          />
        ))}
    </section>
  );
}
