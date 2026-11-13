// Settings → Agents → the agents in the ACP registry.
//
// Every agent the open Agent Client Protocol registry lists, split by where
// it stands on this computer: running here, ready to install, or with no
// build for it. Aura installs into its own folder, updates what it
// installed, and removes only that; an agent already on this computer's
// PATH is the person's and is left alone. A ready agent opens to its
// sign-in and its earlier chats.

import { useMemo, useState } from "react";
import { ChevronDown, ChevronUp, Download, RefreshCw, Trash2 } from "lucide-react";

import { AgentIcon } from "../../agent/AgentIcon";
import { AsciiSpinner } from "../../ui/ascii-spinner";
import { Button } from "../../ui/button";
import { SettingsActions, SettingsEmpty, SettingsError, SettingsStatusLine } from "../../ui/settings-blocks";
import { SettingsRow, SettingsSection } from "../../ui/settings-row";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../ui/tab-panels";
import {
  groupAgents,
  installedByAura,
  resumeTab,
  staleVersion,
  standingLine,
  type AcpAgentRow,
  type AgentGroups,
} from "../../../lib/acpAgents";
import { useEditorStore } from "../../../lib/editorStore";
import { AcpAgentDetail } from "./AcpAgentDetail";
import { useAcpAgents, type AcpAgents } from "./useAcpAgents";
import "./acp-agents.css";

type Group = keyof AgentGroups;

const GROUPS: { id: Group; label: string; empty: string }[] = [
  {
    id: "here",
    label: "On this computer",
    empty: "None of the registry’s agents is on this computer yet. Install one from Available.",
  },
  { id: "available", label: "Available", empty: "Every agent Aura can install here is installed." },
  { id: "elsewhere", label: "Not for this computer", empty: "Every agent in the registry runs here." },
];

export function AcpAgentsSection({ repoRoot, onOpened }: { repoRoot: string; onOpened?: () => void }) {
  const acp = useAcpAgents();
  const editor = useEditorStore();
  const groups = useMemo(() => groupAgents(acp.rows ?? []), [acp.rows]);
  const [chosen, setChosen] = useState<Group | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const tab: Group = chosen ?? (groups.here.length > 0 || groups.available.length === 0 ? "here" : "available");
  const total = acp.rows?.length ?? 0;

  return (
    <SettingsSection
      title="Agent registry"
      description="Agents that speak the open Agent Client Protocol. Aura installs them in its own folder and chats with them directly."
    >
      <SettingsStatusLine
        text={
          acp.rows === null
            ? "Reading the registry…"
            : `${total} agents in the registry. ${groups.here.length} on this computer.`
        }
        onRefresh={() => void acp.refresh()}
        refreshing={acp.refreshing}
      />
      {acp.error && <SettingsError>{acp.error}</SettingsError>}
      {acp.rows === null ? (
        <SettingsEmpty>
          <AsciiSpinner /> Reading the agent registry…
        </SettingsEmpty>
      ) : (
        <Tabs value={tab} onValueChange={(v) => setChosen(v as Group)} className="ui-acp-agents">
          <TabsList aria-label="Registry agents">
            {GROUPS.map((g) => (
              <TabsTrigger key={g.id} value={g.id}>
                {g.label}
                <span className="ui-acp-agents-count">{groups[g.id].length}</span>
              </TabsTrigger>
            ))}
          </TabsList>
          {GROUPS.map((g) => (
            <TabsContent key={g.id} value={g.id}>
              {groups[g.id].length === 0 && <SettingsEmpty>{g.empty}</SettingsEmpty>}
              {groups[g.id].map((row) => (
                <AcpAgentLine
                  key={row.id}
                  row={row}
                  acp={acp}
                  open={open === row.id}
                  onToggle={() => setOpen((o) => (o === row.id ? null : row.id))}
                  repoRoot={repoRoot}
                  onResume={(session) => {
                    editor.openAgent(resumeTab(row, session, repoRoot, `chat-${crypto.randomUUID()}`));
                    onOpened?.();
                  }}
                />
              ))}
            </TabsContent>
          ))}
        </Tabs>
      )}
    </SettingsSection>
  );
}

function AcpAgentLine({
  row,
  acp,
  open,
  onToggle,
  repoRoot,
  onResume,
}: {
  row: AcpAgentRow;
  acp: AcpAgents;
  open: boolean;
  onToggle: () => void;
  repoRoot: string;
  onResume: Parameters<typeof AcpAgentDetail>[0]["onResume"];
}) {
  const busy = acp.busy[row.id];
  const stale = staleVersion(row);
  const ready = row.state === "ready";
  return (
    <SettingsRow
      className="ui-acp-agent"
      data-state={row.state}
      title={
        <span className="ui-acp-agent-title" title={row.description ?? undefined}>
          <AgentIcon agentId={row.aura_id} label={row.name} size={16} />
          {row.name}
        </span>
      }
      description={<span className={stale ? "ui-acp-agent-update" : undefined}>{standingLine(row)}</span>}
      control={
        <SettingsActions>
          {(row.state === "installable" || stale) && (
            <Button size="sm" disabled={!!busy} onClick={() => void acp.install(row)}>
              {busy === "install" ? <AsciiSpinner /> : stale ? <RefreshCw /> : <Download />}
              {stale ? "Update" : "Install"}
            </Button>
          )}
          {installedByAura(row) && (
            <Button variant="ghost" size="sm" disabled={!!busy} onClick={() => void acp.uninstall(row)}>
              {busy === "uninstall" ? <AsciiSpinner /> : <Trash2 />}
              Uninstall
            </Button>
          )}
          {ready && (
            <Button variant="outline" size="sm" aria-expanded={open} onClick={onToggle}>
              {open ? <ChevronUp /> : <ChevronDown />}
              {open ? "Close" : "Sign-in and chats"}
            </Button>
          )}
        </SettingsActions>
      }
    >
      {ready && open && (
        <AcpAgentDetail
          row={row}
          repoRoot={repoRoot}
          busy={busy}
          onForgetSignIn={() => void acp.forgetSignIn(row)}
          onResume={onResume}
        />
      )}
    </SettingsRow>
  );
}
