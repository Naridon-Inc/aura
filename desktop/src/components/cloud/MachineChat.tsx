// The chat tab of a machine's workspace — and it is the *same* chat you get
// on your own code.
//
// It used to be a different product wearing the same word. Local chat was a
// live conversation: a brain that streams, calls tools, shows the file it read
// and the command it ran, takes @mentions and /commands, has a model picker
// and an approvals policy. Cloud chat was a form — one textarea that posted a
// row to the task board and a poller that waited for something to answer. Two
// screens, one noun, and no honest way to tell someone which one they were
// looking at.
//
// So this mounts `ManagerSurface`, exactly as the local work surface does. The
// only difference is one field on the session: `machine_id`. The brain still
// runs on this laptop — it is the *hands* that reach across, through `Place`
// on the Rust side, so read_file reads that box's disk and bash runs on that
// box's CPU. Everything a person can see is identical because it is literally
// the same component over the same stream.
//
// Two consequences worth stating plainly, because they are the reason to build
// it this way rather than running a CLI over there:
//   - your API key never leaves this machine, so a shared box can't spend it;
//   - the transcript, the board and the intent log stay on your disk, so the
//     conversation survives the machine being stopped, imaged or thrown away.

import { useCallback, useEffect, useState } from "react";

import { api } from "../../lib/api";
import { ManagerSurface } from "../manager/ManagerSurface";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { Button } from "../ui/button";
import { openThread } from "./machineThread";

export function MachineChat({
  machineId,
  machineName,
  repoRoot,
}: {
  machineId: string;
  machineName: string;
  /** The local checkout this conversation is filed under. The session, its
   *  transcript and its board live here even though the code doesn't — which
   *  is what lets the chat outlive the box. */
  repoRoot: string;
}) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const open = useCallback(
    async (fresh: boolean) => {
      setError(null);
      try {
        // Which conversation this is — remembered, or new — is decided in
        // `machineThread`. Everything left here is the part that renders it.
        const thread = await openThread(
          { id: machineId, name: machineName, repoRoot },
          fresh,
          {
            store: localStorage,
            // A session id that outlived its session would mount a surface
            // that spins forever on a conversation nobody can load.
            alive: (id) =>
              api
                .managerStatus(id)
                .then(() => true)
                .catch(() => false),
            start: api.managerChatStart,
          },
        );
        setSessionId(thread.sessionId);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [machineId, machineName, repoRoot],
  );

  useEffect(() => {
    setSessionId(null);
    if (repoRoot) void open(false);
  }, [machineId, repoRoot]);

  // Cloud work is filed under a project because that is where its record goes.
  // Without one there is nowhere to keep the transcript, so we say that rather
  // than opening a chat whose history would vanish.
  if (!repoRoot) {
    return (
      <div className="grid h-full place-items-center px-8">
        <div className="flex max-w-md flex-col items-center gap-2 text-center">
          <p className="text-sm text-text-2">
            This machine isn’t filed under a project yet.
          </p>
          <p className="text-xs text-text-5">
            The conversation is kept on this laptop, under a project — that is
            what lets it survive the machine being stopped. Open {machineName}{" "}
            from a project on the Workspaces page and the chat comes with it.
          </p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="grid h-full place-items-center px-8">
        <div className="flex max-w-md flex-col items-center gap-2 text-center">
          <p className="text-sm text-text-2">
            Couldn’t open a conversation about {machineName}.
          </p>
          <p className="font-mono text-xs text-text-5">{error}</p>
          <Button variant="accentSoft" onClick={() => void open(true)}>
            Try again
          </Button>
        </div>
      </div>
    );
  }

  if (!sessionId) {
    return (
      <div className="grid h-full place-items-center text-sm text-text-5">
        <span className="flex items-center gap-2">
          <AsciiSpinner /> Opening the conversation…
        </span>
      </div>
    );
  }

  // `tabChrome={false}` for the same reason the workpane passes it: this chat
  // already sits inside the workspace's own tab strip, and a second header
  // would announce that it is a different kind of thing. It isn't.
  return (
    <ManagerSurface
      key={sessionId}
      sessionId={sessionId}
      tabChrome={false}
      onNewThread={() => void open(true)}
    />
  );
}
