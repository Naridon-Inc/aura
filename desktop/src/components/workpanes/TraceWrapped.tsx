// Aura Wrapped — a calm "year in review" built ENTIRELY from the local intent
// log (Conductor 0.25.1 "Wrapped" parity, reworked to Aura's honesty rule).
//
// HONESTY RULE (inherited from OverviewPane): every number here is derived only
// from real `api.auraIntentRecent` rows. There are NO tokens, NO cost, NO
// fabricated metrics — only what the intent log actually records: how many
// intents you logged, the +/− churn each carried, which agents you worked
// through, how your days clustered, and how much of it was cryptographically
// signed. When a year has no rows we show a quiet empty state, never fake ones.
//
// Cross-agent by construction: the breakdown groups by `agent_id`, so the
// native Aura brain and every CLI agent (Claude, Codex, Gemini, Cursor, Kimi,
// OpenCode) each appear as a first-class collaborator with its own logo.

import { useEffect, useMemo, useState } from "react";
import { api, type ClaudeSession, type IntentRow } from "../../lib/api";
import { agentDisplayLabel } from "../../lib/agentIdentity";
import { collapseAutoStubSessions } from "../../lib/sessionMeta";
import { AgentIcon } from "../agent/AgentIcon";
import { FullscreenOverlay } from "../FullscreenOverlay";

// ── Pure stat computation (no React) ─────────────────────────────────────────

type Counted = { key: string; count: number };

type WrappedStats = {
  total: number;
  sessions: number;
  added: number;
  removed: number;
  filesTouched: number;
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

function computeWrapped(
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

    // Churn + files are summed across the whole collapsed run.
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

const MONTH_LABELS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function fmtNum(n: number): string {
  return n.toLocaleString("en-US");
}

function fmtDate(ms: number): string {
  const d = new Date(ms);
  return `${MONTH_LABELS[d.getMonth()]} ${d.getDate()}`;
}

function typeLabel(raw: string): string {
  // intent_type values are CamelCase (FeatureAdd, BugFix…). Space them out.
  return raw.replace(/([a-z])([A-Z])/g, "$1 $2");
}

// ── Component ────────────────────────────────────────────────────────────────

export function TraceWrapped({
  repoRoot,
  onClose,
}: {
  repoRoot: string;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<IntentRow[]>([]);
  // Real Claude Code sessions — best-effort, used to fold a run's `[auto]`
  // stub spam into one entry per session before counting (see sessionMeta).
  const [claudeSessions, setClaudeSessions] = useState<ClaudeSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [year, setYear] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    Promise.all([
      // A generous ceiling so a full year of activity is covered. The log is a
      // local JSONL read, so this stays cheap.
      api.auraIntentRecent(repoRoot, 5000),
      api.claudeListSessions(repoRoot).catch(() => [] as ClaudeSession[]),
    ])
      .then(([data, sessions]) => {
        if (!alive) return;
        setRows(Array.isArray(data) ? data : []);
        setClaudeSessions(Array.isArray(sessions) ? sessions : []);
        setLoading(false);
      })
      .catch((e) => {
        if (!alive) return;
        setError(String(e));
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [repoRoot]);

  // Years that actually have rows, newest first. Default selection = newest.
  const years = useMemo(() => {
    const set = new Set<number>();
    for (const r of rows) set.add(new Date(r.timestamp * 1000).getFullYear());
    return [...set].sort((a, b) => b - a);
  }, [rows]);

  useEffect(() => {
    if (year === null && years.length > 0) setYear(years[0]);
  }, [years, year]);

  const activeYear = year ?? years[0] ?? new Date().getFullYear();
  const stats = useMemo(
    () => computeWrapped(rows, claudeSessions, activeYear),
    [rows, claudeSessions, activeYear],
  );

  return (
    <FullscreenOverlay onClose={onClose} closeHint="esc">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-[760px] flex-col gap-6 px-6 py-8">
          {loading && rows.length === 0 ? (
            <div className="py-16 text-center text-[12px] text-text-4">
              Reading your intent log…
            </div>
          ) : error ? (
            <div className="py-16 text-center text-[12px] text-text-3">
              Couldn&rsquo;t load your year.
              <span className="mt-1 block font-mono text-[11px] text-text-4">
                {error}
              </span>
            </div>
          ) : stats.total === 0 ? (
            <EmptyYear year={activeYear} years={years} onPick={setYear} />
          ) : (
            <>
              <Hero
                year={activeYear}
                years={years}
                onPick={setYear}
                stats={stats}
              />
              <BigGrid stats={stats} />
              <Collaborators stats={stats} />
              <Rhythm stats={stats} />
              <MonthlyStrip stats={stats} />
              {stats.types.length > 0 && <WorkMix stats={stats} />}
              <Provenance stats={stats} />
              <p className="pb-4 text-center text-[11px] leading-relaxed text-text-4">
                Built only from your local intent log. Nothing here left this
                machine.
              </p>
            </>
          )}
        </div>
      </div>
    </FullscreenOverlay>
  );
}

// ── Sub-views ────────────────────────────────────────────────────────────────

function YearSwitch({
  years,
  active,
  onPick,
}: {
  years: number[];
  active: number;
  onPick: (y: number) => void;
}) {
  if (years.length < 2) return null;
  return (
    <div className="flex items-center justify-center gap-1">
      {years.map((y) => (
        <button
          key={y}
          type="button"
          onClick={() => onPick(y)}
          aria-selected={y === active}
          className={
            "rounded-md px-2.5 py-1 text-[12px] transition-colors " +
            (y === active
              ? "bg-accent text-accent-foreground"
              : "text-text-3 hover:bg-bg-2 hover:text-text-1")
          }
        >
          {y}
        </button>
      ))}
    </div>
  );
}

function Hero({
  year,
  years,
  onPick,
  stats,
}: {
  year: number;
  years: number[];
  onPick: (y: number) => void;
  stats: WrappedStats;
}) {
  const range =
    stats.firstTs && stats.lastTs
      ? `${fmtDate(stats.firstTs * 1000)} – ${fmtDate(stats.lastTs * 1000)}`
      : null;
  return (
    <div className="flex flex-col gap-4">
      <YearSwitch years={years} active={year} onPick={onPick} />
      <div className="rounded-lg border border-accent/30 bg-accent/10 p-4 text-center">
        <div className="text-[11px] uppercase tracking-[0.22em] text-accent">
          Aura — Year in review
        </div>
        <div className="mt-2 text-[44px] font-semibold leading-none text-text-1">
          {year}
        </div>
        <div className="mt-3 text-[13px] leading-relaxed text-text-3">
          You logged{" "}
          <span className="font-semibold text-text-1">
            {fmtNum(stats.total)}
          </span>{" "}
          intents across{" "}
          <span className="font-semibold text-text-1">
            {fmtNum(stats.activeDays)}
          </span>{" "}
          active {stats.activeDays === 1 ? "day" : "days"}
          {range ? `, from ${range}` : ""}.
        </div>
      </div>
    </div>
  );
}

function BigGrid({ stats }: { stats: WrappedStats }) {
  const cards: Array<{ label: string; value: string; sub?: string }> = [
    { label: "Intents", value: fmtNum(stats.total) },
    {
      label: "Lines added",
      value: `+${fmtNum(stats.added)}`,
    },
    {
      label: "Lines removed",
      value: `−${fmtNum(stats.removed)}`,
    },
    {
      label: "Files touched",
      value: fmtNum(stats.filesTouched),
    },
  ];
  // Sessions only when the log actually carried session ids — never invent.
  if (stats.sessions > 0) {
    cards.splice(1, 0, { label: "Sessions", value: fmtNum(stats.sessions) });
  }
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      {cards.map((c) => (
        <div
          key={c.label}
          className="rounded-lg border border-line-soft bg-bg-1 p-3"
        >
          <div className="text-[22px] font-semibold leading-none text-text-1">
            {c.value}
          </div>
          <div className="mt-2 text-[11px] uppercase tracking-wide text-text-4">
            {c.label}
          </div>
        </div>
      ))}
    </div>
  );
}

function Collaborators({ stats }: { stats: WrappedStats }) {
  const top = stats.agents[0];
  if (!top) return null;
  const max = top.count;
  const topShare = Math.round((top.count / stats.total) * 100);
  return (
    <div className="rounded-lg border border-line-soft bg-bg-1 p-3">
      <div className="flex items-center gap-3">
        <AgentIcon agentId={top.key} label={agentDisplayLabel(top.key)} size={28} />
        <div className="min-w-0">
          <div className="text-[11px] uppercase tracking-wide text-text-4">
            Your top collaborator
          </div>
          <div className="truncate text-[15px] font-semibold text-text-1">
            {agentDisplayLabel(top.key)}
          </div>
        </div>
        <div className="ml-auto text-right">
          <div className="text-[18px] font-semibold leading-none text-text-1">
            {topShare}%
          </div>
          <div className="mt-1 text-[11px] text-text-4">of changes</div>
        </div>
      </div>
      <div className="mt-4 flex flex-col gap-2.5">
        {stats.agents.slice(0, 6).map((a) => (
          <div key={a.key} className="flex items-center gap-2.5">
            <AgentIcon agentId={a.key} label={agentDisplayLabel(a.key)} size={16} />
            <span className="w-28 shrink-0 truncate text-[12px] text-text-2">
              {agentDisplayLabel(a.key)}
            </span>
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-bg-3">
              <div
                className="h-full rounded-full bg-accent"
                style={{ width: `${Math.max(3, (a.count / max) * 100)}%` }}
              />
            </div>
            <span className="w-10 shrink-0 text-right text-[11px] tabular-nums text-text-4">
              {fmtNum(a.count)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Rhythm({ stats }: { stats: WrappedStats }) {
  const cells: Array<{ label: string; value: string; sub?: string }> = [
    {
      label: "Longest streak",
      value: `${stats.longestStreak}`,
      sub: stats.longestStreak === 1 ? "day" : "days in a row",
    },
    {
      label: "Active days",
      value: fmtNum(stats.activeDays),
    },
  ];
  if (stats.busiestDay) {
    cells.push({
      label: "Busiest day",
      value: fmtDate(stats.busiestDay.dayMs),
      sub: `${fmtNum(stats.busiestDay.count)} intents`,
    });
  }
  if (stats.busiestMonth !== null) {
    cells.push({
      label: "Busiest month",
      value: MONTH_LABELS[stats.busiestMonth],
      sub: `${fmtNum(stats.monthly[stats.busiestMonth])} intents`,
    });
  }
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {cells.map((c) => (
        <div
          key={c.label}
          className="rounded-lg border border-line-soft bg-bg-1 p-3"
        >
          <div className="text-[18px] font-semibold leading-none text-text-1">
            {c.value}
          </div>
          <div className="mt-2 text-[11px] uppercase tracking-wide text-text-4">
            {c.label}
          </div>
          {c.sub ? (
            <div className="mt-1 text-[11px] leading-none text-text-3">
              {c.sub}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function MonthlyStrip({ stats }: { stats: WrappedStats }) {
  const max = Math.max(1, ...stats.monthly);
  return (
    <div className="rounded-lg border border-line-soft bg-bg-1 p-3">
      <div className="mb-3 text-[11px] uppercase tracking-wide text-text-4">
        Across the year
      </div>
      <div className="flex h-24 items-end gap-1.5">
        {stats.monthly.map((c, m) => (
          <div key={m} className="flex flex-1 flex-col items-center gap-1.5">
            <div className="flex h-20 w-full items-end">
              <div
                className={
                  "w-full rounded-t " +
                  (m === stats.busiestMonth ? "bg-accent" : "bg-bg-3")
                }
                style={{ height: `${Math.max(2, (c / max) * 100)}%` }}
                title={`${MONTH_LABELS[m]}: ${fmtNum(c)} intents`}
              />
            </div>
            <span className="text-[9px] text-text-4">
              {MONTH_LABELS[m].charAt(0)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function WorkMix({ stats }: { stats: WrappedStats }) {
  const max = Math.max(1, ...stats.types.map((t) => t.count));
  return (
    <div className="rounded-lg border border-line-soft bg-bg-1 p-3">
      <div className="mb-3 text-[11px] uppercase tracking-wide text-text-4">
        What you worked on
      </div>
      <div className="flex flex-col gap-2.5">
        {stats.types.slice(0, 7).map((t) => (
          <div key={t.key} className="flex items-center gap-2.5">
            <span className="w-28 shrink-0 truncate text-[12px] text-text-2">
              {typeLabel(t.key)}
            </span>
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-bg-3">
              <div
                className="h-full rounded-full bg-accent"
                style={{ width: `${Math.max(3, (t.count / max) * 100)}%` }}
              />
            </div>
            <span className="w-10 shrink-0 text-right text-[11px] tabular-nums text-text-4">
              {fmtNum(t.count)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Provenance({ stats }: { stats: WrappedStats }) {
  const pct = stats.total > 0 ? Math.round((stats.signed / stats.total) * 100) : 0;
  return (
    <div className="rounded-lg border border-line-soft bg-bg-1 p-3">
      <div className="flex items-baseline justify-between">
        <div className="text-[11px] uppercase tracking-wide text-text-4">
          Signed &amp; verified
        </div>
        <div className="text-[12px] text-text-3">
          {fmtNum(stats.signed)} of {fmtNum(stats.total)}
        </div>
      </div>
      <div className="mt-3 h-2 overflow-hidden rounded-full bg-bg-3">
        <div
          className="h-full rounded-full bg-accent"
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="mt-2 text-[11px] leading-relaxed text-text-3">
        {pct}% of your intents carry a cryptographic signature — a tamper-evident
        record of who changed what, and why.
      </div>
    </div>
  );
}

function EmptyYear({
  year,
  years,
  onPick,
}: {
  year: number;
  years: number[];
  onPick: (y: number) => void;
}) {
  return (
    <div className="flex flex-col items-center gap-5 py-16 text-center">
      <YearSwitch years={years} active={year} onPick={onPick} />
      <div className="text-[15px] font-medium text-text-1">
        No intents logged in {year}
      </div>
      <div className="max-w-[420px] text-[12px] leading-relaxed text-text-3">
        Aura builds your year from the intent log — the reasons you (and your
        agents) recorded for each change. Once you log a few, this fills in.
      </div>
    </div>
  );
}
