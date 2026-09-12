// One port in the Ports popover.
//
// A row says three things and offers three verbs. What is listening — the
// port and who owns it; where it is on this Mac, if it has been brought over;
// and, when the port stopped listening over there but the forward is still
// held, that too. The verbs are "Open on your Mac", "Stop" and "Share", and a
// row only shows the ones that make sense for its state: nothing to stop on a
// port that was never brought over, nothing to share until it has been.

import { ExternalLink, Share2, Square } from "lucide-react";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { MENU_ROW } from "../ui/menuSurface";

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
  const moved = forwarded && line.localPort !== line.port;
  const where = forwarded
    ? moved
      ? `on your Mac at localhost:${line.localPort}`
      : "on your Mac"
    : line.listening
      ? "on the place"
      : "";
  const owner = line.process ? line.process : null;
  const note = !line.listening
    ? "not listening there any more"
    : line.auto
      ? "brought over automatically"
      : null;

  return (
    <div className={`${MENU_ROW} !cursor-default gap-2 px-2.5 py-1`}>
      <div className="min-w-0 flex-1 leading-tight">
        <div className="flex items-baseline gap-1.5 text-xs">
          <span className="font-mono text-text-1">:{line.port}</span>
          {owner && <span className="truncate text-text-3">{owner}</span>}
        </div>
        <div className="truncate text-[10px] text-text-5">
          {where}
          {where && note ? " · " : ""}
          {note}
        </div>
      </div>
      <div className="flex flex-shrink-0 items-center gap-0.5">
        {busy ? (
          <span className="grid h-5 w-5 place-items-center text-text-4">
            <AsciiSpinner size={11} />
          </span>
        ) : (
          <>
            <button
              type="button"
              title={forwarded ? "Open on your Mac" : "Bring it to your Mac and open it"}
              onClick={onOpen}
              className="flex h-5 items-center gap-1 rounded px-1.5 text-[11px] text-accent transition-colors hover:bg-state-hover"
            >
              <ExternalLink className="h-3 w-3" />
              Open on your Mac
            </button>
            {forwarded && (
              <button
                type="button"
                title="Share this port with a live session"
                onClick={onShare}
                className="grid h-5 w-5 place-items-center rounded text-text-4 transition-colors hover:bg-state-hover hover:text-text-2"
              >
                <Share2 className="h-3 w-3" />
              </button>
            )}
            {forwarded && (
              <button
                type="button"
                title="Stop forwarding"
                onClick={onStop}
                className="grid h-5 w-5 place-items-center rounded text-text-4 transition-colors hover:bg-state-hover hover:text-text-2"
              >
                <Square className="h-2.5 w-2.5" />
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
