// The canonical task pipeline, and the small date helpers every task view
// formats with.
//
// These lived inside TasksBoard.tsx when the board was the only thing that
// rendered a task. Now the board view, the list view, the sprint grid and the
// right-rail peek all need them, and a shared module is the only way they can
// agree — a due date must read "tomorrow" in every one of those places or the
// same task looks like two different tasks.

import type { TaskStatus } from "../../lib/api";
import { shortDate } from "../../lib/calendarDate";
import {
  TASK_STATUS,
  TASK_STATUS_OPTIONS,
  TASK_STATUS_ORDER,
} from "../../lib/taskStatus";

// The board's names for the pipeline — one vocabulary for the whole app now,
// see lib/taskStatus. These were two tables of the same four words ten lines
// apart in this file, and both of them wrote "In Progress" where the chip on
// the card inside that very lane wrote "In progress".
export const TASK_COLUMNS = TASK_STATUS_OPTIONS;

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = Object.fromEntries(
  TASK_STATUS_ORDER.map((id) => [id, TASK_STATUS[id].label]),
) as Record<TaskStatus, string>;

export function isOverdue(due: string): boolean {
  // Compare YYYY-MM-DD lexically against today's local date — cheaper than
  // parsing, and immune to timezone edge cases at midnight.
  const today = new Date();
  const y = today.getFullYear();
  const m = String(today.getMonth() + 1).padStart(2, "0");
  const d = String(today.getDate()).padStart(2, "0");
  return due < `${y}-${m}-${d}`;
}

export function formatDueDate(due: string): string {
  // YYYY-MM-DD → "May 23", or a plain relative word for the days either side
  // of today, because "tomorrow" is what a reader actually needs to know.
  const d = new Date(due + "T00:00:00");
  if (isNaN(d.getTime())) return due;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diffDays = Math.round((d.getTime() - today.getTime()) / 86_400_000);
  if (diffDays === 0) return "today";
  if (diffDays === 1) return "tomorrow";
  if (diffDays === -1) return "yesterday";
  return shortDate(d.getTime());
}
