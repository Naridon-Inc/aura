// The Dashboard place: every workspace on the stage board (see
// components/dashboard/WorkspacesDashboard). Tasks live in the details panel
// beside a workspace now, not on a page of their own.
//
// The one other picture this place still draws is the crew graph, and only
// when something links to it directly (lens "graph", from the crew surface or
// the workpane board's own strip). Closing it comes back to the dashboard.
//
// It also owns one piece of lifecycle: clearing the shared task filters on the
// way out, so the workpane board and the popout open on the whole list rather
// than on a narrowing picked somewhere else.

import type { JSX } from "react";
import { useEffect } from "react";

import { CrewSurface } from "../commons/crew/CrewSurface";
import {
  WorkspacesDashboard,
  type WorkspacesDashboardProps,
} from "../dashboard/WorkspacesDashboard";
import { clearTasksSharedFilters } from "../../lib/tasksFilterStore";
import { usePlaceRoot } from "../../lib/projectRoots";
import { isCrewLens, type WorkLens } from "../../lib/workRoute";

export function TasksPlace({
  repoRoot,
  lens,
  onLens,
  onClose,
  dashboard,
}: {
  repoRoot: string;
  lens: WorkLens;
  onLens: (next: WorkLens) => void;
  onClose: () => void;
  /** What the dashboard shows: the open repositories and their copies. */
  dashboard: Omit<WorkspacesDashboardProps, "onClose">;
}): JSX.Element {
  useEffect(() => clearTasksSharedFilters, []);

  // The crew graph reads one project's dependency graph.
  const placeRoot = usePlaceRoot(repoRoot);

  if (isCrewLens(lens)) {
    return (
      <CrewSurface
        asPage
        repoRoot={placeRoot}
        openRoot={repoRoot}
        lens={lens}
        onLens={onLens}
        onClose={() => onLens("list")}
      />
    );
  }
  return <WorkspacesDashboard {...dashboard} onClose={onClose} />;
}
