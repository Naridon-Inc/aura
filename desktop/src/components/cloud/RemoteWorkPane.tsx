// The pane behind a work tab of a remote workspace. Asks the machine once
// whether the project can be opened over there — the checkout exists, git
// answers — and then mounts the surface of the tab's kind on it.
//
// The probe's answer is remembered per place, so switching between Files,
// Changes and Git does not ask again; a refusal shows the machine's own
// sentence (the stderr of the command that failed), with a way to ask again
// after fixing what it named.

import { useCallback, useEffect, useState } from "react";

import type { RemoteWorkKind } from "../../lib/remoteWorkspaceSnapshot";
import * as work from "../../lib/place/workApi";
import { placeScope } from "../../lib/place/workApi";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { Button } from "../ui/button";
import { RemoteChangesPane } from "./RemoteChangesPane";
import { RemoteFilesPane } from "./RemoteFilesPane";
import { RemoteGitPane } from "./RemoteGitPane";
import { RemotePrsPane } from "./RemotePrsPane";
import { RemoteRunPane } from "./RemoteRunPane";

/** The probe's verdict per place scope. `null` = the machine said yes; a
 *  string = its reason for no. Module-level so a re-mount of the pane (a
 *  tab closed and reopened) does not ask the box again. */
const readiness = new Map<string, string | null>();

type Probe =
  | { state: "asking" }
  | { state: "ready" }
  | { state: "refused"; why: string };

function useWorkReady(repoRoot: string | undefined) {
  const scope = repoRoot ? placeScope(repoRoot) : null;
  const [probe, setProbe] = useState<Probe>(() => {
    if (scope && readiness.has(scope)) {
      const why = readiness.get(scope)!;
      return why === null ? { state: "ready" } : { state: "refused", why };
    }
    return { state: "asking" };
  });

  const ask = useCallback(async () => {
    if (!repoRoot || !scope) return;
    setProbe({ state: "asking" });
    const why = await work.workReady(repoRoot);
    readiness.set(scope, why);
    setProbe(why === null ? { state: "ready" } : { state: "refused", why });
  }, [repoRoot, scope]);

  useEffect(() => {
    if (!scope) return;
    if (readiness.has(scope)) {
      const why = readiness.get(scope)!;
      setProbe(why === null ? { state: "ready" } : { state: "refused", why });
      return;
    }
    void ask();
  }, [scope, ask]);

  return { probe, retry: ask };
}

export function RemoteWorkPane({
  kind,
  repoRoot,
  machineName,
  openFile,
  onOpenFile,
}: {
  kind: RemoteWorkKind;
  /** The LOCAL root the place is keyed by; every surface takes it and
   *  `lib/place/workApi` sends the question to the machine. Undefined when
   *  the workspace has no project yet. */
  repoRoot: string | undefined;
  machineName: string;
  /** The file the Files tab shows, held by the workspace so it outlives
   *  the tab. */
  openFile: string | null;
  onOpenFile: (path: string) => void;
}) {
  const { probe, retry } = useWorkReady(repoRoot);

  if (!repoRoot) {
    return (
      <Notice>
        This workspace has no project yet. Open a project on {machineName}, or
        start a session in one, and the {kind === "prs" ? "PRs" : kind} tab
        will read from it.
      </Notice>
    );
  }

  if (probe.state === "asking") {
    return (
      <Notice>
        <AsciiSpinner /> Asking {machineName} whether the project can be opened
        there…
      </Notice>
    );
  }

  if (probe.state === "refused") {
    return (
      <Notice>
        <div className="text-text-2">{machineName} could not open the project.</div>
        <pre className="mt-2 whitespace-pre-wrap break-words font-mono text-xs text-text-3">
          {probe.why}
        </pre>
        <div className="mt-3">
          <Button size="sm" variant="secondary" onClick={() => void retry()}>
            Ask again
          </Button>
        </div>
      </Notice>
    );
  }

  switch (kind) {
    case "files":
      return (
        <RemoteFilesPane
          repoRoot={repoRoot}
          machineName={machineName}
          openFile={openFile}
          onOpenFile={onOpenFile}
        />
      );
    case "changes":
      return <RemoteChangesPane repoRoot={repoRoot} onOpenFile={onOpenFile} />;
    case "git":
      return <RemoteGitPane repoRoot={repoRoot} />;
    case "prs":
      return <RemotePrsPane repoRoot={repoRoot} />;
    case "run":
      return <RemoteRunPane repoRoot={repoRoot} machineName={machineName} />;
  }
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-start px-4 py-3 text-sm text-text-3">
      <div className="max-w-xl">{children}</div>
    </div>
  );
}
