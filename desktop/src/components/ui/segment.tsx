// Segment — a compact toggle group in the shape of a Medusa button group:
// connected cells inside one rounded, hairline-bordered track, sharing
// vertical dividers, with the active cell raised to `bg-ui-bg-base` and the
// rest flat. Reads as a set (like Button + Button.Group + the DropdownMenu
// trigger), stays tiny, and is generic over the value union so callers get
// exhaustive `onChange` typing.
//
// Two densities: `xs` for chrome (header scope tabs) and `sm` for the
// settings rows. No iOS-style sliding pill — the raised cell + shared
// borders match the rest of the Medusa button family.

import * as React from "react";

import { cn } from "../../lib/utils";

export interface SegmentOption<T extends string> {
  value: T;
  label: React.ReactNode;
  icon?: React.ReactNode;
  disabled?: boolean;
  /** Native tooltip — handy for explaining a disabled cell. */
  title?: string;
}

export interface SegmentProps<T extends string> {
  value: T;
  onChange: (value: T) => void;
  options: SegmentOption<T>[];
  size?: "xs" | "sm";
  /** Greys out and blocks the whole control. */
  disabled?: boolean;
  /** Fill the track's width and give every cell an equal share, instead
   *  of hugging its content. The caller sizes the track (e.g. `w-full`
   *  or `flex-1` via `className`). */
  stretch?: boolean;
  ariaLabel?: string;
  className?: string;
}

const SIZE = {
  xs: "h-[22px] px-2 text-[11px] gap-1 [&_svg]:size-3",
  sm: "h-[26px] px-2.5 text-[12px] gap-1.5 [&_svg]:size-3.5",
} as const;

export function Segment<T extends string>({
  value,
  onChange,
  options,
  size = "sm",
  disabled = false,
  stretch = false,
  ariaLabel,
  className,
}: SegmentProps<T>) {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={cn(
        "items-center overflow-hidden rounded-md border border-ui-border-base bg-ui-bg-field divide-x divide-ui-border-base",
        stretch ? "flex" : "inline-flex",
        disabled && "pointer-events-none opacity-50",
        className,
      )}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        const off = opt.disabled;
        return (
          <button
            key={opt.value}
            type="button"
            role="tab"
            aria-selected={active}
            disabled={off}
            title={opt.title}
            // Lets a wrapping context menu resolve which cell was
            // right-clicked (e.g. the Tasks views bar's rename/delete).
            data-segment-value={opt.value}
            onClick={() => !off && onChange(opt.value)}
            className={cn(
              "inline-flex items-center justify-center whitespace-nowrap font-medium transition-colors",
              stretch && "flex-1",
              SIZE[size],
              off
                ? "text-ui-fg-muted cursor-not-allowed opacity-60"
                : active
                  ? "bg-ui-bg-base text-ui-fg-base"
                  : "text-ui-fg-subtle hover:bg-ui-bg-base-hover hover:text-ui-fg-base",
            )}
          >
            {opt.icon}
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
