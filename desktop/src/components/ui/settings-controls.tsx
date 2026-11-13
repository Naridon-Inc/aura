import { useId, useState, type ReactNode, type KeyboardEvent } from "react";
import { Eye, EyeOff, FolderOpen, RotateCcw, Search } from "lucide-react";
import { Button } from "./button";
import { Kbd } from "./kbd";
import { Input } from "./input";
import { Textarea } from "./textarea";
import { Switch } from "./switch";
import { Select, type SelectOption } from "./select";
import { SettingsRow } from "./settings-row";
import { Dialog, DialogContent, DialogTitle, DialogDescription, DialogFooter } from "./dialog";
export function SettingsScopeSwitch({
  value,
  scopes,
  onChange,
}: {
  value: string;
  scopes: SelectOption[];
  onChange: (value: string) => void;
}) {
  return (
    <Select
      aria-label="Settings scope"
      className="ui-settings-scope"
      value={value}
      options={scopes}
      onChange={onChange}
    />
  );
}
export interface SettingsFieldProps {
  title: string;
  description?: ReactNode;
  type: "switch" | "text" | "secret" | "number" | "select" | "textarea" | "path";
  value: string | boolean | number;
  onChange: (value: string | boolean | number) => void;
  options?: SelectOption[];
  disabled?: boolean;
  managed?: boolean;
  inheritedFrom?: string;
  error?: string;
  placeholder?: string;
  min?: number;
  max?: number;
  onReset?: () => void;
  onBrowse?: () => void;
}
export function SettingsField({
  title,
  description,
  type,
  value,
  onChange,
  options = [],
  disabled,
  managed,
  inheritedFrom,
  error,
  placeholder,
  min,
  max,
  onReset,
  onBrowse,
}: SettingsFieldProps) {
  const id = useId(),
    [reveal, setReveal] = useState(false),
    locked = disabled || managed;
  const control =
    type === "switch" ? (
      <Switch id={id} checked={value === true} disabled={locked} onCheckedChange={onChange} />
    ) : type === "select" ? (
      <Select
        id={id}
        aria-label={title}
        value={String(value)}
        options={options}
        disabled={locked}
        invalid={!!error}
        onChange={onChange}
      />
    ) : type === "textarea" ? (
      <Textarea
        id={id}
        value={String(value)}
        disabled={locked}
        aria-invalid={!!error}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
    ) : (
      <div className="ui-settings-input">
        <Input
          id={id}
          type={type === "secret" && !reveal ? "password" : type === "number" ? "number" : "text"}
          value={String(value)}
          disabled={locked}
          min={min}
          max={max}
          aria-invalid={!!error}
          placeholder={placeholder}
          onChange={(event) =>
            onChange(
              type === "number" && event.target.value !== ""
                ? Number(event.target.value)
                : event.target.value,
            )
          }
        />
        {type === "secret" && (
          <Button
            variant="ghost"
            size="iconSm"
            aria-label={reveal ? "Hide value" : "Show value"}
            onClick={() => setReveal(!reveal)}
          >
            {reveal ? <EyeOff /> : <Eye />}
          </Button>
        )}
        {type === "path" && onBrowse && (
          <Button
            variant="outline"
            size="icon"
            aria-label={`Browse ${title}`}
            disabled={locked}
            onClick={onBrowse}
          >
            <FolderOpen />
          </Button>
        )}
      </div>
    );
  return (
    <SettingsRow
      title={title}
      htmlFor={id}
      description={description}
      help={
        error ? (
          <span role="alert" className="ui-field-error">
            {error}
          </span>
        ) : managed ? (
          "Managed by your organization"
        ) : inheritedFrom ? (
          `Inherited from ${inheritedFrom}`
        ) : undefined
      }
      control={
        <>
          {control}
          {onReset && !managed && (
            <Button size="iconXs" variant="ghost" aria-label={`Reset ${title}`} onClick={onReset}>
              <RotateCcw />
            </Button>
          )}
        </>
      }
    />
  );
}
export interface ShortcutBinding {
  id: string;
  label: string;
  group: string;
  keys: string;
  defaultKeys: string;
}
export function formatShortcut(event: KeyboardEvent): string {
  const modifiers = [
    event.ctrlKey && "Ctrl",
    event.altKey && "Alt",
    event.shiftKey && "Shift",
    event.metaKey && "Cmd",
  ].filter(Boolean);
  if (["Control", "Alt", "Shift", "Meta"].includes(event.key)) return "";
  const key =
    event.key === " " ? "Space" : event.key.length === 1 ? event.key.toUpperCase() : event.key;
  return [...modifiers, key].join("+");
}
export function KeyboardShortcutEditor({
  bindings,
  onChange,
}: {
  bindings: ShortcutBinding[];
  onChange: (id: string, keys: string) => void;
}) {
  const [query, setQuery] = useState(""),
    [editing, setEditing] = useState<string>(),
    [keys, setKeys] = useState("");
  const active = bindings.find((binding) => binding.id === editing);
  const conflict =
    keys && bindings.find((binding) => binding.id !== editing && binding.keys === keys);
  const groups = [...new Set(bindings.map((binding) => binding.group))];
  return (
    <div className="ui-shortcut-editor">
      <Input
        prefix={<Search size={16} />}
        placeholder="Search shortcuts"
        aria-label="Search shortcuts"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      {groups.map((group) => {
        const visible = bindings.filter(
          (binding) =>
            binding.group === group &&
            `${binding.label} ${binding.keys}`.toLowerCase().includes(query.toLowerCase()),
        );
        return visible.length ? (
          <section key={group}>
            <h3>{group}</h3>
            <div className="ui-shortcut-group">
              {visible.map((binding) => (
                <div className="ui-shortcut-row" key={binding.id}>
                  <span>{binding.label}</span>
                  <button
                    className="ui-shortcut-keys"
                    aria-label={`Edit shortcut for ${binding.label}`}
                    onClick={() => {
                      setEditing(binding.id);
                      setKeys(binding.keys);
                    }}
                  >
                    {binding.keys
                      ? binding.keys.split("+").map((key, index) => <Kbd key={index}>{key}</Kbd>)
                      : "Not set"}
                  </button>
                  {binding.keys !== binding.defaultKeys && (
                    <Button
                      size="iconXs"
                      variant="ghost"
                      aria-label={`Reset shortcut for ${binding.label}`}
                      onClick={() => onChange(binding.id, binding.defaultKeys)}
                    >
                      <RotateCcw />
                    </Button>
                  )}
                </div>
              ))}
            </div>
          </section>
        ) : null;
      })}
      {!bindings.some((binding) =>
        `${binding.label} ${binding.keys}`.toLowerCase().includes(query.toLowerCase()),
      ) && <div className="ui-pattern-empty">No shortcuts found.</div>}
      <Dialog
        open={!!active}
        onOpenChange={(open) => {
          if (!open) setEditing(undefined);
        }}
      >
        <DialogContent>
          <DialogTitle>Edit keyboard shortcut</DialogTitle>
          <DialogDescription>{active?.label}</DialogDescription>
          <button
            autoFocus
            className="ui-shortcut-recorder"
            onKeyDown={(event) => {
              if (
                event.key === "Escape" ||
                (event.key === "Tab" && !event.ctrlKey && !event.altKey && !event.metaKey)
              )
                return;
              event.preventDefault();
              event.stopPropagation();
              if (event.key === "Backspace" || event.key === "Delete") setKeys("");
              else {
                const next = formatShortcut(event);
                if (next) setKeys(next);
              }
            }}
          >
            {keys || "Press a key combination"}
          </button>
          {conflict && (
            <p className="ui-field-error" role="alert">
              Already used by {conflict.label}.
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(undefined)}>
              Cancel
            </Button>
            <Button
              disabled={!!conflict}
              onClick={() => {
                if (active) onChange(active.id, keys);
                setEditing(undefined);
              }}
            >
              Save shortcut
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
