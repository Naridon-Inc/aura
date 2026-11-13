//! Ambient status indicators for the native Aura chat.
//!
//! Everything here is *quiet* — the chat's peripheral signals (the brain is
//! thinking, a plan is forming, a turn has gone silent). They are all the
//! shared chat status row, so the eye reads them as one calm register.
//!
//! - `ThinkingLine` / `PlanningStatusLine` — the working row with a live
//!   timer. They differ only in their default caption.
//! - `StallNotice` — the same row, raised when a turn goes silent, with Stop.
//! - `humanizeBrainId` / `brainAgentId` — a persisted brain id as a display
//!   name and as the agent whose mark to draw.

import { useEffect, useRef, useState } from "react";
import { Button } from "../../ui/button";
import { ChatStatus } from "../../ui/message";
import "../../ui/chat-surface.css";
import { formatDuration, formatLiveDuration } from "../../../lib/duration";
import { agentName } from "../../../lib/agentNames";

/** Self-contained elapsed ticker for an in-flight status line, in fractional
 *  seconds. Anchors to `startedAt` (the turn's rising-edge stamp) so the count
 *  stays continuous even when the line swaps between Thinking ⇄ Planning
 *  mid-turn; falls back to mount time when no stamp is given.
 *
 *  Ticks at 10Hz, and the caller renders a tenth. A once-a-second counter is
 *  frozen for ~900ms out of every 1000, and a number sitting still beside a
 *  spinner is exactly what a hung turn looks like — the wait feels longer than
 *  it is. Same elapsed time, shown moving.
 *
 *  The interval lives *here*, on the leaf — so the timer re-renders only this
 *  one line, never the whole chat view. A view-level ticker re-rendered the
 *  entire transcript on every beat, which collapsed any text the user was
 *  mid-selecting and made the stream visibly flicker; at 10Hz that would be
 *  ten times worse. Keeping the ticker on the leaf is what makes the finer
 *  cadence affordable. */
function useElapsedSeconds(startedAt: number | null | undefined): number {
  const startRef = useRef<number | null>(null);
  if (startRef.current == null) startRef.current = startedAt ?? Date.now();
  const [sec, setSec] = useState(() =>
    Math.max(0, (Date.now() - (startRef.current as number)) / 1000),
  );
  useEffect(() => {
    const tick = () =>
      setSec(Math.max(0, (Date.now() - (startRef.current as number)) / 1000));
    tick();
    const iv = window.setInterval(tick, 100);
    return () => window.clearInterval(iv);
  }, []);
  return sec;
}

/** The "Thinking…" working row shown while the brain works. It appends a
 *  quiet tabular-nums timer, counting in tenths,
 *  so a long turn visibly keeps working — the persistent "still going"
 *  affordance a long turn needs, instead of a state that flashes
 *  once and vanishes. */
export function ThinkingLine({
  label = "Thinking…",
  startedAt = null,
}: {
  label?: string;
  startedAt?: number | null;
}) {
  const elapsedSec = useElapsedSeconds(startedAt);
  return (
    <ChatStatus state="working">
      {label}
      {elapsedSec > 0 && (
        <span className="ui-chat-status-elapsed">{formatLiveDuration(elapsedSec)}</span>
      )}
    </ChatStatus>
  );
}

/** The same working row as `ThinkingLine`, captioned for the post-answer
 *  beat while the brain works its follow-up after answers land. Sits under
 *  the answered question before the next reply streams. Default caption "Planning next moves". Carries the same optional
 *  elapsed timer as `ThinkingLine`. */
export function PlanningStatusLine({
  label = "Planning next moves",
  startedAt = null,
}: {
  label?: string;
  startedAt?: number | null;
}) {
  const elapsedSec = useElapsedSeconds(startedAt);
  return (
    <ChatStatus state="working">
      {label}
      {elapsedSec > 0 && (
        <span className="ui-chat-status-elapsed">{formatLiveDuration(elapsedSec)}</span>
      )}
    </ChatStatus>
  );
}

/** Stall watchdog — the escalation of `ThinkingLine` for a turn that has gone
 *  worryingly quiet. A brain (especially a CLI-wrapper like Kimi) can accept a
 *  turn and then stream nothing for many minutes — hung subprocess, dropped
 *  socket, a model wedged on a huge context — and the plain shimmer line just
 *  spins forever with no way to tell "still working" from "stuck".
 *
 *  This anchors on a caller-supplied *last-activity* getter, NOT the turn's
 *  start: every streamed delta refreshes it, so a legitimately long answer that
 *  keeps producing tokens/reasoning never trips the notice — only true silence
 *  does. Once `idle ≥ thresholdSec` it raises the status row to name how
 *  long it's been quiet and offers a one-click Stop, so the user isn't left
 *  guessing or force-quitting the app.
 *
 *  Like `ThinkingLine`, the 1s ticker lives on this leaf, so the watch costs no
 *  transcript re-renders; below the threshold it renders nothing at all. */
export function StallNotice({
  getIdleSince,
  brainLabel,
  onStop,
  thresholdSec = 90,
}: {
  /** Epoch-ms of the turn's last observed activity (its last streamed delta,
   *  or its start if nothing has streamed). Read live off a ref each tick. */
  getIdleSince: () => number;
  /** Human name of the brain running the turn, for the copy ("No response
   *  from Kimi…"). Falls back to a generic phrasing when absent. */
  brainLabel?: string;
  /** Halt the in-flight turn — the same handler the composer's Stop uses. */
  onStop: () => void;
  /** Seconds of silence before the notice appears. */
  thresholdSec?: number;
}) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const iv = window.setInterval(() => setTick((n) => (n + 1) % 1_000_000), 1000);
    return () => window.clearInterval(iv);
  }, []);
  const idleSec = Math.max(0, Math.round((Date.now() - getIdleSince()) / 1000));
  if (idleSec < thresholdSec) return null;
  const who = brainLabel ?? "the model";
  return (
    <ChatStatus
      state="error"
      action={
        <Button size="xs" variant="outline" onClick={onStop}>
          Stop
        </Button>
      }
    >
      No response from {who} for {formatDuration(idleSec)}. It may be stuck.
    </ChatStatus>
  );
}

/** Map a persisted `ChatTurn.brain` id to a short, human label for the
 *  per-turn provenance chip. Persisted ids come from the legacy brain
 *  backend (`BrainBackend::id()`): `"anthropic"` for the native Anthropic
 *  API and `"cli:<provider>"` for a CLI-wrapper agent (e.g. `"cli:gemini"`).
 *  A future native id like `gemini_native` or an `openai_compat:<slug>`
 *  endpoint resolves through the same prefix-strip + name table. */
export function humanizeBrainId(id: string): string {
  // The prefix-strip and the name table both live in lib/agentNames now — one
  // table for the whole app. This one read a plain `aura` as a paid tier,
  // naming something the free built-in agent is not.
  return agentName(id);
}

/** Map a persisted `ChatTurn.brain` id to a canonical agent slug that
 *  `AgentIcon`/`brandFor` recognise, so the per-turn provenance row can
 *  paint the *vendor's real mark* (Claude, Gemini, …) next to the model
 *  name instead of a hand-rolled monogram. Mirrors `humanizeBrainId`'s
 *  prefix-strip; the native Anthropic id `"anthropic"` and the legacy
 *  `cli:claude_code` both resolve to `claude` so the orange Anthropic
 *  mark shows. Unknown ids fall through to the stem, which `AgentIcon`
 *  renders as a neutral monogram tile. */
export function brainAgentId(id: string): string {
  const raw = id.trim().toLowerCase();
  if (!raw) return "";
  const stem = raw.includes(":") ? raw.slice(raw.indexOf(":") + 1) : raw;
  const key = stem.replace(/_native$/, "");
  if (key === "anthropic" || key.includes("claude")) return "claude";
  if (key.includes("gemini")) return "gemini";
  if (key.includes("codex")) return "codex";
  if (key === "openai" || key === "gpt" || key.includes("gpt")) return "codex";
  if (key.includes("cursor")) return "cursor";
  if (key.includes("opencode")) return "opencode";
  return key;
}
