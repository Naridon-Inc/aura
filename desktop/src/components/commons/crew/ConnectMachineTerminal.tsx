// The live terminal beside the connect-a-machine steps. It sits outside the
// step pages on purpose: a page is redrawn each time the step changes, and the
// SSH session has to outlive every step — the token exported in step 2 is the
// one the runner started in step 3 inherits.

import { Cloud, TerminalSquare } from "lucide-react";
import { Terminal } from "../../Terminal";
import { EmptyState } from "../../ui/state";
import "../../ui/details-terminal.css";
import "../../ui/connect-machine.css";

export function ConnectMachineTerminal({
  instanceId,
  repoRoot,
  launched,
  bootCommand,
  sessionUser,
  host,
  phase,
  onOpened,
}: {
  instanceId: string;
  repoRoot: string;
  launched: boolean;
  bootCommand: string | null;
  /** The login this session is running as — see `sessionUser` in the wizard. */
  sessionUser: string;
  host: string;
  phase: "connecting" | "ready" | "unreachable";
  onOpened: (ptyId: string) => void;
}) {
  return (
    <section className="ui-details-terminal ui-connect-machine-terminal" aria-label="The machine's terminal">
      <div className="ui-details-terminal-toolbar">
        <TerminalSquare size={14} aria-hidden />
        {launched ? (
          <span className="ui-connect-machine-terminal-title">
            {/* The login we are, not the one we dialled — after a handover on a
                shared box those are two different accounts, and the header is
                the only place on screen that says which. */}
            {sessionUser}@{host} ·{" "}
            {phase === "ready" ? "connected" : phase === "unreachable" ? "no answer" : "connecting…"}
          </span>
        ) : (
          <span className="ui-connect-machine-terminal-title">
            The machine's terminal opens here once you connect.
          </span>
        )}
      </div>
      <div className="ui-connect-machine-terminal-body">
        {launched && bootCommand ? (
          <Terminal
            instanceId={instanceId}
            repoRoot={repoRoot}
            cwd={repoRoot}
            bootCommand={bootCommand}
            onOpened={onOpened}
          />
        ) : (
          <EmptyState
            icon={Cloud}
            title="Fill in your machine and press Connect"
            body="Aura opens a real SSH session here. You'll see everything it runs."
          />
        )}
      </div>
    </section>
  );
}
