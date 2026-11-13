// Removing a Manager task's own copy of the project once the user is done
// with it. A copy with nothing in it to lose goes straight away; one still
// holding unsaved work, in the copy or in a nested repository inside it, is
// listed first and goes only when the user agrees. Every branch stays.

import type { ManagerTask, TaskCopyRemoval } from "./api";

/** The task has stopped running and still has a copy of its own. */
export function canRemoveTaskCopy(task: Pick<ManagerTask, "status" | "worktree_path">): boolean {
  return !!task.worktree_path && task.status !== "running";
}

/** What the user reads before agreeing to lose the listed work. */
export function keptCopyBody(path: string, unsaved: readonly string[]): string {
  return [
    path,
    "",
    "Deleting this folder loses:",
    ...unsaved.map((line) => `• ${line}`),
    "",
    "Its branch is kept, and so are the branches of any separate repositories inside it.",
  ].join("\n");
}

export type TaskCopyRemovalDeps = {
  remove: (force: boolean) => Promise<TaskCopyRemoval>;
  confirm: (body: string) => Promise<boolean>;
};

/** True once the copy at `path` is gone. */
export async function removeTaskCopyWith(path: string, deps: TaskCopyRemovalDeps): Promise<boolean> {
  const first = await deps.remove(false);
  if (first.outcome === "removed") return true;
  if (!(await deps.confirm(keptCopyBody(path, first.unsaved)))) return false;
  return (await deps.remove(true)).outcome === "removed";
}
