// Add server: the form behind "Add server" and behind every "Ready to add"
// row, which opens it filled in from the template.

import type { ReactNode } from "react";
import { AsciiSpinner } from "../../ui/ascii-spinner";
import { Button } from "../../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "../../ui/dialog";
import { Input } from "../../ui/input";
import { Select } from "../../ui/select";
import { Textarea } from "../../ui/textarea";
import type { AddFormState } from "./mcpTemplates";

function FormField({ label, help, children }: { label: string; help: string; children: ReactNode }) {
  return (
    <label className="ui-form-field">
      {label}
      {children}
      <span className="ui-settings-help">{help}</span>
    </label>
  );
}

export function McpAddDialog({
  open,
  form,
  repoName,
  onChange,
  formError,
  busy,
  onCancel,
  onSave,
}: {
  open: boolean;
  form: AddFormState;
  /** The repository the form was opened in; without one the server is
   *  added for every repository and no choice is offered. */
  repoName?: string | null;
  onChange: (next: AddFormState) => void;
  formError: string | null;
  busy: boolean;
  onCancel: () => void;
  onSave: () => void;
}) {
  const here = !!repoName && form.scope === "repository";
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <DialogContent className="ui-environment-dialog">
        <DialogTitle>Add server</DialogTitle>
        <DialogDescription>
          {here
            ? "Its tools show up in the composer for every agent in this repository once it is saved."
            : "Its tools show up in the composer for every agent in every repository once it is saved."}
        </DialogDescription>
        {repoName && (
          // Not a <label>: the select is a button that opens a list, and a
          // label around it would open it from a click on the help line.
          <div className="ui-form-field">
            Use in
            <Select
              aria-label="Where this server is used"
              value={form.scope}
              onChange={(next) =>
                onChange({ ...form, scope: next === "everywhere" ? "everywhere" : "repository" })
              }
              options={[
                { value: "repository", label: `Only ${repoName}` },
                { value: "everywhere", label: "Every repository" },
              ]}
            />
            <span className="ui-settings-help">
              A server for one repository stays out of every other repository's composer.
            </span>
          </div>
        )}
        <FormField
          label="Name"
          help="Becomes the file name under ~/.aura/mcp/. Letters, digits, dashes."
        >
          <Input
            autoFocus
            value={form.name}
            onChange={(e) => onChange({ ...form, name: e.target.value })}
            placeholder="atlassian"
            spellCheck={false}
          />
        </FormField>
        <FormField
          label="Remote URL"
          help="Optional. For hosted MCP servers. Aura uses its native Streamable HTTP transport and OAuth 2.1 PKCE flow. Leave blank for stdio-only servers."
        >
          <Input
            value={form.serverUrl}
            onChange={(e) => onChange({ ...form, serverUrl: e.target.value })}
            placeholder="https://mcp.atlassian.com/v1/sse"
            spellCheck={false}
          />
        </FormField>
        <FormField
          label="Command"
          help="Executable Aura spawns. Usually 'npx'. Leave blank for pure-remote servers."
        >
          <Input
            value={form.command}
            onChange={(e) => onChange({ ...form, command: e.target.value })}
            placeholder="npx"
            spellCheck={false}
          />
        </FormField>
        <FormField label="Arguments" help="Space-separated argv passed after the command.">
          <Input
            value={form.args}
            onChange={(e) => onChange({ ...form, args: e.target.value })}
            placeholder="-y @atlassian/mcp-server"
            spellCheck={false}
          />
        </FormField>
        <FormField
          label="Environment"
          help="One KEY=VALUE per line. Leave blank to inherit the shell environment only."
        >
          <Textarea
            value={form.envText}
            onChange={(e) => onChange({ ...form, envText: e.target.value })}
            rows={4}
            spellCheck={false}
            placeholder={"ATLASSIAN_API_TOKEN=\nATLASSIAN_EMAIL="}
          />
        </FormField>
        <FormField label="Description" help="Optional note shown next to the row.">
          <Input
            value={form.description}
            onChange={(e) => onChange({ ...form, description: e.target.value })}
            placeholder="Atlassian Jira + Confluence"
          />
        </FormField>
        {/* Under the fields, above the button that raised it. */}
        {formError && (
          <p role="alert" className="ui-field-error">
            {formError}
          </p>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={onSave}
            disabled={busy || !form.name.trim() || (!form.command.trim() && !form.serverUrl.trim())}
          >
            {busy && <AsciiSpinner />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
