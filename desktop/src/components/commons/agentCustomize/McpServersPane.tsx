// MCP Servers pane — the agent's connections to the outside world. An MCP
// server is a bridge that lets your agent reach a tool you already use (Linear,
// GitHub, Sentry, a database…) and act in it. Here you see every connection
// and switch it on or off. Setting one up — pasting a key, signing in — is a
// few more fields, so the primary action hands you to the full connection
// manager rather than half-doing it here.

import { useState } from "react";
import { Plug, Settings2 } from "lucide-react";

import { api, type McpServerEntry } from "../../../lib/api";
import { AsciiSpinner } from "../../ui/ascii-spinner";
import { Button } from "../../ui/button";
import { SettingsMcpToolbar } from "../../ui/settings-mcp-parts";
import { SettingsRow } from "../../ui/settings-row";
import { SettingsServiceMark, SettingsServiceTitle } from "../../ui/settings-services-row";
import { Switch } from "../../ui/switch";
import { Card, EmptyHint, PaneIntro, PaneScroll, PaneSpinner } from "./customizeShared";

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

  const on = mcp.filter((row) => row.enabled).length;

  return (
    <PaneScroll>
      <PaneIntro
        title="Connections"
        blurb="Let your agent work in the tools you already use. Issue trackers, error monitors, databases. Switch a connection on to make it available, off to cut access."
      />
      {/* Setting one up — a key, a sign-in — is the full connection manager's
          job, so the page's one action hands you there, from a row's control
          slot the way the connections settings page carries its toolbar. */}
      <Card>
        <SettingsRow
          title="Your connections"
          description={mcp.length > 0 ? `${mcp.length} configured · ${on} on` : undefined}
          control={
            <SettingsMcpToolbar>
              <Button size="sm" variant="ghost" onClick={manage}>
                <Settings2 />
                Manage
              </Button>
            </SettingsMcpToolbar>
          }
        />
      </Card>
      {loading && mcp.length === 0 ? (
        <PaneSpinner label="Loading connections…" />
      ) : mcp.length === 0 ? (
        <EmptyHint
          icon={Plug}
          title="No connections yet"
          body="Connect a tool so your agent can read and act in it, like creating an issue or checking an error."
          action={{ label: "Add a connection", onClick: manage, icon: Plug }}
        />
      ) : (
        <Card>
          {mcp.map((row) => (
            <SettingsRow
              key={row.name}
              title={
                <SettingsServiceTitle
                  mark={
                    <SettingsServiceMark>
                      <Plug />
                    </SettingsServiceMark>
                  }
                >
                  {row.name}
                </SettingsServiceTitle>
              }
              description={row.description || row.server_url || row.command}
              control={
                busy === row.name ? (
                  <AsciiSpinner />
                ) : (
                  <Switch
                    checked={row.enabled}
                    onCheckedChange={() => toggle(row)}
                    aria-label={row.enabled ? "Turn connection off" : "Turn connection on"}
                  />
                )
              }
            />
          ))}
        </Card>
      )}
    </PaneScroll>
  );
}
