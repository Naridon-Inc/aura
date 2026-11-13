// The one way to open the Create workspace dialog from anywhere: the sidebar's
// Create row, ⌘N, the Home toolbar's Create button, a repository group's +,
// a pull request's "Open as workspace" on the Dashboard. The dialog mounts
// once at the app root and waits for this event.

import type { CreateFromSelection } from "./CreateFromPicker";

export const CREATE_WORKSPACE_EVENT = "aura:new-workspace";

export type CreateWorkspaceRequest = {
  /** The repository to make the workspace in. Absent = the most recent one. */
  repoRoot?: string;
  /** Open straight onto "Create from…" (a branch or a PR to start from). */
  createFrom?: boolean;
  /** Open already starting from this branch or pull request. */
  from?: CreateFromSelection;
};

export function openCreateWorkspace(
  repoRoot?: string,
  options: { createFrom?: boolean; from?: CreateFromSelection } = {},
): void {
  const detail: CreateWorkspaceRequest = {};
  if (repoRoot) detail.repoRoot = repoRoot;
  if (options.createFrom) detail.createFrom = true;
  if (options.from) detail.from = options.from;
  window.dispatchEvent(new CustomEvent(CREATE_WORKSPACE_EVENT, { detail }));
}
