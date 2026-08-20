// Crew · Workspace — the body of the crew's page: the work, drawn, and nothing
// else.
//
//   • MAIN — the same live `ready_view` drawn three ways, chosen from the
//       segmented switch in the header above (`board/BoardLayoutSwitch`, the
//       app's common one):
//       - Graph → the dependency map (`CrewCanvas`) — what feeds what.
//       - List  → the stage-grouped run (`MissionActivity`) — what's happening.
//       - Board → the same run in stage lanes (`MissionBoard`).
//       All three are the CREW'S RUN, not the backlog: the backlog is one list
//       in the Tasks place and has no lanes of its own (see lib/workRoute).
//   • DETAIL — picking a task anywhere (a canvas node, a list row, a board
//       card) opens its full detail as a docked sheet over the work, the same
//       shape Add to queue and Cloud machine already use on this surface.
//
// What is NOT here any more is a sidebar. This file used to stand up a 340px
// column on the right holding the goal→task tree and the crew switcher — which
// put a second, different rail on exactly the edge the Tasks place keeps its
// own. Two of the place's four lenses had one navigation, the other two had
// another, and they disagreed about what the work even is: one sliced it by
// sprint and workstream, the other by goal and crew.
//
// Goals and crews live in the place's ONE rail now (tasks/WorkRailGroups),
// alongside the sprints and workstreams, with the per-goal Start / Pause /
// Resume on the goal's own row. The tree they used to nest is the body: pick a
// goal in the rail and every lens narrows to it, at full width, instead of
// printing the same task titles twice — once truncated mid-word in a narrow
// column, once in full in the pane beside it.
//
// The detail is a sheet rather than a column for the same reason: a third
// vertical strip beside the rail is the arrangement the rail exists to prevent.
// No new data, no mock state — the same `ready_view` the runner and chat's
// `/loop` read.

import { useState } from "react";
import { KanbanSquare, List as ListIcon, Network } from "lucide-react";

import type {
  LoopTask,
  MissionRun,
  MissionState,
  ReadyViewDto,
} from "../../../lib/api";
import { type BoardLayoutOption } from "../../board";
import { MissionActivity } from "../mission/MissionActivity";
import { MissionBoard } from "../mission/MissionBoard";
import type { MissionStageId } from "../mission/missionData";
import { CrewCanvas } from "./CrewCanvas";
import type { BoardStepsByTaskId } from "./crewGraphLayout";
import { CrewTaskDetail } from "./CrewTaskDetail";
import type { CrewProof } from "./crewProof";

/** Which drawing of the work fills the main area. `list` and `board` are the
 *  shared pair; `graph` is Crew's own extra layout. */
export type CrewMainView = "list" | "board" | "graph";

/** Every layout Crew's main area offers, in switch order — the shared pair
 *  first, then Crew's own. Exported so the surface that owns the persisted
 *  choice can validate a stored value against the same list. */
export const CREW_MAIN_VIEWS: readonly BoardLayoutOption<CrewMainView>[] = [
  {
    value: "list",
    label: "List",
    icon: ListIcon,
    hint: "See the work as one grouped list",
  },
  {
    value: "board",
    label: "Board",
    icon: KanbanSquare,
    hint: "See the work as lanes by stage",
  },
  {
    value: "graph",
    label: "Graph",
    icon: Network,
    hint: "See the work as a dependency map",
  },
];

/** Just the layout values — what a persisted choice is validated against. A
 *  module constant so its identity is stable across renders. */
export const CREW_MAIN_VIEW_VALUES: readonly CrewMainView[] =
  CREW_MAIN_VIEWS.map((o) => o.value);

export function CrewWorkspace({
  view,
  mission,
  now,
  lens,
  selectedId,
  selectedTask,
  allTasks,
  proof,
  onSelect,
  onDeselect,
  onSetStatus,
  onRetryNode,
  onPlanOrder,
  ordering,
  onRetryRuns,
  boardSteps,
}: {
  view: ReadyViewDto;
  mission: MissionState | null;
  now: number;
  lens: CrewMainView;
  selectedId: string | null;
  selectedTask: LoopTask | null;
  allTasks: LoopTask[];
  proof: Map<string, CrewProof[]>;
  onSelect: (id: string) => void;
  onDeselect: () => void;
  onSetStatus: (nodeId: string, status: string) => void;
  onRetryNode: (nodeId: string) => void;
  onPlanOrder?: () => void;
  ordering?: boolean;
  onRetryRuns?: (runs: MissionRun[]) => void;
  /** Board-plan steps keyed by `board_task_id` — passed straight through to the
   *  graph so a working node names its real step. */
  boardSteps?: BoardStepsByTaskId;
}) {
  // Which stage groups are folded in the List layout. Held here rather than
  // inside `MissionActivity` so a re-poll (which re-renders the list with fresh
  // runs) never silently unfolds a group the reader deliberately closed.
  const [collapsedStages, setCollapsedStages] = useState<Set<MissionStageId>>(
    () => new Set(),
  );
  const toggleStage = (stage: MissionStageId): void => {
    setCollapsedStages((prev) => {
      const next = new Set(prev);
      if (next.has(stage)) next.delete(stage);
      else next.add(stage);
      return next;
    });
  };

  return (
    <div className="relative flex h-full min-h-0">
      {/* The work, full width. List and Board both read `mission`; only Graph
          reads the raw view. */}
      <div className="relative min-w-0 flex-1">
        {lens === "graph" ? (
          <CrewCanvas
            view={view}
            selectedId={selectedId}
            onSelect={onSelect}
            proof={proof}
            onPlanOrder={onPlanOrder}
            ordering={ordering}
            boardSteps={boardSteps}
          />
        ) : mission && lens === "list" ? (
          <MissionActivity
            state={mission}
            now={now}
            selectedId={selectedId}
            onSelect={(run) => onSelect(run.id)}
            collapsed={collapsedStages}
            onToggle={toggleStage}
            onRetry={onRetryRuns}
          />
        ) : mission ? (
          <MissionBoard
            state={mission}
            now={now}
            selectedId={selectedId}
            onSelect={(run) => onSelect(run.id)}
            onRetry={onRetryRuns}
          />
        ) : null}
      </div>

      {/* One task's detail, docked over the work — you asked to see it, so it
          shows, and closing it gives the whole width back. A scrim catches
          stray clicks and closes. No close chrome of our own: the detail
          carries its own "All tasks" return row and its own Esc handler
          (captured and stopped, so Esc doesn't also close the place under it),
          and a second X beside them would be the same act drawn twice. */}
      {selectedTask ? (
        <div className="absolute inset-0 z-20">
          <div
            className="absolute inset-0 bg-black/25"
            aria-hidden
            onClick={onDeselect}
          />
          <div className="absolute inset-y-0 right-0 flex w-full max-w-[420px] flex-col overflow-hidden border-l border-line bg-bg-content shadow-[var(--shadow-modal)]">
            <CrewTaskDetail
              task={selectedTask}
              allTasks={allTasks}
              proof={proof}
              onClose={onDeselect}
              onOpen={onSelect}
              onSetStatus={onSetStatus}
              onRetry={onRetryNode}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
