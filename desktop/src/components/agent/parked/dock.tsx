// The shared chrome for every "your agent is waiting on you" card.
//
// Two different things park an agent and need a human answer:
//   * the destructive-op gate (`AgentGateHost`) — Aura's own validator is
//     unsure about something risky the agent is about to do;
//   * a permission prompt (`PermissionCard`) — claude itself is asking
//     before it uses a tool, routed through our MCP bridge.
//
// They ask different questions, but they are the same *moment* for the
// person using the app: work has stopped, and it will not restart until
// they look. So they dock in the same place, at the same size, with the
// same keymap — and that shape lives here rather than being written twice
// and drifting.
//
// The dock is deliberately NOT a modal. A full-screen scrim in the middle
// of the window read as alarming and got in the way; instead the card
// floats just above the composer the parked agent is waiting on, and the
// rest of the app stays live and clickable behind it.

import {
  useEffect,
  useState,
  type CSSProperties,
  type ReactNode,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import "../../ui/parked-dock.css";

/** Where the card sits: centered on the composer, just above its top edge. */
export type AnchorPos = { left: number; bottom: number } | null;

/**
 * Track the composer's position so the card hovers over the input the agent
 * is parked on. Re-measured on a light interval so it follows the composer
 * as it grows with multi-line input or the window resizes.
 *
 * Returns null when no composer is on screen (terminal-only view, detached
 * window) — callers fall back to bottom-center.
 */
export function useComposerAnchor(): AnchorPos {
  const [pos, setPos] = useState<AnchorPos>(null);
  useEffect(() => {
    let raf = 0;
    const measure = () => {
      const el = document.querySelector<HTMLElement>(".ui-composer, .composer");
      if (!el) {
        setPos((p) => (p === null ? p : null));
        return;
      }
      const r = el.getBoundingClientRect();
      // Off-screen / zero-size (hidden pane) → treat as absent.
      if (r.width === 0 || r.height === 0) {
        setPos((p) => (p === null ? p : null));
        return;
      }
      const left = Math.round(r.left + r.width / 2);
      // Sit 10px above the composer's top edge.
      const bottom = Math.round(Math.max(12, window.innerHeight - r.top + 10));
      setPos((p) =>
        p && p.left === left && p.bottom === bottom ? p : { left, bottom },
      );
    };
    // Measure after layout settles, then keep it fresh cheaply.
    raf = requestAnimationFrame(() => requestAnimationFrame(measure));
    const iv = window.setInterval(measure, 300);
    window.addEventListener("resize", measure);
    return () => {
      cancelAnimationFrame(raf);
      window.clearInterval(iv);
      window.removeEventListener("resize", measure);
    };
  }, []);
  return pos;
}

/**
 * The dock: a full-screen pointer-transparent layer with one card in it,
 * hovering over the composer. The card is the shared permission request;
 * the dock caps its height and keeps the answers pinned to its foot, so they
 * stay reachable however much the card has to say.
 */
export function ParkedShell({
  label,
  tone,
  onKeyDown,
  children,
}: {
  /** Accessible name — the headline of whatever is being asked. */
  label: string;
  /** How loud the card's mark is: a checked risk, a caution, or neither. */
  tone?: "danger" | "warn";
  onKeyDown?: (e: ReactKeyboardEvent) => void;
  children: ReactNode;
}) {
  // One-shot mount transition so the card slides up into place rather than
  // snapping in on top of what the person was reading.
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const anchor = useComposerAnchor();
  const dockStyle: CSSProperties = {
    left: anchor ? anchor.left : "50%",
    bottom: anchor ? anchor.bottom : 24,
    transform: `translateX(-50%) translateY(${shown ? "0px" : "10px"})`,
    opacity: shown ? 1 : 0,
  };

  return (
    <div className="ui-parked-layer" role="presentation">
      <div
        role="alertdialog"
        aria-label={label}
        onKeyDown={onKeyDown}
        style={dockStyle}
        className="ui-parked-dock"
        data-tone={tone}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * The line beside the card's headline: who is asking, and that work has
 * stopped and for how long. That second half is the important one. Someone
 * who walks back to their desk needs to know the agent isn't thinking — it's
 * waiting on them.
 */
export function ParkedLine({ lead, since }: {
  /** "Claude · New Git", or how risky the gate judged it — only when it
   *  says something the headline doesn't. */
  lead?: string | null;
  /** Unix seconds the agent was parked at. */
  since: number;
}) {
  return (
    <span className="ui-parked-line">
      {lead ? `${lead} · ` : ""}
      Waiting for you
      <Elapsed since={since} />
    </span>
  );
}

/** "2 more agents are waiting after this one" — answered oldest-first, so
 *  the person knows answering this card isn't the end of it. */
export function ParkedQueue({ pending }: { pending: number }) {
  if (pending <= 0) return null;
  return (
    <div className="ui-parked-queue">
      {pending === 1
        ? "1 more agent is waiting after this one"
        : `${pending} more agents are waiting after this one`}
    </div>
  );
}

/** Live " · Xs" ticker from a unix-seconds timestamp. */
export function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);
  const secs = Math.max(0, now - since);
  if (secs < 1) return null;
  const label = secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`;
  return <span className="ui-parked-elapsed"> · {label}</span>;
}
