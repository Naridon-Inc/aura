import { useState, type ReactNode } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { AsciiSpinner } from "./ascii-spinner";
import { Button } from "./button";
import { Input } from "./input";
import { Textarea } from "./textarea";
import { Dialog, DialogContent, DialogTitle, DialogDescription, DialogFooter } from "./dialog";
import "./settings-blocks.css";

// The environment page for values that are kept and never read back. Same
// rows, empty state and add dialog as the environment variables page, with
// one difference that matters: a row never holds a value, so there is
// nothing to show or hide. The value is typed once, into a password field,
// and from then on the row says where it goes instead of what it is.

export interface EnvironmentEntry {
  name: string;
  value: string;
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Every `NAME=value` line in a block, including ones whose name is not a
 *  valid variable name, so the dialog can say which line is wrong instead of
 *  dropping it. Blank lines and `#` comments are skipped, a leading `export `
 *  is dropped, and one layer of matching quotes comes off the value — the
 *  three things a real `.env` has in it. A line with no `=` comes back with
 *  a null value. */
function readEnvLines(text: string): Array<{ name: string; value: string | null }> {
  const out: Array<{ name: string; value: string | null }> = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const body = line.startsWith("export ") ? line.slice(7).trim() : line;
    const eq = body.indexOf("=");
    if (eq < 0) {
      out.push({ name: body, value: null });
      continue;
    }
    const name = body.slice(0, eq).trim();
    let value = body.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    out.push({ name, value });
  }
  return out;
}

/** `KEY=VALUE` lines → pairs, keeping only lines with a valid name. */
export function parseEnvLines(text: string): EnvironmentEntry[] {
  return readEnvLines(text).flatMap((entry) =>
    entry.value !== null && NAME.test(entry.name) ? [{ name: entry.name, value: entry.value }] : [],
  );
}

/** Is what was typed in the name field a pasted block rather than one name? */
function isBlock(name: string): boolean {
  return name.includes("=") || name.includes("\n");
}

/** One kept value: its name, a line saying where it goes, and the two things
 *  a person can do to it. */
export function SettingsEnvironmentRow({
  name,
  detail,
  title,
  busy,
  onReplace,
  onRemove,
  removeLabel = "Remove",
}: {
  name: string;
  detail: ReactNode;
  title?: string;
  busy?: boolean;
  onReplace: () => void;
  onRemove: () => void;
  removeLabel?: string;
}) {
  return (
    <div title={title}>
      <code>{name}</code>
      <span>{detail}</span>
      <Button
        variant="ghost"
        size="iconXs"
        aria-label={`Replace ${name}`}
        onClick={onReplace}
        disabled={busy}
      >
        <Pencil />
      </Button>
      <Button
        variant="ghost"
        size="iconXs"
        aria-label={`${removeLabel} ${name}`}
        onClick={onRemove}
        disabled={busy}
      >
        {busy ? <AsciiSpinner /> : <Trash2 />}
      </Button>
    </div>
  );
}

/** The page body: the sentence and the add button, then the rows (or the
 *  empty state), then whatever the page puts underneath. */
export function SettingsEnvironmentSecrets({
  description,
  count,
  loading,
  loadingLabel,
  error,
  onAdd,
  children,
  after,
}: {
  description: ReactNode;
  count: number;
  loading: boolean;
  loadingLabel: string;
  error?: string | null;
  onAdd: () => void;
  /** The rows, as `SettingsEnvironmentRow`s. */
  children: ReactNode;
  /** A titled section under the rows, drawn with `ui-environment-files`. */
  after?: ReactNode;
}) {
  return (
    <section className="ui-environment-settings">
      <header>
        <p>{description}</p>
        <Button size="sm" onClick={onAdd}>
          <Plus />
          Add environment variable
        </Button>
      </header>
      {error && (
        <div role="alert" className="ui-settings-error">
          {error}
        </div>
      )}
      {loading ? (
        <div className="ui-environment-empty">
          <p className="ui-settings-status">
            <AsciiSpinner />
            {loadingLabel}
          </p>
        </div>
      ) : count ? (
        <div className="ui-environment-rows">{children}</div>
      ) : (
        <div className="ui-environment-empty">
          <strong>No variables set</strong>
          <p>Add a variable to make it available in this environment.</p>
        </div>
      )}
      {after}
    </section>
  );
}

/** Add one variable, paste a block of them, or give one a new value.
 *
 *  `target` is `undefined` when closed, `null` to add, and a name to
 *  replace that name's value. A replaced value is never prefilled — there
 *  is no stored value on this side to fill it with. */
export function SettingsEnvironmentDialog({
  target,
  existing,
  onClose,
  onSave,
  extra,
}: {
  target: string | null | undefined;
  existing: string[];
  onClose: () => void;
  onSave: (entries: EnvironmentEntry[]) => Promise<void>;
  /** Fields that only make sense for a single name (not a pasted block). */
  extra?: (block: boolean) => ReactNode;
}) {
  return (
    <Dialog
      open={target !== undefined}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      {target !== undefined && (
        <EnvironmentDialogBody
          key={target ?? ""}
          target={target}
          existing={existing}
          onClose={onClose}
          onSave={onSave}
          extra={extra}
        />
      )}
    </Dialog>
  );
}

function EnvironmentDialogBody({
  target,
  existing,
  onClose,
  onSave,
  extra,
}: {
  target: string | null;
  existing: string[];
  onClose: () => void;
  onSave: (entries: EnvironmentEntry[]) => Promise<void>;
  extra?: (block: boolean) => ReactNode;
}) {
  const [name, setName] = useState(target ?? "");
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const block = target === null && isBlock(name);
  const single = name.trim();
  const replacing = !block && existing.includes(single);

  const save = async () => {
    const lines = block ? readEnvLines(name) : [{ name: single, value }];
    if (!lines.length || lines.some((entry) => !NAME.test(entry.name))) {
      setError("Use letters, numbers and underscores. Names cannot start with a number.");
      return;
    }
    if (lines.some((entry) => entry.value === null)) {
      setError("Each pasted line needs a value: NAME=value.");
      return;
    }
    if (new Set(lines.map((entry) => entry.name)).size !== lines.length) {
      setError("A name appears more than once in the pasted lines.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      await onSave(lines.map((entry) => ({ name: entry.name, value: entry.value ?? "" })));
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <DialogContent className="ui-environment-dialog">
      <DialogTitle>{target ? "Replace" : "Add"} environment variable</DialogTitle>
      <DialogDescription>
        {target
          ? `Type a new value for ${target}. The current one is never shown; saving replaces it.`
          : "Paste a block of KEY=VALUE lines into the name field to add several at once. Values stay on this laptop and can't be read back from here."}
      </DialogDescription>
      <label className="ui-form-field">
        Name
        <Textarea
          autoFocus={target === null}
          aria-label="Variable name"
          placeholder="MY_VARIABLE"
          rows={block ? 5 : 1}
          readOnly={target !== null}
          spellCheck={false}
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            setError("");
          }}
        />
      </label>
      {!block && (
        <label className="ui-form-field">
          Value
          <Input
            autoFocus={target !== null}
            type="password"
            aria-label="Variable value"
            autoComplete="off"
            spellCheck={false}
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
        </label>
      )}
      {extra?.(block)}
      {error && (
        <p role="alert" className="ui-field-error">
          {error}
        </p>
      )}
      <DialogFooter>
        <Button variant="ghost" onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button onClick={() => void save()} disabled={saving || !single || (!block && !value)}>
          {saving && <AsciiSpinner />}
          {replacing ? "Replace" : "Save"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
