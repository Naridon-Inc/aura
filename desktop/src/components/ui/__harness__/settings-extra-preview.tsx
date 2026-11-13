import { useState } from "react";
import { SettingsRow } from "../settings-row";
import { Input } from "../input";
import { Switch } from "../switch";
import { ProviderSettings } from "../provider-settings";
import { EnvironmentSettings, type EnvironmentVariable } from "../environment-settings";
const experimental = [
  "Auto permission mode",
  "Big terminal mode",
  "New workspace page",
  "Tab Freak Mode",
  "Split tabs",
  "Fork chat to new tab",
  "In-app browser preview",
  "Use legacy file preview and editing",
  "Show agent cost",
  "Workspace status matrix for local workspaces",
  "Add projects without GitHub",
  "Auto-run after setup",
  "Dashboard",
  "Voice mode",
  "Show sidebar resource usage",
  "Pokes",
  "Sidebar transparency",
  "Graphite stack support",
];
const advancedPaths = [
  "Root directory",
  "Claude Code executable path",
  "Codex executable path",
  "OpenCode executable path",
  "SSH private key path",
];
const advancedSwitches = [
  "Remote execution MCP",
  "Always allow local commands",
  "Enable file sync in new cloud workspaces",
  "Set upstream on plain git push",
];
export function SettingsExtraPreview({
  page,
  initialProvider,
}: {
  page: string;
  initialProvider?: string;
}) {
  const [paths, setPaths] = useState<Record<string, string>>({});
  const [flags, setFlags] = useState<Record<string, boolean>>({});
  const [variables, setVariables] = useState<EnvironmentVariable[]>([]);
  const [files, setFiles] = useState<string[]>([]);
  if (page === "agents")
    return (
      <ProviderSettings
        key={initialProvider}
        initialProvider={initialProvider}
        paths={paths}
        onPathChange={(provider, value) => setPaths({ ...paths, [provider]: value })}
      />
    );
  if (page === "environment")
    return (
      <EnvironmentSettings
        variables={variables}
        onChange={setVariables}
        files={files}
        onFilesChange={setFiles}
      />
    );
  if (page === "experimental")
    return (
      <>
        {experimental.map((title) => (
          <SettingsRow
            key={title}
            title={title}
            control={
              <Switch
                aria-label={title}
                checked={!!flags[title]}
                onCheckedChange={(value) => setFlags({ ...flags, [title]: value })}
              />
            }
          />
        ))}
      </>
    );
  if (page === "advanced")
    return (
      <>
        {advancedPaths.map((title) => (
          <SettingsRow
            key={title}
            title={title}
            control={
              <Input
                aria-label={title}
                placeholder="Default"
                value={paths[title] ?? ""}
                onChange={(event) => setPaths({ ...paths, [title]: event.target.value })}
              />
            }
          />
        ))}
        {advancedSwitches.map((title) => (
          <SettingsRow
            key={title}
            title={title}
            control={
              <Switch
                aria-label={title}
                checked={!!flags[title]}
                onCheckedChange={(value) => setFlags({ ...flags, [title]: value })}
              />
            }
          />
        ))}
      </>
    );
  return null;
}
