// Crew · Queue — the PLAN, two ways at once. A vibecoder asked for the work as
// a real board they can move around, with a list beside it: so this is a thin
// two-pane composer over the same unified `ready_view`.
//
//   • LEFT  — master→detail in one column. By default `CrewQueueSidebar`: the
//             honest worklist (what runs next, in order, grouped by priority,
//             blocked + done tails). Click any task and this same column SWAPS
//             to `CrewTaskDetail` — the full story, right where the list was, no
//             separate side-popover. A "back" row returns to the list.
//   • RIGHT — `CrewCanvas`: the same tasks as a real node graph on an infinite
//             dotted board. Connected tasks draw as a left→right dependency
//             flow (an edge = "can't start until that's done"). Pan, zoom, click
//             a node — which selects it, lighting its chain AND opening its
//             detail in the left column.
//
// Selection is shared: click a row or a node and both highlight it. No new data,
// no mock state — same `view` the runner and chat's `/loop` read.

import type { LoopTask, ReadyViewDto } from "../../../lib/api";
import type { CrewProof } from "./crewProof";
import { CrewQueueSidebar } from "./CrewQueueSidebar";
import { CrewTaskDetail } from "./CrewTaskDetail";
import { CrewCanvas } from "./CrewCanvas";

export function CrewQueueTab({
  view,
  selectedId,
  selectedTask,
  allTasks,
  proof,
  onSelect,
  onDeselect,
  onSetStatus,
  onRetry,
  onPlanOrder,
  ordering,
  onSync,
  syncing,
}: {
  view: ReadyViewDto;
  selectedId: string | null;
  /** The picked task, resolved by the shell — when set, the left column shows
   *  its detail instead of the worklist. */
  selectedTask: LoopTask | null;
  /** Every node flattened, so the detail can resolve "waiting on / unblocks". */
  allTasks: LoopTask[];
  proof: Map<string, CrewProof[]>;
  onSelect: (id: string) => void;
  /** Return the left column from detail to the worklist. */
  onDeselect: () => void;
  onSetStatus: (nodeId: string, status: string) => void;
  /** Retry a failed task — re-arm AND run it in one click (the shell handles
   *  the run + the "waiting on …" read). Falls back to onSetStatus if absent. */
  onRetry?: (nodeId: string) => void;
  /** Auto-order the orderless pile — the brain infers the dependencies. */
  onPlanOrder?: () => void;
  ordering?: boolean;
  /** Project the task board into the queue — lives at the foot of the list. */
  onSync?: () => void;
  syncing?: boolean;
}) {
  return (
    <div className="flex h-full min-h-0">
      <aside className="w-[340px] shrink-0 border-r border-line-soft">
        {selectedTask ? (
          <CrewTaskDetail
            task={selectedTask}
            allTasks={allTasks}
            proof={proof}
            onClose={onDeselect}
            onOpen={onSelect}
            onSetStatus={onSetStatus}
            onRetry={onRetry}
          />
        ) : (
          <CrewQueueSidebar
            view={view}
            selectedId={selectedId}
            onSelect={onSelect}
            onSync={onSync}
            syncing={syncing}
          />
        )}
      </aside>
      <div className="relative min-w-0 flex-1">
        <CrewCanvas
          view={view}
          selectedId={selectedId}
          onSelect={onSelect}
          proof={proof}
          onPlanOrder={onPlanOrder}
          ordering={ordering}
        />
      </div>
    </div>
  );
}
