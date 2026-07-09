// CostUsagePane — the single home for "what is this costing us": token spend,
// per-model split, the cumulative trend, per-coding-agent usage and the
// per-developer team breakdown. It is the dedicated Trace "Cost & usage" view
// (a sibling of Overview / Team activity / My sessions), so the Overview pane
// only ever shows a one-line cost summary that links here — no usage dashboard
// is rendered in two places.
//
// HONESTY RULE (inherited from OverviewPane): every figure is real. The month
// hero prefers the cloud org total (authoritative, whole team) and falls back
// to the LOCAL usage report; the scope note always says exactly whose numbers
// these are. When there is no usage data at all (not signed in, no local
// report) we show a calm empty state, never fabricated spend.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  type BillingUsageByMember,
  type TeamMember,
  type UsageReport,
} from "../../lib/api";
import { TeamAgentUsage } from "./TeamAgentUsage";
import { TeamOverview } from "./TeamOverview";
import { Button } from "../ui/button";
import {
  CumulativeTrend,
  ModelSplitBar,
  UsageHero,
  slicesFromLocalModels,
  type TrendPoint,
} from "./UsageCharts";
import { currentMonthKey, prettyMonth } from "./usageProviders";

/** Last path segment of a repo root — the repo's short name. */
function repoShortName(root: string): string {
  const trimmed = (root ?? "").replace(/[/\\]+$/, "");
  if (!trimmed) return "";
  const parts = trimmed.split(/[/\\]+/);
  return parts[parts.length - 1] || trimmed;
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

export function CostUsagePane({ repoRoot }: { repoRoot: string }) {
  // Team + usage are best-effort: each source may be unavailable (no team, no
  // cloud auth, usage CLI absent) and degrades only its own section.
  const [roster, setRoster] = useState<TeamMember[]>([]);
  const [billing, setBilling] = useState<BillingUsageByMember | null>(null);
  const [monthUsage, setMonthUsage] = useState<UsageReport | null>(null);
  const [allUsage, setAllUsage] = useState<UsageReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const aliveRef = useRef(true);

  const load = useCallback(async () => {
    if (!repoRoot) {
      setRoster([]);
      setBilling(null);
      setMonthUsage(null);
      setAllUsage(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setNowMs(Date.now());

    // Each source is fetched in isolation so a single failure (no cloud auth,
    // no team manifest, usage CLI absent) degrades only its own card.
    const tasks: Promise<void>[] = [];

    tasks.push(
      (async () => {
        try {
          const team = await api.teamLoad(repoRoot);
          if (aliveRef.current) setRoster(team?.members ?? []);
        } catch {
          if (aliveRef.current) setRoster([]);
        }
      })(),
    );

    tasks.push(
      (async () => {
        try {
          const usage = await api.cloudBillingUsageByMember();
          if (aliveRef.current) setBilling(usage ?? null);
        } catch {
          if (aliveRef.current) setBilling(null);
        }
      })(),
    );

    tasks.push(
      (async () => {
        try {
          const [m, a] = await Promise.all([
            api.auraUsageReport(repoRoot, "month"),
            api.auraUsageReport(repoRoot, "all"),
          ]);
          if (!aliveRef.current) return;
          setMonthUsage(m);
          setAllUsage(a);
        } catch {
          if (aliveRef.current) {
            setMonthUsage(null);
            setAllUsage(null);
          }
        }
      })(),
    );

    await Promise.allSettled(tasks);
    if (aliveRef.current) setLoading(false);
  }, [repoRoot]);

  useEffect(() => {
    aliveRef.current = true;
    void load();
    return () => {
      aliveRef.current = false;
    };
  }, [load]);

  const shortName = useMemo(() => repoShortName(repoRoot), [repoRoot]);
  const nowSecs = Math.floor(nowMs / 1000);

  // Cloud per-dev numbers are only trustworthy at org scope. "self" scope means
  // the cloud only returned the current user — treat that as "not available for
  // the team view" and fall back to roster-only + a hint.
  const cloudAvailable =
    billing != null && billing.scope === "org" && billing.members.length > 0;
  const billingMembers = cloudAvailable ? billing.members : [];

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

  // "Accumulated" = all-time LOCAL usage for this install. We never claim it is
  // team-wide; the label makes the scope explicit.
  const accumulated = useMemo(() => {
    if (!allUsage) return null;
    return {
      tokens: allUsage.totalInputTokens + allUsage.totalOutputTokens,
      costUsd: allUsage.totalCostUsd,
    };
  }, [allUsage]);

  const modelSlices = useMemo(
    () => (monthUsage ? slicesFromLocalModels(monthUsage.byModel) : []),
    [monthUsage],
  );

  const trendPoints = useMemo<TrendPoint[]>(() => {
    if (!allUsage) return [];
    const monthTokens = monthUsage
      ? monthUsage.totalInputTokens + monthUsage.totalOutputTokens
      : 0;
    const allTokens = allUsage.totalInputTokens + allUsage.totalOutputTokens;
    const priorTokens = Math.max(0, allTokens - monthTokens);
    const pts: TrendPoint[] = [];
    if (priorTokens > 0) pts.push({ label: "Earlier", value: priorTokens });
    pts.push({ label: monthLabel, value: monthTokens });
    return pts;
  }, [allUsage, monthUsage, monthLabel]);

  const localByModel = monthUsage?.byModel ?? null;
  const agentScopeNote = cloudAvailable
    ? "Aura Cloud · team"
    : billing
      ? "Aura Cloud · you"
      : "Local · this install";

  // Something worth rendering = any usage figure or any roster member.
  const hasAnything =
    heroMonth != null ||
    modelSlices.length > 0 ||
    billingMembers.length > 0 ||
    roster.length > 0;

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg-content">
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between border-b border-line-soft px-4 py-3">
        <div className="flex flex-col gap-0.5">
          <span className="text-[15px] font-medium leading-none text-text-1">
            Cost & usage
          </span>
          {shortName ? (
            <span className="text-[12px] text-text-4">{shortName}</span>
          ) : null}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={() => void load()}
          disabled={loading}
          className="text-text-3 hover:text-text-1"
          title="Refresh cost & usage"
          aria-label="Refresh cost & usage"
        >
          <RefreshIcon />
        </Button>
      </div>

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading && !hasAnything ? (
          <div className="px-4 py-4 text-[12px] text-text-4">Loading…</div>
        ) : !hasAnything ? (
          <div className="flex h-full flex-col items-center justify-center px-8 text-center">
            <span className="text-[13px] text-text-2">No usage yet.</span>
            <span className="mt-1.5 max-w-[24rem] text-[12px] leading-relaxed text-text-4">
              Token spend and per-developer cost appear here as you and your
              agents work. Sign in to Aura Cloud to see the whole team&rsquo;s
              usage in one place.
            </span>
          </div>
        ) : (
          <div className="mx-auto flex max-w-[760px] flex-col gap-5 px-4 py-5">
            {heroMonth ? (
              <UsageHero
                monthLabel={monthLabel}
                monthTokensIn={heroMonth.tokensIn}
                monthTokensOut={heroMonth.tokensOut}
                monthCostUsd={heroMonth.costUsd}
                accumulatedTokens={accumulated?.tokens ?? 0}
                accumulatedCostUsd={accumulated?.costUsd ?? 0}
                accumulatedLabel="Total · all time"
                scopeNote={heroMonth.scopeNote}
              />
            ) : null}

            {trendPoints.length >= 2 ? (
              <CumulativeTrend points={trendPoints} caption="Usage over time" />
            ) : null}

            {modelSlices.length > 0 ? (
              <ModelSplitBar slices={modelSlices} caption="By AI model · this month" />
            ) : null}

            <TeamAgentUsage
              billing={billingMembers}
              cloudAvailable={cloudAvailable}
              localByModel={localByModel}
              scopeNote={agentScopeNote}
            />

            <TeamOverview
              roster={roster}
              billing={billingMembers}
              cloudAvailable={cloudAvailable}
              localDev={monthUsage?.byDeveloper ?? []}
              nowSecs={nowSecs}
            />
          </div>
        )}
      </div>
    </div>
  );
}
