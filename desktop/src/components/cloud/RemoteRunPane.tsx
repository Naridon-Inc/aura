// The Run tab of a workspace on a machine: the project's run and setup
// scripts, as the local workspace offers them in its strip.
//
// `RunScriptButton` takes `repoRoot` and works out where the scripts are and
// where they run; this only gives it a tab of its own, because a remote
// strip has no local tab bar to hang the button off.

import { RunScriptButton } from "../RunScriptButton";

export function RemoteRunPane({
  repoRoot,
  machineName,
}: {
  repoRoot: string;
  machineName: string;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-shrink-0 items-center gap-3 border-b border-line-soft px-3 py-1.5">
        <span className="text-xs text-text-4">Scripts for this project</span>
        <RunScriptButton repoRoot={repoRoot} />
      </div>
      <div className="px-4 py-3 text-sm text-text-3">
        <p>
          A run script is the one line that starts the project — a dev
          server, a test suite, a build. A setup script is what has to happen
          once before it, on {machineName}, like installing what the project
          depends on.
        </p>
        <p className="mt-2 text-text-4">
          They are read from the project's own settings, so the same scripts
          appear whichever machine the project is open on.
        </p>
      </div>
    </div>
  );
}
