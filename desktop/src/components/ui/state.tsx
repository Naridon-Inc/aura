// The four states any list, pane or surface can be in — loading, empty,
// filtered-empty, broken — in one shape, so two surfaces never disagree about
// what "nothing here yet" looks like.
//
// This file used to hold a thinner set: an EmptyState that took children and
// nothing else. Three files imported it. Meanwhile five more — the clips tray,
// the meaning plane, the attestations dialog, the crew surface, the tasks rail
// — each declared a private `function EmptyState()` of their own, and the good
// implementation (icon, heading, one plain line, one action) lived under
// `components/board/BoardEmpty.tsx`, whose header claimed to be "the ONE empty
// state every work surface uses" while four files used it. A component named
// `BoardEmpty` reads as board furniture, so surfaces that were not boards
// wrote their own instead — which is exactly the drift the name caused.
//
// So the implementation moved here, where someone looking for "the three
// states" already looks, and `components/board` re-exports it under its old
// names for the board system's own call sites.
//
// ─── Measured against Plane ────────────────────────────────────────────────
//
// Plane ships three empty-state layouts chosen by how much ROOM there is, not
// by what's missing: a simple one (panel / widget / list body), a section one
// (a bounded card) and a detailed one (full page). We collapse that to one
// component with a `size`, because our two real cases are "a rail or a
// section" and "a whole surface" — and the middle variant's job, drawing a
// bordered box, is one we don't want at all: this app's rule is no bulky
// cards, and an empty state least of all.
//
// Numbers taken from their spec and honoured here:
//   • ONE gap value between every element in the small size — 10px, no
//     per-slot spacing.
//   • The page size uses 20px between blocks, 6px between heading and body,
//     and 20px/40px padding.
//   • The heading RESTYLES on whether a description exists — smaller and
//     quieter when it's alone, so a title-only empty state reads as a caption
//     rather than an announcement.
//   • Flat hierarchy on purpose: heading tertiary, body placeholder, body only
//     one step below the heading. An empty state should recede, not shout.
//   • The CTA's size is bound to the empty state's size — one prop drives both.
//
// Where we deliberately diverge, and why:
//   • NO ILLUSTRATIONS. Plane pairs every empty state with two theme-matched
//     raster banners. Those are their assets under their licence; we draw a
//     line icon from our own set instead. That also means we keep the copy
//     centred at a readable measure rather than adopting their left-aligned
//     720–960px block, which only reads well beside a wide banner.
//   • 18px headings land on our 16px step. Our type ladder has no 18, and
//     inventing one for a single component would undo the point of a ladder.
//   • The small size KEEPS a call to action, which their simple variant
//     doesn't have. Their panels always have a toolbar within reach; our rail
//     peek and sub-task section don't, so the empty state is the only place
//     the action can live.
//
// Three rules this app adds on top:
//   • THE COPY IS FOR NON-ENGINEERS. The heading says what's missing in plain
//     words and the line says what this place is FOR. No status enums, no
//     "0 results", no file paths.
//   • FILTERED-EMPTY IS NOT EMPTY. A board with work in it that your filters
//     hid must never offer "create the first one" — it must offer to show you
//     what's there. `FilteredEmptyState` is that state, and it's a separate
//     export precisely so a caller can't reach for the wrong one by accident.
//   • LOADING IS NOT EMPTY EITHER. Render `LoadingState` until the first fetch
//     settles. An empty state shown over data that is still arriving is a lie,
//     and the reader has no way to know it was one.

import * as React from "react";
import type { JSX, ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { AlertTriangle, RefreshCw, SearchX } from "lucide-react";

import { cn } from "../../lib/utils";
import { AsciiSpinner } from "./ascii-spinner";
import { Button } from "./button";

/** Shared outer stack. `sm` is for a rail, a lane or a detail section, where
 *  page spacing would push the surrounding content off screen; `md` owns a
 *  whole surface. Same anatomy either way, never a different design. */
function stack(size: "sm" | "md"): string {
  return size === "sm"
    ? // One 10px gap between every element.
      "flex w-full flex-col items-center gap-2.5 px-4 py-6 text-center"
    : // 20px between blocks, 20px/40px padding, centred both axes.
      "flex w-full flex-col items-center gap-5 px-5 py-10 text-center";
}

/**
 * In-flight. `label` names what is being fetched — "Loading your team…", not a
 * bare "Loading…", which reads as a stall rather than progress.
 *
 * `size="sm"` is the inline row a section header or a settings pane wants;
 * `size="md"` is the centred column that matches `EmptyState` on a surface
 * that will render one of the two.
 */
export function LoadingState({
  label,
  size = "sm",
  className,
}: {
  label: string;
  size?: "sm" | "md";
  className?: string;
}): JSX.Element {
  return size === "sm" ? (
    <div
      role="status"
      className={cn("flex items-center gap-2 px-3 py-6 text-sm text-text-3", className)}
    >
      <AsciiSpinner className="text-sm leading-none" />
      {label}
    </div>
  ) : (
    <div role="status" className={cn(stack("md"), "text-text-3", className)}>
      <AsciiSpinner className="text-base leading-none" />
      <p className="text-base">{label}</p>
    </div>
  );
}

/**
 * The genuinely-empty state: this place is real, and nothing is in it yet.
 */
export function EmptyState({
  icon: Icon,
  title,
  body,
  action,
  footnote,
  size = "md",
  className,
}: {
  icon: LucideIcon;
  /** Sentence case, says what is missing. "No work items yet". */
  title: string;
  /** One line, plain language, says what this place is for. Omit it and the
   *  heading quiets down to match — a title-only empty state is a caption. */
  body?: ReactNode;
  /** At most one primary action. Arctic-blue accent: it's the only affordance
   *  on an otherwise empty screen, so it must be unambiguously the next move. */
  action?: { label: string; onClick: () => void; icon?: LucideIcon; disabled?: boolean };
  /** A quieter line under the action — a shortcut, an error note, or a second
   *  route for people who'd rather not press the button. */
  footnote?: ReactNode;
  size?: "sm" | "md";
  className?: string;
}): JSX.Element {
  const ActionIcon = action?.icon;
  const sm = size === "sm";

  return (
    <div className={cn(stack(size), className)}>
      <Icon
        className={`${sm ? "h-6 w-6" : "h-8 w-8"} text-text-5`}
        strokeWidth={1.25}
        aria-hidden
      />

      {/* 6px between heading and body on the page size; on the small size the
          single 10px gap governs, so this stack keeps the same rhythm. */}
      <div className={`flex flex-col ${sm ? "gap-2.5" : "gap-1.5"}`}>
        <p
          className={
            body
              ? // With something to say underneath, the heading steps back and
                // lets the sentence carry the meaning.
                sm
                ? "text-lg font-medium text-text-3"
                : "text-lg font-semibold text-text-1"
              : // Alone, it shrinks and fades into a caption.
                "text-base font-medium text-text-4"
          }
        >
          {title}
        </p>
        {body && (
          // Measure-capped: centred copy past roughly 60 characters a line
          // stops being readable at a glance, which is this line's only job.
          <p
            className={`max-w-[420px] ${
              sm ? "text-md font-medium text-text-4" : "text-base text-text-3"
            }`}
          >
            {body}
          </p>
        )}
      </div>

      {(action || footnote) && (
        <div className="flex flex-col items-center gap-2">
          {action && (
            <Button
              variant="accentSoft"
              size={sm ? "xs" : "sm"}
              onClick={action.onClick}
              disabled={action.disabled}
            >
              {ActionIcon && <ActionIcon strokeWidth={2} aria-hidden />}
              {action.label}
            </Button>
          )}
          {footnote && <p className="text-xs text-text-5">{footnote}</p>}
        </div>
      )}
    </div>
  );
}

/**
 * The filtered-empty state: there IS work here, your filters are hiding it.
 *
 * Separate from `EmptyState` on purpose. Telling someone "nothing here yet —
 * add your first work item" when they have thirty items and one stray filter
 * is the worst thing an empty state can do: it makes them think they lost
 * their work. So this one names the cause, offers the cure, and never offers
 * to create anything.
 */
export function FilteredEmptyState({
  onClear,
  /** What's hidden, in plain words — "tasks", "sub-tasks", "runs". Every
   *  caller should pass the word its own surface uses; the fallback is
   *  deliberately the vaguest word rather than a domain guess, because a
   *  shared component naming somebody else's noun is how "work items" ended
   *  up on a screen whose every other label said "task". */
  noun = "items",
  size = "md",
}: {
  onClear: () => void;
  noun?: string;
  size?: "sm" | "md";
}): JSX.Element {
  return (
    <EmptyState
      icon={SearchX}
      title="Nothing matches those filters"
      body={`There are ${noun} here. The filters you've set are hiding all of them.`}
      action={{ label: "Clear filters", onClick: onClear }}
      size={size}
    />
  );
}

/**
 * The surface tried to load and couldn't.
 *
 * Same anatomy as `EmptyState` so the two never look like different kinds of
 * problem, with one difference: the icon is amber. That is the only colour
 * spent on any of these four, because a failure is the only one of them that
 * needs the reader to do something.
 *
 * `message` carries whatever the surface knows — it is shown verbatim, so give
 * it something a person can read, not a raw exception where you can help it.
 * `onRetry` should re-run exactly the load that failed.
 */
export function ErrorState({
  title = "That didn’t load",
  message,
  onRetry,
  size = "md",
  className,
}: {
  title?: string;
  message: ReactNode;
  onRetry?: () => void;
  size?: "sm" | "md";
  className?: string;
}): JSX.Element {
  const sm = size === "sm";
  return (
    <div role="alert" className={cn(stack(size), className)}>
      <AlertTriangle
        className={`${sm ? "h-6 w-6" : "h-8 w-8"} text-amber`}
        strokeWidth={1.25}
        aria-hidden
      />
      <div className={`flex flex-col ${sm ? "gap-2.5" : "gap-1.5"}`}>
        <p className={sm ? "text-lg font-medium text-text-3" : "text-lg font-semibold text-text-1"}>
          {title}
        </p>
        <p
          className={`max-w-[420px] ${
            sm ? "text-md font-medium text-text-4" : "text-base text-text-3"
          }`}
        >
          {message}
        </p>
      </div>
      {onRetry && (
        <Button variant="subtle" size={sm ? "xs" : "sm"} onClick={onRetry} className="gap-1.5">
          <RefreshCw size={sm ? 12 : 13} strokeWidth={2} aria-hidden />
          Try again
        </Button>
      )}
    </div>
  );
}

/**
 * A failure that belongs to one field or one section rather than the whole
 * surface — a save that didn't take, a row that wouldn't refresh. Inline, red,
 * and it does not take over the layout the way `ErrorState` does.
 */
export function ErrorNote({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <div
      role="alert"
      className={cn(
        "rounded border border-red/30 bg-red/10 px-3 py-2 text-sm text-red",
        className,
      )}
    >
      {children}
    </div>
  );
}
