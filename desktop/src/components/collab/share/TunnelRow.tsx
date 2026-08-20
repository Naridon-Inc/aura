// TunnelRow — one shared port, on one line.
//
// The `aura://localhost:3000` form is the headline because it is the only form
// a person is ever asked to read, say aloud or paste. The relay URL underneath
// it is plumbing; showing both would invite someone to share the wrong one, and
// the wrong one is the one that looks like a normal web link.
//
// "Who can reach it" is on the row rather than behind a tooltip. A port you
// forgot you opened is the whole risk this feature carries, and a list of names
// is the fastest way to notice.

import { useState, type JSX } from "react";
import { Check, Copy, Square, Users } from "lucide-react";

import { Button } from "../../ui/button";
import { AsciiSpinner } from "../../ui/ascii-spinner";
import { useCopyToClipboard } from "../../../lib/useCopyToClipboard";
import { relativeAge } from "../../../lib/relativeTime";
import { auraDisplayUrl, type SessionTunnel } from "./shareTypes";

export type TunnelRowProps = {
  tunnel: SessionTunnel;
  /** The people who can reach it — the session's own roster, passed in rather
   *  than stored on the tunnel, because that is what it actually is. */
  reachableBy: string[];
  /** Close it. Whoever had it open loses it immediately — which is stated on
   *  the button's own confirmation line, not discovered afterwards. */
  onStop: (code: string) => Promise<void> | void;
};

export function TunnelRow({
  tunnel,
  reachableBy,
  onStop,
}: TunnelRowProps): JSX.Element {
  const display = auraDisplayUrl(tunnel.port);
  const { copy, copied } = useCopyToClipboard();
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function stop() {
    if (stopping) return;
    setStopping(true);
    setError(null);
    try {
      await onStop(tunnel.code);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStopping(false);
    }
  }

  const reach =
    reachableBy.length === 0
      ? "Nobody else is in the session yet"
      : reachableBy.length <= 3
        ? reachableBy.join(", ")
        : `${reachableBy.slice(0, 2).join(", ")} and ${
            reachableBy.length - 2
          } others`;

  return (
    <li className="flex flex-col gap-1 border-b border-line-soft py-2.5 last:border-b-0">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="flex items-baseline gap-2 truncate">
            <span className="font-mono text-base text-text-1">{display}</span>
            <span className="truncate text-xs text-text-4">{tunnel.label}</span>
          </p>
          <p className="mt-0.5 flex items-center gap-1.5 truncate text-xs text-text-4">
            <Users size={11} className="shrink-0" aria-hidden />
            {reach}
            <span className="text-text-5">
              · open {relativeAge(tunnel.opened_at, { style: "compact" })}
            </span>
          </p>
        </div>

        <Button
          variant="ghost"
          size="icon-sm"
          className="shrink-0"
          aria-label={`Copy ${display}`}
          title={`Copy ${display}`}
          onClick={() => void copy(display)}
        >
          {copied ? <Check size={13} className="text-accent-green" /> : <Copy size={13} />}
        </Button>

        <Button
          variant="subtle"
          size="sm"
          className="shrink-0"
          onClick={() => void stop()}
          disabled={stopping}
        >
          {stopping ? <AsciiSpinner size={11} /> : <Square size={11} />}
          Stop
        </Button>
      </div>

      {error && (
        <p role="alert" className="text-xs leading-snug text-red">
          Couldn&apos;t close it: {error}
        </p>
      )}
    </li>
  );
}
