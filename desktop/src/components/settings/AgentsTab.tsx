// Settings → Agents.
//
// One tab per coding agent this machine knows about: how it signs in, which
// binary runs, the config file it reads and whether it leads the New-tab
// menu. Under them, every agent in the ACP registry, to install, update,
// remove, and open to its sign-in and earlier chats. Then the machine as a
// whole: look again for agents, declare one in ~/.aura/agents.toml, and
// carry the agents' preferences between machines.

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Plus, RefreshCw } from "lucide-react";

import { AgentIcon as ProductAgentIcon } from "../agent/AgentIcon";
import { AgentIcon } from "../ui/agent-icon";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { Button } from "../ui/button";
import { SettingsEmpty, SettingsError } from "../ui/settings-blocks";
import {
  AgentProviderTabs,
  type AgentEditorChoice,
  type AgentProviderTab,
} from "../ui/settings-agent-providers";
import { SettingsAdvanced } from "../ui/settings-advanced";
import { SettingsRow } from "../ui/settings-row";
import { Switch } from "../ui/switch";
import { api, type AgentsTomlEntry } from "../../lib/api";
import { usePinned } from "../../lib/agentPrefs";
import { MANAGER_AGENT } from "../../lib/agents";
import { AURA_MANAGER_ENABLED } from "../../lib/featureFlags";
import { AcpAgentsSection } from "./agents/AcpAgentsSection";
import { AgentConfigSync } from "./agents/AgentConfigSync";
import { Fold } from "./Fold";
import { AgentEditorDialog } from "./agents/AgentEditorDialog";
import { AgentPanel } from "./agents/AgentPanel";
import { agentDetail, blankEntry, missingAgentsLine, orderAgents, tabLabel } from "./agents/agentModel";
import { useClaudeAuth, useCodexAuth } from "./agents/useAgentAuth";
import { useAgentsRegistry } from "./agents/useAgentsRegistry";

/** The four agents the page leads with draw the page's own marks; every
 *  other agent keeps the brand mark the rest of the app shows for it. */
const PAGE_MARKS = new Set(["claude", "codex", "cursor", "opencode"]);

export function AgentsTab({
  advancedOpen = false,
  repoRoot = "",
  onOpened,
  children,
}: {
  /** Open the Advanced: a link or a search named a part of it. */
  advancedOpen?: boolean;
  /** The project the window has open, for an agent's earlier chats. */
  repoRoot?: string;
  /** A chat tab opened from here; Settings steps aside for it. */
  onOpened?: () => void;
  /** More parts for the Advanced, after this machine's rows. */
  children?: ReactNode;
}) {
  const agents = useAgentsRegistry();
  const { isPinned, toggle: togglePin } = usePinned();
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<AgentsTomlEntry | null>(null);
  const [home, setHome] = useState<string | null>(null);
  const [editors, setEditors] = useState<AgentEditorChoice[] | null>(null);

  const ordered = useMemo(() => orderAgents(agents.registry), [agents.registry]);
  const has = (id: string) => ordered.some((agent) => agent.id === id);
  const claude = useClaudeAuth(has("claude"));
  const codex = useCodexAuth(has("codex"));

  useEffect(() => {
    api.homeDir().then(setHome, () => setHome(null));
  }, []);

  // Probing for editors spawns a lookup per editor, so it waits until a
  // config file's menu is first opened.
  const loadEditors = useCallback(() => {
    if (editors) return;
    api.editorsList().then(
      (list) => setEditors(list.filter((e) => e.available).map(({ id, name }) => ({ id, name }))),
      () => setEditors([]),
    );
  }, [editors]);

  const active = selected && has(selected) ? selected : (ordered[0]?.id ?? "");
  const missing = ordered.filter((agent) => !agent.available).length;
  const pending = agents.tomlEntries.filter((e) => !agents.registry.some((r) => r.id === e.id));

  const tabs: AgentProviderTab[] = ordered.map((agent) => ({
    id: agent.id,
    label: tabLabel(agent),
    title: agentDetail(agent),
    icon: PAGE_MARKS.has(agent.id) ? (
      <AgentIcon provider={tabLabel(agent)} />
    ) : (
      <ProductAgentIcon agentId={agent.id} label={agent.label} size={16} />
    ),
    content: (
      <AgentPanel
        agent={agent}
        install={agents.installs.find((i) => i.agent_id === agent.id)}
        tomlEntry={agents.tomlEntries.find((e) => e.id === agent.id)}
        pinned={isPinned(agent.id)}
        onTogglePin={() => togglePin(agent.id)}
        onEdit={setEditing}
        upsert={agents.upsert}
        remove={agents.remove}
        claude={claude}
        codex={codex}
        home={home}
        editors={editors}
        loadEditors={loadEditors}
      />
    ),
  }));

  return (
    <>
      {agents.error && <SettingsError>{agents.error}</SettingsError>}
      {tabs.length > 0 ? (
        <AgentProviderTabs tabs={tabs} value={active} onValueChange={setSelected} />
      ) : (
        <SettingsEmpty>
          {!agents.loaded || agents.busy ? (
            <>
              <AsciiSpinner /> Looking for coding agents on this machine…
            </>
          ) : (
            "Aura found no coding agents on this machine. Install one, then look again."
          )}
        </SettingsEmpty>
      )}
      <AcpAgentsSection repoRoot={repoRoot} onOpened={onOpened} />
      <SettingsAdvanced openWhen={advancedOpen}>
        <Fold id="machine">
          <SettingsRow
            title="Look again"
            description={
              missingAgentsLine(missing) ??
              "Aura checks this machine for coding agents when it starts. Installed one since? Look again."
            }
            control={
              <Button variant="outline" size="sm" disabled={agents.busy} onClick={() => void agents.lookAgain()}>
                {agents.busy ? <AsciiSpinner /> : <RefreshCw />}
                Look again
              </Button>
            }
          />
          {pending.map((entry) => (
            <SettingsRow
              key={entry.id}
              title={entry.label || entry.id}
              description="You declared this one in ~/.aura/agents.toml, but Aura hasn’t picked it up yet. Look again."
              control={
                <Button size="sm" variant="outline" onClick={() => setEditing(entry)}>
                  Edit
                </Button>
              }
            />
          ))}
          <SettingsRow
            title="Add an agent"
            description="Declare a command-line coding agent in ~/.aura/agents.toml. Aura launches it exactly like the built-in agents."
            control={
              <Button variant="outline" size="sm" onClick={() => setEditing(blankEntry())}>
                <Plus />
                Add an agent
              </Button>
            }
          />
          {/* Aura itself is not in the CLI registry above — it is built in, not
              discovered on PATH — so its place in the New-tab menu is set here. */}
          {AURA_MANAGER_ENABLED && (
            <SettingsRow
              title="Put Aura first"
              description="Aura is the orchestrator that fans work out to the other agents. Everything installed is still listed below the pinned ones."
              control={
                <Switch
                  aria-label="Put Aura first"
                  checked={isPinned(MANAGER_AGENT.id)}
                  onCheckedChange={() => togglePin(MANAGER_AGENT.id)}
                />
              }
            />
          )}
          <SettingsRow
            title="Onboarding"
            description="Walk through connecting your agents again."
            control={
              <Button
                variant="outline"
                size="sm"
                onClick={() => window.dispatchEvent(new CustomEvent("aura:open-onboarding"))}
              >
                Replay onboarding
              </Button>
            }
          />
          <AgentConfigSync />
        </Fold>
        {children}
      </SettingsAdvanced>
      {editing && (
        <AgentEditorDialog
          entry={editing}
          onClose={() => setEditing(null)}
          onSave={async (entry) => {
            await agents.upsert(entry);
            setEditing(null);
          }}
        />
      )}
    </>
  );
}
