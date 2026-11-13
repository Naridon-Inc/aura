// "Ready to add": the connections Aura knows how to set up, one row each,
// with what each one needs said before you click.

import { Plus } from "lucide-react";
import type { McpServerEntry } from "../../../lib/api";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { SettingsRow, SettingsSection } from "../../ui/settings-row";
import { MCP_TEMPLATES, type McpTemplate } from "./mcpTemplates";

export function McpTemplateList({
  rows,
  onPick,
  disabled,
}: {
  rows: McpServerEntry[] | null;
  onPick: (t: McpTemplate) => void;
  disabled: boolean;
}) {
  return (
    <SettingsSection title="Ready to add">
      {MCP_TEMPLATES.map((t) => {
        // Adding a template whose name is already taken can only fail —
        // `mcp_servers_add` refuses to overwrite a config on disk. Say so
        // on the row instead of answering the click with "server 'linear'
        // already exists".
        const added = rows?.some((r) => r.name === t.id) ?? false;
        return (
          <SettingsRow
            key={t.id}
            title={t.label}
            // Not clamped. What the row is FOR is the line telling you what
            // it needs before you click.
            description={t.description}
            help={
              // Pure-remote templates carry no command; showing the endpoint
              // beats an empty line where every other row has one.
              <code>{t.command ? `${t.command} ${t.args.join(" ")}` : (t.serverUrl ?? "")}</code>
            }
            control={
              added ? (
                <Badge variant="highlight">added</Badge>
              ) : (
                <Button size="sm" variant="outline" onClick={() => onPick(t)} disabled={disabled}>
                  <Plus />
                  Add
                </Button>
              )
            }
          />
        );
      })}
    </SettingsSection>
  );
}
