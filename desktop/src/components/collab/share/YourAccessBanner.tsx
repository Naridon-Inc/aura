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
    <div className="flex flex-col gap-1.5">
      <div className="flex items-start gap-2.5 border-t border-line-soft pt-2.5">
        <AccessGlyph
          level={level}
          size={14}
          className={`mt-0.5 shrink-0 ${
            level === "drive" ? "text-accent" : "text-text-3"
          }`}
        />

        <div className="min-w-0 flex-1 text-sm leading-snug text-text-3">
          <span className="font-medium text-text-2">{meta.label}.</span>{" "}
          {meta.guestBlurb}
        </div>

        {level === "watch" && onRequestDrive && (
          <Button
            variant="subtle"
            size="xs"
            className="shrink-0"
            onClick={() => void ask()}
            disabled={asking || driveRequested}
          >
            {asking ? <AsciiSpinner size={11} /> : <Hand size={12} />}
            {driveRequested ? "Asked" : "Ask to drive"}
          </Button>
        )}
      </div>

      {/* Where the words actually go. A guest who can drive is typing into
          someone else's computer, and that should never be a surprise. */}
      {level === "drive" && (
        <p className="flex items-start gap-1.5 pl-[26px] text-xs leading-snug text-text-4">
          <MonitorSmartphone size={12} className="mt-0.5 shrink-0" aria-hidden />
          What you send runs on {hostName}&apos;s machine ({hostMachine}), not
          on yours.
        </p>
      )}

      {!hostOnline && (
        <p className="flex items-start gap-1.5 pl-[26px] text-xs leading-snug text-amber">
          <CircleAlert size={12} className="mt-0.5 shrink-0" aria-hidden />
          {hostName} has stepped away, so nothing is running right now. Anything
          you send is kept and handed over the moment they&apos;re back.
        </p>
      )}

      {driveRequested && level === "watch" && !askError && (
        <p className="pl-[26px] text-xs leading-snug text-text-4">
          {hostName} has been asked. This line changes on its own if they say
          yes. Nothing to refresh.
        </p>
      )}

      {askError && (
        <p role="alert" className="pl-[26px] text-xs leading-snug text-red">
          Couldn&apos;t pass that on: {askError}
        </p>
      )}
    </div>
  );
}
