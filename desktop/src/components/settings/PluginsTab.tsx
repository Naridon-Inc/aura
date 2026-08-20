// Settings → Plugins pane.
//
// Reads `~/.aura/plugins/<scope>/<name>/aura.{plugin,skill,mcp}.json`
// via the Tauri `plugin_*` commands (cmd_plugin.rs). Three grouped
// lists: native plugins, skills, MCP servers. Each row toggles
// enabled state; the on-disk `.state.json` is the source of truth, so
// `aura plugin enable/disable` from the CLI and a click here converge.

import { useEffect, useMemo, useState } from "react";
import { ExternalLink, Puzzle } from "lucide-react";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { EmptyState } from "../ui/state";
import { api, type PluginRow, type PluginSecretRow } from "../../lib/api";
import { refreshPluginContributes } from "../../lib/pluginContributesStore";
import { refreshMcpTools } from "../../lib/mcpToolsStore";
import { PaneIntro, Section, Toggle } from "../settings/kit";

export function PluginsTab() {
  const [rows, setRows] = useState<PluginRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const list = await api.pluginList();
      setRows(list);
      setError(null);
      // Keep slash-command + rail-tile catalog in lockstep with the
      // enabled set the user is staring at.
      void refreshPluginContributes();
    } catch (e) {
      setError(String(e));
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const rescan = async () => {
    try {
      const report = await api.pluginRescan();
      await refresh();
      if (report.rejected.length > 0) {
        setError(
          `${report.rejected.length} manifest(s) rejected. Check ~/.aura/plugins`,
        );
      }
    } catch (e) {
      setError(String(e));
    }
  };

  const setEnabled = async (
    kind: PluginRow["kind"],
    id: string,
    next: boolean,
  ) => {
    try {
      if (next) {
        await api.pluginEnable(kind, id);
      } else {
        await api.pluginDisable(kind, id);
      }
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
  // (plugin + mcp). Render the secrets editor on exactly ONE row per
  // bundle — the native plugin row when present (it carries the
  // declared titles), else whichever row got there first.
  const secretsOwners = useMemo(() => {
    const byBundle = new Map<string, PluginRow>();
    for (const r of rows ?? []) {
      if (!r.bundle) continue;
      const cur = byBundle.get(r.bundle);
      if (!cur || (cur.kind !== "plugin" && r.kind === "plugin")) {
        byBundle.set(r.bundle, r);
      }
    }
    return new Set([...byBundle.values()].map((r) => `${r.kind}/${r.id}`));
  }, [rows]);

  return (
    <>
      <PaneIntro text="Plugins, skills, and MCP servers under ~/.aura/plugins. The shell rescans on disk changes; enable state persists to .state.json." />
      {error && (
        <div className="text-sm text-red mb-3" role="alert">
          {error}
        </div>
      )}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-1.5 text-sm text-text-3">
          {rows === null ? (
            <>
              <AsciiSpinner className="text-sm leading-none" />
              Looking for installed plugins…
            </>
          ) : (
            `${rows.length} installed (${groups.plugin.length} plugin · ${groups.skill.length} skill · ${groups.mcp.length} mcp)`
          )}
        </div>
        <Button size="sm" variant="ghost" onClick={rescan}>
          Rescan
        </Button>
      </div>
      {rows !== null && rows.length === 0 ? (
        <EmptyState
          icon={Puzzle}
          title="No plugins installed"
          size="sm"
          body={
            <>
              Drop a manifest under{" "}
              <code className="text-text-3">
                ~/.aura/plugins/&lt;scope&gt;/&lt;name&gt;/
              </code>{" "}
              and click Rescan.
            </>
          }
        />
      ) : (
        <>
          <PluginGroup
            title="Plugins"
            entries={groups.plugin}
            onToggle={setEnabled}
            secretsOwners={secretsOwners}
          />
          <PluginGroup
            title="Skills"
            entries={groups.skill}
            onToggle={setEnabled}
            secretsOwners={secretsOwners}
          />
          <PluginGroup
            title="MCP Servers"
            entries={groups.mcp}
            onToggle={setEnabled}
            secretsOwners={secretsOwners}
          />
        </>
      )}
    </>
  );
}

function PluginGroup({
  title,
  entries,
  onToggle,
  secretsOwners,
}: {
  title: string;
  entries: PluginRow[];
  onToggle: (kind: PluginRow["kind"], id: string, next: boolean) => void;
  secretsOwners: Set<string>;
}) {
  if (entries.length === 0) return null;
  return (
    <Section title={title}>
      <div className="flex flex-col gap-1">
        {entries.map((row) => (
          <div
            key={`${row.kind}/${row.id}`}
            className="flex items-start justify-between gap-3 py-2 border-b border-line-soft last:border-b-0"
          >
            <div className="flex-1 min-w-0">
              <div className="flex items-baseline gap-2">
                <span className="text-base text-text-1 font-medium truncate">
                  {row.id}
                </span>
                <span className="text-xs text-text-4">v{row.version}</span>
                <span className="text-2xs text-text-4 px-1.5 py-0.5 rounded bg-bg-1">
                  {row.capabilities_count} cap
                  {row.capabilities_count === 1 ? "" : "s"}
                </span>
                <SignatureBadge row={row} />
              </div>
              {row.description && (
                <div className="text-sm text-text-3 mt-0.5 line-clamp-2">
                  {row.description}
                </div>
              )}
              <div className="text-xs text-text-4 mt-0.5 truncate">
                {row.install_dir}
              </div>
              {row.bundle &&
                secretsOwners.has(`${row.kind}/${row.id}`) && (
                  <PluginSecretsEditor bundle={row.bundle} />
                )}
            </div>
            <Toggle
              label=""
              value={row.enabled}
              onChange={(next) => onToggle(row.kind, row.id, next)}
            />
          </div>
        ))}
      </div>
    </Section>
  );
}

// Signature verdict chip (P3). Verified = green check + publisher
// (status color, per palette rules); unknown key = neutral
// "unverified publisher" with the key id on hover; unsigned = dim
// text. Tampered bundles never reach this list — the registry
// rejects them at scan time.
function SignatureBadge({ row }: { row: PluginRow }) {
  if (row.signature === "verified") {
    return (
      <span
        className="text-2xs px-1.5 py-0.5 rounded bg-accent-green/10 text-accent-green whitespace-nowrap"
        title={`Signed by ${row.signed_by ?? "unknown"}. Bundle contents verified`}
      >
        ✓ {row.signed_by}
      </span>
    );
  }
  if (row.signature === "unknown_key") {
    return (
      <span
        className="text-2xs px-1.5 py-0.5 rounded bg-bg-1 text-text-4 whitespace-nowrap"
        title={
          row.signed_by
            ? `Signed with key ${row.signed_by}, which is not in this machine's trust store`
            : "Signed with a key that is not in this machine's trust store"
        }
      >
        unverified publisher
      </span>
    );
  }
  return (
    <span
      className="text-2xs text-text-4/70 whitespace-nowrap"
      title="This bundle carries no publisher signature"
    >
      unsigned
    </span>
  );
}

// Bundle-scoped secrets editor (P2 secrets broker). Values are write-
// only from here: they go straight into the OS keychain and only ever
// resurface inside the MCP child's environment at spawn. The status
// call reports existence, never values.
function PluginSecretsEditor({ bundle }: { bundle: string }) {
  const [rows, setRows] = useState<PluginSecretRow[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const refresh = async () => {
    try {
      setRows(await api.pluginSecretsStatus(bundle));
      setErr(null);
    } catch (e) {
      // Unknown bundle / scan race — hide rather than alarm.
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
      // spawn — refresh the cached tool catalog.
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
    <div className="mt-2 rounded border border-line-soft bg-bg-1/40 px-2.5 py-2">
      <div className="text-xs font-medium text-text-4 mb-1.5">
        Secrets
      </div>
      {err && (
        <div className="text-xs text-red mb-1.5" role="alert">
          {err}
        </div>
      )}
      <div className="flex flex-col gap-1.5">
        {rows.map((s) => (
          <div key={s.key} className="flex items-center gap-2">
            <span
              className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${
                s.set ? "bg-accent-green" : "bg-text-4/40"
              }`}
              title={s.set ? "Stored in OS keychain" : "Not set"}
            />
            <span
              className="text-sm text-text-2 w-[160px] truncate shrink-0"
              title={s.key}
            >
              {s.title ?? s.key}
            </span>
            <Input
              type="password"
              autoComplete="off"
              value={drafts[s.key] ?? ""}
              onChange={(e) =>
                setDrafts((d) => ({ ...d, [s.key]: e.target.value }))
              }
              onKeyDown={(e) => {
                if (e.key === "Enter") void save(s.key);
              }}
              placeholder={s.set ? "••••••••  (replace)" : "paste value"}
              className="flex-1 min-w-0"
            />
            <Button
              size="sm"
              variant="ghost"
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
              <button
                type="button"
                title={`Open token page: ${s.url}`}
                className="p-1 text-text-4 hover:text-text-1"
                onClick={() => {
                  void (async () => {
                    const { openUrl } = await import(
                      "@tauri-apps/plugin-opener"
                    );
                    await openUrl(s.url as string);
                  })();
                }}
              >
                <ExternalLink size={12} />
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
