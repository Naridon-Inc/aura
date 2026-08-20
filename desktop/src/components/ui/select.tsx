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
import { ChevronDown } from "lucide-react";

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

// Radix throws on an item whose value is the empty string — it reserves ""
// for "nothing selected, show the placeholder". Half a dozen call sites use ""
// as an honest option in their own right ("No sprint", "Start a new flow",
// "Smart pick", "— none —"), which is the natural way to say it in this flat
// API, so the adapter carries them over a sentinel instead of making every
// caller invent one. Callers still hand us "" and still get "" back.
const EMPTY = "__aura_none__";

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
  // "" means the empty option when the caller offers one, and "nothing picked
  // yet" when it doesn't — so the placeholder still works exactly as before.
  const hasEmptyOption = options.some((o) => o.value === "");

  return (
    <MedusaSelect
      // Radix requires a matching item or undefined to show the placeholder.
      value={value === "" ? (hasEmptyOption ? EMPTY : undefined) : value}
      onValueChange={(v) => onChange(v === EMPTY ? "" : v)}
      disabled={disabled}
    >
      <MedusaSelect.Trigger
        id={id}
        aria-label={aria["aria-label"]}
        aria-invalid={invalid || undefined}
        className={cn("ade-select-trigger w-full", className)}
      >
        {/* Select.Value reflects the selected item's own children — glyph
            included — so it needs no help. Mirroring the icon here drew it
            twice, and the extra child turned the trigger's space-between into
            three columns, floating the value in the middle of the control. */}
        <MedusaSelect.Value placeholder={placeholder} />
        {/* The house caret. Medusa's trigger appends its own `TrianglesMini` —
            a stacked up/down pair, which is the glyph a NUMBER STEPPER wears:
            it says "increment me", so the rail's project picker read as
            something you nudge through a list rather than something you open.
            Every other menu in this app opens on a single chevron-down.
            Medusa's icon is internal to its trigger, so it can't be replaced by
            a prop: ours renders here and `.ade-select-trigger` hides the one
            after it (styles.css). The hidden node keeps its layout box out of
            the flow entirely, so the trigger's space-between still puts the
            value left and exactly one caret right. */}
        <ChevronDown
          size={13}
          strokeWidth={1.75}
          className="ade-select-caret shrink-0 text-text-4"
          aria-hidden
        />
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
            key={opt.value || EMPTY}
            value={opt.value === "" ? EMPTY : opt.value}
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
