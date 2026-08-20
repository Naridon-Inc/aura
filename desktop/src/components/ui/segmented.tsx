// SegmentedControl — the same toggle group as `Segment`, kept as its own
// entry point because ten surfaces already import it under this name and
// pass a leading status dot.
//
// It used to render `@medusajs/ui`'s `Tabs`, which meant the app shipped two
// visually different segmented controls for one job: eight surfaces on
// `Segment` (a bordered track of connected cells) and ten on Medusa's tab
// strip. Neither was on our tokens, and Medusa's exposed no size control at
// all, so the two could not have been reconciled by styling alone. They share
// one implementation now, so a change to the control is a change to all
// eighteen rather than half of them.
//
// The API is unchanged on purpose — `dotClassName` maps onto `Segment`'s
// `icon` slot, so every existing call site keeps working untouched.

import * as React from "react";

import { cn } from "../../lib/utils";
import { Segment, type SegmentOption } from "./segment";

export interface SegmentedOption<T extends string> {
  value: T;
  label: React.ReactNode;
  /** Colour class for a small leading status dot, e.g. `bg-mint`. */
  dotClassName?: string;
}

export interface SegmentedControlProps<T extends string> {
  value: T;
  onChange: (value: T) => void;
  options: SegmentedOption<T>[];
  ariaLabel?: string;
  className?: string;
}

export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
  className,
}: SegmentedControlProps<T>) {
  // The dot is a decoration, not an affordance, so it rides in the icon slot
  // and stays aria-hidden — the cell's label is what gets announced.
  const mapped: SegmentOption<T>[] = React.useMemo(
    () =>
      options.map((opt) => ({
        value: opt.value,
        label: opt.label,
        icon: opt.dotClassName ? (
          <span
            className={cn("size-1.5 shrink-0 rounded-full", opt.dotClassName)}
            aria-hidden
          />
        ) : undefined,
      })),
    [options],
  );

  return (
    <Segment
      value={value}
      onChange={onChange}
      options={mapped}
      size="sm"
      ariaLabel={ariaLabel}
      className={cn("w-fit", className)}
    />
  );
}
