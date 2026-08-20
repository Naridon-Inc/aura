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

import { api } from "../../../lib/api";
import type { Agent } from "../../../lib/agents";
import { usePinned } from "../../../lib/agentPrefs";
import { AgentIcon } from "../../agent/AgentIcon";
import { agentDisplayLabel, canonicalAgentId } from "../../../lib/agentIdentity";
import { Button } from "../../ui/button";
import {
  Card,
  CountPill,
  EmptyHint,
  PaneIntro,
  PaneScroll,
  PaneSpinner,
} from "./customizeShared";

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
      await api.agentsReload();
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
        action={
          <Button
            size="sm"
            variant="subtle"
            onClick={scan}
            disabled={scanning || loading}
            className="gap-1.5"
          >
            <RefreshCw
              size={13}
              className={scanning ? "animate-spin" : undefined}
            />
            Scan again
          </Button>
        }
      />

      {loading && agents.length === 0 ? (
        <PaneSpinner label="Looking for installed agents…" />
      ) : agents.length === 0 ? (
        <EmptyHint
          icon={Bot}
          title="No coding agents found yet"
          body="Install one (Claude Code, Gemini CLI, Codex, Cursor, or Kimi-Coder) and hit Scan again. It shows up here automatically, nothing to configure."
        />
      ) : (
        <div className="space-y-6">
          {/* Ready — the agents you can start right now. */}
          {ready.length > 0 ? (
            <section>
              <SectionLabel>
                Ready <CountPill>{ready.length}</CountPill>
              </SectionLabel>
              <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                {ready.map((agent) => {
                  const canonical = canonicalAgentId(agent.id);
                  return (
                    <Card
                      key={agent.id}
                      className="flex items-center gap-3 p-3"
                    >
                      <AgentIcon
                        agentId={canonical}
                        label={agent.label}
                        size={26}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-base font-medium text-text-1">
                          {agentDisplayLabel(canonical)}
                        </div>
                        <div className="truncate text-sm text-text-4">
                          {agent.description}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => togglePin(agent.id)}
                        aria-pressed={isPinned(agent.id)}
                        title={
                          isPinned(agent.id)
                            ? `${agentDisplayLabel(canonical)} leads the New-tab menu. Click to unpin it.`
                            : `Put ${agentDisplayLabel(canonical)} at the top of the New-tab menu`
                        }
                        className="shrink-0 rounded-md p-1.5 transition-colors hover:bg-state-hover"
                        style={{
                          color: isPinned(agent.id)
                            ? "var(--color-blue)"
                            : "var(--color-text-4)",
                        }}
                      >
                        <Pin
                          size={14}
                          className={isPinned(agent.id) ? "fill-current" : undefined}
                        />
                      </button>
                      <Button
                        size="sm"
                        variant="subtle"
                        onClick={() => start(agent)}
                        className="shrink-0 gap-1"
                      >
                        Start
                        <ArrowUpRight size={13} />
                      </Button>
                    </Card>
                  );
                })}
              </div>
            </section>
          ) : null}

          {/* Supported but not found — discoverable, dimmed, with the brand
              mark so the user knows what's out there to add. */}
          {notInstalled.length > 0 ? (
            <section>
              <SectionLabel>
                Available to add <CountPill>{notInstalled.length}</CountPill>
              </SectionLabel>
              <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                {notInstalled.map((agent) => {
                  const canonical = canonicalAgentId(agent.id);
                  return (
                    <Card
                      key={agent.id}
                      className="flex items-center gap-3 p-3 opacity-70"
                    >
                      <span className="grayscale">
                        <AgentIcon
                          agentId={canonical}
                          label={agent.label}
                          size={26}
                        />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-base font-medium text-text-2">
                          {agentDisplayLabel(canonical)}
                        </div>
                        <div className="truncate text-sm text-text-4">
                          Not installed on this machine
                        </div>
                      </div>
                      <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-bg-2 px-2 py-0.5 text-xs font-medium text-text-4">
                        <Download size={11} />
                        Install
                      </span>
                    </Card>
                  );
                })}
              </div>
            </section>
          ) : null}

          {/* Add your own — the real power-user path: a [[agent]] block in the
              TOML, then Scan again. Honest about what "add" means. */}
          <section>
            <Card className="flex items-start gap-3 p-3.5">
              <Plus size={15} className="mt-0.5 shrink-0 text-text-4" />
              <div className="min-w-0 flex-1">
                <div className="text-base font-medium text-text-1">
                  Add your own agent
                </div>
                <div className="mt-0.5 text-sm leading-relaxed text-text-4">
                  Point Aura at any CLI by adding an{" "}
                  <code className="rounded bg-bg-2 px-1 py-0.5 text-xs">
                    [[agent]]
                  </code>{" "}
                  block to{" "}
                  <code className="rounded bg-bg-2 px-1 py-0.5 text-xs">
                    ~/.aura/agents.toml
                  </code>
                  , then hit Scan again. No rebuild needed.
                </div>
              </div>
            </Card>
          </section>
        </div>
      )}
    </PaneScroll>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="section-label mb-2 flex items-center gap-2 px-0.5">
      {children}
    </div>
  );
}
