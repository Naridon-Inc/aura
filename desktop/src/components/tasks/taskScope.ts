// Pointing the Dashboard at a project. The rail's picker and the Dashboard's
// project tabs are two controls over one choice, so they make it the same way.

import {
  scopeValueOf,
  setProjectScope,
  type KnownProject,
} from "../../lib/projectRoots";
import {
  setTasksSharedCrew,
  setTasksSharedCycleId,
  setTasksSharedGoal,
  setTasksSharedModuleId,
} from "../../lib/tasksFilterStore";

/** Move to `next` (a project root, or ALL_PROJECTS). Every narrowing the rail
 *  holds — sprint, workstream, goal, crew — belongs to the project being left,
 *  and carrying one across would filter the new board down to nothing with a
 *  row lit in the rail explaining why, so they all reset. Picking the project
 *  the app already has open means "no explicit scope"; that is compared
 *  against the folded root, because that is the one the controls offer. */
export function chooseTasksProject(
  next: string,
  openRoot: string,
  projects: KnownProject[],
): void {
  setTasksSharedCycleId(null);
  setTasksSharedModuleId(null);
  setTasksSharedGoal(null);
  setTasksSharedCrew(null);
  setProjectScope(next === scopeValueOf("", openRoot, projects) ? "" : next);
}
