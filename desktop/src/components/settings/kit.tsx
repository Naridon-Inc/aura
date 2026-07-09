import * as React from "react";
import { Button, Container, Heading, Text } from "@medusajs/ui";

import { cn } from "../../lib/utils";
import { Checkbox } from "../ui/checkbox";
import { Field as UiField } from "../ui/field";
import { SegmentedControl } from "../ui/segmented";
import { Select, type SelectOption } from "../ui/select";
import { StatusChip, type ChipTone } from "../ui/statusChip";
import { Switch } from "../ui/switch";

export function PaneHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="mb-5">
      <Heading level="h2">{title}</Heading>
      {subtitle && (
        <Text size="small" className="mt-1.5 max-w-[560px] text-ui-fg-subtle">
          {subtitle}
        </Text>
      )}
    </div>
  );
}

export function Section({
  title,
  icon,
  children,
}: {
  title: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Container className="mb-3.5 overflow-hidden p-0">
      <header className="flex h-9 items-center gap-2 border-b border-ui-border-base px-3.5">
        {icon && <span className="text-ui-fg-muted [&_svg]:size-3.5">{icon}</span>}
        <Text size="small" weight="plus">{title}</Text>
      </header>
      <div className="divide-y divide-ui-border-base px-3.5 py-1.5">{children}</div>
    </Container>
  );
}

export function Card({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <Container className={cn("mb-3.5 overflow-hidden p-0", className)}>
      <div className="divide-y divide-ui-border-base px-3.5 py-1.5">{children}</div>
    </Container>
  );
}

export function Row({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <Text size="small" className="flex min-w-0 items-center gap-2 text-ui-fg-base">
        {label}
      </Text>
      <div className="shrink-0">{children}</div>
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
    <UiField label={label} description={hint} className="py-3">
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
    <div className="flex items-start justify-between gap-4 py-3">
      <div className="min-w-0">
        <Text size="small">{label}</Text>
        {hint && <Text size="xsmall" className="mt-0.5 text-ui-fg-subtle">{hint}</Text>}
      </div>
      <Switch checked={value} onCheckedChange={onChange} disabled={disabled} className="mt-0.5" />
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
  const control = <SegmentedControl<T> value={value} onChange={onChange} options={options} />;
  return disabled ? <div className="pointer-events-none opacity-50">{control}</div> : control;
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
