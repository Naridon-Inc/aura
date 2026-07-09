// Plain-language labels for the Automations surface.
//
// Audience = non-engineers / vibecoders. NO cron syntax, NO AST/lease jargon
// on the surface — "Every weekday · 9:00am", never "0 9 * * 1-5". Everything
// the recipe rows and form render as human text comes from here.

import type {
  Action,
  Automation,
  AutomationRunRecord,
  Cadence,
  Trigger,
  WriteMode,
} from "../../lib/api";

// ── Cadence ──────────────────────────────────────────────────────────────

export const CADENCE_OPTIONS: { value: Cadence; label: string }[] = [
  { value: "daily", label: "Every day" },
  { value: "weekdays", label: "Every weekday" },
  { value: "weekly", label: "Every week" },
  { value: "hourly", label: "Every hour" },
];

const WEEKDAY_LABELS = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];

export const WEEKDAY_OPTIONS = WEEKDAY_LABELS.map((label, i) => ({
  value: String(i),
  label,
}));

/** "9:00am" from "HH:MM". */
export function prettyTime(timeHm: string): string {
  const [hRaw, mRaw] = timeHm.split(":");
  const h = Number(hRaw);
  const m = Number(mRaw);
  if (Number.isNaN(h) || Number.isNaN(m)) return timeHm;
  const period = h < 12 ? "am" : "pm";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  const mm = m.toString().padStart(2, "0");
  return `${h12}:${mm}${period}`;
}

/** "Every weekday · 9:00am" — the WHEN line. */
export function describeTrigger(t: Trigger): string {
  const time = prettyTime(t.time_hm);
  switch (t.cadence) {
    case "hourly":
      // Honor the :MM the user picked.
      return `Every hour · at :${t.time_hm.split(":")[1] ?? "00"}`;
    case "daily":
      return `Every day · ${time}`;
    case "weekdays":
      return `Every weekday · ${time}`;
    case "weekly": {
      const wd = WEEKDAY_LABELS[t.weekday ?? 0] ?? "Monday";
      return `Every ${wd} · ${time}`;
    }
    default:
      return time;
  }
}

// ── Actions ──────────────────────────────────────────────────────────────

export const ACTION_KIND_OPTIONS: { value: Action["kind"]; label: string }[] = [
  { value: "run_agent", label: "Run an agent" },
  { value: "run_pr_review", label: "Review my changes" },
  { value: "post_to_page", label: "Post to a Page" },
  { value: "create_task", label: "Create a task" },
];

export const WRITE_MODE_OPTIONS: { value: WriteMode; label: string }[] = [
  { value: "append", label: "Add to the bottom" },
  { value: "overwrite", label: "Replace the whole Page" },
];

export const PAGE_SCOPE_OPTIONS: { value: string; label: string }[] = [
  { value: "team", label: "Team" },
  { value: "member", label: "Just me" },
];

/** A short human label for an action — the DO / THEN line. */
export function describeAction(a: Action | null | undefined): string {
  if (!a) return "";
  switch (a.kind) {
    case "run_agent": {
      const who = a.agent || "an agent";
      const what = a.prompt.trim();
      return what ? `Run ${who} — ${truncate(what, 60)}` : `Run agent ${who}`;
    }
    case "run_pr_review":
      return a.base ? `Review my changes vs ${a.base}` : "Review my changes";
    case "post_to_page": {
      const title = a.page.title?.trim() || "a Page";
      const verb = a.mode === "overwrite" ? "Replace" : "Post to";
      return `${verb} Page "${title}"`;
    }
    case "create_task":
      return a.title.trim() ? `Create task "${truncate(a.title, 50)}"` : "Create a task";
    default:
      return "";
  }
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max).trimEnd()}…`;
}

// ── Run records ──────────────────────────────────────────────────────────

/** "2m ago" / "yesterday" / "3d ago" from an ISO timestamp. */
export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const secs = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (secs < 45) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days === 1) return "yesterday";
  return `${days}d ago`;
}

/** "14s" / "1m02s" elapsed between two ISO timestamps. */
export function elapsedBetween(
  start: string | null | undefined,
  end: string | null | undefined,
): string {
  if (!start || !end) return "";
  const a = Date.parse(start);
  const b = Date.parse(end);
  if (Number.isNaN(a) || Number.isNaN(b)) return "";
  const secs = Math.max(0, Math.floor((b - a) / 1000));
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  return `${m}m${(secs % 60).toString().padStart(2, "0")}s`;
}

/** "Every day · 9:00am" next-fire hint for an automation card. */
export function describeNextRun(a: Automation): string {
  if (!a.enabled) return "Paused";
  if (!a.next_run_at) return "Scheduled";
  const when = relativeNextRun(a.next_run_at);
  return when ? `Next: ${when}` : "Scheduled";
}

function relativeNextRun(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const secs = Math.floor((t - Date.now()) / 1000);
  if (secs <= 0) return "due now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `in ${Math.max(1, mins)}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `in ${hrs}h`;
  const days = Math.floor(hrs / 24);
  if (days === 1) return "tomorrow";
  return `in ${days}d`;
}

/** Proof / status verdict text for a Recent-runs row. */
export function runVerdict(r: AutomationRunRecord): {
  label: string;
  tone: "ok" | "fail" | "proven";
} {
  if (!r.ok) return { label: "Failed", tone: "fail" };
  if (r.commit) return { label: "Proven", tone: "proven" };
  return { label: "Done", tone: "ok" };
}

// The user's local offset (minutes east of UTC) for a freshly-built schedule.
// `getTimezoneOffset` returns minutes *behind* UTC, so we negate it.
export function localTzOffsetMin(): number {
  return -new Date().getTimezoneOffset();
}
