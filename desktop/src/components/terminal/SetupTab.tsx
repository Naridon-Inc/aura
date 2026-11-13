// The Setup tab of the terminal panel. On this laptop it shows the setup
// script Aura runs when the workspace is made: its output as it runs, with
// Stop over the corner, then Rerun once it has ended. Before any run, and on
// a connected machine (where setup runs in one of the panel's terminals),
// it is the tab's empty state.

import { remotePlaceForRoot } from "../../lib/activeMachine";
import { isLive, setupFace } from "../../lib/workspaceScripts";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { DetailsTerminalEmpty } from "../ui/details-terminal";
import { SetupLogView } from "./SetupLogView";
import { SetupScriptButton } from "./SetupScriptButton";
import { SetupIdle, type RepoScripts } from "./terminalStrip";
import { useSetupActions, useWorkspaceScript } from "./useWorkspaceSetup";

export function SetupTab({
  repoRoot,
  scripts,
  canAskAgent,
  onAskAgent,
  onAddManually,
  onRunInTerminal,
}: {
  repoRoot: string;
  scripts: RepoScripts;
  canAskAgent: boolean;
  onAskAgent: () => void;
  onAddManually: () => void;
  /** How setup runs where Aura doesn't run it itself: in a panel terminal. */
  onRunInTerminal: () => void;
}) {
  const local = !remotePlaceForRoot(repoRoot);
  const view = useWorkspaceScript(local ? repoRoot : null);
  const actions = useSetupActions(repoRoot, repoRoot);
  const run = view.run;
  const live = isLive(run);

  if (local && run && view.log) {
    const face = setupFace(run);
    return (
      <div className="ui-setup-tab">
        <SetupLogView view={view} />
        <SetupScriptButton
          mode={face}
          size="xs"
          className="ui-details-terminal-corner"
          pending={face === "stop" ? actions.pending === "stop" || run.status === "stopping" : actions.pending === "run"}
          onClick={() => void (face === "stop" ? actions.stop() : actions.run())}
        />
      </div>
    );
  }
  if (local && live) {
    return (
      <DetailsTerminalEmpty>
        <span className="ui-setup-running">
          <AsciiSpinner />
          Running setup script...
        </span>
      </DetailsTerminalEmpty>
    );
  }
  return (
    <SetupIdle
      scripts={scripts}
      canAskAgent={canAskAgent}
      onAskAgent={onAskAgent}
      onAddManually={onAddManually}
      runPending={actions.pending === "run"}
      onRunSetup={local ? () => void actions.run() : onRunInTerminal}
    />
  );
}
