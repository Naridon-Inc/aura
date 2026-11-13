// What the terminal panel's Setup and Run tabs know, and what they show while
// nothing runs in them: the repository's setup script and named scripts, the
// run command, and each tab's empty, loading and idle states.

import { useEffect, useState } from "react";
import { Play } from "lucide-react";
import { repoWorktreeSettingsGet } from "../../lib/api";
import type { TerminalTab } from "../../lib/editorStore";
import { RUN_LABEL, resolveRunCommand } from "../../lib/runPane";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { Button } from "../ui/button";
import {
  DetailsTerminalEmpty,
  DetailsTerminalSetupCard,
  type DetailsTerminalTab,
} from "../ui/details-terminal";
import { Kbd } from "../ui/kbd";
import type { PanelGroupView } from "./grouping";
import type { RunTask } from "./RunControls";
import { RUN_COMMAND_CHANGED } from "./runPrompt";
import { SetupScriptButton } from "./SetupScriptButton";

export const SETUP_LABEL = "Setup";
export const SETUP_TAB = "setup";
export const RUN_TAB = "run";
export type IdleTab = typeof SETUP_TAB | typeof RUN_TAB;
/** A workspace holds at most five terminals. */
export const MAX_TERMINALS = 5;
/** Fired after a repository's scripts are saved, so the panel re-reads them.
 *  `detail.repoRoot` is the repository. */
export const REPO_SCRIPTS_CHANGED = "aura:repo-scripts-changed";

export function groupTab(groupId: string): string {
  return `group:${groupId}`;
}

export function groupIdOfTab(value: string): string | null {
  return value.startsWith("group:") ? value.slice("group:".length) : null;
}

export type RepoScripts =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; setup: string | null; scripts: Array<{ name: string; command: string }> };

function onRepoChanged(repoRoot: string, read: () => void): () => void {
  const onChanged = (e: Event) => {
    const root = (e as CustomEvent<{ repoRoot?: string }>).detail?.repoRoot;
    if (!root || root === repoRoot) read();
  };
  window.addEventListener(RUN_COMMAND_CHANGED, onChanged);
  window.addEventListener(REPO_SCRIPTS_CHANGED, onChanged);
  return () => {
    window.removeEventListener(RUN_COMMAND_CHANGED, onChanged);
    window.removeEventListener(REPO_SCRIPTS_CHANGED, onChanged);
  };
}

/** The repository's setup script and named scripts, re-read when saved. */
export function useRepoScripts(repoRoot: string): RepoScripts {
  const [scripts, setScripts] = useState<RepoScripts>({ status: "loading" });
  useEffect(() => {
    let alive = true;
    setScripts({ status: "loading" });
    const read = () =>
      repoWorktreeSettingsGet(repoRoot)
        .then((s) => {
          if (!alive) return;
          setScripts({
            status: "ready",
            setup: s.setup?.trim() || null,
            scripts: (s.namedScripts ?? []).filter((n) => n.name.trim() && n.command.trim()),
          });
        })
        .catch(() => {
          if (alive) setScripts({ status: "error" });
        });
    void read();
    const stop = onRepoChanged(repoRoot, () => void read());
    return () => {
      alive = false;
      stop();
    };
  }, [repoRoot]);
  return scripts;
}

/** The command Run would start right now, re-read whenever it is changed.
 *  `undefined` while it is still being worked out. */
export function useRunCommand(repoRoot: string): string | null | undefined {
  const [command, setCommand] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    setCommand(undefined);
    const read = () =>
      void resolveRunCommand(repoRoot)
        .then((c) => {
          if (alive) setCommand(c);
        })
        .catch(() => {
          if (alive) setCommand(null);
        });
    read();
    const stop = onRepoChanged(repoRoot, read);
    return () => {
      alive = false;
      stop();
    };
  }, [repoRoot]);
  return command;
}

/** Everything the Run button can start: the run command first, then the
 *  repository's named scripts. */
export function runTasks(
  runCommand: string | null | undefined,
  scripts: Array<{ name: string; command: string }>,
): RunTask[] {
  const tasks: RunTask[] = [];
  if (runCommand) tasks.push({ id: RUN_TAB, label: RUN_LABEL, command: runCommand });
  for (const s of scripts) tasks.push({ id: `script:${s.name}`, label: s.name, command: s.command });
  return tasks;
}

/** The newest live terminal running this project's setup, if any. */
export function liveSetupTermId(repoRoot: string, terminals: TerminalTab[]): string | null {
  for (let i = terminals.length - 1; i >= 0; i--) {
    const t = terminals[i];
    if (t.label === SETUP_LABEL && t.cwd === repoRoot) return t.termId;
  }
  return null;
}

/** Setup, Run, then one tab per terminal group not already standing for
 *  Setup or Run. Setup spins while its script runs; Run wears a dot while
 *  the project runs. */
export function stripTabs({
  setupCommand,
  setupRunning,
  runCommand,
  runRunning,
  views,
  reserved,
  nameFor,
  onClose,
}: {
  setupCommand: string | null;
  setupRunning: boolean;
  runCommand: string | null | undefined;
  runRunning: boolean;
  views: PanelGroupView[];
  /** Terminals that are Setup or Run, so their solo groups are not listed twice. */
  reserved: Array<string | null>;
  nameFor: (tab: TerminalTab, index: number) => string;
  /** Close every terminal in a group's tab. */
  onClose: (termIds: string[]) => void;
}): DetailsTerminalTab[] {
  const tabs: DetailsTerminalTab[] = [
    { value: SETUP_TAB, label: SETUP_LABEL, title: setupCommand ?? undefined, working: setupRunning },
    { value: RUN_TAB, label: RUN_LABEL, title: runCommand ?? undefined, running: runRunning },
  ];
  views
    .filter((v) => !(v.panes.length === 1 && reserved.includes(v.panes[0].termId)))
    .forEach((v, i) => {
      const name = nameFor(v.panes[0], i);
      tabs.push({
        value: groupTab(v.groupId),
        label: v.isSplit ? `${name} +${v.panes.length - 1}` : name,
        onClose: () => onClose(v.panes.map((p) => p.termId)),
      });
    });
  return tabs;
}

/** The Setup tab while no setup terminal is open. */
export function SetupIdle({
  scripts,
  canAskAgent,
  onAskAgent,
  onAddManually,
  onRunSetup,
  runPending = false,
}: {
  scripts: RepoScripts;
  canAskAgent: boolean;
  onAskAgent: () => void;
  onAddManually: () => void;
  onRunSetup: () => void;
  runPending?: boolean;
}) {
  if (scripts.status === "loading") {
    return (
      <DetailsTerminalEmpty>
        <AsciiSpinner />
      </DetailsTerminalEmpty>
    );
  }
  if (scripts.status === "error") {
    return (
      <DetailsTerminalEmpty>
        <span>Couldn't load setup script settings</span>
      </DetailsTerminalEmpty>
    );
  }
  if (!scripts.setup) {
    return (
      <DetailsTerminalSetupCard>
        <h3>Add setup script</h3>
        <div className="ui-details-terminal-card-actions">
          <Button size="sm" disabled={!canAskAgent} onClick={onAskAgent}>
            Ask agent
          </Button>
          <Button size="sm" variant="secondary" onClick={onAddManually}>
            Add manually
          </Button>
        </div>
        <p>Run commands when a workspace is created to install dependencies or set up the environment</p>
      </DetailsTerminalSetupCard>
    );
  }
  return (
    <DetailsTerminalEmpty>
      <span>No setup script output</span>
      <p>Setup script output will appear here after running setup.</p>
      <SetupScriptButton mode="run" pending={runPending} onClick={onRunSetup} />
    </DetailsTerminalEmpty>
  );
}

/** The Run tab while nothing runs. */
export function RunIdle({
  command,
  shortcut,
  onRun,
  onAddAction,
  onAddManually,
}: {
  command: string | null | undefined;
  shortcut?: string;
  onRun: () => void;
  onAddAction: () => void;
  onAddManually: () => void;
}) {
  if (command === undefined) {
    return (
      <DetailsTerminalEmpty>
        <AsciiSpinner />
      </DetailsTerminalEmpty>
    );
  }
  if (!command) {
    return (
      <DetailsTerminalSetupCard>
        <p>Run tests or a development server to test changes in this workspace</p>
        <Button size="sm" onClick={onAddAction}>
          Add action
        </Button>
        <span className="ui-details-terminal-card-or">or</span>
        <Button size="sm" variant="link" onClick={onAddManually}>
          Add action manually
        </Button>
      </DetailsTerminalSetupCard>
    );
  }
  return (
    <DetailsTerminalEmpty>
      <Play className="ui-details-terminal-empty-icon" />
      <Button size="sm" variant="outline" title={command} onClick={onRun}>
        Run workspace
        {shortcut && <Kbd>{shortcut}</Kbd>}
      </Button>
      <span>Test your changes here.</span>
    </DetailsTerminalEmpty>
  );
}
