// The list grouped by status: a section per stage, finished work first. Every
// stage is listed, even one with nothing in it, so the shape of the list does
// not change as work moves; a folded stage says how many it holds.

import { ChevronDown, ChevronRight } from "lucide-react";
import { WORKSPACE_STAGES, WorkspaceStageIcon } from "../../ui/workspace-preview-card";
import type { StatusGroup } from "./rosterStatusLayout";
import type { RosterEnv } from "./rosterTypes";
import type { RosterPick } from "./useRosterPick";
import { WorkspaceRow } from "./WorkspaceRow";

export function RosterStatusGroups({
  groups,
  env,
  pick,
  showRepository,
  onToggle,
}: {
  groups: readonly StatusGroup[];
  env: RosterEnv;
  pick: RosterPick;
  /** Rows wear their repository's icon unless one repository is filtered to. */
  showRepository: boolean;
  onToggle: (group: StatusGroup) => void;
}) {
  return (
    <div className="ui-roster-status-groups">
      {groups.map((group) => {
        const label = WORKSPACE_STAGES.find((s) => s.id === group.stage)?.label ?? group.stage;
        return (
          <section
            key={group.stage}
            className="ui-roster-status"
            data-stage={group.stage}
            aria-label={label}
          >
            <button
              type="button"
              className="ui-roster-status-header"
              aria-expanded={!group.collapsed}
              onClick={() => onToggle(group)}
            >
              <span className="ui-roster-status-icon">
                <WorkspaceStageIcon stage={group.stage} />
              </span>
              <span className="ui-roster-status-label">{label}</span>
              {group.collapsed && group.rows.length > 0 && (
                <span className="ui-roster-status-count">{group.rows.length}</span>
              )}
              <span className="ui-roster-status-chevron" aria-hidden>
                {group.collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
              </span>
            </button>
            {!group.collapsed && (
              <div className="ui-roster-status-rows" data-empty={group.rows.length === 0 || undefined}>
                {group.rows.map(({ w, repo }) => (
                  <WorkspaceRow
                    key={w.path}
                    w={w}
                    repo={repo}
                    env={env}
                    pick={pick}
                    placement={showRepository ? "status" : "repository"}
                  />
                ))}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
