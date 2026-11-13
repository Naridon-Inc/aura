// A goal verdict as the status tone every report item and mark shares, so a
// goal reads the same in a session's Summary, a task and the Goals page.

import type { GoalVerdict } from "../../lib/goalStore";
import type { TraceTone } from "../ui/trace-report";

export const VERDICT_TONE: Record<GoalVerdict, TraceTone> = {
  verified: "good",
  partial: "warn",
  not_wired: "bad",
  unknown: "muted",
};

/** The same verdict as a mark's tone; an unchecked goal gets the plain mark. */
export const VERDICT_MARK: Record<GoalVerdict, "good" | "warn" | "danger" | undefined> = {
  verified: "good",
  partial: "warn",
  not_wired: "danger",
  unknown: undefined,
};
