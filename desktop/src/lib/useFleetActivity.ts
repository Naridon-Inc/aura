// "Is anything working right now?" — the whole-fleet activity signal the
// sidebar mirrors so a working agent shows up-front, not only inside whichever
// chat/terminal tab happens to be open. It reuses the exact same whole-fleet
// stores the floating HUD derives its roster from (no new plumbing), so the
// sidebar pulse and the HUD always agree on what "working" means:
//   - stream coding-agent tabs  → the channel's `running` flag
//   - PTY / chat coding-agent tabs → the OSC-777 event status (`in_progress`)
//   - native Aura chat sessions → an in-flight turn, or a *recent* `running`
//     status (see `isSessionWorking` — the stored flag outlives dead processes)
//
// GLOBAL by design: the user asked for "when ANYTHING is working" — so this
// counts every working agent across every open workspace/worktree, not just the
// active project. An agent grinding away in a background worktree still pulses
// the sidebar. `projectRoot` is accepted only to annotate how many of those are
// in the project you're currently looking at (for the tooltip); it never gates
// the count.

import { useMemo } from "react";

import { streamChannel, useAllStreamStates } from "./agentStreamStore";
import { useAllAgentStatuses } from "./agentEventStore";
import { useEditorStore } from "./editorStore";
import {
  isManagerTurnInFlight,
  useManagerSummaries,
  useManagerTurnsTick,
} from "./managerStore";

export type FleetActivity = {
  /** True when at least one agent anywhere is mid-turn. */
  working: boolean;
  /** Total agents working across all workspaces — drives the tooltip. */
  count: number;
  /** How many of those are in the project currently in view (0 when no
   *  `projectRoot` was given). Lets the tooltip say "2 working · 1 here". */
  inProjectCount: number;
};

function sameRoot(a: string, b: string): boolean {
  const norm = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);
  return norm(a) === norm(b);
}

// How long a session may go silent and still count as working.
//
// `status: "running"` is PERSISTED to `~/.aura/manager-sessions/<id>.json`, and
// nothing rewrites it when the process holding that turn dies — a crash, a
// force-quit, a machine reboot mid-turn all leave the flag set forever. So the
// flag alone answers "did this session ever start a turn", not the question
// this module exists to answer, which is "is anything working right now".
//
// It had been answering the wrong one for months: two sessions on this machine
// were still flagged running, one last touched six days earlier and one
// seventy-eight days earlier, and the roster drew a live loader beside both of
// their projects on every launch — including the bundled Get Started sample, so
// a brand-new user's very first screen showed a spinner for an agent that was
// never running. A loader that is always on says nothing at all.
//
// `updated_at` is the honest liveness signal: `ManagerSession::touch()` stamps
// it on every message and every tool call, so a working agent refreshes it
// continuously. Thirty minutes is deliberately far past any real gap between
// two turn events — the point is to bury the ghosts, not to police slow work,
// and a session that speaks again is counted again on the very next poll.
const STALE_RUNNING_SECS = 30 * 60;

/** Is this session working *right now*?
 *
 *  An in-flight turn is authoritative and needs no timer: this process armed
 *  it, so we know first-hand that it is live. The persisted `running` status is
 *  the fallback that covers a turn still going after its view unmounted, and it
 *  is the one that can outlive its process — so it has to prove recency. */
export function isSessionWorking(
  s: { id: string; status: string; updated_at: number },
  nowSecs: number,
): boolean {
  if (isManagerTurnInFlight(s.id)) return true;
  if (s.status !== "running") return false;
  return nowSecs - s.updated_at < STALE_RUNNING_SECS;
}

/** Reactive count of agents actively working, fleet-wide. Recomputes when any
 *  of the underlying fleet stores tick (a stream chunk, an OSC status flip, a
 *  manager summary poll), so the sidebar pulse tracks real activity without a
 *  timer of its own. */
export function useFleetActivity(
  projectRoot?: string | null,
): FleetActivity {
  const editor = useEditorStore();
  const streamStates = useAllStreamStates();
  const ptyStatuses = useAllAgentStatuses();
  const summaries = useManagerSummaries();
  // Recompute the instant a native turn arms/clears, not only on the 5s
  // summary poll — otherwise a just-injected Aura-chat turn wouldn't pulse the
  // sidebar until the next poll tick.
  const turnsTick = useManagerTurnsTick();

  return useMemo(() => {
    let count = 0;
    let inProjectCount = 0;
    const inProject = (root: string) =>
      !!projectRoot && sameRoot(root, projectRoot);

    // Every coding-agent tab, any workspace. Same mode→store mapping the HUD
    // uses (stream reads the running flag; pty/chat read the OSC status).
    for (const t of editor.agentTabs) {
      const busy =
        t.mode === "stream"
          ? !!streamStates.get(streamChannel(t.agentId, t.repoRoot))?.running
          : ptyStatuses.get(t.sessionId)?.kind === "in_progress";
      if (!busy) continue;
      count += 1;
      if (inProject(t.repoRoot)) inProjectCount += 1;
    }

    // Native Aura chat sessions, any workspace. `isManagerTurnInFlight` reacts
    // immediately on the next store tick; the persisted `running` status covers
    // a turn still going after a view unmount, and must prove it isn't a ghost
    // left behind by a dead process (see `isSessionWorking`). Recency is judged
    // at memo time, which the 5s summary poll re-runs — so a session that goes
    // stale drops out within a tick of crossing the line.
    const nowSecs = Date.now() / 1000;
    for (const s of summaries) {
      if (!isSessionWorking(s, nowSecs)) continue;
      count += 1;
      if (s.repo_root && inProject(s.repo_root)) inProjectCount += 1;
    }

    return { working: count > 0, count, inProjectCount };
  }, [projectRoot, editor.agentTabs, streamStates, ptyStatuses, summaries, turnsTick]);
}

/** The set of workspace / worktree roots that have at least one agent working
 *  right now — normalized (no trailing slash). Lets a per-workspace surface
 *  (e.g. the roster row's worktree icon) show its OWN loader instead of only
 *  the fleet-wide pulse. Reactive on the same store ticks as
 *  `useFleetActivity`. Membership is by the agent's `repoRoot` / the manager
 *  session's `repo_root`, which for a worktree is that worktree's path. */
export function useWorkingRoots(): Set<string> {
  const editor = useEditorStore();
  const streamStates = useAllStreamStates();
  const ptyStatuses = useAllAgentStatuses();
  const summaries = useManagerSummaries();
  // See useFleetActivity: fold in-flight-turn changes in immediately so a
  // freshly-armed Aura-chat turn adds its root without a 5s poll delay.
  const turnsTick = useManagerTurnsTick();

  return useMemo(() => {
    const norm = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);
    const roots = new Set<string>();
    for (const t of editor.agentTabs) {
      const busy =
        t.mode === "stream"
          ? !!streamStates.get(streamChannel(t.agentId, t.repoRoot))?.running
          : ptyStatuses.get(t.sessionId)?.kind === "in_progress";
      if (busy) roots.add(norm(t.repoRoot));
    }
    const nowSecs = Date.now() / 1000;
    for (const s of summaries) {
      if (!isSessionWorking(s, nowSecs)) continue;
      if (s.repo_root) roots.add(norm(s.repo_root));
    }
    return roots;
  }, [editor.agentTabs, streamStates, ptyStatuses, summaries, turnsTick]);
}
