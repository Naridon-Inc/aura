// What turn a terminal agent is in, folded from its hook events.
//
// The agent's own plugin reports the edges of a turn over OSC 777 and the
// loopback listener: `prompt_submit` opens one, `stop` closes it, a permission
// prompt parks it on the user. This is the state machine the tab mark, the HUD
// and the Chat view all read, kept pure so it can be tested without a PTY.
//
// Two things it knows that a bare status did not:
//
//   - **When the turn started.** The CLI prints "Hatching… (22s)" under the
//     conversation the whole time it works. The Chat view shows the same timer,
//     and it has to count from the prompt, not from whenever the view happened
//     to mount — switching to Chat twenty seconds in must not read "0s".
//
//   - **That a turn can end without saying so.** Claude Code does not run its
//     Stop hook when the user interrupts with Escape, and a CLI that crashes
//     runs nothing at all. The status used to stay `in_progress` until the next
//     prompt, so a tab kept breathing over an agent that had stopped. A working
//     TUI is never silent for long — its spinner and elapsed counter keep
//     redrawing — so a turn whose hooks AND terminal have both gone quiet has
//     ended, whatever the last hook said.

import type { CliAgentEvent, CliAgentStatus } from "./api";

export type TurnState = {
  status: CliAgentStatus;
  /** Epoch ms the current turn opened, or null when the agent is between
   *  turns. Survives a permission prompt: waiting on the user is still the
   *  same turn, and its timer keeps running in the CLI too. */
  startedAt: number | null;
  /** Epoch ms of the latest hook event. The silence check needs it so a turn
   *  that has only just opened is never judged by a terminal that has not
   *  drawn its spinner yet. */
  lastEventAt: number;
};

/** How long a turn's hooks and terminal must both be silent before it is
 *  treated as over. Every CLI we host redraws a live timer while it works;
 *  measured on Claude Code 2.1 in a PTY, the longest mid-turn silence —
 *  through a 14s shell command, terminal unfocused — was 2.1s, and an idle
 *  session draws nothing at all. So this is several missed beats, not a
 *  pause. */
export const TURN_QUIET_MS = 8000;

export function initialTurn(): TurnState {
  return { status: { kind: "idle" }, startedAt: null, lastEventAt: 0 };
}

function working(status: CliAgentStatus): boolean {
  return status.kind === "in_progress" || status.kind === "blocked";
}

/** Fold one hook event into the turn. Mirrors Warp's `apply_event` (a
 *  clean-room rewrite; the concept is not copyrightable). Unknown event names
 *  leave the status alone so a newer plugin never wedges the mark. */
export function reduceTurn(
  prev: TurnState,
  ev: CliAgentEvent,
  now: number,
): TurnState {
  const next: TurnState = { ...prev, lastEventAt: now };
  // A turn that is already open keeps its start: a follow-up typed mid-turn
  // is queued into the same run, and the CLI's timer does not reset for it.
  const open = () => {
    if (!working(prev.status) || prev.startedAt == null) next.startedAt = now;
    next.status = { kind: "in_progress" };
  };
  switch (ev.event) {
    case "prompt_submit":
      open();
      break;
    case "pre_tool_use":
      // A tool only runs inside a turn. Seeing one while we think the agent is
      // idle means the turn began before we were listening (the app restarted
      // under a live session) or was settled early — either way it is working.
      // A pending permission prompt is left alone: this call may be the very
      // one it is waiting on.
      if (!working(prev.status)) open();
      break;
    case "tool_complete":
      // A finished tool after a permission prompt means the user answered it;
      // one arriving while idle is the same late-listener case as above.
      if (prev.status.kind !== "in_progress") open();
      break;
    case "permission_request":
      next.status = {
        kind: "blocked",
        summary: ev.summary ?? `Wants to run ${ev.tool_name ?? "tool"}`,
      };
      if (prev.startedAt == null) next.startedAt = now;
      break;
    case "idle_prompt":
      // Claude's "still waiting for you" nudge fires after a turn has ended.
      next.status = { kind: "blocked", summary: ev.summary ?? "Input needed" };
      next.startedAt = null;
      break;
    case "stop":
      next.status = { kind: "success", query: ev.query, response: ev.response };
      next.startedAt = null;
      break;
    default:
      // `session_start` and anything newer: record the time, keep the status.
      break;
  }
  return next;
}

/** Whether a turn that still reads `in_progress` has in fact ended — its
 *  hooks have been silent for `quietMs` and so has its terminal, or the
 *  process behind it is gone. Only `in_progress` is judged: a turn parked on a
 *  permission prompt is supposed to be silent. */
export function turnWentQuiet(
  state: TurnState,
  pty: { idle_ms: number; alive: boolean },
  now: number,
  quietMs: number = TURN_QUIET_MS,
): boolean {
  if (state.status.kind !== "in_progress") return false;
  if (!pty.alive) return true;
  return now - state.lastEventAt >= quietMs && pty.idle_ms >= quietMs;
}

/** Close a turn the CLI never closed itself. */
export function settleTurn(state: TurnState): TurnState {
  if (state.status.kind !== "in_progress") return state;
  return { ...state, status: { kind: "idle" }, startedAt: null };
}
