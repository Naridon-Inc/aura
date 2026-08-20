// Tasks, as ONE place: the rail, fixed, and the work inside it.
//
// Three drawings on one strip — List, Board, Graph — where there were five.
// Plan went because it was the list with its goals above it, which Display's
// "group by goal" now does and every row wears as a tag; Sprint went because
// it was a dashboard about a sprint rather than a way of looking at the work.
// What's left is three genuinely different pictures. See lib/workRoute.
//
// The rail used to be conditional on which lens you were reading. List and
// Board mounted through `PlacePage` and got it; Plan and Graph took the window
// bare, because Mission Control stood up a panel of its own on the same edge
// and two rails on one edge is the arrangement `PlacePage` exists to prevent.
// So the fix was never "give the crew lenses a rail too" — it was to stop the
// body from having one, which is what `CrewWorkspace` does now.
//
// With that gone this component is the whole answer: mount the rail once,
// above the lens, and swap only the body. The rail keeps its scroll position,
// its open/closed groups and its selection across a lens change, because it is
// the same element the whole time rather than one that gets torn down and
// rebuilt from a different file.
//
// It also owns the one piece of lifecycle the board used to: clearing the
// shared selection on the way out. `TasksBoard` cleared it on unmount, which
// was right when leaving the board meant leaving Tasks and is wrong now that
// it only means switching to Plan — the rail would light a goal and the body
// would ignore it, or the pick would silently vanish under you mid-place.
//
// WHICH PROJECT is the rail's too, and it is resolved HERE for the map.
// `TasksBoard` reads the shared scope itself (it has to — it's the one body
// that can draw several projects at once), but the crew surface takes a single
// root, and it was being handed the folder the app has open. So the rail's
// picker moved the list and left the map on the project you started from —
// which is what made the switcher look broken, and why the crew surface had
// grown a second picker of its own to compensate. There is one picker now, in
// the rail, and this hands its answer down. WHO YOU ARE is resolved here for
// the same reason: `@me` is one answer per project and both bodies ask for it.

import type { JSX } from "react";
import { useEffect } from "react";

import { PlacePage } from "../places/PlacePage";
import { TasksSidebar } from "../workpanes/TasksSidebar";
import { TasksBoard } from "../TasksBoard";
import { CrewSurface } from "../commons/crew/CrewSurface";
import { clearTasksSharedFilters } from "../../lib/tasksFilterStore";
import { usePlaceRoot } from "../../lib/projectRoots";
import { useEffectiveHandle } from "../../lib/identityHandle";
import { isCrewLens, type WorkLens } from "../../lib/workRoute";

export function TasksPlace({
  repoRoot,
  lens,
  onLens,
  onClose,
}: {
  repoRoot: string;
  lens: WorkLens;
  onLens: (next: WorkLens) => void;
  onClose: () => void;
}): JSX.Element {
  // Leaving Tasks entirely drops the rail's narrowing, so coming back lands on
  // the whole board rather than on a sprint you picked yesterday. Switching
  // lens does NOT run this — that is the point of hoisting it here.
  useEffect(() => clearTasksSharedFilters, []);

  // The one project this place is pointed at. Under "All projects" it falls
  // back to the open one — the map reads a single dependency graph, and the
  // rail says which project that is (see the notice CrewSurface draws), rather
  // than pretending to aggregate eight.
  const placeRoot = usePlaceRoot(repoRoot);

  // Who `@me` is. Every Tasks surface asks for this and nothing ever answered:
  // the rail's My-tasks row is conditional on it so it never rendered, the
  // board's assignee filter fell back to matching a literal "@me" no task
  // carries, and Create left the assignee blank. It is one answer per project,
  // so it is resolved here and handed to both — see lib/identityHandle.
  const me = useEffectiveHandle(placeRoot);

  return (
    <PlacePage
      rail={
        <TasksSidebar
          repoRoot={repoRoot}
          currentHandle={me}
          // A bucket, a status, a sprint or a workstream is a slice of the
          // BACKLOG, and the map doesn't draw the backlog — so picking one
          // while you're reading the map has to bring you back to the list,
          // where it means something. Goals and crews narrow both, so they
          // deliberately don't call this: you stay put and what you're reading
          // gets smaller.
          onActivate={() => {
            if (isCrewLens(lens)) onLens("list");
          }}
        />
      }
    >
      {isCrewLens(lens) ? (
        // Closing the map is going back to the work, not leaving Tasks. It used
        // to hand up the place's own onClose, which shut the whole destination
        // — so the only way out of a picture you opened from the rail was to
        // leave the place the rail belongs to.
        <CrewSurface
          asPage
          repoRoot={placeRoot}
          lens={lens}
          onLens={onLens}
          // Closing the map is going back to the work, not leaving Tasks. It
          // used to hand up the place's own onClose, which shut the whole
          // destination — so the only way out of a picture you opened from the
          // strip was to leave the place the strip belongs to.
          onClose={() => onLens("list")}
        />
      ) : (
        <TasksBoard
          repoRoot={repoRoot}
          currentHandle={me}
          embedded
          // The place owns the lens, so List → Graph → List returns you to the
          // drawing you left instead of resetting to the board's own memory of
          // one. The board falls back to its own state anywhere the host
          // doesn't pass these (a workpane tab, the popout window).
          lens={lens}
          onLens={onLens}
          onClose={onClose}
        />
      )}
    </PlacePage>
  );
}
