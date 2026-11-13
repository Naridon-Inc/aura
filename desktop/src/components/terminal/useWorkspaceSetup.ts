// A workspace's setup script, for the surfaces that show it: the Setup tab,
// the first chat's intro. Both read the one shared view in
// `lib/workspaceScripts`, so a stop pressed in one shows in the other.

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { toast } from "../../lib/toast";
import {
  EMPTY_VIEW,
  applyScriptEvent,
  loadWorkspaceScript,
  scriptView,
  subscribeScript,
  workspaceScriptRun,
  workspaceScriptStop,
  type ScriptKind,
  type ScriptView,
} from "../../lib/workspaceScripts";

const NOOP_UNSUBSCRIBE = () => {};

/** The latest run of a workspace's script and what it printed, live. */
export function useWorkspaceScript(worktreePath: string | null | undefined, kind: ScriptKind = "setup"): ScriptView {
  const subscribe = useCallback(
    (fn: () => void) => (worktreePath ? subscribeScript(worktreePath, kind, fn) : NOOP_UNSUBSCRIBE),
    [worktreePath, kind],
  );
  const view = useSyncExternalStore(subscribe, () =>
    worktreePath ? scriptView(worktreePath, kind) : EMPTY_VIEW,
  );
  useEffect(() => {
    if (worktreePath) void loadWorkspaceScript(worktreePath, kind);
  }, [worktreePath, kind]);
  return view;
}

/** Run or stop a workspace's setup script, with which of the two is in
 *  flight. `repoRoot` is where the repository's settings are read from. */
export function useSetupActions(repoRoot: string, worktreePath: string) {
  const [pending, setPending] = useState<"run" | "stop" | null>(null);

  const run = useCallback(async () => {
    setPending("run");
    try {
      const started = await workspaceScriptRun(repoRoot, worktreePath, "setup");
      applyScriptEvent({ worktreePath, kind: "setup", chunk: null, run: started });
    } catch (e) {
      toast.warning("Setup couldn't start", e instanceof Error ? e.message : String(e));
    } finally {
      setPending(null);
    }
  }, [repoRoot, worktreePath]);

  const stop = useCallback(async () => {
    setPending("stop");
    try {
      const stopping = await workspaceScriptStop(worktreePath, "setup");
      if (stopping) applyScriptEvent({ worktreePath, kind: "setup", chunk: null, run: stopping });
    } catch (e) {
      toast.warning("Setup couldn't be stopped", e instanceof Error ? e.message : String(e));
    } finally {
      setPending(null);
    }
  }, [worktreePath]);

  return { pending, run, stop };
}
