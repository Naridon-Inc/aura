// One agent's tab: how it signs in (for the CLIs that expose that), what
// Aura found on this machine, whether it leads the New-tab menu, which binary
// runs, and the config file it reads.

import { useState } from "react";

import { askConfirm } from "../../ui/ask";
import { Button } from "../../ui/button";
import {
  SettingsActions,
  SettingsError,
  SettingsStatusLine,
} from "../../ui/settings-blocks";
import {
  AgentConfigFileRow,
  AgentExecutableRow,
  type AgentEditorChoice,
} from "../../ui/settings-agent-providers";
import { SettingsRow } from "../../ui/settings-row";
import { Switch } from "../../ui/switch";
import { installNudge, tildePath } from "../../../lib/agentInstallHealth";
import type { AgentDescriptor, AgentInstallHealth, AgentsTomlEntry } from "../../../lib/api";
import { api } from "../../../lib/api";
import { pickPath } from "../../../lib/nativeDialog";
import { ClaudeAuthPanel, CodexAuthPanel } from "./AgentAuth";
import { AgentInstallNotice } from "./AgentInstallNotice";
import { AGENTS_TOML, cleanVersion, configFileFor, installedLine, tabLabel } from "./agentModel";
import type { ClaudeAuth, CodexAuth } from "./useAgentAuth";

export interface AgentPanelProps {
  agent: AgentDescriptor;
  install: AgentInstallHealth | undefined;
  tomlEntry: AgentsTomlEntry | undefined;
  pinned: boolean;
  onTogglePin: () => void;
  onEdit: (entry: AgentsTomlEntry) => void;
  upsert: (entry: AgentsTomlEntry) => Promise<void>;
  remove: (id: string) => Promise<void>;
  claude: ClaudeAuth;
  codex: CodexAuth;
  home: string | null;
  editors: AgentEditorChoice[] | null;
  loadEditors: () => void;
}

export function AgentPanel({
  agent,
  install,
  tomlEntry,
  pinned,
  onTogglePin,
  onEdit,
  upsert,
  remove,
  claude,
  codex,
  home,
  editors,
  loadEditors,
}: AgentPanelProps) {
  const [error, setError] = useState<string | null>(null);
  const name = tabLabel(agent);
  const nudge = install ? installNudge(install) : null;
  const running = install?.running?.path ?? null;
  const version = cleanVersion(agent);
  const config = configFileFor(agent.id);

  const attempt = async (work: () => Promise<unknown>) => {
    setError(null);
    try {
      await work();
    } catch (e) {
      setError(String(e));
    }
  };

  const openFile = (relativePath: string, editorId: string) => {
    if (!home) return;
    void attempt(() => api.editorOpen(`${home}/${relativePath}`, editorId));
  };

  const removeEntry = async () => {
    const ok = await askConfirm({
      title: `Remove the TOML override for ${agent.id}?`,
      body: "That agent goes back to the settings Aura ships with.",
      confirmLabel: "Remove",
      tone: "danger",
    });
    if (ok) await attempt(() => remove(agent.id));
  };

  return (
    <>
      {agent.id === "claude" && <ClaudeAuthPanel auth={claude} />}
      {agent.id === "codex" && <CodexAuthPanel auth={codex} />}
      {agent.id !== "claude" && agent.id !== "codex" && (
        <SettingsStatusLine text={installedLine(agent)} />
      )}
      {nudge && <AgentInstallNotice nudge={nudge} />}
      {error && <SettingsError>{error}</SettingsError>}
      {/* Only offered for agents actually on this machine — putting one Aura
          cannot start at the top of the menu is an invitation to a failure. */}
      {agent.available && (
        <SettingsRow
          title="Pin to the New-tab menu"
          description={`Pinned agents lead the “+” menu on the tab strip. ${name} is listed there either way.`}
          control={
            <Switch
              aria-label={`Pin ${name} to the New-tab menu`}
              checked={pinned}
              onCheckedChange={onTogglePin}
            />
          }
        />
      )}
      {tomlEntry ? (
        <AgentExecutableRow
          name={name}
          description="The command Aura starts for this agent, saved to ~/.aura/agents.toml."
          value={tomlEntry.bin}
          placeholder={agent.bin}
          onCommit={(bin) => void attempt(() => upsert({ ...tomlEntry, bin }))}
          onBrowse={() =>
            void attempt(async () => {
              const picked = await pickPath({ title: `Choose the ${name} executable` });
              if (typeof picked === "string") await upsert({ ...tomlEntry, bin: picked });
            })
          }
          browseLabel="Browse for executable"
        />
      ) : (
        <AgentExecutableRow
          name={name}
          description={
            agent.available
              ? `The copy Aura starts${version ? `, version ${version}` : ""}. To use another, put it first on your PATH, then look again.`
              : `Aura looks for “${agent.bin}” on your PATH. Install it, then look again.`
          }
          value={running ? tildePath(running) : ""}
          placeholder={agent.available ? agent.bin : "Not installed"}
          onBrowse={running ? () => void attempt(() => api.fsRevealInFinder(running)) : undefined}
          browseLabel="Show in Finder"
        />
      )}
      {config && (
        <AgentConfigFileRow
          title={config.title}
          path={`~/${config.relativePath}`}
          editors={editors}
          onMenuOpen={loadEditors}
          onOpen={(editorId) => openFile(config.relativePath, editorId)}
        />
      )}
      {tomlEntry && (
        <SettingsRow
          title={AGENTS_TOML.title}
          description="You declared this agent yourself, in ~/.aura/agents.toml."
          control={
            <SettingsActions>
              <Button size="sm" variant="outline" onClick={() => onEdit(tomlEntry)}>
                Edit
              </Button>
              <Button size="sm" variant="outlineDestructive" onClick={() => void removeEntry()}>
                Remove
              </Button>
            </SettingsActions>
          }
        />
      )}
    </>
  );
}
