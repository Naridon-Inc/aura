// The three states every list/pane can be in — loading, empty, broken — in one
// shape, so two settings panes never disagree about what "nothing here yet"
// looks like.
//
// Loading is always the app's one loader (the amber braille AsciiSpinner) with
// a plain-language label saying what is being fetched; a bare "Loading…" reads
// as a stall. Empty is the dashed-outline card the Settings panes already use.
// Broken is the same card inked red — the ONE place colour is spent here,
// because a failure is the only one of the three that needs the reader to act.

import * as React from "react";

import { cn } from "../../lib/utils";
import { AsciiSpinner } from "./ascii-spinner";

/** In-flight. `label` should name what's being fetched ("Loading your team…"). */
export function LoadingState({ label, className }: { label: string; className?: string }) {
  return (
    <div
      role="status"
      className={cn("flex items-center gap-2 px-3 py-6 text-[12px] text-text-3", className)}
    >
      <AsciiSpinner className="text-[12px] leading-none" />
      {label}
    </div>
  );
}

/** Nothing here yet. `children` may carry a hint or a single action. */
export function EmptyState({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "rounded border border-dashed border-line-soft px-3 py-6 text-center text-[12px] text-text-4",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** It broke. Say what failed and what to do — never just an exception string. */
export function ErrorState({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={cn(
        "rounded border border-red/30 bg-red/10 px-3 py-2 text-[12px] text-red",
        className,
      )}
    >
      {children}
    </div>
  );
}
