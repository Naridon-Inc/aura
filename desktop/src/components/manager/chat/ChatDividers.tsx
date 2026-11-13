import { useState } from "react";
import { Check, Clock } from "lucide-react";
import type { ChatTurn } from "../../../lib/api";
import { AgentIcon } from "../../agent/AgentIcon";
import { SessionBrainsDetail } from "./SessionBrainsDetail";
import { humanizeBrainId, brainAgentId } from "./StatusLine";

// "12m later" · "about 1h later" · "3h later" · "2d later". `at` is epoch
// seconds, so the gap is already in seconds. Kept deliberately coarse — this
// is a human seam marker, not a stopwatch.
function humanizeGap(seconds: number): string {
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m}m later`;
  const h = Math.floor(seconds / 3600);
  if (h < 24) {
    const rem = Math.round((seconds - h * 3600) / 60);
    if (h === 1 && rem < 20) return "about an hour later";
    return rem >= 30 ? `about ${h + 1}h later` : `${h}h later`;
  }
  const d = Math.round(seconds / 86400);
  return d === 1 ? "a day later" : `${d}d later`;
}

// Milestone divider — a centered rule with the caption inset, marking a
// major thing finished (a task done, a wave shipped). Antigravity adds one
// of these between phases of work so the timeline reads as discrete
// completed chapters rather than an unbroken scroll. A small check leads
// the caption to reinforce "this finished".
export function MilestoneDivider({ text }: { text: string }) {
  return (
    <div className="aura-milestone" role="separator" aria-label={text}>
      <span className="aura-milestone-rule" aria-hidden />
      <span className="aura-milestone-label">
        <Check size={12} strokeWidth={2.5} />
        {text}
      </span>
      <span className="aura-milestone-rule" aria-hidden />
    </div>
  );
}

// Brain-handoff divider — drawn where the conversation carried over to a
// different brain mid-thread (Claude → Gemini → Kimi …). The backend rebuilds
// the full transcript for whichever brain runs the next turn
// (`chat_to_messages`), so the switch is genuinely seamless — this marker just
// makes that legible: "you swapped models here, and the thread came with it",
// reassuring the user (who switches when a provider's limits hit) that nothing
// was dropped. Carries the new brain's own logo so the handoff is scannable.
export function BrainHandoffDivider({
  brain,
  chat,
}: {
  brain: string;
  chat: ChatTurn[];
}) {
  const [open, setOpen] = useState(false);
  const label = humanizeBrainId(brain);
  return (
    <>
      <div
        className="aura-milestone"
        role="separator"
        aria-label={`Continued on ${label}`}
      >
        <span className="aura-milestone-rule" aria-hidden />
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="aura-milestone-label"
          aria-expanded={open}
          title={`The conversation carried over to ${label}. The full thread came with it. Click for session details.`}
          style={{
            background: "transparent",
            border: 0,
            cursor: "pointer",
            font: "inherit",
          }}
        >
          <AgentIcon agentId={brainAgentId(brain)} size={12} />
          Continued on {label}
          <ChevronGlyph open={open} />
        </button>
        <span className="aura-milestone-rule" aria-hidden />
      </div>
      {open && <SessionBrainsDetail chat={chat} />}
    </>
  );
}

/** Tiny disclosure chevron for the handoff divider — currentColor so it
 *  inherits the divider's green ink; rotates when the session details open. */
function ChevronGlyph({ open }: { open: boolean }) {
  return (
    <svg
      width={10}
      height={10}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{
        transform: open ? "rotate(180deg)" : undefined,
        transition: "transform var(--motion-fast)",
      }}
      aria-hidden
    >
      <path d="M4 6l4 4 4-4" />
    </svg>
  );
}

// Time-gap divider — a wiggly rule flanking a relative-time caption, drawn
// where the conversation jumped forward in wall-clock time (a session
// cancelled / closed an hour back, then resumed). The wave (vs. the
// milestone's straight rule) reads as "time passed here", not "a thing
// finished". The rule is a tiling SVG sine wave faded at its inner edges.
export function TimeGapDivider({ seconds }: { seconds: number }) {
  const label = humanizeGap(seconds);
  return (
    <div className="aura-timegap" role="separator" aria-label={label}>
      <span className="aura-timegap-rule" aria-hidden />
      <span className="aura-timegap-label">
        <Clock size={11} strokeWidth={2} />
        {label}
      </span>
      <span className="aura-timegap-rule" aria-hidden />
    </div>
  );
}
