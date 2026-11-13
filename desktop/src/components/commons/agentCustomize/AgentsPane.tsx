// Agents pane — who actually does the work. The full roster of coding agents
// Aura knows about: the ones installed and ready on this machine (Claude,
// Gemini, Codex, Cursor, Kimi-Coder…) up top with a one-click Start, and the
// ones Aura supports but couldn't find below, shown with their brand mark so
// you know what's out there to install. "Scan again" re-checks the machine
// (and re-reads ~/.aura/agents.toml) so a freshly-installed CLI appears without
// a restart. Nothing here is faked — an agent only shows as ready if its
// command answered.

import { useState } from "react";
import { ArrowUpRight, Bot, Download, Pin, Plus, RefreshCw } from "lucide-react";

import { lookAgainForAgents } from "../../../lib/agentsListCache";
import type { Agent } from "../../../lib/agents";
import { usePinned } from "../../../lib/agentPrefs";
import { AgentIcon } from "../../agent/AgentIcon";
import { agentDisplayLabel, canonicalAgentId } from "../../../lib/agentIdentity";
import { AsciiSpinner } from "../../ui/ascii-spinner";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { SettingsActions } from "../../ui/settings-blocks";
import { SettingsMcpToolbar } from "../../ui/settings-mcp-parts";
import { SettingsRow, SettingsSection } from "../../ui/settings-row";
import { SettingsServiceMark, SettingsServiceTitle } from "../../ui/settings-services-row";
import { Card, EmptyHint, PaneIntro, PaneScroll, PaneSpinner } from "./customizeShared";

export function AgentsPane({
  agents,
  loading,
  refresh,
  onClose,
}: {
  agents: Agent[];
  loading: boolean;
  refresh: () => void;
  onClose: () => void;
}) {
  const [scanning, setScanning] = useState(false);
  // Pin state is shared with the Settings roster and the tab strip's "+"
  // menu — pinning here puts the agent at the top of that menu.
  const { isPinned, toggle: togglePin } = usePinned();

  // Launch an agent through the exact same path as the + button: dispatch the
  // preset event the launcher already listens to, then close so the user lands
  // on the running session.
  const start = (agent: Agent) => {
    window.dispatchEvent(
      new CustomEvent("aura:run-agent-preset", {
        detail: { agentId: agent.id, agentLabel: agent.label, prompt: "" },
      }),
    );
    onClose();
  };

  // Re-read the registry: agents_reload picks up ~/.aura/agents.toml edits,
  // then refresh() re-runs discovery so newly-installed CLIs flip to ready.
  const scan = async () => {
    setScanning(true);
    try {
      await lookAgainForAgents();
    } catch {
      /* reload is best-effort; discovery below is the source of truth */
    } finally {
      refresh();
      // Let the discovery round-trip breathe before clearing the spinner.
      window.setTimeout(() => setScanning(false), 600);
    }
  };

  const ready = agents.filter((a) => a.available);
  const notInstalled = agents.filter((a) => !a.available);

  return (
    <PaneScroll>
      <PaneIntro
        title="Agents"
        blurb="The assistants that read and change your code. Ready ones start with a click; the rest are agents Aura supports. Install the CLI and hit Scan again to light it up."
      />

      {/* The page's one action sits in a row's control slot, the way the
          connections settings page carries its toolbar. */}
      <Card>
        <SettingsRow
          title="Coding agents"
          description={
            agents.length > 0
              ? `${ready.length} ready · ${notInstalled.length} available to add`
              : undefined
          }
          control={
            <SettingsMcpToolbar>
              <Button size="sm" variant="ghost" onClick={scan} disabled={scanning || loading}>
                {scanning ? <AsciiSpinner /> : <RefreshCw />}
                Scan again
              </Button>
            </SettingsMcpToolbar>
          }
        />
      </Card>

      {loading && agents.length === 0 ? (
        <PaneSpinner label="Looking for installed agents…" />
      ) : agents.length === 0 ? (
        <EmptyHint
          icon={Bot}
          title="No coding agents found yet"
          body="Install one (Claude Code, Gemini CLI, Codex, Cursor, or Kimi-Coder) and hit Scan again. It shows up here automatically, nothing to configure."
        />
      ) : (
        <>
          {/* Ready — the agents you can start right now. */}
          {ready.length > 0 ? (
            <SettingsSection title="Ready">
              {ready.map((agent) => {
                const canonical = canonicalAgentId(agent.id);
                const name = agentDisplayLabel(canonical);
                const pinned = isPinned(agent.id);
                return (
                  <SettingsRow
                    key={agent.id}
                    title={
                      <SettingsServiceTitle
                        mark={
                          <SettingsServiceMark>
                            <AgentIcon agentId={canonical} label={agent.label} size={16} />
                          </SettingsServiceMark>
                        }
                      >
                        {name}
                      </SettingsServiceTitle>
                    }
                    description={agent.description}
                    control={
                      <SettingsActions>
                        <Button
                          variant="ghost"
                          size="iconSm"
                          className="ui-customize-pin"
                          onClick={() => togglePin(agent.id)}
                          aria-pressed={pinned}
                          aria-label={pinned ? `Unpin ${name}` : `Pin ${name}`}
                          title={
                            pinned
                              ? `${name} leads the New-tab menu. Click to unpin it.`
                              : `Put ${name} at the top of the New-tab menu`
                          }
                        >
                          <Pin />
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => start(agent)}>
                          Start
                          <ArrowUpRight />
                        </Button>
                      </SettingsActions>
                    }
                  />
                );
              })}
            </SettingsSection>
          ) : null}

          {/* Supported but not found — discoverable, dimmed, with the brand
              mark so the user knows what's out there to add. */}
          {notInstalled.length > 0 ? (
            <SettingsSection title="Available to add">
              {notInstalled.map((agent) => {
                const canonical = canonicalAgentId(agent.id);
                return (
                  <SettingsRow
                    key={agent.id}
                    className="ui-customize-dim"
                    title={
                      <SettingsServiceTitle
                        mark={
                          <SettingsServiceMark>
                            <AgentIcon agentId={canonical} label={agent.label} size={16} />
                          </SettingsServiceMark>
                        }
                      >
                        {agentDisplayLabel(canonical)}
                      </SettingsServiceTitle>
                    }
                    description="Not installed on this machine"
                    control={
                      <Badge variant="outline">
                        <Download size={12} />
                        Install
                      </Badge>
                    }
                  />
                );
              })}
            </SettingsSection>
          ) : null}

          {/* Add your own — the real power-user path: a [[agent]] block in the
              TOML, then Scan again. Honest about what "add" means. */}
          <Card>
            <SettingsRow
              title={
                <SettingsServiceTitle
                  mark={
                    <SettingsServiceMark>
                      <Plus />
                    </SettingsServiceMark>
                  }
                >
                  Add your own agent
                </SettingsServiceTitle>
              }
              description={
                <>
                  Point Aura at any CLI by adding an <code>[[agent]]</code> block to{" "}
                  <code>~/.aura/agents.toml</code>, then hit Scan again. No rebuild needed.
                </>
              }
              control={null}
            />
          </Card>
        </>
      )}
    </PaneScroll>
  );
}
