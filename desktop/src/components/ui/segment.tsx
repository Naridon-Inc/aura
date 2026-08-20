// Segment — THE toggle group. Generic over the value union so callers get
// exhaustive `onChange` typing.
//
// It draws the app's one segmented strip: `.ade-seg--row` in styles.css, the
// same rules the right rail's section tabs, the fleet lens, the Display menu's
// sort direction and every board's layout switch wear. Connected cells sharing
// dividers inside one rounded, hairline-bordered track, 26px tall, the active
// cell raised out of the track and its label in the accent.
//
// That track is the whole point, and it has been round the houses. The control
// started as a Medusa button group with exactly this shape, then lost it to a
// bare strip — no border, no background, accent tint on the active cell — in a
// pass that unified two divergent controls onto one. Unifying was right; the
// shape it unified on was not. A bare strip only works in a header, where the
// header IS the surface, its own hairline is the edge, and nothing else on the
// line competes to be the set. The app puts this control in plenty of places
// that are not a header: mid-card in the launcher, inside the Display popover,
// in a wizard step. There an unselected cell has no shape at all, so the strip
// reads as one tinted button with some loose words beside it rather than one
// control with two sides.
//
// So: one appearance, everywhere, and no prop to choose it with. A switch that
// looks like a set of buttons in one place and a set of links in another is the
// thing this component exists to prevent.
//
// Two densities: `xs` for chrome (panel headers, 22px cells) and `sm` for the
// standard 26px row. No iOS-style sliding pill — the raised cell reads as
// selected without animating on every click.

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
  /** Fill the available width and give every cell an equal share, instead
   *  of hugging its content. */
  stretch?: boolean;
  ariaLabel?: string;
  className?: string;
}

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
        "ade-seg ade-seg--row",
        size === "xs" && "ade-seg--xs",
        stretch ? "ade-seg--stretch w-full" : "ade-seg--inline",
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
            className={cn("whitespace-nowrap", active && "active")}
          >
            {opt.icon}
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
