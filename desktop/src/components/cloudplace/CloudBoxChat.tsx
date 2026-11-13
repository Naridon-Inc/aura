// The chat of a cloud workspace that runs on one of the org's machines.
//
// The agent runs over there, in the workspace's worktree, under tmux. This
// laptop connects to it and shows it in `ManagerSurface`, the same chat view
// local work uses, so streaming, tool calls, permissions, cancel and the
// composer are the ones people already know. Each finished turn is copied onto
// the workspace's log, which is how teammates who open it see the work.
//
// Closing the laptop leaves the agent running. Opening the workspace again
// connects to it where it is.
//
// A message that opens with teammates' @logins is for them, not the agent:
// it goes onto the shared log and the chat notes that the agent didn't get it.
// The team is read apart from the workspace, so whoever it holds now is told
// to the chat each time it changes, not only when the chat connects; and the
// chat's `@` list offers them, so the login typed is the one that matches.

import { useCallback, useEffect, useRef, useState } from "react";

import { api } from "../../lib/api";
import {
  boxChat,
  brainFor,
  catchUp,
  heldOnLog,
  sendFirstTurn,
  sessionFor,
  takeFirstPrompt,
} from "../../lib/cloudBoxChat";
import { setCloudNotice } from "../../lib/cloudPlace";
import { setChatTeammates } from "../../lib/chatTeammates";
import { cloudApi, type CloudWorkspacePlace } from "../../lib/cloudWorkspacesApi";
import { saveSessionBrain } from "../../lib/managerSessionPrefs";
import { ManagerSurface } from "../manager/ManagerSurface";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { Button } from "../ui/button";
import type { ComposerSuggestion } from "../ui/composerSuggestions";

function textOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

type View =
  | { kind: "connecting" }
  | { kind: "open"; sessionId: string }
  | { kind: "unfiled" }
  | { kind: "failed"; message: string };

export function CloudBoxChat({
  workspaceId,
  place,
  title,
  authorName,
  people = [],
  mentions = [],
  restarts = 0,
  onFailed,
}: {
  workspaceId: string;
  place: CloudWorkspacePlace;
  title: string;
  /** How you are shown on the turns you send. */
  authorName: string | null;
  /** Your teammates' GitHub logins, who a message can be addressed to. */
  people?: readonly string[];
  /** The rows the chat's `@` list offers for those teammates. */
  mentions?: readonly ComposerSuggestion[];
  /** Counts the Restarts asked for from the workspace's details: each one
   *  lets go of the chat here and connects to it again. */
  restarts?: number;
  /** Told why the chat couldn't be opened, instead of this view saying it:
   *  the workspace then shows the chat the way teammates read it. */
  onFailed?: (message: string) => void;
}) {
  const [view, setView] = useState<View>({ kind: "connecting" });
  // The row is read again every few seconds; only a different workspace or a
  // different machine is a reason to connect again.
  const latest = useRef({ place, title, authorName, people, onFailed });
  latest.current = { place, title, authorName, people, onFailed };

  const connect = useCallback(
    async (again: boolean) => {
      setView({ kind: "connecting" });
      const { place, title, authorName, people } = latest.current;
      try {
        if (again) await boxChat.release(workspaceId).catch(() => false);
        const attached = await boxChat.attach(workspaceId, place, authorName, people);
        if (!attached.repoRoot) {
          setView({ kind: "unfiled" });
          return;
        }
        const { sessionId, resumed } = await sessionFor(
          workspaceId,
          { repoRoot: attached.repoRoot, machineId: attached.machineId, title, brain: attached.provider },
          {
            store: localStorage,
            alive: (id) =>
              api
                .managerStatus(id)
                .then(() => true)
                .catch(() => false),
            start: (root, objective, machine, brain) => api.managerChatStart(root, objective, machine, undefined, brain),
          },
        );
        // Before the view mounts: it reads the session's brain once, then.
        saveSessionBrain(sessionId, brainFor(attached.provider, place.engine, place.machine));
        // Recorded on the session too, which keeps the chat on this machine:
        // a switch or a turn to any other brain is refused from here on. A new
        // session was born with it; one an earlier version started gets it
        // here, which also stops the desktop listing it in the cloud as a
        // session of its own. The view pins it either way, so a failure here
        // doesn't stop the chat.
        await api.managerSetBrainOverride(sessionId, attached.provider).catch(() => undefined);
        // A laptop new to the chat gets the conversation so far, and an answer
        // that finished while no laptop was attached is filled in.
        // Messages sent while no computer ran the workspace are about to be
        // the chat's first turn, so they aren't filed twice.
        const onLog = heldOnLog(localStorage, workspaceId);
        await catchUp(
          { workspaceId, place, sessionId, resumed, provider: attached.provider },
          {
            messages: (id) => cloudApi.messages(id).then((rows) => rows.filter((r) => !onLog.has(r.id))),
            ...boxChat,
          },
        );
        setView({ kind: "open", sessionId });
        const first = takeFirstPrompt(localStorage, workspaceId);
        if (first) {
          sendFirstTurn(sessionId, first, attached.provider).catch((e) =>
            setCloudNotice(`Couldn’t send your first message to ${place.machine}: ${textOf(e)}`),
          );
        }
      } catch (e) {
        const message = textOf(e);
        setView({ kind: "failed", message });
        latest.current.onFailed?.(message);
      }
    },
    [workspaceId],
  );

  useEffect(() => {
    void connect(false);
  }, [connect, place.machine, place.remote_root]);
  // Once per Restart asked for, not again when the chat it restarts changes.
  const restarted = useRef(restarts);
  useEffect(() => {
    if (restarts === restarted.current) return;
    restarted.current = restarts;
    void connect(true);
  }, [connect, restarts]);

  // Who the chat can address, whenever that changes: the logins can arrive
  // after it connected, and a teammate can join while it is open.
  const team = people.join("\n");
  useEffect(() => {
    boxChat.people(workspaceId, authorName, team ? team.split("\n") : []).catch(() => undefined);
  }, [workspaceId, authorName, team]);

  const openSession = view.kind === "open" ? view.sessionId : null;
  useEffect(() => {
    if (!openSession) return;
    setChatTeammates(openSession, mentions);
  }, [openSession, mentions]);
  useEffect(() => {
    if (!openSession) return;
    return () => setChatTeammates(openSession, []);
  }, [openSession]);

  if (view.kind === "open") {
    return (
      <ManagerSurface
        key={view.sessionId}
        sessionId={view.sessionId}
        tabChrome={false}
      />
    );
  }

  return (
    <div className="grid h-full place-items-center px-8">
      <div className="flex max-w-md flex-col items-center gap-2 text-center">
        {view.kind === "connecting" ? (
          <span className="flex items-center gap-2 text-sm text-text-5">
            <AsciiSpinner /> Connecting to {place.machine}…
          </span>
        ) : view.kind === "unfiled" ? (
          <>
            <p className="text-sm text-text-2">
              This laptop doesn’t have a copy of the project {place.machine} is working on.
            </p>
            <p className="text-xs text-text-5">
              The chat is kept on this laptop, under the project it came from. Open the project
              here, or add {place.machine} from inside it, and the chat opens.
            </p>
          </>
        ) : (
          <>
            <p className="text-sm text-text-2">Couldn’t connect to {place.machine}.</p>
            <p className="font-mono text-xs text-text-5">{view.message}</p>
            <Button variant="accentSoft" onClick={() => void connect(true)}>
              Reconnect
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
