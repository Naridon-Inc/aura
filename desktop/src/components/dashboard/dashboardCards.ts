// Which workspaces the Dashboard draws, and what it calls them.
//
// A repository's main checkout is where the repository lives, not a piece of
// work, so the board leaves it off while nothing is happening there. Edits not
// yet committed, a chat running on it, or one waiting for you make it work
// like any copy, and then it is a card, titled with the repository's name so
// two repositories' mains never read the same.

import type { WorkspaceOverview } from "../ui/workspace-preview-card";
import type { WorkspaceRowSource } from "../workspaces/useWorkspaceRows";
import type { WorkspaceCopy } from "../workspaces/workspacesModel";

/** Whether work is happening on a main checkout: uncommitted edits, a chat
 *  running on it, or one waiting for you (`unread`). */
export function mainInUse(copy: WorkspaceCopy, unread: boolean): boolean {
  return (
    unread ||
    copy.agents.length > 0 ||
    copy.added > 0 ||
    copy.removed > 0 ||
    copy.changedFiles > 0
  );
}

/** The board's cards from the shared workspace rows: every copy and cloud
 *  thread as it is, and each main checkout only while it is in use, under its
 *  repository's name. `unreadAt` answers for a chat waiting in a workspace
 *  that is not in front, which the rows' live agents don't carry. */
export function dashboardCards(
  rows: readonly WorkspaceOverview[],
  sourceOf: (id: string) => WorkspaceRowSource | undefined,
  unreadAt: (path: string) => boolean,
): WorkspaceOverview[] {
  const cards: WorkspaceOverview[] = [];
  for (const row of rows) {
    const source = sourceOf(row.id);
    if (source?.kind !== "copy" || !source.copy.isMain) {
      cards.push(row);
      continue;
    }
    const unread = unreadAt(source.copy.path);
    if (!mainInUse(source.copy, unread)) continue;
    cards.push({ ...row, title: row.project, unread: row.unread || unread });
  }
  return cards;
}
