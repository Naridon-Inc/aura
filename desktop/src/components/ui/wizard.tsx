// Wizard — the reusable multi-step pieces for full-screen flows that live in
// FullscreenOverlay. `useWizard` is the index controller; `WizardStepTabs` is
// the step strip for the overlay's `tabs` slot, styled after Medusa's
// ProgressTabs: full-height tab cells that span the header, each with a status
// glyph (dotted = not started, half-solid = in progress, solid-check = done).
// Click-to-jump is gated by `canJump`. Generic so any multi-step flow (not
// just task-create) can reuse it.

import * as React from "react";

import { cn } from "../../lib/utils";

export interface WizardStepMeta {
  id: string;
  label: string;
  /** Reserved for callers that want to flag a step as skippable. */
  optional?: boolean;
  /** Leading glyph for the tab cell. In `tabs` mode every cell shows its
   *  icon (left of the label); in `steps` mode the progress StepIndicator
   *  is the glyph and this is ignored. */
  icon?: React.ReactNode;
}

export interface UseWizard {
  index: number;
  isFirst: boolean;
  isLast: boolean;
  next: () => void;
  back: () => void;
  goTo: (i: number) => void;
}

export function useWizard(count: number): UseWizard {
  const [index, setIndex] = React.useState(0);
  const clamp = React.useCallback(
    (i: number) => Math.max(0, Math.min(count - 1, i)),
    [count],
  );
  return {
    index,
    isFirst: index === 0,
    isLast: index === count - 1,
    next: () => setIndex((i) => clamp(i + 1)),
    back: () => setIndex((i) => clamp(i - 1)),
    goTo: (i: number) => setIndex(clamp(i)),
  };
}

export interface WizardStepTabsProps {
  steps: WizardStepMeta[];
  index: number;
  onJump: (i: number) => void;
  /** Whether step `i` may be jumped to (e.g. unlocked once required fields set). */
  canJump?: (i: number) => boolean;
  /** Whether step `i` is finished (shows the solid check glyph). */
  isComplete?: (i: number) => boolean;
  /** "steps" (default) shows the dotted/half/check progress glyph for a
   *  sequential flow; "tabs" drops the glyph for a non-sequential tab strip
   *  (e.g. the PR detail view's Overview / Files), marking the active cell
   *  with an accent underline instead. Both share the same full-height
   *  Medusa cell shape so every overlay's header reads identically. */
  variant?: "steps" | "tabs";
}

type StepStatus = "not-started" | "in-progress" | "completed";

export function WizardStepTabs({
  steps,
  index,
  onJump,
  canJump,
  isComplete,
  variant = "steps",
}: WizardStepTabsProps) {
  const isTabs = variant === "tabs";
  return (
    <div role="tablist" className="flex w-full items-stretch border-l border-line">
      {steps.map((s, i) => {
        const active = i === index;
        const done = (isComplete?.(i) ?? false) && !active;
        // Non-sequential tabs are always reachable; steps gate on canJump.
        const jumpable = isTabs ? true : (canJump?.(i) ?? true);
        const status: StepStatus = active
          ? "in-progress"
          : done
            ? "completed"
            : "not-started";
        return (
          <button
            key={s.id}
            type="button"
            role="tab"
            aria-selected={active}
            disabled={!jumpable && !active}
            onClick={() => (jumpable || active) && onJump(i)}
            className={cn(
              "relative inline-flex h-[52px] max-w-[200px] flex-1 items-center gap-2 border-r border-line px-4 text-left text-[13px] font-medium leading-5 transition-colors",
              "overflow-hidden text-ellipsis whitespace-nowrap outline-none",
              "focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
              active
                ? "bg-bg-content text-text-1"
                : jumpable
                  ? "bg-bg-1 text-text-4 hover:bg-bg-2 hover:text-text-2"
                  : "bg-bg-1 text-text-5 cursor-not-allowed",
            )}
          >
            {!isTabs ? (
              <StepIndicator
                status={status}
                className={cn("shrink-0", active ? "text-accent" : "text-text-4")}
              />
            ) : (
              s.icon && (
                <span
                  className={cn(
                    "shrink-0 inline-flex items-center justify-center",
                    active ? "text-accent" : "text-text-4",
                  )}
                  aria-hidden
                >
                  {s.icon}
                </span>
              )
            )}
            <span className="truncate">{s.label}</span>
            {/* Active-cell underline — the tab-mode affordance in place of the
                step glyph. */}
            {isTabs && active && (
              <span
                className="absolute inset-x-0 bottom-0 h-0.5 bg-accent"
                aria-hidden
              />
            )}
          </button>
        );
      })}
    </div>
  );
}

// StepIndicator — Medusa's three ProgressTabs glyphs, inlined so the shapes
// match exactly: CircleDottedLine / CircleHalfSolid / CheckCircleSolid.
function StepIndicator({
  status,
  className,
}: {
  status: StepStatus;
  className?: string;
}) {
  if (status === "completed") {
    return (
      <svg width="15" height="15" viewBox="0 0 15 15" fill="none" className={className} aria-hidden>
        <circle cx="7.5" cy="7.5" r="6" fill="currentColor" />
        <path
          d="M4.8 7.6l1.9 1.9 3.5-3.7"
          stroke="var(--color-bg-0)"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (status === "in-progress") {
    return (
      <svg width="15" height="15" viewBox="0 0 15 15" fill="none" className={className} aria-hidden>
        <circle cx="7.5" cy="7.5" r="5.5" stroke="currentColor" strokeWidth="1.3" />
        <path d="M7.5 2A5.5 5.5 0 017.5 13z" fill="currentColor" />
      </svg>
    );
  }
  return (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none" className={className} aria-hidden>
      <circle
        cx="7.5"
        cy="7.5"
        r="5.5"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeDasharray="1.6 1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}
