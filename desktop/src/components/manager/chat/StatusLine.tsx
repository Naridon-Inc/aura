//! Ambient status indicators for the native Aura chat.
//!
//! Everything here is *quiet* — these are the chat's peripheral signals
//! (the brain is thinking, a plan is forming, which model produced a turn,
//! whether a tool is mid-flight). They share one visual family so the eye
//! reads them as a single calm register rather than four competing widgets.
//!
//! - `ThinkingLine` / `PlanningStatusLine` — the animated shimmer line,
//!   reusing the `.aura-chat`-scoped `.thinking`/`.spinner`/`.shimmer` CSS
//!   in `styles.css`. They differ only in their default caption.
//! - `humanizeBrainId` — maps a persisted legacy brain id to a display name.
//! - `BrainProvenanceChip` — a subtle mono chip naming the brain behind a turn.
//! - `StatusPip` — a 6px dot keyed to a `ToolStatus`, for reuse by cards.
//!
//! Tokens only — never a raw hex. These must never out-shout the message
//! content they sit beside.

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Sparkles } from "lucide-react";

import { AsciiSpinner } from "../../ui/ascii-spinner";
import type { ToolStatus } from "./types";

/** Format an in-flight turn's elapsed seconds for the working indicator —
 *  `8s` under a minute, `1m 04s` beyond. Sub-second renders nothing (the
 *  caller hides the stat until ≥1s so it never flashes `0s`). */
function formatElapsed(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}

/** Self-contained 1s elapsed ticker for an in-flight status line. Anchors to
 *  `startedAt` (the turn's rising-edge stamp) so the count stays continuous
 *  even when the line swaps between Thinking ⇄ Planning mid-turn; falls back to
 *  mount time when no stamp is given.
 *
 *  The interval lives *here*, on the leaf — so the timer re-renders only this
 *  one line each second, never the whole chat view. A view-level ticker
 *  re-rendered the entire transcript every second, which collapsed any text the
 *  user was mid-selecting and made the stream visibly flicker. Keeping the
 *  ticker on the leaf is the fix for both. */
function useElapsedSeconds(startedAt: number | null | undefined): number {
  const startRef = useRef<number | null>(null);
  if (startRef.current == null) startRef.current = startedAt ?? Date.now();
  const [sec, setSec] = useState(() =>
    Math.floor((Date.now() - (startRef.current as number)) / 1000),
  );
  useEffect(() => {
    const tick = () =>
      setSec(Math.floor((Date.now() - (startRef.current as number)) / 1000));
    tick();
    const iv = window.setInterval(tick, 1000);
    return () => window.clearInterval(iv);
  }, []);
  return sec;
}

/** The shimmer "Thinking…" line shown while the brain works. Renders the
 *  `.aura-chat`-scoped `.thinking` family (spinner + shimmer caption) from
 *  `styles.css`. When `elapsedSec` is provided (≥1) it appends a quiet
 *  tabular-nums timer so a long turn visibly keeps working — the persistent
 *  "still going" affordance Conductor/Claude Code show, instead of a state
 *  that flashes once and vanishes. */
export function ThinkingLine({
  label = "Thinking…",
  startedAt = null,
}: {
  label?: string;
  startedAt?: number | null;
}) {
  const elapsedSec = useElapsedSeconds(startedAt);
  return (
    <div className="thinking">
      <AsciiSpinner />
      <span className="shimmer">{label}</span>
      {elapsedSec >= 1 && (
        <span className="thinking-elapsed">{formatElapsed(elapsedSec)}</span>
      )}
    </div>
  );
}

/** Same shimmer family as `ThinkingLine`, captioned for the post-answer
 *  beat — Cursor shows a tiny spinner while the brain works its follow-up
 *  after answers land. Sits under the AnswersCard before the next bubble
 *  streams. Default caption "Planning next moves". Carries the same optional
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
    <div className="thinking">
      <AsciiSpinner />
      <span className="shimmer">{label}</span>
      {elapsedSec >= 1 && (
        <span className="thinking-elapsed">{formatElapsed(elapsedSec)}</span>
      )}
    </div>
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
 *  does. Once `idle ≥ thresholdSec` it fades in a calm amber row that names how
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
    <div className="aura-stall-notice" role="status">
      <AlertTriangle size={13} strokeWidth={2} className="aura-stall-icon" aria-hidden />
      <span className="aura-stall-text">
        No response from {who} for {formatElapsed(idleSec)} — it may be stuck.
      </span>
      <button type="button" className="aura-stall-stop" onClick={onStop}>
        Stop
      </button>
    </div>
  );
}

/** Map a persisted `ChatTurn.brain` id to a short, human label for the
 *  per-turn provenance chip. Persisted ids come from the legacy brain
 *  backend (`BrainBackend::id()`): `"anthropic"` for the native Anthropic
 *  API and `"cli:<provider>"` for a CLI-wrapper agent (e.g. `"cli:gemini"`).
 *  A future native id like `gemini_native` or an `openai_compat:<slug>`
 *  endpoint resolves through the same prefix-strip + name table. */
export function humanizeBrainId(id: string): string {
  const raw = id.trim();
  if (!raw) return "";
  // Strip a family prefix (`cli:`, `cli_wrapper:`, `openai_compat:`) → stem.
  const stem = raw.includes(":") ? raw.slice(raw.indexOf(":") + 1) : raw;
  const key = stem.replace(/_native$/, "").toLowerCase();
  const NAMES: Record<string, string> = {
    anthropic: "Claude",
    claude: "Claude",
    gemini: "Gemini",
    openai: "OpenAI",
    gpt: "GPT",
    kimi: "Kimi",
    moonshot: "Kimi",
    codex: "Codex",
    opencode: "OpenCode",
    cursor: "Cursor",
    deepseek: "DeepSeek",
    qwen: "Qwen",
    ollama: "Ollama",
    aura_pro: "Aura Pro",
    aura: "Aura Pro",
  };
  if (NAMES[key]) return NAMES[key];
  // openai_compat:<slug> or any unknown id → title-case the stem.
  return stem.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
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

/** Per-turn brain provenance. Shows which brain produced THIS turn so a
 *  conversation that swapped brains mid-stream (Claude → Gemini → Kimi via
 *  the composer BrainPicker) stays legible when scrolled back. Reads the
 *  persisted `ChatTurn.brain`; renders nothing when it's absent (native
 *  `brain_chat_turn` turns don't persist one, so the chip surfaces exactly
 *  the cross-vendor swaps this is for).
 *
 *  Redesigned as a subtle token chip — mono, muted ink, hairline border on
 *  a faint chrome fill. It names the model without ever pulling focus. */
export function BrainProvenanceChip({ brain }: { brain: string }) {
  const label = humanizeBrainId(brain);
  if (!label) return null;
  return (
    <span
      className="inline-flex items-center gap-1 mb-1 select-none align-middle"
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: "10px",
        lineHeight: "14px",
        letterSpacing: "0.02em",
        color: "var(--color-text-3)",
        background: "var(--color-bg-1)",
        border: "1px solid var(--color-line)",
        borderRadius: "var(--radius-sm)",
        padding: "1px 5px",
      }}
      title={`This turn was produced by ${label}`}
    >
      <Sparkles size={9} strokeWidth={1.75} />
      {label}
    </span>
  );
}

/** A 6px status dot keyed to a tool's `ToolStatus`, for reuse by cards and
 *  inline rows. `running` is the arctic accent and pulses; `ok` is the green
 *  status token; `error` is the red token. Pure ambient signal — no label. */
export function StatusPip({ status }: { status: ToolStatus }) {
  const color =
    status === "error"
      ? "var(--color-red)"
      : status === "ok"
      ? "var(--color-accent-green)"
      : "var(--color-accent)";
  return (
    <span
      aria-hidden
      style={{
        width: "6px",
        height: "6px",
        flex: "none",
        borderRadius: "50%",
        background: color,
        animation:
          status === "running"
            ? "aura-chat-shimmer 1.6s ease-in-out infinite"
            : undefined,
      }}
    />
  );
}
