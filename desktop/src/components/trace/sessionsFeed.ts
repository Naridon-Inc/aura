// The data behind "My sessions": every run you and your agents have made,
// read from the real intent log plus native Aura chats, collapsed to one entry
// per session and grouped by local day. No mock rows — an empty log is an
// empty list.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  type ClaudeSession,
  type IntentRow,
  type ManagerSummary,
} from "../../lib/api";
import { fetchManagerList } from "../../lib/managerCache";
import { fetchSessions } from "../../lib/sessionsCache";
import { fetchIntentRows } from "../../lib/intentCache";
import { relativeAgeFromDelta } from "../../lib/relativeTime";
import {
  collapseAutoStubSessions,
  provenanceTag,
  sessionDisplayTitle,
  titleProvenance,
  type SessionDisplayRow,
} from "../../lib/sessionMeta";

/** Relative time from a "seconds ago" delta — "now", "2h", "3d". One ladder
 *  for the whole app; see lib/relativeTime. */
export function relTime(secsAgo: number): string {
  return relativeAgeFromDelta(secsAgo, { style: "compact" });
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A stable local-day key (YYYY-MM-DD) for grouping. */
function dayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** A day header in plain words: "Today", "Yesterday", else "Thursday 30 Apr". */
export function dayLabel(d: Date, now = new Date()): string {
  if (dayKey(d) === dayKey(now)) return "Today";
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (dayKey(d) === dayKey(yesterday)) return "Yesterday";
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

/** The full stamp a row's time column carries as its tooltip. */
export function fullStamp(unixSecs: number): string {
  return new Date(unixSecs * 1000).toLocaleString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// Two sources feed the list: the intent log (genuine logged intents pass
// through 1:1; a run's `[auto]` stubs collapse into a single entry — see
// `collapseAutoStubSessions`) and native Aura chat (manager) sessions, which
// never touch the intent log. A `ListRow` is the shape both reduce to so they
// interleave in one day-grouped feed.
export type ListRow =
  | { kind: "intent"; key: string; timestamp: number; display: SessionDisplayRow }
  | { kind: "manager"; key: string; timestamp: number; summary: ManagerSummary };

export type DayGroup = { key: string; label: string; rows: ListRow[] };

/** A native Aura chat has no intent prompt — its title is the objective when
 *  one was set, else a calm generic. */
export function managerSessionTitle(s: ManagerSummary): string {
  return (s.objective ?? "").trim() || "Aura chat";
}

/** Newest-meaningful timestamp for a manager session (unix seconds, matching
 *  `IntentRow.timestamp`). */
export function managerSessionTimestamp(s: ManagerSummary): number {
  return s.updated_at || s.created_at || 0;
}

/** Project a manager session into the `IntentRow` shape the detail pane
 *  opens, stamping `manager_session_id` so it replays the chat transcript
 *  instead of looking for a Claude JSONL. No changeset — a chat's file work,
 *  when any, is tracked by its own task rows, not the intent log. */
export function managerRowToIntent(s: ManagerSummary): IntentRow {
  return {
    timestamp: managerSessionTimestamp(s),
    agent_id: "aura-manager",
    intent: managerSessionTitle(s),
    intent_type: null,
    signed_block_id: null,
    key_id: null,
    changeset: null,
    claude_session_id: null,
    manager_session_id: s.id,
  };
}

/** Where a session happened. Each intent row is stamped at write time with the
 *  branch + checkout folder it was written in, so this is a fact about the
 *  run, not a guess from where we read it. A row recovered from another
 *  branch's committed copy carries no stamp and stays unlabelled rather than
 *  wear a branch that would misdirect. */
export function sessionOrigin(row: IntentRow): { label: string; title: string } | null {
  const branch = row.branch?.trim();
  const checkout = row.worktree?.trim();
  if (!branch && !checkout) return null;
  const where = checkout ? ` in the ${checkout} folder` : "";
  return {
    label: branch || checkout || "",
    title: branch ? `Worked on the ${branch} branch${where}` : `Worked on in the ${checkout} folder`,
  };
}

/** Sentinel for "no branch filter". A leading space keeps it out of the space
 *  of real branch names, which git forbids one in. */
export const ALL_BRANCHES = " all";

/** How far back the feed reaches. The intent log spans every checkout of this
 *  repo, so 250 entries is a working week or two of a busy project — enough to
 *  find yesterday's run without paging. */
const SESSIONS_WINDOW = 250;

type SessionsSnapshot = {
  rows: IntentRow[];
  claudeSessions: ClaudeSession[];
  managerSessions: ManagerSummary[];
  /** The branch the checkout was on when this was read. */
  currentBranch: string | null;
  nowSecs: number;
};

// Process-lifetime, per-workspace snapshot cache. The list remounts on every
// Trace open / view switch / detail close; painting the last result at once
// and revalidating underneath (stale-while-revalidate) removes the spinner
// flash. The Rust side already mtime-gates the reads, so revalidation is cheap.
const sessionsCache = new Map<string, SessionsSnapshot>();

export function useSessionsFeed(repoRoot: string) {
  const seed = sessionsCache.get(repoRoot);
  const [snap, setSnap] = useState<SessionsSnapshot>(
    () =>
      seed ?? {
        rows: [],
        claudeSessions: [],
        managerSessions: [],
        currentBranch: null,
        nowSecs: Math.floor(Date.now() / 1000),
      },
  );
  const [loading, setLoading] = useState(() => !sessionsCache.has(repoRoot));
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);

  const load = useCallback(async () => {
    if (!repoRoot) {
      setSnap((s) => ({ ...s, rows: [] }));
      setLoading(false);
      return;
    }
    const cached = sessionsCache.get(repoRoot);
    if (cached) {
      setSnap(cached);
      setLoading(false);
    } else {
      setLoading(true);
    }
    setError(null);
    try {
      // Claude sessions and native chats are best-effort: the intent log alone
      // can populate the list, so their absence never fails it.
      const [data, sessions, managers, branch] = await Promise.all([
        fetchIntentRows(repoRoot, SESSIONS_WINDOW),
        fetchSessions(repoRoot).catch(() => [] as ClaudeSession[]),
        fetchManagerList(repoRoot).catch(() => [] as ManagerSummary[]),
        api.gitBranch(repoRoot).catch(() => ""),
      ]);
      if (!alive.current) return;
      const next: SessionsSnapshot = {
        rows: Array.isArray(data) ? data : [],
        claudeSessions: Array.isArray(sessions) ? sessions : [],
        managerSessions: Array.isArray(managers) ? managers : [],
        currentBranch: typeof branch === "string" && branch ? branch : null,
        nowSecs: Math.floor(Date.now() / 1000),
      };
      sessionsCache.set(repoRoot, next);
      setSnap(next);
    } catch (e) {
      if (!alive.current) return;
      // A failed background revalidation must not blank out good cached data.
      if (!cached) {
        setError(e instanceof Error ? e.message : String(e));
        setSnap((s) => ({ ...s, rows: [] }));
      }
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [repoRoot]);

  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
    };
  }, [load]);

  return { ...snap, loading, error, load };
}

/** Does this entry mention the query — in its title, who wrote that title
 *  (so "Aura's summary" finds the lines Aura wrote from a diff), its agent,
 *  its branch or the files it touched. */
function matches(row: ListRow, q: string, sessions: ClaudeSession[]): boolean {
  if (row.kind === "manager") {
    return managerSessionTitle(row.summary).toLowerCase().includes(q) || "chat".includes(q);
  }
  const r = row.display.row;
  const hay = [
    sessionDisplayTitle(r, sessions),
    provenanceTag(titleProvenance(r, sessions)),
    r.agent_id,
    r.branch ?? "",
    r.intent_type ?? "",
    ...row.display.paths,
  ]
    .join("\n")
    .toLowerCase();
  return hay.includes(q);
}

/** Build the unified feed: collapse auto-stub runs into one entry per session,
 *  project native chats into the same shape, interleave newest first, filter,
 *  and group by local day. */
export function useSessionGroups({
  rows,
  claudeSessions,
  managerSessions,
  currentBranch,
  branchFilter,
  query,
}: {
  rows: IntentRow[];
  claudeSessions: ClaudeSession[];
  managerSessions: ManagerSummary[];
  currentBranch: string | null;
  branchFilter: string;
  query: string;
}): DayGroup[] {
  return useMemo(() => {
    const showAll = branchFilter === ALL_BRANCHES;
    const visible = showAll ? rows : rows.filter((r) => (r.branch ?? "") === branchFilter);
    const intentRows: ListRow[] = collapseAutoStubSessions(
      [...visible].sort((a, b) => b.timestamp - a.timestamp),
      claudeSessions,
    ).map((display) => ({
      kind: "intent" as const,
      key: `intent:${display.row.timestamp}:${display.row.agent_id}`,
      timestamp: display.row.timestamp,
      display,
    }));
    // Native chats live in this checkout only — they belong to whatever branch
    // it's standing on, so they drop out when you narrow to a different one.
    const chatsApply = showAll || branchFilter === (currentBranch ?? "");
    const managerRows: ListRow[] = (chatsApply ? managerSessions : []).map((summary) => ({
      kind: "manager" as const,
      key: `manager:${summary.id}`,
      timestamp: managerSessionTimestamp(summary),
      summary,
    }));
    const q = query.trim().toLowerCase();
    const all = [...intentRows, ...managerRows]
      .filter((r) => !q || matches(r, q, claudeSessions))
      .sort((a, b) => b.timestamp - a.timestamp);
    const byDay = new Map<string, DayGroup>();
    for (const r of all) {
      const date = new Date(r.timestamp * 1000);
      const key = dayKey(date);
      let g = byDay.get(key);
      if (!g) {
        g = { key, label: dayLabel(date), rows: [] };
        byDay.set(key, g);
      }
      g.rows.push(r);
    }
    return [...byDay.values()];
  }, [rows, claudeSessions, managerSessions, branchFilter, currentBranch, query]);
}

/** Every branch that actually wrote something in this feed, current one
 *  first, then the rest alphabetically — so the filter only offers choices
 *  that would return something. */
export function branchesOf(rows: IntentRow[], currentBranch: string | null): string[] {
  const seen = new Set<string>();
  for (const r of rows) {
    const b = r.branch?.trim();
    if (b) seen.add(b);
  }
  const rest = [...seen].filter((b) => b !== currentBranch).sort((a, b) => a.localeCompare(b));
  return currentBranch && seen.has(currentBranch) ? [currentBranch, ...rest] : rest;
}
