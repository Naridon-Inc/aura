// The plain words Goals is told in: what a part is called, how many are in
// place, where a file sits, and the one tension the page exists to show — a
// task the board calls done that the code doesn't back up.

import { sentenceCase } from "@shared/textCase";
import { humanizeIdentifier } from "../../../lib/prove";
import { isTaskDone } from "../../../lib/taskGoals";
import type { GoalRequirement, GoalVerdict } from "../../../lib/goalStore";
import type { TaskStatus } from "../../../lib/api";
import { formatCount } from "./storyFormat";

/** How many goals a group shows before "Show all". */
export const GOALS_SHOWN = 6;
/** How many parts or files a goal's story shows before "Show all". */
export const PARTS_SHOWN = 8;

/** Marked done on the board, but a check couldn't find it all in the code. */
export function claimsDoneButNot(status: TaskStatus, verdict: GoalVerdict): boolean {
  return isTaskDone(status) && (verdict === "not_wired" || verdict === "partial");
}

/** A part a goal was broken into, named in words: `saveThemePref` reads
 *  "Save theme pref". A name that is already words is kept as it is. */
export function requirementTitle(r: GoalRequirement): string {
  if (!r.nodeName || /\s/.test(r.nodeName)) return r.nodeName;
  return sentenceCase(humanizeIdentifier(r.nodeName)) || r.nodeName;
}

/** "3 of 4 parts are in place." — or nothing before anything was checked. */
export function partsSentence(passed: number, total: number): string | null {
  if (total <= 0) return null;
  if (passed >= total) return total === 1 ? "The one part it needs is in place." : `All ${formatCount(total)} parts it needs are in place.`;
  if (passed <= 0) return total === 1 ? "The one part it needs isn't in place yet." : `None of the ${formatCount(total)} parts it needs are in place yet.`;
  return `${formatCount(passed)} of the ${formatCount(total)} parts it needs are in place.`;
}

/** A file as a name and the folder it sits in. */
export function splitPath(path: string): { name: string; folder: string } {
  const slash = path.lastIndexOf("/");
  if (slash < 0) return { name: path, folder: "the repository's top folder" };
  return { name: path.slice(slash + 1), folder: path.slice(0, slash) };
}
