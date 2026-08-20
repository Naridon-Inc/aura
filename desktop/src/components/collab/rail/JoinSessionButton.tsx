// How you get into someone else's session from the rail.
//
// Opening a session you are already in and entering one you aren't are two
// different acts, and the row can't say both with one click: clicking the row
// itself reads as "show me", so joining — which announces you to everyone in
// there and puts your name on the participant list — gets its own control and
// its own word.
//
// It says "Watch" instead of "Join" for either of two reasons, and both are
// about not promising something the room won't give you:
//
//  - the session only grants `watch`, so you could follow it and nothing more;
//  - the host desktop is away, so there is nothing running the agent and
//    anything you type sits until it comes back.
//
// "Join" on a room that turns out to be read-only is the kind of small lie that
// makes people stop trusting a button.
//
// Hover-revealed, focus-persistent: the rail stays quiet at rest, and the
// control is still reachable by keyboard because opacity doesn't remove it
// from the tab order.

import { useState, type MouseEvent } from "react";

import { AsciiSpinner } from "../../ui/ascii-spinner";
import type { RailAccess } from "./railModel";

export type JoinSessionButtonProps = {
  sessionId: string;
  /** Whose session it is — named in the hover text so the control says what
   *  room you'd be walking into. */
  ownerName: string;
  /** Is the desktop that runs the agent connected? */
  hostOnline: boolean;
  /** What you'd get by joining, when the session has said. Undefined falls
   *  back to what the host's presence implies. */
  access?: RailAccess | null;
  /** Enter the session. May be async; the control owns its own busy + failed
   *  states so no caller has to thread them back down. */
  onJoin: (sessionId: string) => void | Promise<void>;
};

export function JoinSessionButton({
  sessionId,
  ownerName,
  hostOnline,
  access,
  onJoin,
}: JoinSessionButtonProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canDrive = hostOnline && access !== "watch";
  const label = error ? "Try again" : canDrive ? "Join" : "Watch";
  const hover = error
    ? `Couldn’t get you in. ${error}`
    : canDrive
      ? `Join ${ownerName}’s session. You’ll show up in there and can take a turn`
      : access === "watch"
        ? `Follow along. ${ownerName} has this set so visitors can watch, not take a turn.`
        : `Follow along. ${ownerName} isn’t running it right now, so anything you say waits for them.`;

  const go = async (e: MouseEvent<HTMLButtonElement>) => {
    // The row underneath opens the session read-only; this button means
    // something else, so it must not do both.
    e.stopPropagation();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onJoin(sessionId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      className={[
        "flex-none inline-flex items-center gap-1 rounded px-1.5 h-[17px]",
        "text-2xs font-medium leading-none transition-opacity",
        "opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100",
        error ? "text-red" : "text-accent",
      ].join(" ")}
      style={{
        background: error
          ? "color-mix(in srgb, var(--color-red) 12%, transparent)"
          : "color-mix(in srgb, var(--color-accent) 13%, transparent)",
      }}
      title={hover}
      aria-label={hover}
      onClick={(e) => void go(e)}
      disabled={busy}
    >
      {busy ? <AsciiSpinner size={10} /> : null}
      <span>{busy ? "Joining" : label}</span>
    </button>
  );
}
