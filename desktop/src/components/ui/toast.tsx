// Toast — the one card shape every bottom-right notification in the app wears.
//
// Before this module there were six hosts (the general Toaster, the CLI update
// pill, plugin toasts, the crash report, the huddle failure, the recording
// notice) and each hand-rolled its own surface: three radii, three shadows,
// four widths and a pile of raw hex that ignored the theme entirely. Seeing two
// of them stacked in the same corner made the app look assembled rather than
// designed.
//
// One shape now: a `--color-bg-2` card, hairline `--color-line` border, a 2px
// tone stripe down the left, a tone dot, a 13px/600 title, a 12.5px body, an
// optional right-aligned action row, and an optional close button that can draw
// a draining countdown ring. Tone is the ONLY colour a toast carries, and it is
// always a token — green means done, amber means needs-you, red means failed,
// accent means informational.
//
// `ToastStack` is the fixed-position column. Hosts keep their own bottom offset
// and z-index (they deliberately stack in the same corner at different heights)
// but share the width, gap and pointer-events behaviour.

import * as React from "react";

import { cn } from "../../lib/utils";

export type ToastTone = "info" | "accent" | "success" | "warning" | "danger";

/** Tone → token. Never a literal: the theme owns these values. */
export const toastToneColor: Record<ToastTone, string> = {
  info: "var(--color-accent)",
  accent: "var(--color-accent)",
  success: "var(--color-accent-green)",
  warning: "var(--color-amber)",
  danger: "var(--color-red)",
};

const RING_R = 9;
const RING_C = 2 * Math.PI * RING_R;

export interface ToastStackProps {
  /** Distance from the bottom of the viewport, px. Hosts differ so their
   *  cards sit above/below each other rather than overlapping. */
  bottom?: number;
  /** Stacking order against the other hosts in this corner. */
  zIndex?: number;
  /** Newest card nearest the corner (the general Toaster appends). */
  reverse?: boolean;
  children: React.ReactNode;
}

export function ToastStack({
  bottom = 16,
  zIndex = 9999,
  reverse = false,
  children,
}: ToastStackProps) {
  return (
    <div
      aria-live="polite"
      className={cn(
        "fixed right-4 flex w-[360px] max-w-[calc(100vw-32px)] gap-2.5",
        // Clicks fall through the gaps between cards; each card re-enables.
        "pointer-events-none",
        reverse ? "flex-col-reverse" : "flex-col",
      )}
      style={{ bottom, zIndex }}
    >
      {children}
    </div>
  );
}

export interface ToastCloseButtonProps {
  onDismiss: () => void;
  /** Draws a ring that drains over this many ms; the ring IS the timer, so
   *  when it finishes it calls `onDurationEnd`. `null` → plain close button. */
  durationMs?: number | null;
  paused?: boolean;
  onDurationEnd?: () => void;
  label?: string;
  title?: string;
}

export function ToastCloseButton({
  onDismiss,
  durationMs = null,
  paused = false,
  onDurationEnd,
  label = "Dismiss",
  title,
}: ToastCloseButtonProps) {
  const hasRing = durationMs != null && durationMs > 0;
  return (
    <button
      type="button"
      onClick={onDismiss}
      aria-label={label}
      title={title ?? label}
      className="relative grid size-[22px] shrink-0 place-items-center rounded-full border-none bg-transparent p-0 leading-none text-text-4 transition-colors hover:bg-bg-3 hover:text-text-2 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      {hasRing && (
        <svg
          width={22}
          height={22}
          viewBox="0 0 22 22"
          aria-hidden
          // Start draining from 12 o'clock.
          className="absolute inset-0 -rotate-90"
        >
          <circle cx={11} cy={11} r={RING_R} fill="none" stroke="var(--color-line)" strokeWidth={1.5} />
          <circle
            cx={11}
            cy={11}
            r={RING_R}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeDasharray={RING_C}
            style={{
              animation: `aura-toast-ring ${durationMs}ms linear forwards`,
              animationPlayState: paused ? "paused" : "running",
            }}
            onAnimationEnd={onDurationEnd ?? onDismiss}
          />
        </svg>
      )}
      <CloseGlyph />
    </button>
  );
}

function CloseGlyph() {
  return (
    <svg width="9" height="9" viewBox="0 0 16 16" fill="none" aria-hidden className="relative">
      <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

export interface ToastActionButtonProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  /** Exactly one action per toast may be `primary`. */
  variant?: "primary" | "default";
  children: React.ReactNode;
}

export function ToastActionButton({
  variant = "default",
  className,
  children,
  ...props
}: ToastActionButtonProps) {
  return (
    <button
      type="button"
      className={cn(
        "inline-flex h-[26px] items-center whitespace-nowrap rounded-[var(--radius-sm)] px-2.5 text-[11.5px] font-medium transition-colors",
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-60",
        variant === "primary"
          ? "border border-transparent bg-accent text-bg-0 hover:opacity-90"
          : "border border-line bg-transparent text-text-2 hover:bg-bg-3 hover:text-text-1",
        className,
      )}
      {...props}
    />
  );
}

export interface ToastCardProps {
  tone?: ToastTone;
  title?: React.ReactNode;
  /** Body copy. Muted, sits under the title. */
  message?: React.ReactNode;
  /** Right-aligned action row under the body. */
  actions?: React.ReactNode;
  /** Replaces the tone dot (e.g. a spinner while work is in flight). */
  icon?: React.ReactNode;
  /** Extra content below the body — the crash report drawer uses this. */
  children?: React.ReactNode;
  onDismiss?: () => void;
  durationMs?: number | null;
  paused?: boolean;
  onDurationEnd?: () => void;
  dismissLabel?: string;
  dismissTitle?: string;
  /** `alert` for failures the reader must not miss. */
  role?: "status" | "alert";
  className?: string;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
}

export function ToastCard({
  tone = "info",
  title,
  message,
  actions,
  icon,
  children,
  onDismiss,
  durationMs = null,
  paused = false,
  onDurationEnd,
  dismissLabel,
  dismissTitle,
  role = "status",
  className,
  onMouseEnter,
  onMouseLeave,
}: ToastCardProps) {
  const color = toastToneColor[tone];
  return (
    <div
      role={role}
      aria-live={role === "alert" ? "assertive" : "polite"}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      className={cn(
        "pointer-events-auto flex w-full items-start gap-2.5 rounded-[var(--radius-md)] border border-line bg-bg-2 py-2.5 pl-3 pr-3 text-text-2 shadow-[var(--shadow-flyout)]",
        className,
      )}
      style={{ borderLeft: `2px solid ${color}` }}
    >
      {icon ?? (
        <span
          aria-hidden
          className="mt-1 size-[7px] shrink-0 rounded-full"
          style={{ background: color }}
        />
      )}

      <div className="min-w-0 flex-1">
        {title != null && (
          <div className="text-[13px] font-semibold leading-[1.35] text-text-1">{title}</div>
        )}
        {message != null && (
          <div className={cn("text-[12.5px] leading-[1.45] text-text-3", title != null && "mt-0.5")}>
            {message}
          </div>
        )}
        {children}
        {actions != null && (
          <div className="mt-2.5 flex flex-wrap items-center justify-end gap-1.5">{actions}</div>
        )}
      </div>

      {onDismiss != null && (
        <ToastCloseButton
          onDismiss={onDismiss}
          durationMs={durationMs}
          paused={paused}
          onDurationEnd={onDurationEnd}
          label={dismissLabel}
          title={dismissTitle}
        />
      )}
    </div>
  );
}

/** The countdown-ring keyframes. Rendered once by whichever host draws rings. */
export function ToastRingKeyframes() {
  return <style>{`@keyframes aura-toast-ring { from { stroke-dashoffset: 0 } to { stroke-dashoffset: ${RING_C}px } }`}</style>;
}
