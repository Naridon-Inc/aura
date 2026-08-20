// Wizard — the reusable multi-step pieces for full-screen flows that live in
// FullscreenOverlay. `useWizard` is the index controller; `WizardStepTabs` is
// the step strip for the overlay's `tabs` slot, styled after Medusa's
// ProgressTabs: full-height tab cells that span the header, each with a status
// glyph (dotted = not started, half-solid = in progress, solid-check = done).
// Click-to-jump is gated by `canJump`. Generic so any multi-step flow (not
// just task-create) can reuse it.
//
// `WizardStepTabs` also answered to `variant="tabs"`, which was a plain view
// switch wearing the wizard's clothes: no progress, no gate, nothing
// sequential about it, but 52px cells that stretched to fill the bar. That is
// `ViewTabs`' job and it draws 44px cells that keep their label's width, so
// the detail panes that asked for `variant="tabs"` were the only surfaces in
// the app whose header was a different height. It now delegates rather than
// re-draws; only the sequential half is still implemented here.

import * as React from "react";

import { cn } from "../../lib/utils";
import { ViewTabs } from "./tabs";

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
   *  sequential flow. "tabs" is a non-sequential view switch (the PR detail
   *  view's Overview / Files, and its kind) and is rendered by `ViewTabs`,
   *  the app's one tab strip — see the delegation below. */
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

  // A "tab" here is the same job `ViewTabs` does on Tasks, Trace and
  // Workspaces: which drawing of this thing am I reading. It was drawn
  // separately, and separately meant differently — 52px cells that stretched
  // to fill, against the shared strip's 44px cells that keep their label's
  // width. So the Session, PR and Task detail panes wore a header 8px taller
  // than every other surface, with the tab underneath jumping as you moved
  // between them.
  //
  // Only the tabs half delegates. `steps` is not the same control wearing a
  // different skin: it is a sequential flow with a progress glyph per cell and
  // a gate on which of them you may jump to, and none of that has a meaning in
  // a tab strip.
  if (isTabs) {
    return (
      <ViewTabs
        value={steps[index]?.id ?? steps[0]?.id ?? ""}
        onChange={(id) => {
          const i = steps.findIndex((s) => s.id === id);
          if (i >= 0) onJump(i);
        }}
        options={steps.map((s) => ({
          value: s.id,
          label: s.label,
          icon: s.icon,
        }))}
        className="w-full"
      />
    );
  }

  return (
    <div role="tablist" className="flex w-full items-stretch border-l border-line">
      {steps.map((s, i) => {
        const active = i === index;
        const done = (isComplete?.(i) ?? false) && !active;
        const jumpable = canJump?.(i) ?? true;
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
              "relative inline-flex h-[52px] max-w-[200px] flex-1 items-center gap-2 border-r border-line px-4 text-left text-base font-medium leading-5 transition-colors",
              "overflow-hidden text-ellipsis whitespace-nowrap outline-none",
              "focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
              active
                ? "bg-bg-content text-text-1"
                : jumpable
                  ? "bg-bg-1 text-text-4 hover:bg-state-hover hover:text-text-2"
                  : "bg-bg-1 text-text-5 cursor-not-allowed",
            )}
          >
            <StepIndicator
              status={status}
              className={cn("shrink-0", active ? "text-accent" : "text-text-4")}
            />
            <span className="truncate">{s.label}</span>
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
