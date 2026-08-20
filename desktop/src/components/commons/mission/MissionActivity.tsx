// MissionActivity — the LIST layout of Mission Control: every agent, crew and
// automation run across your projects, grouped top-to-bottom by the stage it's
// in (Triage → Planning → Building → Reviewing → Done → Failed).
//
// This is the exact same work `MissionBoard` draws as lanes, grouped by the
// exact same helper (`groupByStage`), and rendered through the exact same
// primitives (`BoardListGroup` / `BoardListRow` from `components/board`) the
// Tasks list uses. Flipping between List and Board here must feel like turning
// the same object round in your hand, not landing in a different product —
// which is why this file is thin: it only says which run field goes in which
// slot, and everything visual comes from the shared design system.
//
// This view owns no data and no time of its own — the shell hands it the polled
// `state` + `now` and the selection/collapse it manages, so a re-poll never
// loses which row you picked or which group you folded. Empty groups are hidden,
// and when there is nothing at all this view draws its own empty state.
//
// It used to return null in that case, on the stated assumption that the shell
// painted a global empty state instead. No shell does — `CrewWorkspace` is the
// only thing that mounts this, and its List branch has no fallback — so a crew
// with no runs yet showed a blank content area with nothing in it but the
// floating layout switch. Board survived the same case because it asks
// `groupByStage` for empty lanes too and still has its columns to draw; a list
// has no lanes, so if it doesn't speak, nothing does.
//
// Audience: non-engineers. Every label is plain ("Building", "An agent is on
// it", "Proven · 3/3 checks") — the stage groups and run rows carry it for us.

import type { JSX } from "react";
import { Waypoints } from "lucide-react";

import type { MissionRun, MissionState } from "../../../lib/api";
import {
  BoardEmpty,
  BoardListGroup,
  StateGlyph,
} from "../../board";
import { agentsWorthNaming } from "../crew/crewShared";
import { MissionRetryButton } from "./MissionRetryButton";
import { MissionRunRow } from "./MissionRunRow";
import {
  allRuns,
  groupByStage,
  proofWorthShowing,
  stageHint,
  STAGE_GLYPH_GROUP,
  STAGE_LABEL,
  STAGE_TONE,
  type MissionStageId,
} from "./missionData";

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
}): JSX.Element {
  const { state, now, selectedId, onSelect, collapsed, onToggle, onRetry } =
    props;

  // One flat run list → the ordered, non-empty stage groups. The Board reads the
  // same helper with `keepEmpty`, so a row here and a column there never
  // disagree about where a run sits.
  const runs = allRuns(state);
  const groups = groupByStage(runs);
  // Only stamp the agent when the agents differ — otherwise it's the same mark,
  // in the one colour reserved for agents, down every row of the list.
  const showAgent = agentsWorthNaming(runs.map((r) => r.agent));
  // And only say where a finished run stands on proof once the finished runs
  // differ on it — otherwise the group header says it once for all of them.
  const showProof = proofWorthShowing(runs);

  // Nothing has run yet. This is the genuinely-empty case, never the filtered
  // one — this view has no filters, so there is no work being hidden and no
  // "clear filters" to offer. No action either: runs start from the plan, not
  // from here, and an empty state that offers a button going nowhere is worse
  // than one that just explains itself.
  if (groups.length === 0) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-bg-content">
        <BoardEmpty
          icon={Waypoints}
          title="Nothing has run yet"
          body="Start a plan and every agent working on it shows up here, grouped by how far along it is."
        />
      </div>
    );
  }

  return (
    // No bottom pad. The layout switch used to float over this list's last
    // run, so 56px of empty space had to be reserved under the final row just
    // to keep it readable. The switch is in the header now.
    <div className="h-full w-full overflow-y-auto bg-bg-content px-4 pb-6 sm:px-6">
      {groups.map((group) => (
        <BoardListGroup
          key={group.stage}
          title={STAGE_LABEL[group.stage]}
          titleHint={stageHint(group.stage, group.runs)}
          count={group.runs.length}
          glyph={
            <StateGlyph
              group={STAGE_GLYPH_GROUP[group.stage]}
              color={STAGE_TONE[group.stage]}
              size={12}
            />
          }
          expanded={!collapsed.has(group.stage)}
          onToggle={() => onToggle(group.stage)}
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
              showAgent={showAgent}
              showProof={showProof}
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
        </BoardListGroup>
      ))}
    </div>
  );
}
