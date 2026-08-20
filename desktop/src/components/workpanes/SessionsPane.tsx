// SessionsPane — the "Sessions" list for the redesigned Trace section.
//
// Modeled on entire.io's Sessions view: a calm, dim, day-grouped list of
// every run you and your agents have made, sourced entirely from the real
// intent log (`api.auraIntentRecent`). Each row is one logged intent — its
// prompt is the title, with a status dot, agent chip, relative time, and the
// changeset's file count + churn. No mock data: when the log is empty we show
// a quiet empty state instead of fabricating rows.
//
// Product decision: the default verdict for a session is "not reviewed yet"
// (a neutral grey dot), never a fabricated pass/fail. A signed_block_id only
// adds a subtle lock glyph — it does not turn the dot green.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type ClaudeSession,
  type IntentRow,
  type ManagerSummary,
} from "../../lib/api";
import { fetchManagerList } from "../../lib/managerCache";
import { fetchSessions } from "../../lib/sessionsCache";
import { fetchIntentRows } from "../../lib/intentCache";
import { History } from "lucide-react";
import { relativeAgeFromDelta } from "../../lib/relativeTime";
import { intentTypeChip } from "../../lib/intentTypeLabels";
import * as Icons from "../Icons";
import { AgentBadge } from "../agent/AgentBadge";
import { Button } from "../ui/button";
import { EmptyState, ErrorState, LoadingState } from "../ui/state";
import {
  collapseAutoStubSessions,
  provenanceTag,
  sessionDisplayTitle,
  titleProvenance,
  type SessionDisplayRow,
} from "../../lib/sessionMeta";

/** Relative time from a "seconds ago" delta — "now", "2h", "3d". */
function relTime(secsAgo: number): string {
  // One ladder for the whole app — see lib/relativeTime. This copy skipped the
  // seconds rung, so 45s through 59s printed "0m".
  return relativeAgeFromDelta(secsAgo, { style: "compact" });
}

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** A stable local-day key (YYYY-MM-DD) for grouping. */
function dayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** "Thursday 30 Apr" style label for a day header. */
function dayLabel(d: Date): string {
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

// The list shows one entry per session. Two sources feed it: the intent log
// (genuine logged intents pass through 1:1; a run's `[auto]` stubs collapse
// into a single entry — see `collapseAutoStubSessions`) and native Aura chat
// (manager) sessions, which never touch the intent log. A `ListRow` is the
// unified shape both reduce to so they can interleave in one day-grouped feed.
type ListRow =
  | { kind: "intent"; key: string; timestamp: number; display: SessionDisplayRow }
  | { kind: "manager"; key: string; timestamp: number; summary: ManagerSummary };

type DayGroup = {
  key: string;
  label: string;
  rows: ListRow[];
};

/** A native Aura chat (manager) session has no intent prompt — its title is the
 *  objective when one was set, else its first user message, else a calm
 *  generic. Trimmed to a single line so the row reads like every other. */
function managerSessionTitle(s: ManagerSummary): string {
  const obj = (s.objective ?? "").trim();
  if (obj) return obj;
  return "Aura chat";
}

/** Newest-meaningful timestamp for a manager session: `updated_at` when set,
 *  else `created_at`. Both are unix seconds, matching `IntentRow.timestamp`. */
function managerSessionTimestamp(s: ManagerSummary): number {
  return s.updated_at || s.created_at || 0;
}

/** Project a manager session into the `IntentRow` shape `onOpenSession`
 *  expects, stamping `manager_session_id` so the detail pane replays the chat
 *  transcript (via `managerLoadTranscript`) instead of looking for a Claude
 *  JSONL. No changeset — a chat session's file work, when any, is tracked by
 *  its own task rows, not the intent log. */
function managerRowToIntent(s: ManagerSummary): IntentRow {
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

function RefreshIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M23 4v6h-6" />
      <path d="M1 20v-6h6" />
      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10" />
      <path d="M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

function SessionRow({
  display,
  sessions,
  nowSecs,
  onOpen,
}: {
  display: SessionDisplayRow;
  sessions: ClaudeSession[];
  nowSecs: number;
  onOpen: (row: IntentRow) => void;
}) {
  const { row, editCount } = display;
  // Aggregate churn for a collapsed session, raw churn for a single entry.
  const churn = {
    files: display.files,
    adds: display.adds,
    dels: display.dels,
    hasChurn: display.hasChurn,
  };
  const rel = relTime(nowSecs - row.timestamp);
  const signed = !!row.signed_block_id;
  const title = sessionDisplayTitle(row, sessions);
  // A line Aura's own model wrote from the diff reads, on this list, exactly
  // like a reason somebody gave — same place, same weight, same voice. The
  // detail pane now says which is which; a list you scan needs the one bit.
  const provTag = provenanceTag(titleProvenance(row, sessions));
  // A halted attempt Aura refused to let land — the honest record of a guard
  // catch. It reads as an error-class event, so it gets the red marker and a
  // "Blocked" badge in place of the neutral verdict dot / intent-type chip.
  const isBlocked = row.intent_type === "blocked";

  return (
    <button
      type="button"
      onClick={() => onOpen(row)}
      className="group flex w-full items-start gap-2.5 px-3 py-2 text-left hover:bg-state-hover"
    >
      {/* Status dot — red ONLY when Aura blocked this change. Every other run
          keeps the gutter but draws nothing: a grey dot on all 119 rows,
          captioned "No verdict yet", is a mark that never varies and so says
          nothing — it reads as a bullet while claiming to be a status. The
          space stays so titles stay aligned with the blocked ones. */}
      <span
        className={`mt-[5px] h-2 w-2 shrink-0 rounded-full ${
          isBlocked ? "bg-red" : ""
        }`}
        title={isBlocked ? "Blocked. Aura halted this change" : undefined}
        aria-hidden="true"
      />

      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-sm leading-snug text-text-1">
            {title}
          </span>
          {signed ? (
            <span
              className="shrink-0 text-text-4"
              title="Sealed. This record is locked and can’t be altered"
            >
              <LockIcon />
            </span>
          ) : null}
        </span>

        <span className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-text-3">
          <AgentBadge agentId={row.agent_id} />
          {provTag ? (
            <span
              className="text-text-4"
              title="Nobody wrote a reason for this change, so Aura read the diff and wrote the line above. It describes what happened. Open it for the detail."
            >
              {provTag}
            </span>
          ) : null}
          <span className="text-text-4">{rel}</span>
          {row.changeset ? (
            <>
              <span className="text-text-4">·</span>
              <span>
                {churn.files} {churn.files === 1 ? "file" : "files"}
              </span>
              {churn.hasChurn ? (
                <span className="font-mono text-2xs">
                  <span className="text-accent-green">+{churn.adds}</span>
                  <span className="text-text-4"> / </span>
                  <span className="text-text-3">−{churn.dels}</span>
                </span>
              ) : null}
            </>
          ) : null}
          {editCount > 1 ? (
            <>
              <span className="text-text-4">·</span>
              <span
                className="text-text-4"
                title={`${editCount} file edits in this session were grouped together`}
              >
                {editCount} edits
              </span>
            </>
          ) : null}
          {isBlocked ? (
            <span className="rounded border border-red px-1.5 py-px text-2xs font-medium text-red">
              Blocked
            </span>
          ) : row.intent_type ? (
            // Plain words, not the raw CamelCase enum ("FeatureAdd").
            <span className="rounded border border-line-soft px-1.5 py-px text-2xs text-text-4">
              {intentTypeChip(row.intent_type)}
            </span>
          ) : null}
        </span>
      </span>
    </button>
  );
}

/** A native Aura chat (manager) session row. Same calm layout as a SessionRow,
 *  but the meta line carries the chat's task progress (done/total) when it ran
 *  a plan, since these sessions have no intent changeset to summarise. */
function ManagerSessionRow({
  summary,
  nowSecs,
  onOpen,
}: {
  summary: ManagerSummary;
  nowSecs: number;
  onOpen: (row: IntentRow) => void;
}) {
  const rel = relTime(nowSecs - managerSessionTimestamp(summary));
  const title = managerSessionTitle(summary);
  const hasTasks = summary.task_count > 0;

  return (
    <button
      type="button"
      onClick={() => onOpen(managerRowToIntent(summary))}
      className="group flex w-full items-start gap-2.5 px-3 py-2 text-left hover:bg-state-hover"
    >
      {/* Empty gutter, matching the intent rows: their dot only draws when
          Aura blocked a change, and a chat with the manager can't be blocked.
          The space stays so every title in the list lines up. */}
      <span className="mt-[5px] h-2 w-2 shrink-0" aria-hidden="true" />

      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-sm leading-snug text-text-1">
            {title}
          </span>
        </span>

        <span className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-text-3">
          <AgentBadge agentId="aura-manager" />
          <span className="text-text-4">{rel}</span>
          {hasTasks ? (
            <>
              <span className="text-text-4">·</span>
              <span>
                {summary.done_count}/{summary.task_count} done
              </span>
            </>
          ) : null}
          <span className="rounded border border-line-soft px-1.5 py-px text-2xs text-text-4">
            chat
          </span>
        </span>
      </span>
    </button>
  );
}

/** The three lists this pane shows, plus the clock they were stamped against. */
type SessionsSnapshot = {
  rows: IntentRow[];
  claudeSessions: ClaudeSession[];
  managerSessions: ManagerSummary[];
  nowSecs: number;
};

// Process-lifetime, per-workspace snapshot cache. The Sessions pane remounts on
// every Trace open / tab toggle / detail close, and each cold mount re-runs the
// three IPC calls and flashes a spinner. We keep the last result per repoRoot
// and render it instantly on remount (no spinner), then revalidate in the
// background — stale-while-revalidate. The Rust side already mtime-gates the
// underlying reads, so the revalidation is cheap; this just removes the
// round-trip flash. Cleared implicitly when the app process exits.
const sessionsCache = new Map<string, SessionsSnapshot>();

export function SessionsPane({
  repoRoot,
  onOpenSession,
}: {
  repoRoot: string;
  onOpenSession: (row: IntentRow) => void;
}) {
  // Seed every list from the per-workspace snapshot cache so a remount paints
  // the previous result on the first frame instead of an empty flash; `load`
  // then revalidates underneath (stale-while-revalidate).
  const [rows, setRows] = useState<IntentRow[]>(
    () => sessionsCache.get(repoRoot)?.rows ?? [],
  );
  // Real Claude Code sessions — used to relabel the guard's `[auto]`
  // placeholder rows with the agent's actual prompt (see sessionMeta).
  const [claudeSessions, setClaudeSessions] = useState<ClaudeSession[]>(
    () => sessionsCache.get(repoRoot)?.claudeSessions ?? [],
  );
  // Native Aura chat (manager) sessions — they never write to the intent log,
  // so without this they'd never appear in the list. Scoped to this workspace
  // by `manager_list(repoRoot)`. Best-effort: absence never fails the list.
  const [managerSessions, setManagerSessions] = useState<ManagerSummary[]>(
    () => sessionsCache.get(repoRoot)?.managerSessions ?? [],
  );
  // Only show the cold-load spinner when there's no cached snapshot to paint.
  const [loading, setLoading] = useState(() => !sessionsCache.has(repoRoot));
  const [error, setError] = useState<string | null>(null);
  // Captured once per fetch so every row in a render computes rel time from
  // the same clock — avoids rows drifting against each other mid-render.
  const [nowSecs, setNowSecs] = useState(
    () => sessionsCache.get(repoRoot)?.nowSecs ?? Math.floor(Date.now() / 1000),
  );
  // Per-day collapse disclosure, keyed by dayKey (true = collapsed). Default
  // is everything expanded (empty map); not persisted.
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const aliveRef = useRef(true);

  const load = useCallback(async () => {
    if (!repoRoot) {
      setRows([]);
      setLoading(false);
      return;
    }
    // Stale-while-revalidate: if a snapshot for this workspace is cached, paint
    // it immediately and refresh underneath (no spinner). Only a cold mount
    // with nothing cached shows the spinner.
    const cached = sessionsCache.get(repoRoot);
    if (cached) {
      setRows(cached.rows);
      setClaudeSessions(cached.claudeSessions);
      setManagerSessions(cached.managerSessions);
      setNowSecs(cached.nowSecs);
      setLoading(false);
    } else {
      setLoading(true);
    }
    setError(null);
    try {
      // Claude sessions + native chat sessions are both best-effort — never
      // let their absence fail the list, which the intent log alone can
      // populate. `managerList(repoRoot)` is workspace-scoped so chats from
      // other workspaces don't leak in.
      const [data, sessions, managers] = await Promise.all([
        fetchIntentRows(repoRoot, 100),
        fetchSessions(repoRoot).catch(() => [] as ClaudeSession[]),
        fetchManagerList(repoRoot).catch(() => [] as ManagerSummary[]),
      ]);
      if (!aliveRef.current) return;
      const snap: SessionsSnapshot = {
        rows: Array.isArray(data) ? data : [],
        claudeSessions: Array.isArray(sessions) ? sessions : [],
        managerSessions: Array.isArray(managers) ? managers : [],
        nowSecs: Math.floor(Date.now() / 1000),
      };
      sessionsCache.set(repoRoot, snap);
      setRows(snap.rows);
      setClaudeSessions(snap.claudeSessions);
      setManagerSessions(snap.managerSessions);
      setNowSecs(snap.nowSecs);
    } catch (e) {
      if (!aliveRef.current) return;
      // A failed background revalidation must not blank out good cached data —
      // only surface the error when there was nothing to show.
      if (!cached) {
        setError(e instanceof Error ? e.message : String(e));
        setRows([]);
      }
    } finally {
      if (aliveRef.current) setLoading(false);
    }
  }, [repoRoot]);

  useEffect(() => {
    aliveRef.current = true;
    void load();
    return () => {
      aliveRef.current = false;
    };
  }, [load]);

  // Build the unified feed: collapse the intent log's auto-stub spam into one
  // entry per session (collapsing operates ONLY on intent rows so a chat
  // session is never double-counted), project native chat sessions into the
  // same `ListRow` shape, interleave both by timestamp (newest first), then
  // group by local day.
  const groups = useMemo<DayGroup[]>(() => {
    const intentRows: ListRow[] = collapseAutoStubSessions(
      [...rows].sort((a, b) => b.timestamp - a.timestamp),
      claudeSessions,
    ).map((display) => ({
      kind: "intent" as const,
      key: `intent:${display.row.timestamp}:${display.row.agent_id}`,
      timestamp: display.row.timestamp,
      display,
    }));
    const managerRows: ListRow[] = managerSessions.map((summary) => ({
      kind: "manager" as const,
      key: `manager:${summary.id}`,
      timestamp: managerSessionTimestamp(summary),
      summary,
    }));

    const all = [...intentRows, ...managerRows].sort(
      (a, b) => b.timestamp - a.timestamp,
    );
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
    // Map preserves insertion order, and we inserted in newest-first order.
    return [...byDay.values()];
  }, [rows, claudeSessions, managerSessions]);

  // Count the entries the list actually shows (post-collapse), not raw rows —
  // so the header reads "12 sessions", matching what's on screen.
  const total = useMemo(
    () => groups.reduce((n, g) => n + g.rows.length, 0),
    [groups],
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg-content">
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between border-b border-line-soft px-3 py-2.5">
        {/* The count, not the name. "My sessions" was already written twice on
            screen — the sidebar row you clicked and the tab it opened — and a
            third copy 8px below them taught nothing. The number is the one
            thing here the reader can't get from the chrome, so it says its own
            noun now and stands alone.

            No count until we've actually read them: on a cold open this
            printed "0" for the several seconds the list took to load, a flat
            claim that you have none, contradicted moments later by 119 rows. */}
        <div className="flex items-baseline gap-2">
          {loading && total === 0 ? (
            <span />
          ) : (
            <span className="text-xs text-text-4">
              {total} {total === 1 ? "session" : "sessions"}
            </span>
          )}
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="text-text-3 hover:text-text-1"
          title="Refresh sessions"
          aria-label="Refresh sessions"
        >
          <RefreshIcon />
        </Button>
      </div>

      {/* List */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {error ? (
          <ErrorState
            title="Couldn’t load your sessions"
            message={error}
            onRetry={() => void load()}
            size="sm"
          />
        ) : loading && total === 0 ? (
          <LoadingState label="Reading your sessions…" />
        ) : total === 0 ? (
          <EmptyState
            icon={History}
            title="No sessions yet"
            body="Every run you or an agent makes is kept here. What was asked, what changed, and why. Nothing is written down until the first one happens."
          />
        ) : (
          groups.map((group) => {
            const isCollapsed = !!collapsed[group.key];
            return (
              <div key={group.key}>
                {/* Day header doubles as the collapse toggle for its rows. */}
                <button
                  type="button"
                  onClick={() =>
                    setCollapsed((m) => ({ ...m, [group.key]: !m[group.key] }))
                  }
                  aria-expanded={!isCollapsed}
                  className="sticky top-0 z-10 flex w-full items-center justify-between bg-bg-content px-3 py-1.5 text-left hover:bg-state-hover"
                >
                  <span className="flex items-center gap-1.5">
                    <Icons.ChevronDown
                      size={14}
                      className={`chev text-text-4${isCollapsed ? "" : " open"}`}
                    />
                    <span className="section-label">
                      {group.label}
                    </span>
                  </span>
                  <span className="text-xs text-text-4">
                    {group.rows.length}{" "}
                    {group.rows.length === 1 ? "session" : "sessions"}
                  </span>
                </button>
                {!isCollapsed && (
                  <div className="pb-1">
                    {group.rows.map((r, i) =>
                      r.kind === "manager" ? (
                        <ManagerSessionRow
                          key={`${r.key}-${i}`}
                          summary={r.summary}
                          nowSecs={nowSecs}
                          onOpen={onOpenSession}
                        />
                      ) : (
                        <SessionRow
                          key={`${r.key}-${i}`}
                          display={r.display}
                          sessions={claudeSessions}
                          nowSecs={nowSecs}
                          onOpen={onOpenSession}
                        />
                      ),
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
