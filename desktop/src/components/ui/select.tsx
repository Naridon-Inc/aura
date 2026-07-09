// Select — thin adapter over @medusajs/ui's REAL <Select>. The app-wide
// call sites use a flat `value / onChange / options[]` API (priority, status,
// agent, sprint, parent-epic, model pickers, …); this module maps that API
// onto Medusa's compound `Select.Trigger / Select.Content / Select.Item`
// primitives so every one of those dropdowns renders as the genuine Medusa
// component — its own trigger caret, flyout shadow, row typography and check
// indicator — not a hand-rolled look-alike. Medusa's classes come from the
// v3-preset bridge wired in styles.css (`@config ../tailwind.config.cjs`).
//
// The exported `SelectOption` / `SelectProps` shape is unchanged, so consumers
// keep working verbatim.

import * as React from "react";
import { Select as MedusaSelect } from "@medusajs/ui";

import { cn } from "../../lib/utils";

export interface SelectOption {
  value: string;
  label: React.ReactNode;
  /** Optional leading glyph/avatar/colour dot. */
  icon?: React.ReactNode;
  disabled?: boolean;
}

export interface SelectProps {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  invalid?: boolean;
  id?: string;
  className?: string;
  align?: "start" | "center" | "end";
  "aria-label"?: string;
}

export function Select({
  value,
  onChange,
  options,
  placeholder = "Select…",
  disabled,
  invalid,
  id,
  className,
  align = "start",
  ...aria
}: SelectProps) {
  const selected = options.find((o) => o.value === value);

  return (
    <MedusaSelect
      // Radix requires a matching item or undefined to show the placeholder;
      // an unmatched value (e.g. "") falls through to the placeholder cleanly.
      value={value || undefined}
      onValueChange={onChange}
      disabled={disabled}
    >
      <MedusaSelect.Trigger
        id={id}
        aria-label={aria["aria-label"]}
        aria-invalid={invalid || undefined}
        className={cn("w-full", className)}
      >
        {/* Medusa's Select.Value reflects the selected option's text; the
            leading glyph isn't part of that text, so mirror it here to keep
            icon-carrying selects (agent, status) showing their glyph. */}
        {selected?.icon}
        <MedusaSelect.Value placeholder={placeholder} />
      </MedusaSelect.Trigger>
      {/* `aura-menu` remaps Medusa's flyout design-tokens to our arctic-dark
          popover palette (same token-scoping trick the composer's effort /
          Approvals / Mode menus use), so every app-wide Select — priority,
          status, agent, sprint, model, … — shares one surface instead of
          Medusa's out-of-the-box neutral. The class rides the portaled
          Content element itself because Radix portals it out of the app tree. */}
      <MedusaSelect.Content align={align} className="aura-menu">
        {options.map((opt) => (
          <MedusaSelect.Item
            key={opt.value}
            value={opt.value}
            disabled={opt.disabled}
            // Radix typeahead + the trigger's reflected text need a string;
            // fall back to the value when the label is a rich node.
            textValue={typeof opt.label === "string" ? opt.label : opt.value}
          >
            <span className="flex min-w-0 items-center gap-2">
              {opt.icon}
              <span className="min-w-0 truncate">{opt.label}</span>
            </span>
          </MedusaSelect.Item>
        ))}
      </MedusaSelect.Content>
    </MedusaSelect>
  );
}
