// Settings → Plugins.
//
// Reads `~/.aura/plugins/<scope>/<name>/aura.{plugin,skill,mcp}.json`
// via the Tauri `plugin_*` commands (cmd_plugin.rs). Three groups: native
// plugins, skills, MCP servers. Each row's switch sets its enabled state;
// the on-disk `.state.json` is the source of truth, so `aura plugin
// enable/disable` from the CLI and a click here converge.

import { useEffect, useMemo, useState } from "react";
import { ExternalLink } from "lucide-react";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import {
  SettingsActions,
  SettingsEmpty,
  SettingsError,
  SettingsIntro,
  SettingsStatusLine,
} from "../ui/settings-blocks";
import { SettingsRow, SettingsSection } from "../ui/settings-row";
import { api, type PluginRow, type PluginSecretRow } from "../../lib/api";
import { refreshPluginContributes } from "../../lib/pluginContributesStore";
import { refreshMcpTools } from "../../lib/mcpToolsStore";

export function PluginsTab() {
  const [rows, setRows] = useState<PluginRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);

  const refresh = async () => {
    try {
      setRows(await api.pluginList());
      setError(null);
      // Keep the slash-command + rail-tile catalog in lockstep with the
      // enabled set on screen.
      void refreshPluginContributes();
    } catch (e) {
      setError(String(e));
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const rescan = async () => {
    setScanning(true);
    try {
      const report = await api.pluginRescan();
      await refresh();
      if (report.rejected.length > 0) {
        setError(`${report.rejected.length} manifest(s) rejected. Check ~/.aura/plugins`);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setScanning(false);
    }
  };

  const setEnabled = async (kind: PluginRow["kind"], id: string, next: boolean) => {
    try {
      if (next) await api.pluginEnable(kind, id);
      else await api.pluginDisable(kind, id);
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  };

  const groups = useMemo(() => {
    const list = rows ?? [];
    return {
      plugin: list.filter((r) => r.kind === "plugin"),
      skill: list.filter((r) => r.kind === "skill"),
      mcp: list.filter((r) => r.kind === "mcp"),
    };
  }, [rows]);

  // Secrets are bundle-scoped, but a bundle can ship several manifests
  // (plugin + mcp). The secret rows go under exactly ONE row per bundle:
  // the native plugin row when present (it carries the declared titles),
  // else whichever row got there first.
  const secretsOwners = useMemo(() => {
    const byBundle = new Map<string, PluginRow>();
    for (const r of rows ?? []) {
      if (!r.bundle) continue;
      const cur = byBundle.get(r.bundle);
      if (!cur || (cur.kind !== "plugin" && r.kind === "plugin")) byBundle.set(r.bundle, r);
    }
    return new Set([...byBundle.values()].map((r) => `${r.kind}/${r.id}`));
  }, [rows]);

  const count =
    rows === null ? (
      <span className="ui-settings-status" role="status">
        <AsciiSpinner />
        Looking for installed plugins…
      </span>
    ) : (
      `${rows.length} installed · ${groups.plugin.length} plugin · ${groups.skill.length} skill · ${groups.mcp.length} MCP`
    );

  return (
    <>
      <SettingsIntro>
        Plugins, skills and MCP servers under <code>~/.aura/plugins</code>. Aura rescans when the
        folder changes, and what you switch on stays on.
      </SettingsIntro>
      {error && <SettingsError>{error}</SettingsError>}
      <SettingsStatusLine text={count} onRefresh={() => void rescan()} refreshing={scanning} />
      {rows !== null && rows.length === 0 ? (
        <SettingsEmpty>
          No plugins installed. Drop a manifest under{" "}
          <code>~/.aura/plugins/&lt;scope&gt;/&lt;name&gt;/</code> and press Refresh.
        </SettingsEmpty>
      ) : (
        (
          [
            ["Plugins", groups.plugin],
            ["Skills", groups.skill],
            ["MCP servers", groups.mcp],
          ] as const
        ).map(([title, entries]) =>
          entries.length === 0 ? null : (
            <SettingsSection key={title} title={title}>
              {entries.map((row) => (
                <PluginEntry
                  key={`${row.kind}/${row.id}`}
                  row={row}
                  ownsSecrets={!!row.bundle && secretsOwners.has(`${row.kind}/${row.id}`)}
                  onToggle={(next) => void setEnabled(row.kind, row.id, next)}
                />
              ))}
            </SettingsSection>
          ),
        )
      )}
    </>
  );
}

function PluginEntry({
  row,
  ownsSecrets,
  onToggle,
}: {
  row: PluginRow;
  ownsSecrets: boolean;
  onToggle: (next: boolean) => void;
}) {
  return (
    <>
      <SettingsRow
        title={row.id}
        description={row.description ?? undefined}
        help={
          <>
            v{row.version} · {row.capabilities_count} capabilit
            {row.capabilities_count === 1 ? "y" : "ies"} · <code>{row.install_dir}</code>
          </>
        }
        control={
          <SettingsActions>
            <SignatureBadge row={row} />
            <Switch
              aria-label={`Enable ${row.id}`}
              checked={row.enabled}
              onCheckedChange={onToggle}
            />
          </SettingsActions>
        }
      />
      {ownsSecrets && row.bundle && <PluginSecretRows bundle={row.bundle} owner={row.id} />}
    </>
  );
}

// Signature verdict. Verified names the publisher; an unknown key reads
// "Unverified publisher" with the key id on hover; unsigned says so.
// Tampered bundles never reach this list: the registry rejects them at
// scan time.
function SignatureBadge({ row }: { row: PluginRow }) {
  if (row.signature === "verified") {
    return (
      <Badge
        variant="highlight"
        title={`Signed by ${row.signed_by ?? "unknown"}. Bundle contents verified`}
      >
        ✓ {row.signed_by}
      </Badge>
    );
  }
  if (row.signature === "unknown_key") {
    return (
      <Badge
        variant="outline"
        title={
          row.signed_by
            ? `Signed with key ${row.signed_by}, which is not in this machine's trust store`
            : "Signed with a key that is not in this machine's trust store"
        }
      >
        Unverified publisher
      </Badge>
    );
  }
  return (
    <Badge variant="secondary" title="This bundle carries no publisher signature">
      Unsigned
    </Badge>
  );
}

// The bundle's secrets, one row each, under the plugin that declares them.
// Values are write-only from here: they go straight into the OS keychain
// and only resurface inside the MCP child's environment at spawn. The
// status call reports existence, never values.
function PluginSecretRows({ bundle, owner }: { bundle: string; owner: string }) {
  const [rows, setRows] = useState<PluginSecretRow[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const refresh = async () => {
    try {
      setRows(await api.pluginSecretsStatus(bundle));
      setErr(null);
    } catch (e) {
      // Unknown bundle / scan race: hide rather than alarm.
      console.warn(`[plugins] secrets status failed for ${bundle}:`, e);
      setRows([]);
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bundle]);

  if (!rows || rows.length === 0) return null;

  const save = async (key: string) => {
    const value = (drafts[key] ?? "").trim();
    if (!value) return;
    setBusy(key);
    try {
      await api.pluginSecretSet(bundle, key, value);
      setDrafts((d) => ({ ...d, [key]: "" }));
      setErr(null);
      await refresh();
      // Servers that failed their probe with "secret not set" can now
      // spawn, so the cached tool catalog is read again.
      void refreshMcpTools();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(null);
    }
  };

  const clear = async (key: string) => {
    setBusy(key);
    try {
      await api.pluginSecretClear(bundle, key);
      setErr(null);
      await refresh();
      void refreshMcpTools();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      {err && <SettingsError>{err}</SettingsError>}
      {rows.map((s) => {
        const id = `plugin-secret-${bundle}-${s.key}`;
        return (
          <SettingsRow
            key={s.key}
            title={s.title ?? s.key}
            htmlFor={id}
            description={
              s.set
                ? `${owner} secret · stored in your OS keychain.`
                : `${owner} secret · not set yet.`
            }
            control={
              <SettingsActions>
                <Input
                  id={id}
                  type="password"
                  autoComplete="off"
                  value={drafts[s.key] ?? ""}
                  onChange={(e) => setDrafts((d) => ({ ...d, [s.key]: e.target.value }))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void save(s.key);
                  }}
                  placeholder={s.set ? "Replace value" : "Paste value"}
                />
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy === s.key || !(drafts[s.key] ?? "").trim()}
                  onClick={() => void save(s.key)}
                >
                  Set
                </Button>
                {s.set && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy === s.key}
                    onClick={() => void clear(s.key)}
                  >
                    Clear
                  </Button>
                )}
                {s.url && (
                  <Button
                    size="iconSm"
                    variant="ghost"
                    aria-label={`Open token page: ${s.url}`}
                    onClick={() => {
                      void (async () => {
                        const { openUrl } = await import("@tauri-apps/plugin-opener");
                        await openUrl(s.url as string);
                      })();
                    }}
                  >
                    <ExternalLink size={14} />
                  </Button>
                )}
              </SettingsActions>
            }
          />
        );
      })}
    </>
  );
}
