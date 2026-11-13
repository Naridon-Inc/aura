import { useState } from "react";
import { Plus, Pencil, Trash2, Eye, EyeOff } from "lucide-react";
import { Button } from "./button";
import { Input } from "./input";
import { Textarea } from "./textarea";
import { Dialog, DialogContent, DialogTitle, DialogDescription, DialogFooter } from "./dialog";
export interface EnvironmentVariable {
  name: string;
  value: string;
}
export function EnvironmentSettings({
  variables,
  onChange,
  files,
  onFilesChange,
}: {
  variables: EnvironmentVariable[];
  onChange: (variables: EnvironmentVariable[]) => void;
  files: string[];
  onFilesChange: (files: string[]) => void;
}) {
  const [editing, setEditing] = useState<string | null>();
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const [revealed, setRevealed] = useState<string[]>([]);
  const [fileDialog, setFileDialog] = useState(false);
  const [filePath, setFilePath] = useState("");
  const begin = (variable?: EnvironmentVariable) => {
    setEditing(variable?.name ?? null);
    setName(variable?.name ?? "");
    setValue(variable?.value ?? "");
    setError("");
  };
  const save = () => {
    const entries =
      name.includes("=") || name.includes("\n")
        ? name
            .split(/\r?\n/)
            .filter((line) => line.trim() && !line.trim().startsWith("#"))
            .map((line) => {
              const index = line.indexOf("=");
              return {
                name: line
                  .slice(0, index < 0 ? undefined : index)
                  .trim()
                  .replace(/^export\s+/, ""),
                value: index < 0 ? "" : line.slice(index + 1).trim(),
              };
            })
        : [{ name: name.trim(), value }];
    if (!entries.length || entries.some((entry) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(entry.name))) {
      setError("Use letters, numbers and underscores. Names cannot start with a number.");
      return;
    }
    if (
      new Set(entries.map((entry) => entry.name)).size !== entries.length ||
      entries.some((entry) =>
        variables.some((existing) => existing.name === entry.name && existing.name !== editing),
      )
    ) {
      setError("A variable with this name already exists.");
      return;
    }
    onChange([...variables.filter((entry) => entry.name !== editing), ...entries]);
    setEditing(undefined);
  };
  return (
    <section className="ui-environment-settings">
      <header>
        <p>Configure environment variables passed to agents.</p>
        <Button size="sm" onClick={() => begin()}>
          <Plus />
          Add environment variable
        </Button>
      </header>
      {variables.length ? (
        <div className="ui-environment-rows">
          {variables.map((variable) => (
            <div key={variable.name}>
              <code>{variable.name}</code>
              <span>{revealed.includes(variable.name) ? variable.value : "••••••••"}</span>
              <Button
                variant="ghost"
                size="iconXs"
                aria-label={`${revealed.includes(variable.name) ? "Hide" : "Show"} ${variable.name}`}
                onClick={() =>
                  setRevealed((ids) =>
                    ids.includes(variable.name)
                      ? ids.filter((id) => id !== variable.name)
                      : [...ids, variable.name],
                  )
                }
              >
                {revealed.includes(variable.name) ? <EyeOff /> : <Eye />}
              </Button>
              <Button
                variant="ghost"
                size="iconXs"
                aria-label={`Edit ${variable.name}`}
                onClick={() => begin(variable)}
              >
                <Pencil />
              </Button>
              <Button
                variant="ghost"
                size="iconXs"
                aria-label={`Remove ${variable.name}`}
                onClick={() => onChange(variables.filter((entry) => entry.name !== variable.name))}
              >
                <Trash2 />
              </Button>
            </div>
          ))}
        </div>
      ) : (
        <div className="ui-environment-empty">
          <strong>No variables set</strong>
          <p>Add a variable to make it available in this environment.</p>
        </div>
      )}
      <section className="ui-environment-files">
        <h2>Env files</h2>
        <p>Load environment variables from env files.</p>
        {files.map((file) => (
          <div className="ui-environment-file" key={file}>
            <code>{file}</code>
            <Button
              size="iconXs"
              variant="ghost"
              aria-label={`Remove ${file}`}
              onClick={() => onFilesChange(files.filter((path) => path !== file))}
            >
              <Trash2 />
            </Button>
          </div>
        ))}
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setFilePath("");
            setFileDialog(true);
          }}
        >
          <Plus />
          Add env file
        </Button>
      </section>
      <Dialog
        open={editing !== undefined}
        onOpenChange={(open) => {
          if (!open) setEditing(undefined);
        }}
      >
        <DialogContent className="ui-environment-dialog">
          <DialogTitle>{editing ? "Edit" : "Add"} environment variable</DialogTitle>
          <DialogDescription>
            Paste a block of KEY=VALUE lines into the name field to add several at once.
          </DialogDescription>
          <label className="ui-form-field">
            Name
            <Textarea
              autoFocus
              aria-label="Variable name"
              placeholder="MY_VARIABLE"
              rows={1}
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                setError("");
              }}
            />
          </label>
          <label className="ui-form-field">
            Value
            <Textarea
              aria-label="Variable value"
              rows={3}
              value={value}
              onChange={(event) => setValue(event.target.value)}
            />
          </label>
          {error && (
            <p role="alert" className="ui-field-error">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setEditing(undefined)}>
              Cancel
            </Button>
            <Button onClick={save} disabled={!name.trim()}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={fileDialog} onOpenChange={setFileDialog}>
        <DialogContent>
          <DialogTitle>Add env file</DialogTitle>
          <DialogDescription>Enter the path to an environment file.</DialogDescription>
          <Input
            autoFocus
            aria-label="Environment file path"
            value={filePath}
            placeholder=".env"
            onChange={(event) => setFilePath(event.target.value)}
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setFileDialog(false)}>
              Cancel
            </Button>
            <Button
              disabled={!filePath.trim() || files.includes(filePath.trim())}
              onClick={() => {
                onFilesChange([...files, filePath.trim()]);
                setFileDialog(false);
              }}
            >
              Add
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
