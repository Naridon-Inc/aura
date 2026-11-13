// The year in review, as numbers: everything the Wrapped page shows is
// computed here from real intent-log rows, with no React in sight.
//
// HONESTY RULE: every figure is derived only from `api.auraIntentRecent`
// rows. No tokens, no cost, nothing fabricated.

import { type ClaudeSession, type IntentRow } from "../../../lib/api";
import { intentTypeChip } from "@shared/intentTypeLabels";
import { collapseAutoStubSessions } from "../../../lib/sessionMeta";

// ── Pure stat computation (no React) ─────────────────────────────────────────

export type Counted = { key: string; count: number };

export type WrappedStats = {
  total: number;
  sessions: number;
  added: number;
  removed: number;
  filesTouched: number;
  /** How many of those runs actually recorded a line count. `added`/`removed`/
   *  `filesTouched` are sums over ONLY these — a log full of rows that never
   *  carried a changeset sums to zero, which is not the same fact as "nothing
   *  changed" and must never be printed as one. */
  churnRuns: number;
  activeDays: number;
  longestStreak: number;
  signed: number;
  busiestDay: { dayMs: number; count: number } | null;
  busiestMonth: number | null; // 0–11, null when empty
  firstTs: number | null;
  lastTs: number | null;
  monthly: number[]; // length 12
  agents: Counted[]; // sorted desc by count
  types: Counted[]; // sorted desc by count
};

/** Local-midnight day index for an epoch-seconds timestamp. */
function dayIndexOf(tsSecs: number): number {
  const d = new Date(tsSecs * 1000);
  return Math.floor(
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 86400000,
  );
}

export function computeWrapped(
  rows: IntentRow[],
  sessions: ClaudeSession[],
  year: number,
): WrappedStats {
  const inYear = rows.filter(
    (r) => new Date(r.timestamp * 1000).getFullYear() === year,
  );

  // Distinct Claude sessions touched this year — a naturally de-duped set, so
  // it's never inflated by stub spam. Computed from the raw rows before the
  // collapse (which only keeps one representative id per folded entry).
  const sessionIds = new Set<string>();
  for (const r of inYear) {
    if (r.claude_session_id) sessionIds.add(r.claude_session_id);
  }

  // Collapse a run's `[auto]` backfill stubs into one entry per session — they
  // were never "intents you logged", just the guard noticing unlogged edits,
  // so counting each as an intent is exactly the inflation we're removing.
  // Churn (adds/dels) and the touched-file set are pre-aggregated across the
  // whole run, so the +/− and files-touched totals stay truthful.
  const display = collapseAutoStubSessions(inYear, sessions);

  const monthly = new Array(12).fill(0) as number[];
  const dayCounts = new Map<number, number>();
  const agentCounts = new Map<string, number>();
  const typeCounts = new Map<string, number>();
  const files = new Set<string>();
  let added = 0;
  let removed = 0;
  let signed = 0;
  let churnRuns = 0;
  let firstTs: number | null = null;
  let lastTs: number | null = null;

  for (const entry of display) {
    const r = entry.row;
    const d = new Date(r.timestamp * 1000);
    monthly[d.getMonth()] += 1;

    const di = dayIndexOf(r.timestamp);
    dayCounts.set(di, (dayCounts.get(di) ?? 0) + 1);

    const aid = (r.agent_id ?? "").trim() || "unknown";
    agentCounts.set(aid, (agentCounts.get(aid) ?? 0) + 1);

    const ty = (r.intent_type ?? "").trim() || "Uncategorized";
    typeCounts.set(ty, (typeCounts.get(ty) ?? 0) + 1);

    if (r.signed_block_id) signed += 1;

    // Churn + files are summed across the whole collapsed run. `hasChurn` is
    // the difference between a run that recorded "+0" and one that recorded
    // nothing at all; without counting it, the two are indistinguishable in
    // the totals below.
    if (entry.hasChurn) churnRuns += 1;
    added += Math.max(0, entry.adds);
    removed += Math.max(0, entry.dels);
    for (const p of entry.paths) files.add(p);

    if (firstTs === null || r.timestamp < firstTs) firstTs = r.timestamp;
    if (lastTs === null || r.timestamp > lastTs) lastTs = r.timestamp;
  }

  // Busiest day.
  let busiestDay: WrappedStats["busiestDay"] = null;
  for (const [di, count] of dayCounts) {
    if (!busiestDay || count > busiestDay.count) {
      busiestDay = { dayMs: di * 86400000, count };
    }
  }

  // Longest streak of consecutive calendar days with at least one intent.
  const sortedDays = [...dayCounts.keys()].sort((a, b) => a - b);
  let longestStreak = 0;
  let run = 0;
  let prev: number | null = null;
  for (const di of sortedDays) {
    run = prev !== null && di === prev + 1 ? run + 1 : 1;
    if (run > longestStreak) longestStreak = run;
    prev = di;
  }

  // Busiest month.
  let busiestMonth: number | null = null;
  let busiestMonthCount = -1;
  monthly.forEach((c, m) => {
    if (c > busiestMonthCount) {
      busiestMonthCount = c;
      busiestMonth = c > 0 ? m : busiestMonth;
    }
  });

  const agents = [...agentCounts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count);
  const types = [...typeCounts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count);

  return {
    total: display.length,
    sessions: sessionIds.size,
    added,
    removed,
    filesTouched: files.size,
    churnRuns,
    activeDays: dayCounts.size,
    longestStreak,
    signed,
    busiestDay,
    busiestMonth,
    firstTs,
    lastTs,
    monthly,
    agents,
    types,
  };
}

// ── Formatting helpers ───────────────────────────────────────────────────────

export const MONTH_LABELS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

export function fmtNum(n: number): string {
  return n.toLocaleString("en-US");
}

export function fmtDate(ms: number): string {
  const d = new Date(ms);
  return `${MONTH_LABELS[d.getMonth()]} ${d.getDate()}`;
}

// intent_type values are CamelCase (FeatureAdd, BugFix…). `intentTypeChip` is
// the one shared map that turns them into words — spacing them out here left
// "Feature Add", which is still the enum with a gap in it.
export const typeLabel = intentTypeChip;
