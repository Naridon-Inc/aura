// YourAccessBanner — the line that tells a guest what they can do here, sitting
// where they'd otherwise be staring at a composer that won't take a keystroke.
//
// This exists because of a specific, avoidable moment: you join a colleague's
// session, you type, nothing happens, and you conclude the product is broken.
// A disabled input explains nothing. So the level a person has been given is
// stated in words, next to the thing it disables, at all times — not in a
// tooltip, not in a settings pane, not only at the moment it changes.
//
// It is a strip, not a card. It lives inside a surface that already has edges.

import { useState, type JSX } from "react";
import { CircleAlert, Hand, MonitorSmartphone } from "lucide-react";

import { Button } from "../../ui/button";
import { AsciiSpinner } from "../../ui/ascii-spinner";
import { AccessGlyph } from "./AccessLevelMenu";
import { ACCESS_META, type AccessLevel } from "./shareTypes";
import "../../ui/session-room.css";

export type YourAccessBannerProps = {
  level: AccessLevel;
  /** Whose machine this is running on — the guest's instructions land there,
   *  and saying so up front is the difference between "shared screen" and
   *  "your words reach someone else's computer". */
  hostName: string;
  hostMachine: string;
  /** From `{"type":"host","online":false}`. The session stays open and what you
   *  send is kept — it just doesn't reach a running agent until they're back.
   *  That is worth saying, because silence looks identical to failure. */
  hostOnline: boolean;
  /** Ask the host for the wheel. Omit it and no ask is offered — which is the
   *  right shape when the caller has no channel to carry the request. */
  onRequestDrive?: () => Promise<void> | void;
  /** The host has already been asked and hasn't answered yet. */
  driveRequested?: boolean;
};

export function YourAccessBanner({
  level,
  hostName,
  hostMachine,
  hostOnline,
  onRequestDrive,
  driveRequested = false,
}: YourAccessBannerProps): JSX.Element {
  const [asking, setAsking] = useState(false);
  const [askError, setAskError] = useState<string | null>(null);
  const meta = ACCESS_META[level];

  async function ask() {
    if (!onRequestDrive || asking) return;
    setAsking(true);
    setAskError(null);
    try {
      await onRequestDrive();
    } catch (e) {
      setAskError(e instanceof Error ? e.message : String(e));
    } finally {
      setAsking(false);
    }
  }

  return (
    <div className="ui-session-access" role="note" data-level={level}>
      <AccessGlyph level={level} size={14} />

      <div>
        <p>
          <strong>{meta.label}.</strong> {meta.guestBlurb}
        </p>

        {/* Where the words actually go. A guest who can drive is typing into
            someone else's computer, and that should never be a surprise. */}
        {level === "drive" && (
          <small>
            <MonitorSmartphone aria-hidden />
            What you send runs on {hostName}&apos;s machine ({hostMachine}), not on yours.
          </small>
        )}

        {!hostOnline && (
          <small data-tone="warning">
            <CircleAlert aria-hidden />
            {hostName} has stepped away, so nothing is running right now. Anything you send is
            kept and handed over the moment they&apos;re back.
          </small>
        )}

        {driveRequested && level === "watch" && !askError && (
          <small>
            {hostName} has been asked. This line changes on its own if they say yes. Nothing to
            refresh.
          </small>
        )}

        {askError && (
          <small role="alert" data-tone="error">
            Couldn&apos;t pass that on: {askError}
          </small>
        )}
      </div>

      {level === "watch" && onRequestDrive && (
        <Button
          variant="outline"
          size="xs"
          onClick={() => void ask()}
          disabled={asking || driveRequested}
        >
          {asking ? <AsciiSpinner size={11} /> : <Hand />}
          {driveRequested ? "Asked" : "Ask to drive"}
        </Button>
      )}
    </div>
  );
}
