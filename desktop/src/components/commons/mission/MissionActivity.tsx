// MissionActivity — the default Mission Control view, modelled directly on the
// Warp Oz "Activity" screen: one calm, status-grouped list of every agent, crew,
// and automation run across your projects. Each stage (Triage → Planning →
// Building → Reviewing → Done → Failed) is its own collapsible group with a
// count; inside, one row per run. Selecting a row opens its detail panel.
//
// This view owns no data and no time of its own — the shell hands it the polled
// `state` + `now` and the selection/collapse it manages, so a re-poll never
// loses which row you picked or which group you folded. Empty groups are hidden;
// when there's nothing at all, the shell paints the global empty state, not us.
//
// Audience: non-engineers. Every label is plain ("Building", "an agent is on
// it", "Proven · 3/3 checks") — the stage groups and run rows carry it for us.

import type { JSX } from "react";

import type { MissionRun, MissionState } from "../../../lib/api";
import { MissionGroup } from "./MissionGroup";
import { MissionRetryButton } from "./MissionRetryButton";
import { MissionRunRow } from "./MissionRunRow";
import { allRuns, groupByStage, type MissionStageId } from "./missionData";

export function MissionActivity(props: {
  state: MissionState;
  now: number;
  selectedId: string | null;
  onSelect: (run: MissionRun) => void;
  collapsed: Set<MissionStageId>;
  onToggle: (stage: MissionStageId) => void;
  /** Re-arm failed runs back into the ready set — gives each failed row a quick
   *  "Retry" and the Failed group a header "Retry all". Omit to hide both. */
  onRetry?: (runs: MissionRun[]) => void;
}): JSX.Element | null {
  const { state, now, selectedId, onSelect, collapsed, onToggle, onRetry } =
    props;

  // One flat run list → the ordered, non-empty stage groups. The Board reads the
  // same helper with `keepEmpty`, so a row here and a column there never
  // disagree about where a run sits.
  const groups = groupByStage(allRuns(state));
  if (groups.length === 0) return null;

  return (
    <div className="space-y-1">
      {groups.map((group) => (
        <MissionGroup
          key={group.stage}
          stage={group.stage}
          count={group.runs.length}
          collapsed={collapsed.has(group.stage)}
          onToggle={onToggle}
          action={
            group.stage === "failed" ? (
              <MissionRetryButton
                runs={group.runs}
                onRetry={onRetry}
                label="Retry all"
              />
            ) : undefined
          }
        >
          {group.runs.map((run) => (
            <MissionRunRow
              key={run.id}
              run={run}
              now={now}
              selected={run.id === selectedId}
              onSelect={onSelect}
              trailing={
                group.stage === "failed" ? (
                  <MissionRetryButton
                    runs={[run]}
                    onRetry={onRetry}
                    label="Retry"
                  />
                ) : undefined
              }
            />
          ))}
        </MissionGroup>
      ))}
    </div>
  );
}
