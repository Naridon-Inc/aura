// Team activity's days: a run's automatic edits folded into one session,
// then told day by day, newest first, under the same captions every story
// column uses.

import type { ClaudeSession, IntentRow } from "../../../lib/api";
import { collapseAutoStubSessions } from "../../../lib/sessionMeta";
import { dayLabel, type DayGroup } from "../sessionsFeed";

/** A changeset or git path made comparable: forward slashes, no trailing one. */
export function pathKey(p: string): string {
  return (p ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
}

function localDay(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

export function teamDays(rows: IntentRow[], sessions: ClaudeSession[], now = new Date()): DayGroup[] {
  const sorted = [...rows].sort((a, b) => b.timestamp - a.timestamp);
  const byDay = new Map<string, DayGroup>();
  collapseAutoStubSessions(sorted, sessions).forEach((display, i) => {
    const date = new Date(display.row.timestamp * 1000);
    const key = localDay(date);
    let g = byDay.get(key);
    if (!g) {
      g = { key, label: dayLabel(date, now), rows: [] };
      byDay.set(key, g);
    }
    g.rows.push({
      kind: "intent",
      key: `${display.row.timestamp}:${display.row.agent_id}:${i}`,
      timestamp: display.row.timestamp,
      display,
    });
  });
  return [...byDay.values()];
}
