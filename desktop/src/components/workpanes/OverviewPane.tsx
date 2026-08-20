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
import { fetchSessions } from "../../lib/sessionsCache";
import { fetchIntentRows } from "../../lib/intentCache";
import { isAutomationIdentity } from "../../lib/agentIdentity";
import { collapseAutoStubSessions } from "../../lib/sessionMeta";
import { TEAM_ACTIVITY_ENABLED } from "../../lib/featureFlags";
import { Activity } from "lucide-react";
import { EmptyState, ErrorState, LoadingState } from "../ui/state";
import { ContributionsScatter } from "./ContributionsScatter";
import { TeamActivityNow } from "./TeamActivityNow";
import { SprintProgress } from "./SprintProgress";
import { currentMonthKey, prettyMonth } from "./usageProviders";
import { compactNumber } from "../../lib/compactNumber";
import { formatCost } from "../../lib/money";
import { relativeAgeFromDelta } from "../../lib/relativeTime";
import { fetchTeam } from "../../lib/teamCache";
import { fetchBillingUsage } from "../../lib/billingCache";

/** Relative time from a "seconds ago" delta — "now", "2h", "3d". */
function relTime(secsAgo: number): string {
  // One ladder for the whole app — see lib/relativeTime. This copy skipped the
  // seconds rung, so 45s through 59s printed "0m".
  return relativeAgeFromDelta(secsAgo, { style: "compact" });
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

/** Shortest gap between two automatic re-reads. Returning to the window is the
 *  cue to refresh, and a window can regain focus several times in a few
 *  seconds; below this the pane just keeps what it already has. */
const REFRESH_MIN_GAP_MS = 20_000;

type Aggregates = {
  total: number;
  thisWeek: number;
  /** Runs that landed today — the recency slice to show when the whole
   *  history already fits inside the week (see the "This week" card). */
  today: number;
  adds: number;
  dels: number;
  /** How many sessions actually recorded line counts. Churn is optional on an
   *  intent row, so `adds`/`dels` are a total over THESE sessions, not over
   *  `total` — and the card has to say so rather than let a partial sum read
   *  as the project's whole net change. */
  churnRows: number;
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

  const todayKey = dayKey(startOfToday);

  let adds = 0;
  let dels = 0;
  let churnRows = 0;
  let signed = 0;
  let thisWeek = 0;
  let today = 0;

  for (const d of display) {
    const row = d.row;
    const ms = row.timestamp * 1000;
    if (ms >= weekCutoff) thisWeek += 1;

    // Churn is pre-summed across the collapsed run, so totalling over display
    // rows still accounts for every edit's +/−. `hasChurn` is tracked
    // alongside because line counts are OPTIONAL on an intent row: a session
    // that recorded none contributes 0 here and is indistinguishable, in the
    // total alone, from one that genuinely changed nothing.
    adds += d.adds;
    dels += d.dels;
    if (d.hasChurn) churnRows += 1;

    if (row.signed_block_id) signed += 1;

    if (dayKey(new Date(ms)) === todayKey) today += 1;

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
    today,
    adds,
    dels,
    churnRows,
    signed,
    activity,
    activeDays,
    streak,
  };
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

/** One figure in the headline row — a big number over a dim label,
 *  with an optional supporting sub-line (a second honest figure that gives the
 *  headline context).
 *
 *  No box. Four numbers used to sit in four separately-bordered, separately-
 *  filled rounded cards, which drew four containers around content that has
 *  nothing inside it to contain — a border is for holding things apart, and
 *  these are one row of one kind of thing. A hairline between neighbours says
 *  "these are four readings" at a fraction of the ink. */
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
    <div className="px-3 py-0.5 sm:[&:not(:first-child)]:border-l sm:[&:not(:first-child)]:border-line-soft">
      <div className="text-xl font-semibold leading-none text-text-1">
        {children}
      </div>
      <div className="section-label mt-2">
        {label}
      </div>
      {sub ? (
        <div className="mt-1 text-xs leading-none text-text-3">{sub}</div>
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
  runsThisMonth,
  scopeNote,
  onOpen,
}: {
  monthLabel: string;
  tokens: number;
  costUsd: number;
  /** Runs Aura recorded in this same month — the check on a zero total. */
  runsThisMonth: number;
  scopeNote: string;
  onOpen: () => void;
}) {
  // A zero here is two very different facts, and the row used to print the
  // same "0 tokens · $0" for both. On this project it read $0 for July
  // directly beneath a chart of 178 July runs — the page contradicting itself
  // in the space of one scroll. Runs cost tokens; a zero next to runs means
  // nobody wrote the usage down, not that the month was free.
  //
  // The card two rows up already handles its own version of this correctly
  // ("— / no line counts recorded"), so match it: assert a measurement only
  // when there is one.
  const measured = tokens > 0 || costUsd > 0;
  return (
    <button
      type="button"
      onClick={onOpen}
      title="Open Cost & usage"
      // A row you can click, not a card. It holds one line of text and opens
      // one destination — transparent at rest, filled on hover, which is how
      // every other clickable row in the app reads.
      className="-mx-3 flex w-full items-center justify-between gap-3 rounded px-3 py-2.5 text-left hover:bg-state-hover"
    >
      <span className="flex min-w-0 items-baseline gap-1.5">
        <span className="section-label">
          {monthLabel}
        </span>
        {measured ? (
          <span className="truncate text-base text-text-2">
            <span className="font-mono text-text-1">{compactNumber(tokens)}</span>{" "}
            tokens
            <span className="text-text-4"> · </span>
            <span className="font-mono text-text-1">{formatCost(costUsd)}</span>
          </span>
        ) : (
          <span className="truncate text-base text-text-4">
            {runsThisMonth > 0
              ? `usage wasn't recorded for this month's ${runsThisMonth} run${runsThisMonth === 1 ? "" : "s"}`
              : "no runs yet this month"}
          </span>
        )}
      </span>
      <span className="flex shrink-0 items-center gap-1.5 text-xs text-text-4">
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
  // When we last ASKED for data, not when it landed — a slow read must not
  // leave the window open for a second one to start behind it.
  const askedAtRef = useRef(0);

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
    askedAtRef.current = Date.now();
    setLoading(true);
    setError(null);
    try {
      // Claude sessions are best-effort enrichment for the collapse — their
      // absence just means no folding, never a failed load.
      const [data, sessions] = await Promise.all([
        // This ceiling used to be 200, which quietly turned every headline on
        // this pane into "the last 200 log lines" rather than the project's
        // totals — the "sessions" and "active days" cards could never grow past
        // it, and "Year in review", one click away on this same header, reads
        // 5000 and so reported a different history for the same project. Same
        // number as Wrapped, and both go through the shared read so opening one
        // from the other costs nothing.
        //
        // It is not "one local JSONL read", as this comment used to claim: the
        // backend unions the log across every branch tip with a `git show` per
        // ref and then pulls teammates' intents over the network. That is why
        // it goes through intentCache rather than straight at the api.
        fetchIntentRows(repoRoot, 5000),
        fetchSessions(repoRoot).catch(() => [] as ClaudeSession[]),
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
        const team = await fetchTeam(repoRoot);
        if (aliveRef.current) setRoster(team?.members ?? []);
      } catch {
        if (aliveRef.current) setRoster([]);
      }
    })();

    void (async () => {
      try {
        const usage = await fetchBillingUsage();
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

  // Staying current without asking.
  //
  // This pane used to carry a refresh button, and it was the only thing that
  // re-read the log after mount: leave Overview open, let an agent work for an
  // hour, come back, and every figure was still the one from when the tab
  // opened — stale numbers that look exactly like fresh ones. The button is
  // gone, so the reload has to happen by itself, and returning to the window is
  // the moment you expect to be looking at now. Throttled, because flicking
  // between windows would otherwise turn one glance into a run of fetches.
  useEffect(() => {
    function refreshOnReturn() {
      if (document.visibilityState === "hidden") return;
      if (Date.now() - askedAtRef.current < REFRESH_MIN_GAP_MS) return;
      void load();
    }
    window.addEventListener("focus", refreshOnReturn);
    document.addEventListener("visibilitychange", refreshOnReturn);
    return () => {
      window.removeEventListener("focus", refreshOnReturn);
      document.removeEventListener("visibilitychange", refreshOnReturn);
    };
  }, [load]);

  const agg = useMemo(
    () => computeAggregates(rows, claudeSessions, nowMs),
    [rows, claudeSessions, nowMs],
  );

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
  const monthKey = useMemo(
    () =>
      billing?.month && billing.month.trim()
        ? billing.month
        : currentMonthKey(new Date(nowMs)),
    [billing, nowMs],
  );
  const monthLabel = useMemo(() => prettyMonth(monthKey), [monthKey]);

  // How many runs Aura recorded in the month the figure above is about. A zero
  // spend means nothing on its own; a zero spend across 178 recorded runs means
  // the usage numbers are missing, and the row has to say which it is.
  const runsThisMonth = useMemo(
    () =>
      rows.filter(
        (r) => currentMonthKey(new Date(r.timestamp * 1000)) === monthKey,
      ).length,
    [rows, monthKey],
  );

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

  // Machines don't make a project collaborative. Aura's own agent and the
  // checkpointer commit under git identities of their own, so a solo repo where
  // Aura has worked came back with a roster of three and got told it had a live
  // team — a "who's on this project" summary about one person and two bots.
  const peopleCount = useMemo(
    () => roster.filter((m) => !isAutomationIdentity(m.name, m.email)).length,
    [roster],
  );
  // Team / shared signal: a roster beyond me, a cloud org, or any month spend.
  const hasTeamSection =
    peopleCount > 0 || cloudAvailable || heroMonth != null;
  // A "team" worth a live summary = more than just me, or a cloud org.
  const hasLiveTeam = peopleCount > 1 || cloudAvailable;

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg-content">
      {/* No header. What sat here was a strip of chrome carrying two controls
          and nothing else: a "Year in review" chip and a refresh icon, above a
          surface that is already a wall of live figures. Both were doing work
          that didn't need a bar. Refreshing is not a decision anyone makes —
          it happens on its own now, whenever you come back to the window (see
          the focus effect above). And "Year in review" is somewhere to go, not
          an action on this pane, so it belongs beside "View all sessions" at
          the foot of the content where the other exits live. Removing the strip
          gives the numbers back the top of the pane. */}

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
          <ErrorState
            title="Couldn’t load this project’s history"
            message={error}
            onRetry={() => void load()}
            size="sm"
          />
        ) : loading && rows.length === 0 ? (
          <LoadingState label="Reading this project’s history…" />
        ) : agg.total === 0 ? (
          // No local intent activity yet. If there's still a team and/or
          // shared usage to show, render those below a calm inline notice
          // instead of swallowing the whole pane into an empty state.
          hasTeamSection ? (
            <div className="mx-auto flex max-w-[760px] flex-col gap-5 px-4 py-5">
              {/* Your own machine has nothing yet, but your team does — so this
                  is a note above their work, not a takeover of the pane. */}
              <EmptyState
                icon={Activity}
                title="Nothing from you yet"
                body="Your teammates’ work is below. Yours appears here the moment you or one of your agents changes something."
                size="sm"
              />
              {heroMonth ? (
                <CostSummaryLine
                  monthLabel={monthLabel}
                  tokens={heroMonth.tokensIn + heroMonth.tokensOut}
                  costUsd={heroMonth.costUsd}
                  runsThisMonth={runsThisMonth}
                  scopeNote={heroMonth.scopeNote}
                  onOpen={onOpenCostUsage}
                />
              ) : null}
              <SprintProgress repoRoot={repoRoot} />
            </div>
          ) : (
            <div className="flex h-full items-center justify-center">
              <EmptyState
                icon={Activity}
                title="Nothing has happened here yet"
                body="This is the record of the work on this project, who changed what, when, and why they said they did. It fills itself in as you and your agents go."
              />
            </div>
          )
        ) : (
          <div className="mx-auto flex max-w-[760px] flex-col gap-5 px-4 py-5">
            {/* The headline figures — one row, hairlines between, no boxes.
                `-mx-3` pulls the first figure's own padding back to the
                column edge so the numbers line up with everything below. */}
            <div className="-mx-3 grid grid-cols-2 gap-y-4 sm:grid-cols-4 sm:gap-y-0">
              {/* The count above is every run on record; the line below counts
                  only the last fortnight. Unlabelled, the two read as one
                  scope, and "12 active days" looked like the project's whole
                  history — while "Year in review", one click up in this same
                  header, said 30. Name the window and both are true. */}
              <StatCard
                label="Sessions"
                sub={`active ${agg.activeDays} of the last ${ACTIVITY_DAYS} days`}
              >
                {agg.total}
              </StatCard>
              {/* Recency. "This week" only says something when there IS work
                  older than a week to contrast it against — on a young project
                  every session is this week's, and the card printed the exact
                  number sitting beside it, twice, teaching nothing. So it
                  narrows to today when the whole history already fits in the
                  week. Both readings are true; only one is informative. */}
              <StatCard
                label={agg.thisWeek < agg.total ? "This week" : "Today"}
                sub={
                  agg.streak > 0
                    ? `${agg.streak}-day streak`
                    : newestRel
                      ? `last run ${newestRel}`
                      : undefined
                }
              >
                {agg.thisWeek < agg.total ? agg.thisWeek : agg.today}
              </StatCard>
              {/* Net change, with the honest denominator. Line counts are
                  optional on an intent row, so this is the total over the
                  sessions that recorded them — never over all of them. Saying
                  "+84 / −10" flat, next to a card that carefully reads "178 of
                  178", invites it to be read as the project's whole net change
                  when it may be a handful of sessions' worth. When nothing
                  recorded any, the card says that instead of printing a
                  "+0 / −0" that asserts nothing changed. */}
              {agg.churnRows === 0 ? (
                <StatCard label="Net change" sub="no line counts recorded">
                  <span className="text-text-4">·</span>
                </StatCard>
              ) : (
                <StatCard
                  label="Net change"
                  sub={
                    agg.churnRows < agg.total ? (
                      `from ${agg.churnRows} of ${agg.total} sessions`
                    ) : (
                      <span className="font-mono">
                        {agg.adds - agg.dels >= 0 ? "+" : "−"}
                        {Math.abs(agg.adds - agg.dels)} net
                      </span>
                    )
                  }
                >
                  <span className="font-mono">
                    <span className="text-accent-green">+{agg.adds}</span>
                    <span className="text-text-4"> / </span>
                    <span className="text-text-3">−{agg.dels}</span>
                  </span>
                </StatCard>
              )}
              <StatCard label="Genuine records" sub="sealed &amp; tamper-proof">
                <span className="flex items-center gap-1.5">
                  <span className="text-text-3">
                    <LockIcon />
                  </span>
                  <span>
                    {agg.signed}{" "}
                    <span className="text-md font-normal text-text-4">
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
                runsThisMonth={runsThisMonth}
                scopeNote={heroMonth.scopeNote}
                onOpen={onOpenCostUsage}
              />
            ) : null}

            {/* Where to go next. Both of these are the same kind of thing — the
                rest of the record, and the long look back at it — so they read
                as one row of exits at the foot of the summary rather than one
                here and one pinned to a strip at the top of the pane. "Year in
                review" is only offered where there is a history to look back
                over; on an empty log it opened a year with nothing in it. */}
            <div className="flex items-center gap-4">
              <button
                type="button"
                onClick={onOpenSessions}
                className="flex items-center gap-1 rounded px-1 py-1 text-sm text-text-3 hover:text-text-1"
              >
                <span>View all sessions</span>
                <ArrowRightIcon />
              </button>
              <button
                type="button"
                onClick={onOpenWrapped}
                className="flex items-center gap-1 rounded px-1 py-1 text-sm text-text-3 hover:text-text-1"
                title="Your year with Aura. A calm look back at everything you've built"
              >
                <span>Year in review</span>
                <ArrowRightIcon />
              </button>
            </div>

            {/* Sprint completion + velocity — BEAD-I tie-in. Self-hides
                when the repo has no sprints. */}
            <SprintProgress repoRoot={repoRoot} />
          </div>
        )}
      </div>
    </div>
  );
}
