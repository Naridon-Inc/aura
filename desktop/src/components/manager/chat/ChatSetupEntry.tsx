//! The setup line in the first chat of a new copy: how the repository's
//! setup script is doing in this workspace. Running, with Stop beside it;
//! stopping; failed, offering to hand the log to the agent; cancelled;
//! completed, linking to where the script is set. A repository with no setup
//! script gets a quiet link to add one.

import { ArrowUpRight, CircleAlert, CircleX, Terminal } from "lucide-react";
import { remotePlaceForRoot } from "../../../lib/activeMachine";
import { attachToComposer } from "../../../lib/composerAttachments";
import { toast } from "../../../lib/toast";
import { fixSetupScriptPrompt, workspaceScriptLog } from "../../../lib/workspaceScripts";
import { AsciiSpinner } from "../../ui/ascii-spinner";
import type { TimelineEntry } from "../../ui/timeline";
import { SetupScriptButton } from "../../terminal/SetupScriptButton";
import { useRepoScripts } from "../../terminal/terminalStrip";
import { openRepoScriptsSettings } from "../../terminal/useTerminalStrip";
import { useSetupActions, useWorkspaceScript } from "../../terminal/useWorkspaceSetup";

export const SETUP_LOGS_FILE = "setup-logs.txt";

const NO_LOGS = "Setup logs are unavailable because Aura quit before the setup process finished.";

/** Hand a failed setup to the agent: the fix request and the log, as a file
 *  on the chat's next message. */
export async function attachSetupLogs(sessionId: string, worktreePath: string, setupScript: string | null, live: string) {
  let logs = live;
  try {
    logs = (await workspaceScriptLog(worktreePath, "setup")) || live;
  } catch {
    /* the log in memory stands */
  }
  const text = fixSetupScriptPrompt(setupScript, logs.trim() ? logs : NO_LOGS);
  const file = new File([text], SETUP_LOGS_FILE, { type: "text/plain" });
  if (!attachToComposer(sessionId, file)) toast.danger("Failed to attach setup logs");
}

function SettingsLink({ repoRoot, children }: { repoRoot: string; children: React.ReactNode }) {
  return (
    <button type="button" className="ui-chat-setup-link" onClick={() => openRepoScriptsSettings(repoRoot)}>
      {children}
      <ArrowUpRight aria-hidden />
    </button>
  );
}

/** The setup line for this workspace, or `null` when there is nothing true
 *  to say yet (settings still loading, or setup never ran here). */
export function useSetupEntry(repoRoot: string, sessionId: string | undefined): TimelineEntry | null {
  const local = !remotePlaceForRoot(repoRoot);
  const scripts = useRepoScripts(repoRoot);
  const view = useWorkspaceScript(local ? repoRoot : null);
  const actions = useSetupActions(repoRoot, repoRoot);
  // On another machine setup runs in that machine's terminal; this copy's
  // runner knows nothing about it.
  if (!local || scripts.status !== "ready") return null;
  const run = view.run;

  if (!scripts.setup && !run) {
    return {
      id: "setup",
      title: "",
      marker: <CircleAlert aria-hidden />,
      detail: (
        <SettingsLink repoRoot={repoRoot}>Optional: add a setup script</SettingsLink>
      ),
    };
  }
  if (!run) return null;

  switch (run.status) {
    case "running":
      return {
        id: "setup",
        title: "",
        tone: "active",
        marker: <AsciiSpinner />,
        detail: (
          <span className="ui-chat-setup-line">
            Running setup script...
            <SetupScriptButton
              mode="stop"
              size="xs"
              pending={actions.pending === "stop"}
              onClick={() => void actions.stop()}
            />
          </span>
        ),
      };
    case "stopping":
      return { id: "setup", title: "", tone: "active", marker: <AsciiSpinner />, detail: "Stopping setup script..." };
    case "failed":
      return {
        id: "setup",
        title: "",
        marker: <CircleX aria-hidden data-mark="failed" />,
        detail: (
          <button
            type="button"
            className="ui-chat-setup-failed"
            disabled={!sessionId}
            onClick={() => sessionId && void attachSetupLogs(sessionId, repoRoot, scripts.setup, view.log)}
          >
            Setup script failed — fix it?
          </button>
        ),
      };
    case "did_not_start":
      return {
        id: "setup",
        title: "",
        marker: <Terminal aria-hidden />,
        detail: (
          <span className="ui-chat-setup-stack">
            Setup did not start
            {run.reason && <small>{run.reason}</small>}
          </span>
        ),
      };
    case "cancelled":
      return { id: "setup", title: "", marker: <CircleAlert aria-hidden />, detail: "Cancelled setup script" };
    case "completed":
      return {
        id: "setup",
        title: "",
        marker: <Terminal aria-hidden />,
        detail: (
          <span className="ui-chat-setup-line">
            Completed
            <SettingsLink repoRoot={repoRoot}>setup script</SettingsLink>
          </span>
        ),
      };
  }
}
