// The side sheet that adds or replaces environment variables. A block of
// KEY=VALUE lines pasted into Key, or a .env file imported, becomes a list
// saved together.

import { useState, type ClipboardEvent, type FormEvent } from "react";
import { Eye, EyeOff, X } from "lucide-react";

import {
  entriesProblem,
  keyRefusal,
  looksLikeEnvText,
  parseEnvText,
  type EnvEntry,
} from "../../lib/cloudEnvVars";
import { Button } from "../ui/button";
import { Field } from "../ui/field";
import { Input } from "../ui/input";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "../ui/sheet";

export type EnvSheetMode = { type: "add"; entries?: EnvEntry[] } | { type: "edit"; key: string };

/** Later entries replace earlier ones of the same name. */
function merge(a: EnvEntry[], b: EnvEntry[]): EnvEntry[] {
  const out = new Map(a.map((e) => [e.key, e.value]));
  for (const e of b) out.set(e.key, e.value);
  return [...out].map(([key, value]) => ({ key, value }));
}

export function CloudEnvVarSheet({
  mode,
  existing,
  saving,
  onSave,
  onClose,
}: {
  mode: EnvSheetMode;
  existing: Set<string>;
  saving: boolean;
  onSave: (entries: EnvEntry[]) => Promise<boolean>;
  onClose: () => void;
}) {
  const editing = mode.type === "edit" ? mode.key : null;
  const [list, setList] = useState<EnvEntry[]>(mode.type === "add" ? (mode.entries ?? []) : []);
  const [key, setKey] = useState(editing ?? "");
  const [value, setValue] = useState("");
  const [shown, setShown] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const many = list.length > 0;
  const title = many ? "Add environment variables" : editing ? `Edit ${editing}` : "Add environment variable";
  const warning = many ? list.map((e) => keyRefusal(e.key)).find(Boolean) : keyRefusal(key.trim());

  const pasteKey = (e: ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData("text");
    if (editing || !looksLikeEnvText(text)) return;
    e.preventDefault();
    setList((l) => merge(l, parseEnvText(text)));
    setKey("");
    setError(undefined);
  };

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    const entries = many ? list : [{ key: key.trim(), value }];
    // Editing replaces the one being edited; it is the only name allowed to exist.
    const problem = entriesProblem(entries, editing ? new Set() : existing);
    if (problem) {
      setError(problem);
      return;
    }
    if (await onSave(entries)) onClose();
  };

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="ui-cloud-env-sheet">
        <SheetHeader>
          <SheetTitle>{title}</SheetTitle>
          {editing && (
            <SheetDescription>The saved value can't be shown. Enter a new one to replace it.</SheetDescription>
          )}
        </SheetHeader>
        <form onSubmit={(ev) => void submit(ev)}>
          {many ? (
            <div className="ui-cloud-env-pending">
              <div className="ui-cloud-env-pending-head">
                <span>Variables</span>
                <Button type="button" variant="ghost" size="xs" onClick={() => setList([])}>
                  Clear
                </Button>
              </div>
              <ul>
                {list.map((e) => (
                  <li key={e.key}>
                    <span className="ui-cloud-env-key">{e.key}</span>
                    <span className="ui-cloud-env-value">••••••••</span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="iconXs"
                      aria-label={`Remove ${e.key}`}
                      onClick={() => setList((l) => l.filter((x) => x.key !== e.key))}
                    >
                      <X size={12} />
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <>
              <Field label="Key" htmlFor="cloud-env-key">
                <Input
                  id="cloud-env-key"
                  className="ui-cloud-env-mono"
                  placeholder="KEY"
                  autoComplete="off"
                  spellCheck={false}
                  autoFocus={!editing}
                  disabled={!!editing}
                  value={key}
                  onChange={(e) => {
                    setKey(e.target.value);
                    setError(undefined);
                  }}
                  onPaste={pasteKey}
                />
              </Field>
              <Field label="Value" htmlFor="cloud-env-value">
                <Input
                  id="cloud-env-value"
                  className="ui-cloud-env-mono"
                  type={shown ? "text" : "password"}
                  autoComplete="new-password"
                  spellCheck={false}
                  autoFocus={!!editing}
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  suffix={
                    <Button
                      type="button"
                      variant="ghost"
                      size="iconXs"
                      aria-label={shown ? "Hide value" : "Reveal value"}
                      onClick={() => setShown((s) => !s)}
                    >
                      {shown ? <EyeOff size={12} /> : <Eye size={12} />}
                    </Button>
                  }
                />
              </Field>
              {!editing && (
                <p className="ui-cloud-env-hint">Paste KEY=VALUE lines into Key to add several at once.</p>
              )}
            </>
          )}
          {warning && !error && <p className="ui-cloud-env-warning">{warning}</p>}
          {error && (
            <p role="alert" className="ui-cloud-env-error">
              {error}
            </p>
          )}
          <SheetFooter>
            <Button type="button" variant="outline" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}
