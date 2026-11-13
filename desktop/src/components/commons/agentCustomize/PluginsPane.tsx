// Plugins pane — the add-ons installed in this workspace. A plugin extends
// what Aura itself can do (a new panel, a game in the Lounge, a shared tool).
// Every plugin here is a signed bundle on disk, so we show who signed it and
// let you switch it on or off.

import { useState } from "react";
import { BadgeCheck, Blocks, ShieldAlert } from "lucide-react";

import { api, type PluginRow } from "../../../lib/api";
import { SettingsRow } from "../../ui/settings-row";
import { SettingsServiceMark, SettingsServiceTitle } from "../../ui/settings-services-row";
import { Switch } from "../../ui/switch";
import { Card, EmptyHint, PaneIntro, PaneScroll, PaneSpinner } from "./customizeShared";

export function PluginsPane({
  plugins,
  loading,
  refresh,
}: {
  plugins: PluginRow[];
  loading: boolean;
  refresh: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  // Skills get their own pane; MCP bundles show under Connections. This pane
  // is the actual UI/worker plugins.
  const rows = plugins.filter((p) => p.kind === "plugin");

  const toggle = async (row: PluginRow) => {
    setBusy(row.id);
    try {
      if (row.enabled) await api.pluginDisable("plugin", row.id);
      else await api.pluginEnable("plugin", row.id);
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
        title="Plugins"
        blurb="Add-ons that extend what Aura can do. Each one is a signed package. You can see who made it and turn it on or off any time."
      />
      {loading && plugins.length === 0 ? (
        <PaneSpinner label="Loading plugins…" />
      ) : rows.length === 0 ? (
        <EmptyHint
          icon={Blocks}
          title="No plugins installed"
          body="Plugins you install land in ~/.aura/plugins and show up here. Aura only runs plugins that are signed, so you always know what you're getting."
        />
      ) : (
        <Card>
          {rows.map((row) => (
            <SettingsRow
              key={row.id}
              title={
                <SettingsServiceTitle
                  mark={
                    <SettingsServiceMark>
                      <Blocks />
                    </SettingsServiceMark>
                  }
                  badge={<SignatureMark row={row} />}
                >
                  {row.id}
                </SettingsServiceTitle>
              }
              description={row.description || undefined}
              control={
                <Switch
                  checked={row.enabled}
                  disabled={busy === row.id}
                  onCheckedChange={() => toggle(row)}
                  aria-label={row.enabled ? "Turn plugin off" : "Turn plugin on"}
                />
              }
            />
          ))}
        </Card>
      )}
    </PaneScroll>
  );
}

// A tiny trust mark: a calm check when the publisher is known, a muted warning
// when the key is unrecognized. Unsigned bundles never reach this list.
function SignatureMark({ row }: { row: PluginRow }) {
  if (row.signature === "verified") {
    return (
      <span
        className="ui-customize-signature"
        data-tone="ok"
        title={row.signed_by ? `Signed by ${row.signed_by}` : "Signed"}
      >
        <BadgeCheck />
      </span>
    );
  }
  if (row.signature === "unknown_key") {
    return (
      <span
        className="ui-customize-signature"
        data-tone="attention"
        title="Signed by a publisher you haven't trusted yet"
      >
        <ShieldAlert />
      </span>
    );
  }
  return null;
}
