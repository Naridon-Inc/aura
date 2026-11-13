// "In <repository>" in a Tasks toolbar. Every lens of the Dashboard carries
// the same control in the same place, and every copy points the place the
// same way (see taskScope), so switching lens never moves or changes it.

import type { JSX } from "react";

import { TaskProjectMenu } from "../ui/tasks-toolbar";
import {
  ALL_PROJECTS,
  projectNameFromRoot,
  scopeValueOf,
  useKnownProjects,
  useProjectScope,
} from "../../lib/projectRoots";
import { chooseTasksProject } from "./taskScope";

export function TasksRepositoryMenu({ openRoot }: { openRoot: string }): JSX.Element {
  const scope = useProjectScope();
  const projects = useKnownProjects(openRoot);
  return (
    <TaskProjectMenu
      value={scopeValueOf(scope, openRoot, projects)}
      allValue={ALL_PROJECTS}
      projects={projects.map((p) => ({
        value: p.root,
        name: p.label || projectNameFromRoot(p.root),
        hint: p.root,
      }))}
      onChange={(next) => chooseTasksProject(next, openRoot, projects)}
      disabled={projects.length === 0}
    />
  );
}
