// Plugins pane — the add-ons installed in this workspace. A plugin extends
// what Aura itself can do (a new panel, a game in the Lounge, a shared tool).
// Every plugin here is a signed bundle on disk, so we show who signed it and
// let you switch it on or off. Finding and installing new ones lives in the
// Extensions browser, one click away.

import { useState } from "react";
import { BadgeCheck, Blocks, ShieldAlert } from "lucide-react";

import { api, type PluginRow } from "../../../lib/api";
import { Button } from "../../ui/button";
import { Switch } from "../../ui/switch";
import {
  Card,
  EmptyHint,
  PaneIntro,
  PaneScroll,
  PaneSpinner,
} from "./customizeShared";

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
        action={
          <Button
            size="sm"
            variant="subtle"
            onClick={() => window.dispatchEvent(new CustomEvent("aura:open-extensions"))}
          >
            Browse add-ons
          </Button>
        }
      />
      {loading && plugins.length === 0 ? (
        <PaneSpinner label="Loading plugins…" />
      ) : rows.length === 0 ? (
        <EmptyHint
          icon={Blocks}
          title="No plugins installed"
          body="Browse add-ons to install one. Aura only runs plugins that are signed, so you always know what you're getting."
        />
      ) : (
        <Card>
          {rows.map((row, i) => (
            <div
              key={row.id}
              className={`flex items-center gap-3 px-3.5 py-3 ${
                i > 0 ? "border-t border-line-soft" : ""
              }`}
            >
              <Blocks size={15} className="shrink-0 text-text-4" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-base font-medium text-text-1">
                    {row.id}
                  </span>
                  <SignatureMark row={row} />
                </div>
                {row.description ? (
                  <div className="truncate text-sm text-text-4">
                    {row.description}
                  </div>
                ) : null}
              </div>
              <Switch
                checked={row.enabled}
                disabled={busy === row.id}
                onCheckedChange={() => toggle(row)}
                aria-label={row.enabled ? "Turn plugin off" : "Turn plugin on"}
              />
            </div>
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
        className="inline-flex items-center gap-0.5 text-2xs"
        style={{ color: "var(--color-accent)" }}
        title={row.signed_by ? `Signed by ${row.signed_by}` : "Signed"}
      >
        <BadgeCheck size={12} />
      </span>
    );
  }
  if (row.signature === "unknown_key") {
    return (
      <span
        className="inline-flex items-center gap-0.5 text-2xs text-amber"
        title="Signed by a publisher you haven't trusted yet"
      >
        <ShieldAlert size={12} />
      </span>
    );
  }
  return null;
}
