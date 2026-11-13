import { useState } from "react";
import { Plus, X } from "lucide-react";

import type { RepoWorktreeSettings } from "../../../lib/api";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { SettingsRow } from "../../ui/settings-row";

type NamedScript = RepoWorktreeSettings["namedScripts"][number];

/** Extra commands launched by name from the project header. Each script is
 *  a name and a command; a row with either left blank is dropped on save. */
export function NamedScriptsRow({
  scripts,
  onAdd,
  onChange,
  onRemove,
}: {
  scripts: NamedScript[];
  onAdd: () => void;
  onChange: (index: number, field: "name" | "command", value: string) => void;
  onRemove: (index: number) => void;
}) {
  return (
    <SettingsRow
      title="Named scripts"
      description="Extra commands you can launch by name from the workspace header."
      control={
        <Button type="button" variant="outline" size="sm" onClick={onAdd}>
          <Plus />
          Add script
        </Button>
      }
    >
      {scripts.length > 0 && (
        <div className="ui-settings-list">
          {scripts.map((script, index) => (
            <div key={index} className="ui-settings-list-row">
              <Input
                aria-label="Script name"
                value={script.name}
                onChange={(event) => onChange(index, "name", event.target.value)}
                placeholder="Dev"
                className="ui-settings-list-name"
              />
              <Input
                aria-label="Script command"
                value={script.command}
                onChange={(event) => onChange(index, "command", event.target.value)}
                placeholder="npm run dev"
                spellCheck={false}
                className="ui-settings-list-command"
              />
              <Button
                type="button"
                variant="ghost"
                size="iconSm"
                aria-label={`Remove ${script.name || "script"}`}
                onClick={() => onRemove(index)}
              >
                <X />
              </Button>
            </div>
          ))}
        </div>
      )}
    </SettingsRow>
  );
}

/** Out-of-git files (like `.env`) seeded into each fresh copy, since an
 *  agent's copy still needs them to run. "Add .env" covers the common case
 *  in one press. */
export function CopyFilesRow({
  files,
  onAdd,
  onRemove,
}: {
  files: string[];
  onAdd: (name: string) => void;
  onRemove: (name: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const commit = () => {
    onAdd(draft);
    setDraft("");
  };
  return (
    <SettingsRow
      title="Files to copy into each new copy"
      // A bare "supports .env*" ends on an asterisk that reads as a
      // footnote marker; naming it a wildcard costs one clause.
      description="Files like .env that aren't in git but an agent's copy needs to run. End a name with * to match a family — .env* also brings .env.local."
      control={
        !files.includes(".env") && (
          <Button type="button" variant="outline" size="sm" onClick={() => onAdd(".env")}>
            Add .env
          </Button>
        )
      }
    >
      <div className="ui-settings-list">
        {files.length > 0 && (
          <div className="ui-settings-chips">
            {files.map((file) => (
              <Badge key={file} variant="outline" className="ui-settings-chip">
                <code>{file}</code>
                <Button
                  type="button"
                  variant="ghost"
                  size="iconXs"
                  aria-label={`Remove ${file}`}
                  onClick={() => onRemove(file)}
                >
                  <X />
                </Button>
              </Badge>
            ))}
          </div>
        )}
        <div className="ui-settings-list-row">
          <Input
            aria-label="File to copy"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commit();
              }
            }}
            placeholder=".env"
            spellCheck={false}
            className="ui-settings-list-command"
          />
          <Button type="button" variant="outline" size="sm" onClick={commit} disabled={!draft.trim()}>
            <Plus />
            Add
          </Button>
        </div>
      </div>
    </SettingsRow>
  );
}
