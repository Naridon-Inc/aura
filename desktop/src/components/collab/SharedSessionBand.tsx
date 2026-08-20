// The one line a terminal grows when somebody else is in it.
//
// An agent surface has no header — that was a deliberate removal, and this
// does not put it back. It appears only while the session is shared, and it
// carries exactly the three facts that change what typing here means:
//
//  - **Who is in here.** Without it, the difference between working alone and
//    working while two people read every keystroke is invisible.
//  - **Whether you may drive.** A watcher's keystrokes never reach this PTY.
//    That has to be visible where the typing happens, not only in the share
//    panel they opened once.
//  - **Whether the plane is actually up.** A dropped socket looks exactly like
//    a quiet room, and the two are opposite situations.
//
// It renders nothing at all when the session isn't shared, which is the
// ordinary case. A band that is always there, saying "1 participant: you", is
// a row of chrome charging rent on every terminal in the app.

import type { JSX } from "react";

import {
  useMyAccess,
  useSessionConnection,
  useSessionForAgent,
  useSessionLive,
} from "../../lib/sessionLiveStore";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { ParticipantsStrip } from "./ParticipantsStrip";
import { SessionTypingLine } from "./SessionTypingLine";

export type SharedSessionBandProps = {
  /** The pane's own PTY id. The external session is resolved from it, so a
   *  caller never has to know the plane exists. */
  agentSessionId: string;
};

export function SharedSessionBand({
  agentSessionId,
}: SharedSessionBandProps): JSX.Element | null {
  const sessionId = useSessionForAgent(agentSessionId);
  const live = useSessionLive(sessionId);
  const connection = useSessionConnection(sessionId);
  const access = useMyAccess(sessionId);

  // Not shared. Nothing to say, and no space taken saying it.
  if (!sessionId) return null;

  const others = live.participants.filter((p) => p.id !== live.you?.id);
  const typing = live.participants.filter((p) => live.typing.has(p.id));

  return (
    <div className="flex items-center gap-2 h-7 px-2 border-b border-line shrink-0">
      <ParticipantsStrip
        participants={live.participants}
        youId={live.you?.id ?? null}
        max={5}
        loading={connection === "connecting" && live.participants.length === 0}
        error={connection === "error" ? (live.lastError ?? "Lost this session") : null}
      />

      {typing.length > 0 && (
        <SessionTypingLine
          typing={typing}
          working={[]}
          participants={live.participants}
          youId={live.you?.id ?? null}
        />
      )}

      <div className="flex-1" />

      {connection === "reconnecting" && (
        <span className="flex items-center gap-1.5 text-2xs text-text-3">
          <AsciiSpinner size={11} />
          Reconnecting
        </span>
      )}

      {/* Said where the typing happens, because that is where being wrong
          about it costs something. */}
      {access === "watch" && (
        <span className="text-2xs text-text-3 whitespace-nowrap">
          You're watching. Only {live.participants.find((p) => p.role === "host")?.name ?? "the host"} can type here
        </span>
      )}

      {/* Everyone else has left, but the session is still shared: the link
          still works and somebody can walk back in. */}
      {access !== "watch" && others.length === 0 && connection === "live" && (
        <span className="text-2xs text-text-4 whitespace-nowrap">Shared · nobody else here yet</span>
      )}
    </div>
  );
}
