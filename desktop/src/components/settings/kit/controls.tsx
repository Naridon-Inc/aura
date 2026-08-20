import { Button, Text } from "@medusajs/ui";

import { cn } from "../../../lib/utils";
import { Checkbox } from "../../ui/checkbox";
import { Segment } from "../../ui/segment";
import { Select, type SelectOption } from "../../ui/select";
import { StatusChip, type ChipTone } from "../../ui/statusChip";

// The right-hand side of a row: the things a setting is actually set with.
// Thin wrappers over the app-wide primitives, sized for a settings row so
// every pane's controls line up on the same right edge.

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
    <label className="flex cursor-pointer items-center gap-2">
      <Checkbox checked={checked} onCheckedChange={(next) => onChange(next === true)} />
      <Text size="small">{label}</Text>
    </label>
  );
}

export function SegControl<T extends string>({
  value,
  options,
  onChange,
  disabled = false,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  return (
    <Segment<T>
      value={value}
      onChange={onChange}
      options={options}
      size="sm"
      disabled={disabled}
    />
  );
}

export function SelectField({
  value,
  onChange,
  options,
  disabled,
  placeholder,
  widthClass = "min-w-[168px]",
}: {
  value: string;
  onChange: (v: string) => void;
  options: SelectOption[];
  disabled?: boolean;
  placeholder?: string;
  widthClass?: string;
}) {
  return (
    <Select
      value={value}
      onChange={onChange}
      options={options}
      disabled={disabled}
      placeholder={placeholder}
      align="end"
      className={cn("w-auto", widthClass)}
    />
  );
}

export function Stepper({
  value,
  onChange,
  min,
  max,
  step = 1,
  suffix,
  disabled = false,
}: {
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
  /** Whole control is inert — the setting it drives can't take effect yet.
   *  Distinct from the per-button min/max clamps, which are about the range. */
  disabled?: boolean;
}) {
  const dec = () => onChange(Math.max(min, value - step));
  const inc = () => onChange(Math.min(max, value + step));
  return (
    <div
      className={cn(
        "inline-flex items-center overflow-hidden rounded-md border border-line-soft bg-bg-2",
        disabled && "opacity-50",
      )}
    >
      <Button type="button" variant="transparent" size="small" onClick={dec} disabled={disabled || value <= min} aria-label="Decrease">
        −
      </Button>
      <Text size="small" className="w-[52px] border-x border-line-soft py-1 text-center tabular-nums">
        {value}
        {suffix}
      </Text>
      <Button type="button" variant="transparent" size="small" onClick={inc} disabled={disabled || value >= max} aria-label="Increase">
        +
      </Button>
    </div>
  );
}

export function StatusPill({
  tone,
  text,
}: {
  tone: "muted" | "amber" | "red" | "green";
  text: string;
}) {
  const chipTone: ChipTone = tone === "muted" ? "neutral" : tone;
  return <StatusChip tone={chipTone} dense>{text}</StatusChip>;
}
