// One port in the Ports popover.
//
// A row says three things and offers three verbs. What is listening — the
// port and who owns it; where it is on this Mac, if it has been brought over;
// and, when the port stopped listening over there but the forward is still
// held, that too. The verbs are "Open on your Mac", "Stop" and "Share", and a
// row only shows the ones that make sense for its state: nothing to stop on a
// port that was never brought over, nothing to share until it has been.

//
// The row is the library's forwarded-port row: the port and where it answers
// on the left, a ghost "Open" and the icon verbs on the right.

import { ArrowUpRight, Share2, Square } from "lucide-react";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { Button } from "../ui/button";

/** A row as the popover assembles it — a listening port, a held forward, or
 *  both at once. */
export type PortLine = {
  port: number;
  /** The process over there, when the place could say. */
  process: string | null;
  /** Where it answers on this Mac, or null until it has been forwarded. */
  localPort: number | null;
  url: string | null;
  /** False when the forward is held but nothing listens over there any more. */
  listening: boolean;
  /** Brought over by "Forward new ports automatically" on this refresh. */
  auto: boolean;
};

type Props = {
  line: PortLine;
  /** Which verb is in flight on this row, if any. */
  busy: "open" | "stop" | "share" | null;
  onOpen: () => void;
  onStop: () => void;
  onShare: () => void;
};

export function PortRow({ line, busy, onOpen, onStop, onShare }: Props) {
  const forwarded = line.localPort !== null;
  // Where it answers here is on the port itself (":5173 → localhost:5174"),
  // as the library's forwarded-port row spells it; the words say which side.
  const where = forwarded ? "on your Mac" : line.listening ? "on the place" : "";
  const owner = line.process ? line.process : null;
  const note = !line.listening
    ? "not listening there any more"
    : line.auto
      ? "brought over automatically"
      : null;

  const detail = [owner, where, note].filter(Boolean).join(" · ");

  return (
    <div className="ui-cloud-port ui-port-row" data-listening={line.listening}>
      <div>
        <code>
          :{line.port}
          {forwarded && ` → localhost:${line.localPort}`}
        </code>
        {detail && <small>{detail}</small>}
      </div>
      {busy ? (
        <span className="ui-port-busy">
          <AsciiSpinner size={11} />
        </span>
      ) : (
        <>
          <Button
            size="xs"
            variant="ghost"
            title={forwarded ? "Open on your Mac" : "Bring it to your Mac and open it"}
            aria-label={
              forwarded
                ? `Open port ${line.port} on your Mac`
                : `Bring port ${line.port} to your Mac and open it`
            }
            onClick={onOpen}
          >
            Open <ArrowUpRight />
          </Button>
          {forwarded && (
            <Button
              size="iconXs"
              variant="ghost"
              aria-label={`Share port ${line.port} with a live session`}
              title="Share this port with a live session"
              onClick={onShare}
            >
              <Share2 />
            </Button>
          )}
          {forwarded && (
            <Button
              size="iconXs"
              variant="ghost"
              aria-label={`Stop forwarding port ${line.port}`}
              title="Stop forwarding"
              onClick={onStop}
            >
              <Square />
            </Button>
          )}
        </>
      )}
    </div>
  );
}
