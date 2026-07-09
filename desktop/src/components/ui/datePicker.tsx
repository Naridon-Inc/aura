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
  placeholder?: string;
  align?: "start" | "center" | "end";
  className?: string;
  disabled?: boolean;
}

export function DatePicker({
  value,
  onChange,
  placeholder: _placeholder,
  align: _align,
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
    />
  );
}
