// Crew · Workspace — the body of Mission Control: ONE persistent sidebar beside
// a main area that swaps between two views of the same live `ready_view`.
//
//   • SIDEBAR (left, always present) — the plan as a goal→task tree
//       (`CrewPlanSidebar`): every goal is a group with its tasks nested under
//       it, each goal carrying its own Start / Pause / Resume control and past
//       runs. Loose tasks that belong to no goal collect under "Other tasks".
//       Click a task and this column SWAPS to its full detail (`CrewTaskDetail`)
//       in place; a back row returns to the tree.
//   • MAIN (right) — the same work drawn two ways, chosen by a floating capsule
//       that hovers over the canvas (bottom-center, clear of the zoom pad):
//       - Graph  → the dependency map (`CrewCanvas`).
//       - Board  → the Kanban board by stage (`MissionBoard`).
//
// Selecting a task anywhere (a canvas node, a tree row, a board card) opens its
// detail in the sidebar, so the detail is reachable from both main views without
// a competing drawer. No new data, no mock state — the same `view` the runner
// and chat's `/loop` read.

import { LayoutGrid, Network } from "lucide-react";

import type {
  CrewRow,
  GoalSummary,
  LoopTask,
  MissionRun,
  MissionState,
  ReadyViewDto,
  RunRecord,
} from "../../../lib/api";
import { cn } from "../../../lib/utils";
import { MissionBoard } from "../mission/MissionBoard";
import { CrewCanvas } from "./CrewCanvas";
import { CrewPlanSidebar } from "./CrewPlanSidebar";
import { CrewTaskDetail } from "./CrewTaskDetail";
import type { CrewProof } from "./crewProof";

/** Which drawing of the work fills the main area. */
export type CrewMainView = "graph" | "board";

export function CrewWorkspace({
  view,
  mission,
  now,
  lens,
  onLens,
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
  onSync,
  syncing,
  onRetryRuns,
  crews,
  activeCrew,
  onSelectCrew,
  runs,
  acting,
  onSpawnCrew,
  onRunGoal,
  onPauseGoal,
  onResumeGoal,
}: {
  view: ReadyViewDto;
  mission: MissionState | null;
  now: number;
  lens: CrewMainView;
  onLens: (l: CrewMainView) => void;
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
  onSync?: () => void;
  syncing?: boolean;
  onRetryRuns?: (runs: MissionRun[]) => void;
  crews: CrewRow[];
  activeCrew: string | null;
  onSelectCrew: (id: string | null) => void;
  runs: RunRecord[];
  acting: string | null;
  onSpawnCrew: (title: string) => Promise<void>;
  onRunGoal: (goal: GoalSummary) => void;
  onPauseGoal: (goal: GoalSummary) => void;
  onResumeGoal: (goal: GoalSummary) => void;
}) {
  return (
    <div className="flex h-full min-h-0">
      {/* Sidebar — always present, in both main views. */}
      <aside className="flex w-[340px] shrink-0 flex-col border-r border-line-soft">
        {selectedTask ? (
          // A task is picked — the whole column becomes its detail, with a back
          // row (onClose) returning to the goal→task tree.
          <CrewTaskDetail
            task={selectedTask}
            allTasks={allTasks}
            proof={proof}
            onClose={onDeselect}
            onOpen={onSelect}
            onSetStatus={onSetStatus}
            onRetry={onRetryNode}
          />
        ) : (
          <CrewPlanSidebar
            view={view}
            selectedId={selectedId}
            onSelect={onSelect}
            onSync={onSync}
            syncing={syncing}
            crews={crews}
            activeCrew={activeCrew}
            onSelectCrew={onSelectCrew}
            runs={runs}
            acting={acting}
            onSpawnCrew={onSpawnCrew}
            onRunGoal={onRunGoal}
            onPauseGoal={onPauseGoal}
            onResumeGoal={onResumeGoal}
            onRetry={onRetryNode}
          />
        )}
      </aside>

      {/* Main — the same work drawn two ways, chosen by the floating capsule. */}
      <div className="relative min-w-0 flex-1">
        {lens === "graph" ? (
          <CrewCanvas
            view={view}
            selectedId={selectedId}
            onSelect={onSelect}
            proof={proof}
            onPlanOrder={onPlanOrder}
            ordering={ordering}
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

        <MainViewSwitch lens={lens} onLens={onLens} />
      </div>
    </div>
  );
}

/** The Board ⇄ Graph switch — a small pill hovering over the main area
 *  (bottom-center), the Figma/Miro view-control convention. Sits clear of the
 *  canvas zoom pad (bottom-right). */
function MainViewSwitch({
  lens,
  onLens,
}: {
  lens: CrewMainView;
  onLens: (l: CrewMainView) => void;
}) {
  const opts: Array<{
    value: CrewMainView;
    label: string;
    icon: React.ReactNode;
  }> = [
    { value: "graph", label: "Graph", icon: <Network size={13} /> },
    { value: "board", label: "Board", icon: <LayoutGrid size={13} /> },
  ];
  return (
    <div className="absolute bottom-3 left-1/2 z-20 -translate-x-1/2">
      <div className="flex items-center gap-0.5 rounded-full border border-line-soft bg-bg-1/90 p-0.5 shadow-[var(--shadow-modal)] backdrop-blur">
        {opts.map((o) => {
          const active = o.value === lens;
          return (
            <button
              key={o.value}
              type="button"
              onClick={() => onLens(o.value)}
              aria-pressed={active}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-medium transition-colors",
                active
                  ? "bg-bg-content text-text-1 shadow-sm"
                  : "text-text-4 hover:text-text-2",
              )}
              title={
                o.value === "graph"
                  ? "See the work as a dependency map"
                  : "See the work as a board by stage"
              }
            >
              {o.icon}
              {o.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
