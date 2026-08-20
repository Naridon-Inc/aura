// Keeps every open Aura conversation's tab titled with what the conversation
// is ABOUT.
//
// The backend names each session from its first user message
// (`seed_objective_from` → `summarize_objective`) and the Sessions list has
// always shown that name. The tab strip kept whatever literal the opener
// passed, so three open chats read "Chat", "Chat", "Chat" — same word, same
// mark, in the one control you use to move between them.

import { useEffect } from "react";

import { renameManagerTabById, type ManagerTab } from "../../lib/editorStore";
import { useManagerSummaries } from "../../lib/managerStore";

/** Reads from `manager_list`, not from a per-tab `useManagerSession`: that
 *  returns the RUNTIME session, which is null for a conversation restored with
 *  the workspace but not currently loaded — i.e. exactly the tabs that were
 *  showing the placeholder. `manager_list` unions the runtime with the
 *  persisted sessions on disk, so a cold tab gets its name too.
 *
 *  Writes back into the tab rather than resolving at each render, because the
 *  global strip, the split pane's own strip, the tooltip, the pane pickers and
 *  the popout window title all read `tab.label`, and one true name beats five
 *  resolutions of it. A user's own rename lives in a separate map and wins over
 *  both.
 *
 *  Mounted by App, not by a tab strip: there are two strips — the global one,
 *  and the per-pane one that replaces it while a split is active — and a split
 *  is exactly when the most tabs are open. The naming belongs to neither. One
 *  subscription for the app (the summary poll is shared and ref-counted), alive
 *  only while a manager tab exists. Renders nothing. */
export function ManagerTabTitles({ tabs }: { tabs: ManagerTab[] }) {
  const summaries = useManagerSummaries();
  useEffect(() => {
    for (const t of tabs) {
      // Empty until the first message is sent, which is right: a blank chat is
      // "Aura" until you've said something for it to be about.
      const objective = summaries
        .find((s) => s.id === t.sessionId)
        ?.objective?.trim();
      if (objective) renameManagerTabById(t.sessionId, objective);
    }
  }, [tabs, summaries]);
  return null;
}
