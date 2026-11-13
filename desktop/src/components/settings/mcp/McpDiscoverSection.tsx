// "Discovered from your agents": servers already set up in another agent's
// config (and already signed into there), offered for import in one go.

import type { DiscoveredMcp } from "../../../lib/api";
import { AsciiSpinner } from "../../ui/ascii-spinner";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { Checkbox } from "../../ui/checkbox";
import { SettingsEmpty, SettingsError } from "../../ui/settings-blocks";
import { SettingsMcpTitle, SettingsMcpToolbar } from "../../ui/settings-mcp-parts";
import { SettingsRow, SettingsSection } from "../../ui/settings-row";
import { discoveredKey } from "./mcpTemplates";

export function McpDiscoverSection({
  discovered,
  discovering,
  error,
  picked,
  onPick,
  onImport,
  onCancel,
  busy,
}: {
  discovered: DiscoveredMcp[] | null;
  discovering: boolean;
  error: string | null;
  picked: Set<string>;
  onPick: (next: Set<string>) => void;
  onImport: () => void;
  onCancel: () => void;
  busy: boolean;
}) {
  const importable = (discovered ?? []).filter((d) => !d.already_imported);
  const toggle = (k: string) => {
    const next = new Set(picked);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    onPick(next);
  };
  return (
    <SettingsSection title="Discovered from your agents">
      {error && <SettingsError>{error}</SettingsError>}
      {discovered === null && discovering && (
        <p className="ui-settings-status">
          <AsciiSpinner />
          Scanning agent configs…
        </p>
      )}
      {discovered !== null && discovered.length === 0 && !discovering && (
        <SettingsEmpty>
          Nothing new found. Aura scans Claude Code, Claude Desktop, Cursor, Windsurf, Cline, Roo
          Cline, Zed, opencode, Gemini CLI, Codex, and repo-local <code>.mcp.json</code>. Configure
          a server in any of those and re-run.
        </SettingsEmpty>
      )}
      {discovered !== null && discovered.length > 0 && (
        <>
          <SettingsRow
            title={`${picked.size} selected`}
            description={`${discovered.length} server${discovered.length === 1 ? "" : "s"} found · ${importable.length} importable`}
            control={
              <SettingsMcpToolbar>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => onPick(new Set(importable.map((d) => discoveredKey(d))))}
                >
                  Select all
                </Button>
                <Button size="sm" variant="ghost" onClick={() => onPick(new Set())}>
                  Clear
                </Button>
                <Button size="sm" variant="ghost" onClick={onCancel} disabled={busy}>
                  Cancel
                </Button>
                <Button size="sm" onClick={onImport} disabled={busy || picked.size === 0}>
                  Import {picked.size > 0 ? `(${picked.size})` : ""}
                </Button>
              </SettingsMcpToolbar>
            }
          />
          {discovered.map((d) => {
            const k = discoveredKey(d);
            const envCount = Object.keys(d.env).length;
            return (
              <SettingsRow
                key={`${k}::${d.source}`}
                title={
                  <SettingsMcpTitle name={d.name}>
                    <Badge variant="outline">{d.source}</Badge>
                    {d.already_imported && <Badge variant="highlight">already imported</Badge>}
                  </SettingsMcpTitle>
                }
                description={<code>{`${d.command} ${d.args.join(" ")}`}</code>}
                help={
                  envCount > 0
                    ? `${envCount} env var${envCount === 1 ? "" : "s"} inherited`
                    : undefined
                }
                control={
                  <Checkbox
                    aria-label={`Import ${d.name}`}
                    checked={picked.has(k)}
                    disabled={d.already_imported}
                    onCheckedChange={() => toggle(k)}
                  />
                }
              />
            );
          })}
        </>
      )}
    </SettingsSection>
  );
}
