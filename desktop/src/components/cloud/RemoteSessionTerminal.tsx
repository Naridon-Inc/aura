// A terminal sitting down in front of a session that is already running.
//
// This is a component rather than three lines inside `RemoteWorkspace` because
// the boot line is now ASKED for. It used to be built here — three fields off
// the machine row, an `ssh` line assembled in TypeScript — which was instant
// and which was also a second transport to a box, reached by a route that knew
// nothing about connection multiplexing, agreed quoting, or whatever a managed
// place will need instead of ssh. `Place` answers that question now, and the
// answer arrives over IPC.
//
// So there is a moment before the terminal. It is short — nothing is dialled to
// produce the line, both arms of `Place::boot` are a string — but it is real,
// and it has to be drawn honestly: waiting says it's opening, and a place that
// can't be named says so in words instead of booting a terminal on a fallback
// line of somebody's own. A fallback line is how this got two transports the
// first time.

import { useEffect, useState } from "react";

import { askBoot, openAttach, type Place } from "../../lib/place";
import { Terminal } from "../Terminal";
import { AsciiSpinner } from "../ui/ascii-spinner";

export function RemoteSessionTerminal({
  place,
  session,
  readOnly,
  instanceId,
  cwd,
  repoRoot,
}: {
  place: Place;
  /** The session's own name, as the machine reported it. Never invented here —
   *  that is what lets the CLI, yesterday's laptop and a teammate all show up
   *  in the same list. */
  session: string;
  /** Watch without taking the keyboard. */
  readOnly: boolean;
  instanceId: string;
  /** This laptop's directory: where the local pty starts before it is replaced
   *  by the session. Deliberately not the place's — see `RemoteWorkspace`. */
  cwd?: string;
  repoRoot?: string;
}) {
  const [boot, setBoot] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setBoot(null);
    setError(null);
    askBoot(place, openAttach(session, readOnly))
      .then((line) => {
        if (alive) setBoot(line);
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, [place.machineId, place.project.root, session, readOnly]);

  if (error) {
    return (
      <div className="grid h-full place-items-center px-8 text-center text-sm leading-relaxed text-text-5">
        <div className="max-w-[360px]">
          Couldn't open a terminal on this machine.
          <div className="mt-1.5 text-text-4">{error}</div>
        </div>
      </div>
    );
  }

  if (boot === null) {
    return (
      <div className="grid h-full place-items-center text-sm text-text-5">
        <span className="flex items-center gap-2">
          <AsciiSpinner size={13} />
          Opening {session}…
        </span>
      </div>
    );
  }

  return (
    <Terminal
      instanceId={instanceId}
      cwd={cwd}
      repoRoot={repoRoot}
      bootCommand={boot}
    />
  );
}
