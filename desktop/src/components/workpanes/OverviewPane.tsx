// OverviewPane — the calm "Overview" landing for the redesigned Trace section,
// modeled on entire.io's Overview dashboard. It is the FIRST thing a coder sees
// in Trace: its job is to make long AI runs feel calm and trustworthy.
//
// HONESTY RULE: every number here is derived ONLY from the real intent log
// (`api.auraIntentRecent`). We never fabricate metrics we don't track — there
// are NO tokens, NO "% AI", NO cost, NO throughput. The only aggregates shown
// are session counts, the +/− churn summed from each row's changeset, the
// signed/total provenance ratio, a per-day activity strip, and a per-agent
// breakdown. When the log is empty we show a quiet empty state, never fake rows.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  type BillingUsageByMember,
  type ClaudeSession,
  type IntentRow,
  type TeamMember,
  type UsageReport,
} from "../../lib/api";
import { collapseAutoStubSessions } from "../../lib/sessionMeta";
import { TEAM_ACTIVITY_ENABLED } from "../../lib/featureFlags";
import { Button } from "../ui/button";
import { ContributionsScatter } from "./ContributionsScatter";
import { TeamActivityNow } from "./TeamActivityNow";
import { SprintProgress } from "./SprintProgress";
import { currentMonthKey, fmtCost, fmtTokens, prettyMonth } from "./usageProviders";

/** Relative time from a "seconds ago" delta — "just now", "2h", "3d". */
function relTime(secsAgo: number): string {
  if (!Number.isFinite(secsAgo) || secsAgo < 0) return "just now";
  if (secsAgo < 45) return "just now";
  const mins = Math.floor(secsAgo / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(secsAgo / 3600);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(secsAgo / 86400);
  if (days < 7) return `${days}d`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;
  return `${Math.floor(days / 365)}y`;
}

/** Last path segment of a repo root — the repo's short name. */
function repoShortName(root: string): string {
  const trimmed = (root ?? "").replace(/[/\\]+$/, "");
  if (!trimmed) return "";
  const parts = trimmed.split(/[/\\]+/);
  return parts[parts.length - 1] || trimmed;
}

/** A stable local-day key (YYYY-MM-DD) for bucketing. */
function dayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

const DAY_MS = 86_400_000;
const ACTIVITY_DAYS = 14;

type Aggregates = {
  total: number;
  thisWeek: number;
  adds: number;
  dels: number;
  signed: number;
  /** Oldest → newest, exactly ACTIVITY_DAYS entries, one per local day. */
  activity: { date: Date; count: number }[];
  /** Days in the activity window with at least one run. */
  activeDays: number;
  /** Consecutive active days ending today (a continuity/streak signal). */
  streak: number;
};

/** Fold the rows into every aggregate the pane renders — all honest, all
 *  derived, nothing fabricated. A run's `[auto]` stub spam is collapsed into
 *  one entry per session first (see sessionMeta), so the session count,
 *  per-day strip and per-agent breakdown reflect real sessions rather than the
 *  inflated raw intent-log length — while churn is summed across the whole
 *  collapsed run, so the +/− totals stay truthful. Computed once per
 *  (rows, sessions, nowMs). */
function computeAggregates(
  rows: IntentRow[],
  sessions: ClaudeSession[],
  nowMs: number,
): Aggregates {
  // Collapse first: one display entry per session, churn pre-aggregated.
  const display = collapseAutoStubSessions(rows, sessions);

  // Per-day activity buckets for the trailing ACTIVITY_DAYS, keyed by local day.
  const buckets = new Map<string, number>();
  const days: { date: Date; key: string }[] = [];
  const startOfToday = new Date(nowMs);
  startOfToday.setHours(0, 0, 0, 0);
  for (let i = ACTIVITY_DAYS - 1; i >= 0; i--) {
    const d = new Date(startOfToday.getTime() - i * DAY_MS);
    const key = dayKey(d);
    days.push({ date: d, key });
    buckets.set(key, 0);
  }

  const weekCutoff = nowMs - 7 * DAY_MS;

  let adds = 0;
  let dels = 0;
  let signed = 0;
  let thisWeek = 0;

  for (const d of display) {
    const row = d.row;
    const ms = row.timestamp * 1000;
    if (ms >= weekCutoff) thisWeek += 1;

    // Churn is pre-summed across the collapsed run, so totalling over display
    // rows still accounts for every edit's +/−.
    adds += d.adds;
    dels += d.dels;

    if (row.signed_block_id) signed += 1;

    const key = dayKey(new Date(ms));
    if (buckets.has(key)) buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }

  const activity = days.map((d) => ({
    date: d.date,
    count: buckets.get(d.key) ?? 0,
  }));

  // Continuity signals from the activity window. `activeDays` = days that saw
  // any run; `streak` = the unbroken run of active days ending today (walk
  // backward from the newest bucket while it stays non-empty).
  const activeDays = activity.reduce((n, d) => n + (d.count > 0 ? 1 : 0), 0);
  let streak = 0;
  for (let i = activity.length - 1; i >= 0; i--) {
    if (activity[i].count > 0) streak += 1;
    else break;
  }

  return {
    total: display.length,
    thisWeek,
    adds,
    dels,
    signed,
    activity,
    activeDays,
    streak,
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

function WrappedIcon() {
  // A small sparkle — the "year in review" affordance.
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 3l1.9 4.8L18.7 9l-4.8 1.9L12 15.7 10.1 11 5.3 9l4.8-1.9z" />
      <path d="M19 14l.7 1.8L21.5 16.5 19.7 17.2 19 19l-.7-1.8L16.5 16.5l1.8-.7z" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg
      width="12"
      height="12"
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

function ArrowRightIcon() {
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
      <path d="M5 12h14" />
      <path d="M13 5l7 7-7 7" />
    </svg>
  );
}

/** One stat card — a big number over a dim uppercase label, with an optional
 *  supporting sub-line (a second honest figure that gives the headline
 *  context, mirroring the reference dashboard's richer cards). */
function StatCard({
  label,
  sub,
  children,
}: {
  label: string;
  sub?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-line-soft bg-bg-1 p-3">
      <div className="text-[22px] font-semibold leading-none text-text-1">
        {children}
      </div>
      <div className="mt-2 text-[11px] uppercase tracking-wide text-text-4">
        {label}
      </div>
      {sub ? (
        <div className="mt-1 text-[11px] leading-none text-text-3">{sub}</div>
      ) : null}
    </div>
  );
}

/** The one-line cost summary — Overview's only nod to spend. The full
 *  breakdown (per-model split, cumulative trend, per-developer cost) lives on
 *  the dedicated Cost & usage view, which this row opens. */
function CostSummaryLine({
  monthLabel,
  tokens,
  costUsd,
  scopeNote,
  onOpen,
}: {
  monthLabel: string;
  tokens: number;
  costUsd: number;
  scopeNote: string;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      title="Open Cost & usage"
      className="flex w-full items-center justify-between gap-3 rounded-lg border border-line-soft bg-bg-1 px-3 py-2.5 text-left hover:bg-bg-2"
    >
      <span className="flex min-w-0 items-baseline gap-1.5">
        <span className="text-[11px] uppercase tracking-wide text-text-4">
          {monthLabel}
        </span>
        <span className="truncate text-[12.5px] text-text-2">
          <span className="font-mono text-text-1">{fmtTokens(tokens)}</span>{" "}
          tokens
          <span className="text-text-4"> · </span>
          <span className="font-mono text-text-1">{fmtCost(costUsd)}</span>
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-text-4">
        {scopeNote}
        <ArrowRightIcon />
      </span>
    </button>
  );
}

export function OverviewPane({
  repoRoot,
  onOpenSessions,
  onOpenWrapped,
  onOpenCostUsage,
}: {
  repoRoot: string;
  onOpenSessions: () => void;
  onOpenWrapped: () => void;
  /** Open the dedicated Cost & usage view — the one home for token/cost data.
   *  Overview only shows a single summary line that links here. */
  onOpenCostUsage: () => void;
}) {
  const [rows, setRows] = useState<IntentRow[]>([]);
  // Real Claude Code sessions — best-effort, used to fold a run's `[auto]`
  // stub spam into one entry per session before counting (see sessionMeta).
  const [claudeSessions, setClaudeSessions] = useState<ClaudeSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Captured once per fetch so every relative time in a render shares a clock.
  const [nowMs, setNowMs] = useState(() => Date.now());
  // Team + usage are best-effort: each may be unavailable (no team, no cloud
  // auth) and MUST NOT block or break the solo view. They live in their own
  // state and the solo render never waits on them.
  const [roster, setRoster] = useState<TeamMember[]>([]);
  const [billing, setBilling] = useState<BillingUsageByMember | null>(null);
  const [monthUsage, setMonthUsage] = useState<UsageReport | null>(null);
  const aliveRef = useRef(true);

  const load = useCallback(async () => {
    if (!repoRoot) {
      setRows([]);
      setClaudeSessions([]);
      setRoster([]);
      setBilling(null);
      setMonthUsage(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      // Claude sessions are best-effort enrichment for the collapse — their
      // absence just means no folding, never a failed load.
      const [data, sessions] = await Promise.all([
        api.auraIntentRecent(repoRoot, 200),
        api.claudeListSessions(repoRoot).catch(() => [] as ClaudeSession[]),
      ]);
      if (!aliveRef.current) return;
      setRows(Array.isArray(data) ? data : []);
      setClaudeSessions(Array.isArray(sessions) ? sessions : []);
      setNowMs(Date.now());
    } catch (e) {
      if (!aliveRef.current) return;
      setError(e instanceof Error ? e.message : String(e));
      setRows([]);
    } finally {
      if (aliveRef.current) setLoading(false);
    }

    // ── Team + usage (independent, non-blocking) ──────────────────────
    // Each source is fetched in isolation so a single failure (no cloud
    // auth, no team manifest, usage CLI absent) degrades only its own
    // section. We never surface these as the pane-level error.
    void (async () => {
      try {
        const team = await api.teamLoad(repoRoot);
        if (aliveRef.current) setRoster(team?.members ?? []);
      } catch {
        if (aliveRef.current) setRoster([]);
      }
    })();

    void (async () => {
      try {
        const usage = await api.cloudBillingUsageByMember();
        if (aliveRef.current) setBilling(usage ?? null);
      } catch {
        // Not signed in / no org plan / network — fall back to solo + hint.
        if (aliveRef.current) setBilling(null);
      }
    })();

    void (async () => {
      try {
        // Overview only needs THIS month's figure for the one-line cost
        // summary; the accumulated/trend/per-model breakdowns live on the
        // dedicated Cost & usage view.
        const m = await api.auraUsageReport(repoRoot, "month");
        if (!aliveRef.current) return;
        setMonthUsage(m);
      } catch {
        if (aliveRef.current) setMonthUsage(null);
      }
    })();
  }, [repoRoot]);

  useEffect(() => {
    aliveRef.current = true;
    void load();
    return () => {
      aliveRef.current = false;
    };
  }, [load]);

  const agg = useMemo(
    () => computeAggregates(rows, claudeSessions, nowMs),
    [rows, claudeSessions, nowMs],
  );
  const shortName = useMemo(() => repoShortName(repoRoot), [repoRoot]);

  // Newest row's age for the recent-activity line.
  const newestRel = useMemo(() => {
    if (rows.length === 0) return null;
    const newest = rows.reduce(
      (m, r) => (r.timestamp > m ? r.timestamp : m),
      rows[0].timestamp,
    );
    return relTime(Math.floor(nowMs / 1000) - newest);
  }, [rows, nowMs]);

  // ── Cost summary line (one-line only; full breakdown lives on Cost & usage) ─
  // Cloud per-dev numbers are only trustworthy at org scope. "self" scope means
  // the cloud only returned the current user — we treat that as "not available
  // for the team view" and fall back to roster-only.
  const cloudAvailable =
    billing != null && billing.scope === "org" && billing.members.length > 0;

  // The month figure prefers the cloud org total (authoritative, whole team)
  // and falls back to the LOCAL month usage report. Either way the numbers are
  // real and the scope note says exactly whose they are.
  const monthLabel = useMemo(() => {
    const key =
      billing?.month && billing.month.trim()
        ? billing.month
        : currentMonthKey(new Date(nowMs));
    return prettyMonth(key);
  }, [billing, nowMs]);

  const heroMonth = useMemo(() => {
    if (cloudAvailable) {
      let tin = 0;
      let tout = 0;
      for (const m of billing.members) {
        tin += m.tokens_in;
        tout += m.tokens_out;
      }
      return {
        tokensIn: tin,
        tokensOut: tout,
        costUsd: billing.total_cost_usd,
        scopeNote: "Aura Cloud · team",
      };
    }
    if (monthUsage) {
      return {
        tokensIn: monthUsage.totalInputTokens,
        tokensOut: monthUsage.totalOutputTokens,
        costUsd: monthUsage.totalCostUsd,
        scopeNote: billing ? "Aura Cloud · you" : "Local · this install",
      };
    }
    return null;
  }, [cloudAvailable, billing, monthUsage]);

  // Team / shared signal: a roster beyond me, a cloud org, or any month spend.
  const hasTeamSection =
    roster.length > 0 || cloudAvailable || heroMonth != null;
  // A "team" worth a live summary = more than just me, or a cloud org.
  const hasLiveTeam = roster.length > 1 || cloudAvailable;

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg-content">
      {/* ── Header ─────────────────────────────────────────────────── */}
      <div className="flex shrink-0 items-center justify-between border-b border-line-soft px-4 py-3">
        <div className="flex flex-col gap-0.5">
          <span className="text-[15px] font-medium leading-none text-text-1">
            Overview
          </span>
          {shortName ? (
            <span className="text-[12px] text-text-4">{shortName}</span>
          ) : null}
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={onOpenWrapped}
            className="flex h-6 items-center gap-1.5 rounded border border-accent/30 bg-accent/10 px-2 text-[11px] text-accent hover:bg-accent/20"
            title="Your year with Aura — a calm look back at everything you've built"
          >
            <WrappedIcon />
            Year in review
          </button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={() => void load()}
            disabled={loading}
            className="text-text-3 hover:text-text-1"
            title="Refresh overview"
            aria-label="Refresh overview"
          >
            <RefreshIcon />
          </Button>
        </div>
      </div>

      {/* ── Body ───────────────────────────────────────────────────── */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* Live "what is everyone doing right now" — independent of the intent
            log load, so it stays useful even while/if the log is loading or
            errored. Renders nothing when solo + idle. */}
        {TEAM_ACTIVITY_ENABLED && (
          <TeamActivityNow
            repoRoot={repoRoot}
            roster={roster}
            rows={rows}
            sessions={claudeSessions}
            hasTeam={hasLiveTeam}
          />
        )}
        {error ? (
          <div className="px-4 py-4 text-[12px] text-text-3">
            Couldn&rsquo;t load overview.
            <span className="mt-1 block font-mono text-[11px] text-text-4">
              {error}
            </span>
          </div>
        ) : loading && rows.length === 0 ? (
          <div className="px-4 py-4 text-[12px] text-text-4">Loading…</div>
        ) : agg.total === 0 ? (
          // No local intent activity yet. If there's still a team and/or
          // shared usage to show, render those below a calm inline notice
          // instead of swallowing the whole pane into an empty state.
          hasTeamSection ? (
            <div className="mx-auto flex max-w-[760px] flex-col gap-5 px-4 py-5">
              <div className="rounded-lg border border-line-soft bg-bg-0 shadow-[var(--shadow-card)] p-4 text-center">
                <span className="text-[13px] text-text-2">
                  No local activity yet.
                </span>
                <span className="mt-1 block text-[12px] leading-relaxed text-text-4">
                  As you and your agents work, Aura traces every run here.
                </span>
              </div>
              {heroMonth ? (
                <CostSummaryLine
                  monthLabel={monthLabel}
                  tokens={heroMonth.tokensIn + heroMonth.tokensOut}
                  costUsd={heroMonth.costUsd}
                  scopeNote={heroMonth.scopeNote}
                  onOpen={onOpenCostUsage}
                />
              ) : null}
              <SprintProgress repoRoot={repoRoot} />
            </div>
          ) : (
            <div className="flex h-full flex-col items-center justify-center px-8 text-center">
              <span className="text-[13px] text-text-2">No activity yet.</span>
              <span className="mt-1.5 max-w-[22rem] text-[12px] leading-relaxed text-text-4">
                As you and your agents work, Aura traces every run here.
              </span>
            </div>
          )
        ) : (
          <div className="mx-auto flex max-w-[760px] flex-col gap-5 px-4 py-5">
            {/* Stat cards */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <StatCard
                label="Sessions"
                sub={`${agg.activeDays} active ${
                  agg.activeDays === 1 ? "day" : "days"
                }`}
              >
                {agg.total}
              </StatCard>
              <StatCard
                label="This week"
                sub={
                  agg.streak > 0
                    ? `${agg.streak}-day streak`
                    : newestRel
                      ? `last run ${newestRel}`
                      : undefined
                }
              >
                {agg.thisWeek}
              </StatCard>
              <StatCard
                label="Net change"
                sub={
                  <span className="font-mono">
                    {agg.adds - agg.dels >= 0 ? "+" : "−"}
                    {Math.abs(agg.adds - agg.dels)} net
                  </span>
                }
              >
                <span className="font-mono">
                  <span className="text-accent-green">+{agg.adds}</span>
                  <span className="text-text-4"> / </span>
                  <span className="text-text-3">−{agg.dels}</span>
                </span>
              </StatCard>
              <StatCard label="Genuine records" sub="sealed &amp; tamper-proof">
                <span className="flex items-center gap-1.5">
                  <span className="text-text-3">
                    <LockIcon />
                  </span>
                  <span>
                    {agg.signed}{" "}
                    <span className="text-[14px] font-normal text-text-4">
                      of {agg.total}
                    </span>
                  </span>
                </span>
              </StatCard>
            </div>

            {/* Activity — the single centerpiece: every run plotted over time,
                colored by the agent that authored it (the x-axis is time, the
                legend is the per-agent breakdown — so this one chart replaces
                the old separate activity strip + by-agent bars). */}
            <ContributionsScatter rows={rows} />

            {/* One-line cost summary → opens the dedicated Cost & usage view.
                The full breakdown (per-model, trend, per-developer) lives
                there, never duplicated here. */}
            {heroMonth ? (
              <CostSummaryLine
                monthLabel={monthLabel}
                tokens={heroMonth.tokensIn + heroMonth.tokensOut}
                costUsd={heroMonth.costUsd}
                scopeNote={heroMonth.scopeNote}
                onOpen={onOpenCostUsage}
              />
            ) : null}

            {/* View all sessions affordance */}
            <button
              type="button"
              onClick={onOpenSessions}
              className="flex items-center gap-1 self-start rounded px-1 py-1 text-[12px] text-text-3 hover:text-text-1"
            >
              <span>View all sessions</span>
              <ArrowRightIcon />
            </button>

            {/* Sprint completion + velocity — BEAD-I tie-in. Self-hides
                when the repo has no sprints. */}
            <SprintProgress repoRoot={repoRoot} />
          </div>
        )}
      </div>
    </div>
  );
}
