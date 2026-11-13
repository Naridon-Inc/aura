// The controls a task's property rows change a value with: a menu for a
// one-of-many value (priority, sprint, workstream, status) and a date field.
// Each shows the current value as a quiet button and opens the shared menu
// or popover surface.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { CalendarDays, ChevronDown } from "lucide-react";

import { shortDate } from "../../lib/calendarDate";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { Input } from "../ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { TaskPropertyEmpty } from "../ui/tasks-properties";

export interface TaskPropertyOption {
  value: string;
  label: string;
  icon?: ReactNode;
}

// Radix radio groups can't hold an empty value, so "nothing set" gets a
// stand-in that no real id can collide with.
const NONE = "\u0000none";

/** Pick one value. With `noneLabel`, the value can also be cleared, and
 *  that label is what an unset property reads as. */
export function TaskPropertyMenu({
  label,
  value,
  options,
  onChange,
  noneLabel,
}: {
  label: string;
  value: string;
  options: TaskPropertyOption[];
  onChange: (value: string) => void;
  noneLabel?: string;
}) {
  const current = options.find((o) => o.value === value) ?? null;
  const face = current?.label ?? noneLabel ?? "Not set";
  const pick = (next: string) => {
    const v = next === NONE ? "" : next;
    if (v !== value) onChange(v);
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="xs"
          className="ui-tasks-property-trigger"
          aria-label={`${label}: ${face}. Change it`}
        >
          {current ? (
            <>
              {current.icon}
              <span>{current.label}</span>
            </>
          ) : (
            <TaskPropertyEmpty>{face}</TaskPropertyEmpty>
          )}
          <ChevronDown aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuRadioGroup value={current ? value : NONE} onValueChange={pick}>
          {noneLabel && (
            <>
              <DropdownMenuRadioItem value={NONE}>{noneLabel}</DropdownMenuRadioItem>
              <DropdownMenuSeparator />
            </>
          )}
          {options.map((o) => (
            <DropdownMenuRadioItem key={o.value} value={o.value}>
              {o.icon}
              {o.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** "2026-03-04" → a short calendar date in the reader's locale. */
function dayLabel(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  return shortDate(new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime());
}

/** A calendar date, or none. The date is kept while the field is open and
 *  saved when it closes, so typing a year digit by digit doesn't write
 *  four different dates. Escape closes without saving. */
export function TaskDateField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  const discard = useRef(false);
  useEffect(() => {
    if (!open) setDraft(value);
  }, [value, open]);
  const close = (save: boolean) => {
    setOpen(false);
    if (save && draft !== value) onChange(draft);
  };
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) setOpen(true);
        else close(!discard.current);
        discard.current = false;
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="xs"
          className="ui-tasks-property-trigger"
          aria-label={`${label}: ${value ? dayLabel(value) : "not set"}. Change it`}
        >
          <CalendarDays aria-hidden />
          {value ? <span>{dayLabel(value)}</span> : <TaskPropertyEmpty>Not set</TaskPropertyEmpty>}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="ui-tasks-property-popover"
        onEscapeKeyDown={() => {
          discard.current = true;
        }}
      >
        <label className="ui-form-field">
          {label}
          <Input
            type="date"
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") close(true);
            }}
          />
        </label>
        {value && (
          <Button
            variant="ghost"
            size="xs"
            onClick={() => {
              setOpen(false);
              onChange("");
            }}
          >
            Clear date
          </Button>
        )}
      </PopoverContent>
    </Popover>
  );
}
