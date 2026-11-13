// Archiving a copy runs the repository's archive script in it first, the way
// setup runs when the copy is made. The sidebar entry goes away at once; the
// script finishes in the background and only speaks up when it went wrong.
// A copy on another machine is left to that machine.

import { remotePlaceForRoot } from "./activeMachine";
import { toast } from "./toast";
import { onWorkspaceArchived } from "./workspaceCustomization";
import { archiveNotice, workspaceArchiveScript } from "./workspaceScripts";

export async function runArchiveScript(worktreePath: string): Promise<void> {
  if (remotePlaceForRoot(worktreePath)) return;
  try {
    const notice = archiveNotice(await workspaceArchiveScript(worktreePath, worktreePath));
    if (notice) toast.warning(notice.title, notice.body);
  } catch (e) {
    toast.warning("Archive script didn't run", String(e));
  }
}

/** Run the archive script whenever a workspace is archived. Returns the
 *  unsubscribe. */
export function installArchiveScript(): () => void {
  return onWorkspaceArchived((root) => void runArchiveScript(root));
}
