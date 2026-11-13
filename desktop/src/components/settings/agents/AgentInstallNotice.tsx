// The endless-update-nag explainer. Shown only when a newer copy of the
// agent exists but nothing can reach it — the case where the CLI's own
// "please update" prompt can never clear, because the update lands in a
// folder the shell looks past or has never been told about.

import { Alert, AlertDescription, AlertTitle } from "../../ui/alert";
import { parentDir, tildePath, type InstallNudge } from "../../../lib/agentInstallHealth";

export function AgentInstallNotice({ nudge }: { nudge: InstallNudge }) {
  const running = nudge.running;
  return (
    <Alert className="ui-agent-provider-notice">
      <AlertTitle>
        {nudge.trouble === "off-path-only"
          ? `${nudge.bin} is installed where your shell can’t reach it`
          : `${nudge.bin} keeps asking to update`}
      </AlertTitle>
      <AlertDescription>
        <p>{nudge.line}</p>
        {running ? (
          <p title={`${running.path}\n${nudge.other.path}`}>
            Install it into <code>{tildePath(parentDir(running.path))}</code> instead, or put{" "}
            <code>{tildePath(parentDir(nudge.other.path))}</code> ahead of it in your PATH.
          </p>
        ) : (
          <p>
            Add <code>{tildePath(parentDir(nudge.other.path))}</code> to your PATH, or reinstall it
            into a folder that is already there.
          </p>
        )}
      </AlertDescription>
    </Alert>
  );
}
