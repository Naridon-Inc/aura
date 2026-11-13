// Add or edit a command-line agent declared in ~/.aura/agents.toml. Aura
// launches an entry exactly like the agents it ships with.

import { useState } from "react";

import { AsciiSpinner } from "../../ui/ascii-spinner";
import { Button } from "../../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "../../ui/dialog";
import { Field } from "../../ui/field";
import { Input } from "../../ui/input";
import { SettingsError } from "../../ui/settings-blocks";
import { SettingsRow } from "../../ui/settings-row";
import { Switch } from "../../ui/switch";
import type { AgentsTomlEntry } from "../../../lib/api";
import { tokenize } from "./agentModel";

type Capability = "supports_stream" | "supports_pty" | "supports_resume";

const CAPABILITIES: { key: Capability; title: string; description: string }[] = [
  {
    key: "supports_stream",
    title: "Streaming output",
    description: "The CLI streams tokens as it generates, instead of one final block.",
  },
  {
    key: "supports_pty",
    title: "Interactive terminal (PTY)",
    description: "Runs as a full TUI inside a pseudo-terminal.",
  },
  {
    key: "supports_resume",
    title: "Resume sessions",
    description: "Can pick up a previous session by id.",
  },
];

export function AgentEditorDialog({
  entry,
  onClose,
  onSave,
}: {
  entry: AgentsTomlEntry;
  onClose: () => void;
  onSave: (entry: AgentsTomlEntry) => Promise<void>;
}) {
  const [draft, setDraft] = useState<AgentsTomlEntry>(entry);
  const [argsText, setArgsText] = useState((entry.args ?? []).join(" "));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isNew = !entry.id;
  const saveDisabled = saving || !draft.id.trim() || !draft.bin.trim();

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await onSave({
        ...draft,
        id: draft.id.trim(),
        bin: draft.bin.trim(),
        args: tokenize(argsText),
        supports_stream: !!draft.supports_stream,
        supports_pty: !!draft.supports_pty,
        supports_resume: !!draft.supports_resume,
      });
    } catch (e) {
      setError(String(e));
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="ui-agent-editor">
        <DialogTitle>{isNew ? "New coding agent" : `Edit ${entry.label || entry.id}`}</DialogTitle>
        <DialogDescription>
          Declare a command-line coding agent Aura can drive. Saved to{" "}
          <code>~/.aura/agents.toml</code>. Aura launches it exactly like the built-in agents.
        </DialogDescription>
        <div className="ui-agent-editor-fields">
          <div className="ui-agent-editor-pair">
            <Field label="ID" htmlFor="agent-editor-id" description="Stable, lowercase. Examples: kimi, devstral.">
              <Input
                id="agent-editor-id"
                value={draft.id}
                onChange={(e) => setDraft({ ...draft, id: e.target.value })}
                disabled={!isNew}
                placeholder="kimi"
              />
            </Field>
            <Field label="Label" htmlFor="agent-editor-label" description="The name shown in the agent picker.">
              <Input
                id="agent-editor-label"
                value={draft.label}
                onChange={(e) => setDraft({ ...draft, label: e.target.value })}
                placeholder="Kimi"
              />
            </Field>
          </div>
          <Field
            label="Binary"
            htmlFor="agent-editor-bin"
            description="Path or PATH-resolvable name. E.g. /opt/kimi or just kimi."
          >
            <Input
              id="agent-editor-bin"
              value={draft.bin}
              onChange={(e) => setDraft({ ...draft, bin: e.target.value })}
              placeholder="kimi"
            />
          </Field>
          <Field
            label="Args"
            htmlFor="agent-editor-args"
            description="Tokens, space-separated. Use {prompt} for the message and optional {resume} for a session id."
          >
            <Input
              id="agent-editor-args"
              value={argsText}
              onChange={(e) => setArgsText(e.target.value)}
              placeholder="chat --prompt {prompt}"
            />
          </Field>
          <div>
            {CAPABILITIES.map((cap) => (
              <SettingsRow
                key={cap.key}
                title={cap.title}
                description={cap.description}
                control={
                  <Switch
                    aria-label={cap.title}
                    checked={!!draft[cap.key]}
                    onCheckedChange={(on) => setDraft({ ...draft, [cap.key]: on })}
                  />
                }
              />
            ))}
          </div>
        </div>
        {error && <SettingsError>{error}</SettingsError>}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={saveDisabled}>
            {saving && <AsciiSpinner />}
            {isNew ? "Add agent" : "Save changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
