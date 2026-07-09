import * as React from "react";
import { Tabs } from "@medusajs/ui";

import { cn } from "../../lib/utils";

export interface SegmentedOption<T extends string> {
  value: T;
  label: React.ReactNode;
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
  return (
    <Tabs value={value} onValueChange={(next) => onChange(next as T)}>
      <Tabs.List aria-label={ariaLabel} className={cn("w-fit", className)}>
        {options.map((opt) => (
          <Tabs.Trigger key={opt.value} value={opt.value} className="gap-1.5">
            {opt.dotClassName && <span className={cn("size-1.5 rounded-full", opt.dotClassName)} aria-hidden />}
            {opt.label}
          </Tabs.Trigger>
        ))}
      </Tabs.List>
    </Tabs>
  );
}
