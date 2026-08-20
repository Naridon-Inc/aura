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
import { Receipt } from "lucide-react";
import { Button } from "../ui/button";
import { EmptyState, LoadingState } from "../ui/state";
import {
  CumulativeTrend,
  ModelSplitBar,
  UsageHero,
  slicesFromLocalModels,
  type TrendPoint,
} from "./UsageCharts";
import { currentMonthKey, prettyMonth } from "./usageProviders";
import { fetchTeam } from "../../lib/teamCache";
import { fetchBillingUsage } from "../../lib/billingCache";

/** What the empty state may say about WHY it is empty.
 *
 *  This keyed off `billing` — the spend payload — and the catch that fills it
 *  does `setBilling(null)` for every failure mode there is. So a signed-in
 *  reader whose billing call timed out got "Sign in to Aura Cloud", directly
 *  under a comment saying that doing exactly that makes a reader "reasonably
 *  conclude the page is broken". Whether you are signed in is a different
 *  question with its own API (`cloud_auth_status`), and it is asked now.
 *
 *  `null` here means the sign-in check itself failed: the empty state only
 *  renders once `loading` is false, and `loading` clears after every task —
 *  the auth one included — has settled. So there is no "not yet" to confuse
 *  with "no"; there is only "yes", "no", and "we couldn't find out". */
export function spendFootnote(signedIn: boolean | null): string {
  if (signedIn === null)
    return "Aura couldn’t check your Aura Cloud connection just now. Reopen this tab to see the whole team’s spend.";
  return signedIn
    ? "You’re connected to Aura Cloud. Spend will appear here as your team runs agents."
    : "Sign in to Aura Cloud to see the whole team’s spend in one place.";
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
  /** Whether you're SIGNED IN — which is not the same question as whether a
   *  spend figure came back, and the footnote below used to answer it with the
   *  latter. `setBilling(null)` is what the catch does for every failure mode,
   *  so a signed-in reader whose billing call timed out was told to sign in.
   *  Null here means the auth check itself hasn't answered. */
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [monthUsage, setMonthUsage] = useState<UsageReport | null>(null);
  const [allUsage, setAllUsage] = useState<UsageReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const aliveRef = useRef(true);

  const load = useCallback(async () => {
    // Whether you're signed in is not a property of the open project, so this
    // one runs even when there isn't one — otherwise the no-project frame would
    // report a failed sign-in check that never ran.
    const authTask = (async () => {
      try {
        const st = await api.cloudAuthStatus();
        if (aliveRef.current) setSignedIn(st?.connected === true);
      } catch {
        if (aliveRef.current) setSignedIn(null);
      }
    })();

    if (!repoRoot) {
      setRoster([]);
      setBilling(null);
      setMonthUsage(null);
      setAllUsage(null);
      await authTask;
      if (aliveRef.current) setLoading(false);
      return;
    }
    setLoading(true);
    setNowMs(Date.now());

    // Each source is fetched in isolation so a single failure (no cloud auth,
    // no team manifest, usage CLI absent) degrades only its own card.
    const tasks: Promise<void>[] = [authTask];

    tasks.push(
      (async () => {
        try {
          const team = await fetchTeam(repoRoot);
          if (aliveRef.current) setRoster(team?.members ?? []);
        } catch {
          if (aliveRef.current) setRoster([]);
        }
      })(),
    );

    tasks.push(
      (async () => {
        try {
          const usage = await fetchBillingUsage();
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

  // Only models that actually burned something. `byModel` can carry a row per
  // configured model with every total at 0; charting those draws a split bar
  // with no width and — worse — counts as "there is usage here" downstream.
  const modelSlices = useMemo(
    () =>
      (monthUsage ? slicesFromLocalModels(monthUsage.byModel) : []).filter(
        (s) => s.tokensIn + s.tokensOut > 0 || s.costUsd > 0,
      ),
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

  // Something worth rendering = a NON-ZERO usage figure somewhere.
  //
  // This used to be satisfied by `roster.length > 0` (and by `heroMonth`, which
  // is non-null whenever a usage report exists even when every total in it is
  // 0). The roster is the git contributor list, so it is non-empty in any repo
  // that has ever been committed to — which made the empty state below
  // unreachable in practice and put a dashboard of zeros in its place: a $0
  // hero over six people each labelled "no usage". That reads as a broken page,
  // not as "nothing spent", and it contradicts this file's own honesty rule.
  //
  // Presence of a roster is not evidence of spend, so it is no longer counted.
  const spent = (n: number | undefined) => (n ?? 0) > 0;
  const hasAnything =
    (heroMonth != null &&
      (spent(heroMonth.tokensIn) ||
        spent(heroMonth.tokensOut) ||
        spent(heroMonth.costUsd))) ||
    (accumulated != null &&
      (spent(accumulated.tokens) || spent(accumulated.costUsd))) ||
    modelSlices.length > 0 ||
    billingMembers.some(
      (m) => spent(m.tokens_in) || spent(m.tokens_out) || spent(m.cost_usd),
    );

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg-content">
      {/* ── Header ─────────────────────────────────────────────────────
          Actions only. It used to open with "Cost & usage" in 18px and the
          project's name under it — the exact two words on the tab you clicked
          to get here, over the exact name in the window's breadcrumb. 56px
          spent telling the reader where they already know they are. */}
      <div className="flex shrink-0 items-center justify-end border-b border-line-soft px-4 py-1.5">
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
          <LoadingState label="Adding up what you’ve spent…" />
        ) : !hasAnything ? (
          <div className="flex h-full items-center justify-center">
            <EmptyState
              icon={Receipt}
              title="Nothing spent yet"
              body="Running an agent costs money. This is where you see how much (by month, and by who ran it) so it never turns into a surprise on the bill."
              // Only offer the sign-in when signing in is actually the missing
              // piece. Told to sign in while already signed in, a reader
              // reasonably concludes the page is broken — which is what this
              // did, because it asked the spend payload instead of the sign-in
              // check. See `spendFootnote`.
              footnote={spendFootnote(signedIn)}
            />
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
