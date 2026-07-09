//! Collapsible extended-thinking ("reasoning") disclosure — the "whisper line".
//!
//! When a brain streams its chain-of-thought (Anthropic extended thinking,
//! Gemini `thought` parts — gated on the composer's Effort chip), those
//! deltas arrive as `StreamBlock { kind: "reasoning" }`. This renders them as
//! a single quiet line — a green ✦ spark + "Thinking…" (live) / "Thought for
//! Ns" (settled) — that the thinking never competes with the answer prose.
//! It auto-expands while the thought is still streaming (so the user sees the
//! model working) and auto-collapses once the answer text starts, leaving the
//! whisper line behind. Expanding reveals the reasoning in a left-ruled aside.
//!
//! Chosen treatment "T1 whisper line" from the chat-redesign mockups. Tokens
//! only: muted ink, the spark on the (chat-scoped, green) accent.

import { useEffect, useRef, useState } from "react";

import { Sparkles } from "lucide-react";

import { MarkdownBody } from "./Markdown";

/** A whisper-line disclosure wrapping streamed reasoning text. `streaming`
 *  drives the auto-open/auto-close: open while the thought is mid-flight,
 *  collapsed to one line once the model moves on to its answer. The user can
 *  override by clicking — once they do, we stop auto-managing it for this
 *  turn. The streamed duration is self-measured (clock starts the first time
 *  the block is seen live, freezes when streaming ends) so a settled thought
 *  reads "Thought for Ns" without the parent threading a timestamp. */
export function ReasoningBlock({
  text,
  streaming,
}: {
  text: string;
  streaming: boolean;
}) {
  const [open, setOpen] = useState(streaming);
  // Once the user clicks the header we hand them control and stop the
  // auto open/close that would otherwise fight their choice.
  const userTouchedRef = useRef(false);
  // Self-measured think duration. `startRef` latches the first live render;
  // `durationSec` freezes once streaming ends. A persisted reload (streaming
  // false from the first render) never starts the clock → no duration.
  const startRef = useRef<number | null>(null);
  const [durationSec, setDurationSec] = useState<number | null>(null);

  if (streaming && startRef.current == null) {
    startRef.current = Date.now();
  }

  useEffect(() => {
    if (!streaming && startRef.current != null && durationSec == null) {
      const secs = Math.max(1, Math.round((Date.now() - startRef.current) / 1000));
      setDurationSec(secs);
    }
  }, [streaming, durationSec]);

  useEffect(() => {
    if (userTouchedRef.current) return;
    // Open while thinking streams; collapse the moment it's done so the
    // finished answer leads and the thought tucks into the whisper line.
    setOpen(streaming);
  }, [streaming]);

  if (!text.trim()) return null;

  const label = streaming
    ? "Thinking…"
    : durationSec != null
      ? `Thought for ${durationSec}s`
      : "Thought process";

  return (
    <div className="reasoning-whisper">
      <button
        type="button"
        onClick={() => {
          userTouchedRef.current = true;
          setOpen((v) => !v);
        }}
        className="reasoning-whisper-head"
        title={open ? "Hide reasoning" : "Show reasoning"}
      >
        <span className={`spark ${streaming ? "live" : ""}`} aria-hidden>
          <Sparkles size={12} strokeWidth={1.75} />
        </span>
        <span className={streaming ? "shimmer" : ""}>{label}</span>
        <span className="chev" aria-hidden>
          <Chevron dir={open ? "up" : "down"} />
        </span>
      </button>
      {open && (
        <div className="reasoning-whisper-body reasoning-prose">
          <MarkdownBody source={text} trailingCursor={streaming} />
        </div>
      )}
    </div>
  );
}

/** Tiny inline chevron — own SVG, currentColor, rotates on open. */
function Chevron({ dir }: { dir: "up" | "down" }) {
  return (
    <svg
      width={11}
      height={11}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{
        transform: dir === "up" ? "rotate(180deg)" : undefined,
        transition: "transform var(--motion-fast)",
      }}
      aria-hidden
    >
      <path d="M4 6l4 4 4-4" />
    </svg>
  );
}
