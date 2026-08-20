// The rail, wired to the app.
//
// `PeopleRail` takes everything it draws as props and reaches for nothing —
// that is what makes it photographable and testable. Something still has to do
// the reaching, and this is that something, kept apart so the component stays
// pure and `App.tsx` gains one element rather than a hook, two stores and a
// resolver.
//
// Opening a row is the only action the rail has today. What it does depends on
// where the session lives:
//
//  - **Your own agent, running here.** Adopt it as a tab and place it. Same
//    route the launcher's "running elsewhere" rows take, so a session opened
//    from the rail and the same session opened from ⌘K land in one tab, not
//    two.
//  - **A session on the plane hosted by this machine.** It has a local agent
//    behind it (`agentSessionId`), so it opens exactly as above.
//  - **Someone else's session.** There is no local process to place. Joining is
//    a decision with a socket behind it, which `SessionJoin` owns; until the
//    row is joinable the rail says so rather than opening an empty tab.

import { useCallback } from "react";

import { useEditorStore } from "../../../lib/editorStore";
import { labelForAgentId, useLiveAgentSessions } from "../../../lib/useLiveAgentSessions";
import { letterMark } from "../../../lib/monogram";
import { getSessionLive, isSessionLive } from "../../../lib/sessionLiveStore";
import { PeopleRail } from "./PeopleRail";
import { railHasCompany } from "./railModel";
import { useRailGroups } from "./useRailGroups";

export type PeopleRailMountProps = {
  /** The project on screen. It is how the rail learns your name: identity is
   *  per-repo here (roster alias, then per-repo override, then git), which is
   *  why this is a prop and not a global read. */
  repoRoot?: string | null;
  /** The session on screen, so its row can say so. */
  activeSessionId?: string | null;
  heading?: string | null;
};

export function PeopleRailMount({
  repoRoot = null,
  activeSessionId = null,
  heading = "People",
}: PeopleRailMountProps) {
  const { groups, loading, error } = useRailGroups(repoRoot);
  const store = useEditorStore();
  const live = useLiveAgentSessions(true);

  const openSession = useCallback(
    (sessionId: string) => {
      // The rail's ids are whatever the source used: a local PTY id for your
      // own agents, an external session id for anything on the plane. A plane
      // session hosted here resolves to its local agent; one hosted elsewhere
      // resolves to nothing local, and gets the joined-session pane instead.
      const localId = getSessionLive(sessionId).agentSessionId ?? sessionId;
      const s = live.find((l) => l.session_id === localId);
      if (!s) {
        // Someone else's session. There is no process here to place, so the
        // room itself is what opens — the same pane a pasted join code lands
        // in, keyed by the external id so both doors reach one tab.
        //
        // Only for a session this app is actually connected to. A row can also
        // come from a roster read, where all we know is that a session exists
        // somewhere; opening a live pane for a socket nobody has opened would
        // show a permanently empty room. Those rows stay inert, which is what
        // they were before, and the rail already says they aren't joinable.
        if (isSessionLive(sessionId)) store.openLiveSession(sessionId);
        return;
      }
      const base = labelForAgentId(s.agent_id);
      const title = s.title?.trim();
      const label = title ? `${base} · ${title}` : base;
      store.openAgent({
        sessionId: s.session_id,
        agentId: s.agent_id,
        agentLabel: label,
        agentMonogram: letterMark(label),
        repoRoot: s.repo_root,
        mode: "pty",
      });
    },
    [live, store],
  );

  // Nothing at all when it is just you — no heading, no empty state, no row.
  // See `railHasCompany`. This also covers the first paint: `groups` is null
  // until we know who you are, and a rail that appeared for one frame and then
  // vanished on the machine where nobody has joined anything (the ordinary
  // machine) would be worse than one that never appeared.
  if (!groups || !railHasCompany(groups)) return null;

  return (
    <PeopleRail
      groups={groups}
      loading={loading}
      error={error}
      activeSessionId={activeSessionId}
      onOpenSession={openSession}
      heading={heading}
    />
  );
}
