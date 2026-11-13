// Form pieces the task dialog needs beyond the shared form field: a
// two-up row for short fields, a quiet section heading, a multi-owner
// picker (drawn as a select trigger in a form, or as a quiet button in a
// property row), and an inline error line.

import type { ReactNode } from "react";
import { ChevronDown, ChevronsUpDown } from "lucide-react";

import { Button } from "./button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "./dropdown-menu";
import "./tasks-form.css";

/** Two short fields side by side; one column on a narrow dialog. */
export function TaskFormRow({ children }: { children: ReactNode }) {
  return <div className="ui-tasks-form-row">{children}</div>;
}

export function TaskFormHeading({ children }: { children: ReactNode }) {
  return <h4 className="ui-tasks-form-heading">{children}</h4>;
}

export function TaskFormError({ children }: { children: ReactNode }) {
  return (
    <p className="ui-tasks-form-error" role="alert">
      {children}
    </p>
  );
}

export interface TaskOwnerOption {
  value: string;
  name: string;
}

/** Pick any number of owners. Reads as a select; opens a checklist that
 *  stays open while the reader ticks several. */
export function TaskOwnerPicker({
  id,
  values,
  options,
  onChange,
  placeholder = "Unassigned",
  inline = false,
  size = "xs",
  icon,
}: {
  id?: string;
  values: string[];
  options: TaskOwnerOption[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  /** A quiet button for a property row instead of a form's select box. */
  inline?: boolean;
  /** The quiet button's size: a property row's `xs`, or `sm` beside the
   *  other pickers in a create dialog's footer. */
  size?: "xs" | "sm";
  /** Leads the quiet button's name. */
  icon?: ReactNode;
}) {
  // An owner already on the task stays listed even when the member list
  // doesn't know them, so it can still be removed.
  const known = new Set(options.map((o) => o.value));
  const all = [
    ...options,
    ...values.filter((v) => !known.has(v)).map((v) => ({ value: v, name: v })),
  ];
  const nameOf = (v: string) => all.find((o) => o.value === v)?.name ?? v;
  const face =
    values.length === 0
      ? placeholder
      : values.length <= 2
        ? values.map(nameOf).join(", ")
        : `${nameOf(values[0])} and ${values.length - 1} more`;
  const toggle = (v: string) =>
    onChange(values.includes(v) ? values.filter((x) => x !== v) : [...values, v]);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {inline ? (
          <Button
            variant="ghost"
            size={size}
            id={id}
            className="ui-tasks-property-trigger ui-tasks-owner-trigger"
            data-empty={values.length === 0 || undefined}
            aria-label={`Owners: ${face}. Change them`}
          >
            {icon}
            <span className="ui-tasks-owner-value">{face}</span>
            <ChevronDown aria-hidden />
          </Button>
        ) : (
          <button
            type="button"
            id={id}
            className="ui-select-trigger ade-select-trigger ui-tasks-owner-trigger"
            data-empty={values.length === 0 || undefined}
          >
            <span className="ui-tasks-owner-value">{face}</span>
            <ChevronsUpDown className="ade-select-caret" size={14} aria-hidden />
          </button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="ui-tasks-owner-menu">
        <DropdownMenuCheckboxItem
          checked={values.length === 0}
          onSelect={(e) => {
            e.preventDefault();
            onChange([]);
          }}
        >
          {placeholder}
        </DropdownMenuCheckboxItem>
        {all.length > 0 && <DropdownMenuSeparator />}
        {all.map((o) => (
          <DropdownMenuCheckboxItem
            key={o.value}
            checked={values.includes(o.value)}
            onSelect={(e) => {
              e.preventDefault();
              toggle(o.value);
            }}
          >
            {o.name}
            {o.name !== o.value && <DropdownMenuShortcut>@{o.value}</DropdownMenuShortcut>}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
