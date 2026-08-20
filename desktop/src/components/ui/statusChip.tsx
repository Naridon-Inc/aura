// StatusChip — the app's status pill: "Open", "Failing", "In review", "Done".
// Seventeen files import it, which makes it the single most-repeated object on
// screen and the one most worth getting exactly right.
//
// It used to wrap `@medusajs/ui`'s StatusBadge, and three things were wrong
// with that in ways no screenshot would show:
//
//   • `dense` applied `txt-compact-2xsmall-plus`, a class that does not exist
//     in Medusa's type ramp. It compiled to nothing, so the twenty-odd call
//     sites asking for a dense chip all got the normal one.
//   • `dot` was destructured and thrown away, while Medusa's badge drew its
//     marker unconditionally. So the prop was inert in both directions: you
//     could not ask for a dot and you could not turn one off, and the two
//     spellings rendered identically.
//   • The marker was an 8px rounded *square* parked in a fixed 20px-wide box —
//     more dead gutter than glyph — and it was the only part of the chip that
//     carried the tone. A failing check read as a grey pill with a small red
//     mark rather than as something failing.
//
// So the tone now lands on the label, where the reader is already looking, and
// the dot is a real 6px dot that appears only when asked for. Colours come from
// our own theme tokens, which means the chip tracks light mode and all five
// accent packs instead of Medusa's fixed cool ramp.
//
// The surface stays neutral on purpose. Seventeen surfaces × several chips each
// is a lot of pills, and tinting every one of their backgrounds would turn a
// task list into a paint chart. Colour is spent on the word, not the box.
//
// Audience: non-engineers. The labels below are the vocabulary — "Passing",
// "Changes requested", "No priority" — never the underlying state name.

import * as React from "react";

import { cn } from "../../lib/utils";
import { TASK_STATUS } from "../../lib/taskStatus";

export type ChipTone = "neutral" | "green" | "red" | "amber" | "violet" | "blue";

export interface StatusChipProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: ChipTone;
  /** Show a leading tone-coloured dot. Off by default — use it when the chip
   *  sits among other chips and the colour alone has to carry a distinction. */
  dot?: boolean;
  /** The 18px cut, for table cells and single-line rows. */
  dense?: boolean;
  icon?: React.ReactNode;
}

/** Label colour per tone. Neutral deliberately drops to the secondary text
 *  step rather than a colour, so "Backlog" recedes and "Failing" does not. */
const TONE_TEXT: Record<ChipTone, string> = {
  neutral: "text-text-2",
  green: "text-green",
  red: "text-red",
  amber: "text-amber",
  violet: "text-violet",
  blue: "text-blue",
};

const TONE_DOT: Record<ChipTone, string> = {
  neutral: "bg-text-3",
  green: "bg-green",
  red: "bg-red",
  amber: "bg-amber",
  violet: "bg-violet",
  blue: "bg-blue",
};

export const StatusChip = React.forwardRef<HTMLSpanElement, StatusChipProps>(
  ({ tone = "neutral", dot = false, dense = false, icon, className, children, ...props }, ref) => (
    <span
      ref={ref}
      className={cn(
        "inline-flex w-fit select-none items-center whitespace-nowrap rounded-md border border-line-soft bg-bg-2",
        dense
          ? "h-[18px] gap-1 px-1.5 text-2xs [&_svg]:size-2.5"
          : "h-[22px] gap-1.5 px-2 text-xs [&_svg]:size-3",
        TONE_TEXT[tone],
        className,
      )}
      {...props}
    >
      {dot && (
        <span
          className={cn("size-1.5 shrink-0 rounded-full", TONE_DOT[tone])}
          aria-hidden
        />
      )}
      {icon}
      {children}
    </span>
  ),
);
StatusChip.displayName = "StatusChip";

export type ChipSpec = { tone: ChipTone; label: string };

export const PR_STATE_CHIP: Record<"draft" | "open" | "merged" | "closed", ChipSpec> = {
  draft: { tone: "neutral", label: "Draft" },
  open: { tone: "green", label: "Open" },
  merged: { tone: "violet", label: "Merged" },
  closed: { tone: "red", label: "Closed" },
};

export const REVIEW_STATE_CHIP: Record<
  "approved" | "changes_requested" | "commented" | "rejected" | "pending",
  ChipSpec
> = {
  approved: { tone: "green", label: "Approved" },
  changes_requested: { tone: "amber", label: "Changes requested" },
  commented: { tone: "blue", label: "Commented" },
  rejected: { tone: "red", label: "Rejected" },
  pending: { tone: "neutral", label: "Pending" },
};

export const CI_STATE_CHIP: Record<"passed" | "failed" | "pending" | "running", ChipSpec> = {
  passed: { tone: "green", label: "Passing" },
  failed: { tone: "red", label: "Failing" },
  pending: { tone: "amber", label: "Pending" },
  running: { tone: "blue", label: "Running" },
};

// The four canonical statuses come from lib/taskStatus, which is where the
// board, the filter bar, the create wizard and both detail surfaces read them
// too. This table's own labels used to be written out here and read by nobody:
// all three call sites took `.tone` and then supplied their own word, so the
// one table that looked like the shared home was really a fourth opinion with
// better placement.
//
// `cancelled` is not a TaskStatus — nothing can be filed under it and no lane
// renders it — but a task that came back cancelled still has to draw as
// something, so it lives here beside the four rather than widening the type
// every board surface switches over.
export const TASK_STATE_CHIP: Record<
  "backlog" | "in_progress" | "in_review" | "done" | "cancelled",
  ChipSpec
> = {
  backlog: TASK_STATUS.backlog,
  in_progress: TASK_STATUS.in_progress,
  in_review: TASK_STATUS.in_review,
  done: TASK_STATUS.done,
  cancelled: { tone: "neutral", label: "Cancelled" },
};

export const PRIORITY_CHIP: Record<"urgent" | "high" | "medium" | "low" | "none", ChipSpec> = {
  urgent: { tone: "red", label: "Urgent" },
  high: { tone: "amber", label: "High" },
  medium: { tone: "blue", label: "Medium" },
  low: { tone: "neutral", label: "Low" },
  none: { tone: "neutral", label: "No priority" },
};
