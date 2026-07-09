// TasksToolbarPill — Plane `.viewbar` parity.
//
// Plane CSS spec (docs/plane-app-examples.html):
//   .viewbar { display: inline-flex; align-items: center; gap: 2px; padding: 0 }
//   .vbtn    { width: 28px; height: 26px; border-radius: 5px;
//              display: grid; place-items: center; color: var(--txt-placeholder) }
//   .vbtn:hover { background: var(--bg-layer-1-hover); color: var(--txt-secondary) }
//   .vbtn.on    { background: var(--bg-accent-subtle); color: var(--txt-accent-primary) }
//   .vbtn svg { width: 14px; height: 14px }
//
// No chrome wrapper, no shadow — the viewbar reads as a raw button
// strip in the page header.
//
// Exports:
//   - `TasksToolbarPill`    — raw inline-flex container (gap 2px).
//   - `TasksToolbarButton`  — 28×26, 5px radius icon button.
//   - `TasksToolbarLabelButton` — wider variant for "+ New", "Filter".
//   - `TasksToolbarSep`     — 0.5px × 16px vertical divider.

import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

type PillProps = {
  children: ReactNode;
  className?: string;
};

export function TasksToolbarPill({ children, className }: PillProps) {
  return (
    <div
      className={cn(
        "relative inline-flex items-center gap-[2px]",
        className,
      )}
    >
      {children}
    </div>
  );
}

type ButtonProps = {
  onClick?: () => void;
  active?: boolean;
  disabled?: boolean;
  title?: string;
  ariaLabel?: string;
  children: ReactNode;
  className?: string;
};

export function TasksToolbarButton({
  onClick,
  active = false,
  disabled = false,
  title,
  ariaLabel,
  children,
  className,
}: ButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={ariaLabel ?? title}
      aria-pressed={active || undefined}
      className={cn(
        "inline-grid place-items-center w-7 h-[26px] rounded-[5px]",
        "text-[11px] font-medium [&_svg]:w-3.5 [&_svg]:h-3.5",
        "transition-colors",
        active
          ? "bg-accent/15 text-accent"
          : "text-text-5 hover:bg-bg-2 hover:text-text-2",
        disabled && "opacity-40 cursor-not-allowed hover:bg-transparent",
        className,
      )}
    >
      {children}
    </button>
  );
}

/** Wider variant — accepts a label, sized to fit its content. Use for
 *  named actions like "+ New" or "Filter" inside the pill. Same
 *  height/radius as the icon button. */
export function TasksToolbarLabelButton({
  onClick,
  active = false,
  disabled = false,
  title,
  children,
  className,
}: ButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-pressed={active || undefined}
      className={cn(
        "inline-flex items-center gap-1 h-[26px] px-2 rounded-[5px]",
        "text-[11px] font-medium whitespace-nowrap",
        "transition-colors",
        active
          ? "bg-accent/15 text-accent"
          : "text-text-4 hover:bg-bg-2 hover:text-text-2",
        disabled && "opacity-40 cursor-not-allowed hover:bg-transparent",
        className,
      )}
    >
      {children}
    </button>
  );
}

export function TasksToolbarSep() {
  return (
    <span
      aria-hidden
      className="inline-block w-px h-4 bg-line-soft mx-0.5"
    />
  );
}
