import { DatePicker as MedusaDatePicker } from "@medusajs/ui";

function parseLocalDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

function toIsoDate(value: Date | null): string {
  if (!value) return "";
  const y = value.getFullYear();
  const m = String(value.getMonth() + 1).padStart(2, "0");
  const d = String(value.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export interface DatePickerProps {
  value: string;
  onChange: (next: string) => void;
  /** Names the control for screen readers and as the trigger's tooltip. An
   *  empty date picker renders as a bare calendar icon, so without this there
   *  is nothing to say which date it sets. */
  label?: string;
  className?: string;
  disabled?: boolean;
}

// Deliberately no `placeholder` prop. There used to be one — declared,
// accepted, and dropped on the floor, because the underlying control is an
// aria date field that renders its own empty state and takes no placeholder.
// Both call sites passed "—" and got nothing. Callers that want to say a date
// is unset say it themselves, next to the picker, in words.
export function DatePicker({
  value,
  onChange,
  label,
  className,
  disabled,
}: DatePickerProps) {
  return (
    <MedusaDatePicker
      value={parseLocalDate(value)}
      onChange={(next) => onChange(toIsoDate(next))}
      className={className}
      isDisabled={disabled}
      size="small"
      shouldCloseOnSelect
      aria-label={label}
    />
  );
}
