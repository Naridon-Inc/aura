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
//
// The pane also carries the same furniture a local terminal does — toolbar,
// find widget, ⌘F/⌘K/⌘A — because it is the same engine underneath and the
// same work in front of it. See `RemoteTerminalToolbar` for what is here that
// a local pane has no need of.

import { useCallback, useEffect, useState } from "react";

import type { BoxSession } from "../../lib/api";
import { askBoot, openAttach, type Place } from "../../lib/place";
import {
  Terminal,
  clearTerminalSession,
  copyTerminalSelection,
  pasteIntoTerminal,
  selectAllTerminal,
} from "../Terminal";
import { TerminalFindWidget } from "../terminal/TerminalFindWidget";
import { AsciiSpinner } from "../ui/ascii-spinner";
import {
  RemoteTerminalToolbar,
  type RemoteSplitOffer,
} from "./RemoteTerminalToolbar";
import { SessionCatchUp } from "./SessionCatchUp";

export function RemoteSessionTerminal({
  place,
  session,
  readOnly,
  instanceId,
  split,
  cwd,
  repoRoot,
  onCloseView,
  onToggleReadOnly,
}: {
  place: Place;
  /** The session as the machine reported it. Never invented here — that is
   *  what lets the CLI, yesterday's laptop and a teammate all show up in the
   *  same list. */
  session: BoxSession;
  /** Watch without taking the keyboard. */
  readOnly: boolean;
  instanceId: string;
  /** What this pane can be shown beside. Omitted where the surface has no
   *  second pane to offer. */
  split?: RemoteSplitOffer;
  /** This laptop's directory: where the local pty starts before it is replaced
   *  by the session. Deliberately not the place's — see `RemoteWorkspace`. */
  cwd?: string;
  repoRoot?: string;
  /** Close this view. The session keeps running on the box. */
  onCloseView: () => void;
  /** Re-join the same session the other way round — take the keyboard, or give
   *  it back. Omitted where the workspace cannot offer that. */
  onToggleReadOnly?: () => void;
}) {
  // The line is held with the ask it answered. One instance can be handed a
  // different session (a tab switch re-renders the same body), and on that
  // first render the old line is still in state: passed through, the new
  // tab's terminal would open on the old session — with the keyboard, even
  // when the new tab was opened to watch. A line for another ask is no line.
  const ask = `${place.machineId ?? ""}\0${place.project.root}\0${session.name}\0${readOnly ? "r" : "w"}`;
  const [answered, setAnswered] = useState<{ ask: string; line: string } | null>(null);
  const boot = answered?.ask === ask ? answered.line : null;
  const [error, setError] = useState<string | null>(null);
  const [findOpen, setFindOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    setAnswered(null);
    setError(null);
    askBoot(place, openAttach(session.name, readOnly))
      .then((line) => {
        if (alive) setAnswered({ ask, line });
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, [place.machineId, place.project.root, session.name, readOnly]);

  // The pane's own shortcuts, taken on the way down through this subtree rather
  // than from a window listener: a remote workspace can be one of several
  // things on screen, and the terminal that gets ⌘F has to be the one the
  // keystroke happened in.
  //
  // ⌘ on macOS, Ctrl+Shift elsewhere — never bare Ctrl, which belongs to
  // readline (Ctrl+F forward-char, Ctrl+K kill-line, Ctrl+A beginning-of-line).
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!e.metaKey && !(e.ctrlKey && e.shiftKey)) return;
      const key = e.key.toLowerCase();
      if (key === "f") {
        e.preventDefault();
        setFindOpen(true);
      } else if (key === "k") {
        e.preventDefault();
        clearTerminalSession(instanceId);
      } else if (key === "a") {
        e.preventDefault();
        selectAllTerminal(instanceId);
      }
    },
    [instanceId],
  );

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
          Opening {session.name}…
        </span>
      </div>
    );
  }

  // The terminal shows the session from the moment you sat down. What it did
  // before that — the part a person coming back actually wants — is read off
  // the machine and shown above it, when it has been long enough to matter
  // (AURA-1308). A machine id is what the capture is keyed by; a session on
  // this laptop is watched live and has nothing to catch up on.
  return (
    <div className="flex h-full min-h-0 flex-col" onKeyDown={onKeyDown}>
      <RemoteTerminalToolbar
        session={session}
        readOnly={readOnly}
        split={split}
        onFind={() => setFindOpen(true)}
        onClear={() => clearTerminalSession(instanceId)}
        onCopy={() => void copyTerminalSelection(instanceId)}
        onPaste={() => void pasteIntoTerminal(instanceId)}
        onSelectAll={() => selectAllTerminal(instanceId)}
        onToggleReadOnly={onToggleReadOnly}
        onCloseView={onCloseView}
      />
      {place.machineId && (
        <SessionCatchUp
          key={`${place.machineId}:${session.name}`}
          machineId={place.machineId}
          session={session.name}
        />
      )}
      <div className="relative min-h-0 flex-1">
        <Terminal
          instanceId={instanceId}
          cwd={cwd}
          repoRoot={repoRoot}
          bootCommand={boot}
        />
        {findOpen && (
          <TerminalFindWidget termId={instanceId} onClose={() => setFindOpen(false)} />
        )}
      </div>
    </div>
  );
}
