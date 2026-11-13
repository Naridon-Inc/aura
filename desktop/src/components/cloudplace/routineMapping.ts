// Routines between the server's shape and the library editor's.
//
// The server keeps a schedule as ISO weekdays and a time of day in a fixed
// zone; the editor speaks in "Every day at 09:00". Only the schedules both
// can say are offered, so nothing saved reads back as something else.

import type { CloudRoutineRow, NewCloudRoutine } from "../../lib/cloudWorkspacesApi";
import type { CloudRoutine, RoutineTrigger } from "../ui/cloud-routines";
import { relTime } from "../workspaces/workspacesModel";

/** The zone schedules are written in. The server stores it beside each schedule. */
export const ROUTINE_TZ = "UTC";

const EVERY_DAY = [1, 2, 3, 4, 5, 6, 7];
const WEEKDAYS = [1, 2, 3, 4, 5];

/** The schedule words the server can hold, in the editor's vocabulary. */
export const ROUTINE_SCHEDULES = ["Every day", "Every weekday"];

/** Triggers the server accepts. A GitHub event trigger isn't one of them. */
export const ROUTINE_TRIGGER_TYPES: RoutineTrigger["type"][] = ["Scheduled", "Webhook"];

/** Saved routines can't be edited: the server has no update for them. */
export const ROUTINE_READ_ONLY =
  "Saved routines can’t be changed from the app yet — delete it and save a new one.";

type ScheduleConfig = { days?: unknown; at?: unknown; tz?: unknown };

function sameDays(a: number[], b: number[]) {
  return a.length === b.length && a.every((d, i) => d === b[i]);
}

function scheduleWords(days: number[]): string {
  if (sameDays(days, EVERY_DAY)) return "Every day";
  if (sameDays(days, WEEKDAYS)) return "Every weekday";
  return "Custom";
}

function triggerOf(t: CloudRoutineRow["triggers"][number]): RoutineTrigger | null {
  if (t.kind === "schedule") {
    const c = (t.config ?? {}) as ScheduleConfig;
    const days = Array.isArray(c.days)
      ? c.days.filter((d): d is number => typeof d === "number").sort((a, b) => a - b)
      : [];
    const at = typeof c.at === "string" ? c.at : "";
    const schedule = scheduleWords(days);
    return {
      id: t.id,
      type: "Scheduled",
      schedule,
      // A schedule the editor can't word keeps its days visible rather than
      // reading as some other schedule.
      time: schedule === "Custom" ? `${at} on days ${days.join(",")}` : at,
      event: "",
      filter: "",
    };
  }
  if (t.kind === "webhook") return { id: t.id, type: "Webhook", schedule: "", time: "", event: "", filter: "" };
  return null;
}

function stamp(iso: string | null | undefined): number {
  const at = iso ? Date.parse(iso) : Number.NaN;
  return Number.isNaN(at) ? 0 : at;
}

/** A stored routine as the editor draws it. */
export function routineFromRow(row: CloudRoutineRow, nowMs: number): CloudRoutine {
  const last = stamp(row.last_fired_at);
  return {
    id: row.id,
    name: row.name,
    prompt: row.prompt,
    repository: row.repo ?? "",
    model: { model: row.model ?? "", effort: row.effort ?? undefined },
    enabled: row.enabled,
    triggers: row.triggers.map(triggerOf).filter((t): t is RoutineTrigger => t !== null),
    runs: [],
    versions: [],
    runCount: row.run_count,
    lastRunLabel: last ? relTime(Math.floor(last / 1000), nowMs) : undefined,
  };
}

/** What to send to create a routine from an editor draft. */
export function routineToNew(draft: CloudRoutine, tz: string = ROUTINE_TZ): NewCloudRoutine {
  const triggers: NewCloudRoutine["triggers"] = [];
  for (const t of draft.triggers) {
    if (t.type === "Scheduled") {
      const days = t.schedule === "Every weekday" ? WEEKDAYS : EVERY_DAY;
      triggers.push({ kind: "schedule", config: { days, at: t.time, tz } });
    } else if (t.type === "Webhook") {
      triggers.push({ kind: "webhook", config: {} });
    }
  }
  return {
    name: draft.name.trim(),
    prompt: draft.prompt.trim(),
    repo: draft.repository || null,
    model: draft.model.model || null,
    effort: draft.model.effort ?? null,
    enabled: draft.enabled,
    triggers,
  };
}
