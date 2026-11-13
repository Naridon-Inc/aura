import { useEffect, useState } from "react";

import { Badge } from "../../ui/badge";
import { Checkbox } from "../../ui/checkbox";
import { Input } from "../../ui/input";
import { Select, type SelectOption } from "../../ui/select";
import "../../ui/settings-blocks.css";

// The right-hand side of a row: the things a setting is set with. Every
// enumeration is a select, every number a number field, the way the rest
// of the settings pages draw them.

export function CheckboxLabel({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <label className="ui-settings-choice">
      <Checkbox checked={checked} onCheckedChange={(next) => onChange(next === true)} />
      <span>{label}</span>
    </label>
  );
}

/** A choice between a few named values. */
export function ChoiceSelect<T extends string>({
  value,
  options,
  onChange,
  disabled = false,
  label,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  disabled?: boolean;
  /** Spoken name of the control; the row title it sits in. */
  label?: string;
}) {
  return (
    <Select
      value={value}
      onChange={(next) => onChange(next as T)}
      options={options}
      disabled={disabled}
      align="end"
      aria-label={label}
    />
  );
}

export function SelectField({
  value,
  onChange,
  options,
  disabled,
  placeholder,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  options: SelectOption[];
  disabled?: boolean;
  placeholder?: string;
  label?: string;
}) {
  return (
    <Select
      value={value}
      onChange={onChange}
      options={options}
      disabled={disabled}
      placeholder={placeholder}
      align="end"
      aria-label={label}
    />
  );
}

/** A bounded whole number. Typing is free; the value is clamped into range
 *  when it is committed (blur or Enter), so a two-digit entry is never cut
 *  short by its own first digit. */
export function Stepper({
  value,
  onChange,
  min,
  max,
  step = 1,
  suffix,
  disabled = false,
  label,
}: {
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
  /** Whole control is inert — the setting it drives can't take effect yet. */
  disabled?: boolean;
  label?: string;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const n = Number(draft);
    if (!Number.isFinite(n) || draft.trim() === "") {
      setDraft(String(value));
      return;
    }
    const next = Math.min(max, Math.max(min, Math.round(n / step) * step));
    setDraft(String(next));
    if (next !== value) onChange(next);
  };
  return (
    <Input
      type="number"
      className="ui-settings-number"
      aria-label={label}
      min={min}
      max={max}
      step={step}
      value={draft}
      disabled={disabled}
      suffix={suffix}
      onChange={(event) => {
        setDraft(event.target.value);
        const n = Number(event.target.value);
        if (event.target.value !== "" && Number.isFinite(n) && n >= min && n <= max) onChange(n);
      }}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") commit();
      }}
    />
  );
}

export function StatusPill({
  tone,
  text,
}: {
  tone: "muted" | "amber" | "red" | "green";
  text: string;
}) {
  const variant =
    tone === "green" ? "highlight" : tone === "red" ? "destructive" : tone === "amber" ? "tip" : "outline";
  return <Badge variant={variant}>{text}</Badge>;
}
