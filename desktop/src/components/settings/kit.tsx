import * as React from "react";
import { Button, Text } from "@medusajs/ui";

import { cn } from "../../lib/utils";
import { Checkbox } from "../ui/checkbox";
import { Field as UiField } from "../ui/field";
import { Segment } from "../ui/segment";
import { Select, type SelectOption } from "../ui/select";
import { StatusChip, type ChipTone } from "../ui/statusChip";
import { Switch } from "../ui/switch";

// ── Compact settings kit ──────────────────────────────────────────────
// Flat, card-less rows: a bold label + muted description on the left, the
// control right-aligned, a hairline divider between rows. No bordered
// section cards (per the "no bulky cards" house rule) — sections are just
// a quiet group label over a divided list. One type scale, one rhythm, so
// every pane reads the same. Signatures stay backward-compatible: existing
// `<Row label>` / `<Toggle label hint>` callers render unchanged; new
// `description`/`hint` slots are opt-in.

/** The pane title at the top of each section's content. */
export function PaneHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="mb-4">
      <h1 className="text-[18px] font-semibold leading-tight tracking-[-0.01em] text-ui-fg-base">
        {title}
      </h1>
      {subtitle && (
        <p className="mt-1 max-w-[540px] text-[12px] leading-snug text-ui-fg-subtle">
          {subtitle}
        </p>
      )}
    </div>
  );
}

/** A flat group of rows under a quiet uppercase label. `title` is now
 *  optional — omit it for an unlabelled cluster (same as `Card`). */
export function Section({
  title,
  icon,
  children,
}: {
  title?: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="mt-6 first:mt-0">
      {title && (
        <div className="mb-0.5 flex items-center gap-2">
          {icon && <span className="text-ui-fg-muted [&_svg]:size-3">{icon}</span>}
          <span className="text-[10px] font-semibold uppercase tracking-[0.09em] text-ui-fg-muted">
            {title}
          </span>
        </div>
      )}
      <div className="divide-y divide-ui-border-base/70">{children}</div>
    </div>
  );
}

export function Card({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("mt-6 first:mt-0 divide-y divide-ui-border-base/70", className)}>{children}</div>;
}

/** One setting row: bold label (+ optional description / dim hint) on the
 *  left, control right-aligned, top-aligned so multi-line labels don't
 *  shove the control down. */
export function Row({
  label,
  description,
  hint,
  children,
}: {
  label: React.ReactNode;
  description?: React.ReactNode;
  hint?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-5 py-2.5">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-[12.5px] font-medium leading-snug text-ui-fg-base">{label}</span>
        {description && (
          <span className="text-[11.5px] leading-snug text-ui-fg-subtle">{description}</span>
        )}
        {hint && <span className="text-[11px] leading-snug text-ui-fg-muted">{hint}</span>}
      </div>
      <div className="shrink-0 pt-0.5">{children}</div>
    </div>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <UiField label={label} description={hint} className="py-2">
      {children}
    </UiField>
  );
}

export function Toggle({
  label,
  hint,
  value,
  onChange,
  disabled,
}: {
  label: string;
  hint?: string;
  value: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-5 py-2.5">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-[12.5px] font-medium leading-snug text-ui-fg-base">{label}</span>
        {hint && <span className="text-[11.5px] leading-snug text-ui-fg-subtle">{hint}</span>}
      </div>
      <Switch checked={value} onCheckedChange={onChange} disabled={disabled} className="mt-0.5 shrink-0" />
    </div>
  );
}

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
}: {
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
}) {
  const dec = () => onChange(Math.max(min, value - step));
  const inc = () => onChange(Math.min(max, value + step));
  return (
    <div className="inline-flex items-center overflow-hidden rounded-md border border-ui-border-base bg-ui-bg-base">
      <Button type="button" variant="transparent" size="small" onClick={dec} disabled={value <= min} aria-label="Decrease">
        −
      </Button>
      <Text size="small" className="w-[52px] border-x border-ui-border-base py-1 text-center tabular-nums">
        {value}
        {suffix}
      </Text>
      <Button type="button" variant="transparent" size="small" onClick={inc} disabled={value >= max} aria-label="Increase">
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
