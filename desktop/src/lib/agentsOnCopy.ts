// Who is actually working on a copy right now.
//
// Two surfaces answer this question — the sidebar roster's live-agent lane
// and the Workspaces board's "Agent on it" column — and both used to answer
// it the same wrong way: live tabs from the focused workspace, unioned with
// `readPersistedAgents(path)` for everything else.
//
// That union is where the lie came from. The persisted roster is a TAB
// RESTORE LIST: which agent tabs were open the last time you had this
// workspace in view, written so switching away and back doesn't lose them.
// It carries no timestamp and no liveness, and nothing ever prunes it — so
// a workspace you left in June still reported an agent on it in August. The
// Workspaces board showed "Agent on it · 7" with cards last touched five
// weeks earlier.
//
// A backgrounded workspace CAN still have a real agent on it: PTY sessions
// outlive the tab, and the aura-pty-daemon's outlive the whole app. So the
// answer isn't "drop persisted agents", it's "ask whether the session is
// still alive" — `pty_list_alive` is that answer, and it spans every project.
//
// Stream and chat tabs are deliberately NOT resurrected from persistence.
// A stream tab's id is `stream:<agent>@<root>` and its run is a per-turn
// subprocess in this window's store; a chat tab is a conversation view, not
// a process. Neither can be running in a workspace you aren't looking at, so
// a persisted one is a bookmark, not an agent.

import { readPersistedAgents } from "./editorStore";

/** One agent parked on a copy. `sessionId` is the dedup key across the two
 *  sources; `attention` is only ever true for a live tab, because it's a
 *  real-time flag the persisted record doesn't carry. */
export type ParkedAgent = {
  sessionId: string;
  agentId: string;
  agentLabel: string;
  attention: boolean;
};

/** The subset of `AgentTab` this needs — kept structural so both callers can
 *  pass their own tab rows without a cast. */
export type LiveAgentTab = {
  sessionId: string;
  repoRoot: string;
  agentId: string;
  agentLabel: string;
  attention?: boolean;
};

/**
 * Agents on `path`: every tab open on it in this window, plus the persisted
 * ones whose PTY is still alive.
 *
 * `livePtyIds` is the id set from `pty_list_alive` (see
 * `useLivePtySessionIds`). Pass an empty set and you get the live tabs alone
 * — which is the honest answer when the registry hasn't been read yet, and
 * is why the first paint under-reports rather than over-reports.
 */
export function agentsOnCopy(
  path: string,
  tabs: readonly LiveAgentTab[],
  livePtyIds: ReadonlySet<string>,
): ParkedAgent[] {
  const live = tabs.filter((t) => t.repoRoot === path);
  const seen = new Set(live.map((t) => t.sessionId));
  return [
    ...live.map((t) => ({
      sessionId: t.sessionId,
      agentId: t.agentId,
      agentLabel: t.agentLabel,
      attention: !!t.attention,
    })),
    ...readPersistedAgents(path)
      .filter(
        (p) =>
          !seen.has(p.sessionId) &&
          p.mode === "pty" &&
          livePtyIds.has(p.sessionId),
      )
      .map((p) => ({
        sessionId: p.sessionId,
        agentId: p.agentId,
        agentLabel: p.agentLabel,
        attention: false,
      })),
  ];
}
