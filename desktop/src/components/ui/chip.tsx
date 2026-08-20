// ChipButton — the small labelled button that opens a picker: the model chip
// under the composer, the project and effort chips on the new-workspace form,
// the mode chip in the inline editor. Ten of them, four files.
//
// It is deliberately *not* StatusChip. That one is a read-only pill you look
// at; this one is a control you press, and the chevron is a promise that
// something will open. Same size family, different job.
//
// It used to wrap `@medusajs/ui`'s Button, which meant every chip in the app
// carried Medusa's own type ramp, its focus ring and its hover wash, none of
// which matched the surface around them. The shape is small enough to own
// outright, so it is written here — and the `active` state now uses the theme's
// selected rung rather than a value that happened to be nearby.

import * as React from "react";

import { cn } from "../../lib/utils";

export interface ChipButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** `ghost` sits on the surface with no chrome until you point at it.
   *  `outline` is the one that has to look pressable before it is touched. */
  variant?: "ghost" | "outline";
  size?: "sm" | "default";
  /** The picker behind it has a value chosen — a persistent state, so it
   *  takes the selected rung of the wash ladder, not the hover one. */
  active?: boolean;
  chevron?: boolean;
}

const VARIANT: Record<NonNullable<ChipButtonProps["variant"]>, string> = {
  ghost: "border border-transparent text-text-2 hover:bg-state-hover hover:text-text-1",
  outline:
    "border border-line-soft bg-bg-2 text-text-1 hover:bg-bg-3 hover:border-line",
};

export const ChipButton = React.forwardRef<HTMLButtonElement, ChipButtonProps>(
  (
    { className, variant = "ghost", size = "default", active, chevron = true, children, ...props },
    ref,
  ) => (
    <button
      ref={ref}
      type="button"
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-md text-xs font-medium",
        "whitespace-nowrap transition-colors disabled:pointer-events-none disabled:opacity-50",
        size === "sm" ? "h-6 px-1.5" : "h-[26px] px-2",
        VARIANT[variant],
        active && "bg-state-selected text-text-1",
        className,
      )}
      {...props}
    >
      {children}
      {chevron && (
        <svg
          width="12"
          height="12"
          viewBox="0 0 16 16"
          fill="none"
          className="shrink-0 text-text-3"
          aria-hidden
        >
          <path
            d="M4 6.5L8 10.5L12 6.5"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
    </button>
  ),
);
ChipButton.displayName = "ChipButton";
