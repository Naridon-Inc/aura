// The terminal panel's tab state: which tabs it shows, which one is selected,
// what Setup or Run draws while nothing runs there, and what the Run button
// can start.

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { remotePlaceForRoot } from "../../lib/activeMachine";
import type { TerminalGroup, TerminalTab } from "../../lib/editorStore";
import { startGitChat, useGitChats } from "../../lib/gitChat";
import { bootCommandFor } from "../../lib/place/runAt";
import { focusRun, type RunDeps } from "../../lib/runPane";
import { toast } from "../../lib/toast";
import { tabIdFor, useTabCustomizationMap } from "../../lib/useTabCustomization";
import { isLive } from "../../lib/workspaceScripts";
import { repoPage } from "../settings/nav";
import type { DetailsTerminalTab } from "../ui/details-terminal";
import { panelGroupViews } from "./grouping";
import type { RunTask } from "./RunControls";
import { promptForRunCommand } from "./runPrompt";
import { SetupTab } from "./SetupTab";
import { useWorkspaceScript } from "./useWorkspaceSetup";
import {
  RUN_TAB,
  RunIdle,
  SETUP_LABEL,
  SETUP_TAB,
  groupIdOfTab,
  groupTab,
  liveSetupTermId,
  runTasks,
  stripTabs,
  useRepoScripts,
  useRunCommand,
  type IdleTab,
} from "./terminalStrip";

const SETUP_CHAT_ID = "setup-script";

/** The message "Ask agent" sends: write this repository a setup script. */
export const SETUP_REQUEST = {
  label: "Add setup script",
  text:
    "Write a setup script for this repository: the commands a fresh copy of it needs before work can start, " +
    "such as installing dependencies, copying environment files and building anything the app needs to run. " +
    "Save it as the `setup` entry under `[worktree]` in `.aura/settings.toml`, and keep it safe to run more than once.",
  failure: "Failed to send setup request",
};

/** Open the repository's scripts settings, or its run actions. */
export function openRepoScriptsSettings(repoRoot: string, section: "scripts" | "actions" = "scripts") {
  window.dispatchEvent(
    new CustomEvent("aura:open-settings", { detail: { pane: repoPage(repoRoot, section) } }),
  );
}

export function useTerminalStrip({
  repoRoot,
  terminalTabs,
  terminalGroups,
  panelActiveTermId,
  panelActiveGroupId,
  runDeps,
  runTermId,
  onRun,
  selectPanelTerminal,
  selectPanelGroup,
  openPanelTerminal,
  closeTerminal,
  runShortcut,
}: {
  repoRoot: string;
  terminalTabs: TerminalTab[];
  terminalGroups: TerminalGroup[];
  panelActiveTermId: string | null;
  panelActiveGroupId: string | null;
  runDeps: RunDeps;
  runTermId: string | null;
  onRun: () => void;
  selectPanelTerminal: (termId: string) => void;
  selectPanelGroup: (groupId: string) => void;
  openPanelTerminal: (cwd: string, opts?: { bootCommand?: string; label?: string }) => string;
  closeTerminal: (termId: string) => void;
  runShortcut?: string;
}): {
  tabs: DetailsTerminalTab[];
  value: string;
  select: (value: string) => void;
  idle: ReactNode | null;
  tasks: RunTask[];
  runTask: (task: RunTask) => void;
  /** Terminals the panel counts against its cap: everything but Setup and Run. */
  terminalCount: number;
} {
  const scripts = useRepoScripts(repoRoot);
  const setupCommand = scripts.status === "ready" ? scripts.setup : null;
  const runCommand = useRunCommand(repoRoot);
  const customMap = useTabCustomizationMap(repoRoot);
  const chatSending = useGitChats(repoRoot);
  const setupTermId = useMemo(
    () => liveSetupTermId(repoRoot, terminalTabs),
    [repoRoot, terminalTabs],
  );
  // The setup Aura runs itself when a workspace is made here; on a machine
  // setup runs in one of the panel's terminals instead.
  const setupView = useWorkspaceScript(remotePlaceForRoot(repoRoot) ? null : repoRoot);
  const setupLive = isLive(setupView.run);
  const [idleTab, setIdleTab] = useState<IdleTab | null>(null);
  // Anything that focuses a terminal (a new one, Run starting) ends the
  // "nothing running" view.
  useEffect(() => {
    setIdleTab(null);
  }, [panelActiveTermId]);

  const views = useMemo(
    () => panelGroupViews(terminalGroups, terminalTabs),
    [terminalGroups, terminalTabs],
  );
  const tabs = useMemo(
    () =>
      stripTabs({
        setupCommand,
        setupRunning: !!setupTermId || setupLive,
        runCommand,
        runRunning: !!runTermId,
        views,
        reserved: [runTermId, setupTermId],
        nameFor: (tab, i) =>
          customMap[tabIdFor("term", tab.termId)]?.name || `Terminal ${i + 1}`,
        onClose: (ids) => ids.forEach(closeTerminal),
      }),
    // `closeTerminal` is a store action on a singleton; it never changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [setupCommand, setupLive, runCommand, views, runTermId, setupTermId, customMap],
  );
  const terminalCount = tabs.filter((t) => groupIdOfTab(t.value)).length;
  const tasks = useMemo(
    () => runTasks(runCommand, scripts.status === "ready" ? scripts.scripts : []),
    [runCommand, scripts],
  );

  const value =
    idleTab ??
    (panelActiveTermId && panelActiveTermId === runTermId
      ? RUN_TAB
      : panelActiveTermId && panelActiveTermId === setupTermId
        ? SETUP_TAB
        : panelActiveGroupId && tabs.some((t) => t.value === groupTab(panelActiveGroupId))
          ? groupTab(panelActiveGroupId)
          : RUN_TAB);

  async function bootIn(command: string, failure: string): Promise<string | null> {
    try {
      return await bootCommandFor(repoRoot, command);
    } catch (e) {
      toast.warning(failure, e instanceof Error ? e.message : String(e));
      return null;
    }
  }

  async function runSetup() {
    if (!setupCommand) return;
    const bootCommand = await bootIn(setupCommand, "Setup couldn't start on the machine");
    if (!bootCommand) return;
    if (setupTermId) closeTerminal(setupTermId);
    selectPanelTerminal(openPanelTerminal(repoRoot, { bootCommand, label: SETUP_LABEL }));
  }

  function runTask(task: RunTask) {
    if (task.id === RUN_TAB) {
      onRun();
      return;
    }
    void (async () => {
      const bootCommand = await bootIn(task.command, `${task.label} couldn't start on the machine`);
      if (bootCommand) selectPanelTerminal(openPanelTerminal(repoRoot, { bootCommand, label: task.label }));
    })();
  }

  function select(next: string) {
    if (next === RUN_TAB) {
      setIdleTab(focusRun(repoRoot, runDeps) ? null : RUN_TAB);
      return;
    }
    if (next === SETUP_TAB) {
      if (setupTermId) selectPanelTerminal(setupTermId);
      setIdleTab(setupTermId ? null : SETUP_TAB);
      return;
    }
    const groupId = groupIdOfTab(next);
    if (!groupId) return;
    setIdleTab(null);
    selectPanelGroup(groupId);
  }

  const shownIdle: IdleTab | null =
    idleTab ?? (value === RUN_TAB && !runTermId ? RUN_TAB : null);
  const idle =
    shownIdle === SETUP_TAB ? (
      <SetupTab
        repoRoot={repoRoot}
        scripts={scripts}
        canAskAgent={!chatSending(SETUP_CHAT_ID)}
        onAskAgent={() => void startGitChat({ repoRoot, id: SETUP_CHAT_ID, chat: SETUP_REQUEST })}
        onAddManually={() => openRepoScriptsSettings(repoRoot)}
        onRunInTerminal={() => void runSetup()}
      />
    ) : shownIdle === RUN_TAB ? (
      <RunIdle
        command={runCommand}
        shortcut={runShortcut}
        onRun={onRun}
        onAddAction={() => void promptForRunCommand(repoRoot)}
        onAddManually={() => openRepoScriptsSettings(repoRoot)}
      />
    ) : null;

  return { tabs, value, select, idle, tasks, runTask, terminalCount };
}
