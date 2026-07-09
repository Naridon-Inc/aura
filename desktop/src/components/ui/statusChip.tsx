import * as React from "react";
import { StatusBadge as MedusaStatusBadge } from "@medusajs/ui";

import { cn } from "../../lib/utils";

export type ChipTone = "neutral" | "green" | "red" | "amber" | "violet" | "blue";

export interface StatusChipProps extends React.ComponentPropsWithoutRef<typeof MedusaStatusBadge> {
  tone?: ChipTone;
  dot?: boolean;
  dense?: boolean;
  icon?: React.ReactNode;
}

const colorMap: Record<ChipTone, React.ComponentPropsWithoutRef<typeof MedusaStatusBadge>["color"]> = {
  neutral: "grey",
  green: "green",
  red: "red",
  amber: "orange",
  violet: "purple",
  blue: "blue",
};

export const StatusChip = React.forwardRef<HTMLSpanElement, StatusChipProps>(
  ({ tone = "neutral", dot: _dot, dense = false, icon, className, children, ...props }, ref) => (
    <MedusaStatusBadge
      ref={ref}
      color={colorMap[tone]}
      className={cn(dense && "txt-compact-2xsmall-plus", className)}
      {...props}
    >
      {icon}
      {children}
    </MedusaStatusBadge>
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

export const TASK_STATE_CHIP: Record<
  "backlog" | "in_progress" | "in_review" | "done" | "cancelled",
  ChipSpec
> = {
  backlog: { tone: "neutral", label: "Backlog" },
  in_progress: { tone: "blue", label: "In progress" },
  in_review: { tone: "amber", label: "In review" },
  done: { tone: "green", label: "Done" },
  cancelled: { tone: "neutral", label: "Cancelled" },
};

export const PRIORITY_CHIP: Record<"urgent" | "high" | "medium" | "low" | "none", ChipSpec> = {
  urgent: { tone: "red", label: "Urgent" },
  high: { tone: "amber", label: "High" },
  medium: { tone: "blue", label: "Medium" },
  low: { tone: "neutral", label: "Low" },
  none: { tone: "neutral", label: "No priority" },
};
