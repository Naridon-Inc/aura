// MCP Servers pane — the agent's connections to the outside world. An MCP
// server is a bridge that lets your agent reach a tool you already use (Linear,
// GitHub, Sentry, a database…) and act in it. Here you see every connection
// and switch it on or off. Setting one up — pasting a key, signing in — is a
// few more fields, so the primary action hands you to the full connection
// manager rather than half-doing it here.

import { useState } from "react";
import { Loader2, Plug, Settings2 } from "lucide-react";

import { api, type McpServerEntry } from "../../../lib/api";
import { Button } from "../../ui/button";
import { Switch } from "../../ui/switch";
import {
  Card,
  EmptyHint,
  PaneIntro,
  PaneScroll,
  PaneSpinner,
} from "./customizeShared";

export function McpServersPane({
  mcp,
  loading,
  refresh,
  onClose,
}: {
  mcp: McpServerEntry[];
  loading: boolean;
  refresh: () => void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);

  const manage = () => {
    onClose();
    window.dispatchEvent(
      new CustomEvent("aura:open-settings", { detail: { pane: "mcp" } }),
    );
  };

  const toggle = async (row: McpServerEntry) => {
    setBusy(row.name);
    try {
      await api.mcpServersToggle(row.name, !row.enabled);
      refresh();
    } catch {
      refresh();
    } finally {
      setBusy(null);
    }
  };

  return (
    <PaneScroll>
      <PaneIntro
        title="Connections"
        blurb="Let your agent work in the tools you already use — issue trackers, error monitors, databases. Switch a connection on to make it available, off to cut access."
        action={
          <Button size="sm" variant="subtle" onClick={manage} className="gap-1">
            <Settings2 size={14} />
            Manage
          </Button>
        }
      />
      {loading && mcp.length === 0 ? (
        <PaneSpinner label="Loading connections…" />
      ) : mcp.length === 0 ? (
        <EmptyHint
          icon={<Plug size={22} />}
          title="No connections yet"
          body="Connect a tool so your agent can read and act in it — like creating an issue or checking an error."
          action={
            <Button size="sm" onClick={manage} className="gap-1">
              <Plug size={14} />
              Add a connection
            </Button>
          }
        />
      ) : (
        <Card>
          {mcp.map((row, i) => (
            <div
              key={row.name}
              className={`flex items-center gap-3 px-3.5 py-3 ${
                i > 0 ? "border-t border-line-soft" : ""
              }`}
            >
              <Plug size={15} className="shrink-0 text-text-4" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12.5px] font-medium text-text-1">
                  {row.name}
                </div>
                <div className="truncate text-[11.5px] text-text-4">
                  {row.description || row.server_url || row.command}
                </div>
              </div>
              {busy === row.name ? (
                <Loader2 size={15} className="shrink-0 animate-spin text-text-4" />
              ) : (
                <Switch
                  checked={row.enabled}
                  onCheckedChange={() => toggle(row)}
                  aria-label={
                    row.enabled ? "Turn connection off" : "Turn connection on"
                  }
                />
              )}
            </div>
          ))}
        </Card>
      )}
    </PaneScroll>
  );
}
