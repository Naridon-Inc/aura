// UsageCharts — the "shared usage" hero for the Trace Overview team section.
//
// Three honest pieces, all hand-rolled SVG (no chart deps — recharts is NOT
// installed) and matched to OverviewPane's bar/opacity/sparkline aesthetic:
//   1. UsageHero        — big current-month tokens + cost, plus an
//                          "accumulated" (all-time local) figure.
//   2. CumulativeTrend  — a calm filled area line over the last N usage
//                          buckets (period-derived, real points only).
//   3. ModelSplitBar    — a single stacked bar splitting spend by provider,
//                          tinted with each provider's brand accent.
//
// Every number is passed in from the parent, which sourced it from real api
// calls (cloud billing or local usage report). Nothing is invented here.

import { useId, useMemo } from "react";
import { AgentIcon } from "../agent/AgentIcon";
import {
  fmtCost,
  fmtTokens,
  modelLabel,
  providerAccent,
  providerForModel,
} from "./usageProviders";

export type ModelSlice = {
  /** Raw model id (local) or provider+model (cloud) — used for keys. */
  key: string;
  /** Canonical provider id for the logo + accent. */
  providerId: string;
  /** Human label shown in the legend. */
  label: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
};

/** One stat in the hero — a big value over a dim uppercase caption, with an
 *  optional secondary line. Mirrors OverviewPane's StatCard rhythm but sized
 *  up for the hero. */
function HeroStat({
  caption,
  value,
  sub,
  accent,
}: {
  caption: string;
  value: string;
  sub?: string;
  accent?: string;
}) {
  return (
    <div className="flex flex-col">
      <div className="text-[11px] uppercase tracking-wide text-text-4">
        {caption}
      </div>
      <div
        className="mt-1.5 text-[28px] font-semibold leading-none"
        style={{ color: accent ?? "var(--color-text-1)" }}
      >
        {value}
      </div>
      {sub ? (
        <div className="mt-1.5 text-[12px] text-text-3">{sub}</div>
      ) : null}
    </div>
  );
}

/** The shared-usage hero card: current-month tokens + cost (big), an
 *  accumulated all-time figure, and the source/scope caption. */
export function UsageHero({
  monthLabel,
  monthTokensIn,
  monthTokensOut,
  monthCostUsd,
  accumulatedTokens,
  accumulatedCostUsd,
  accumulatedLabel,
  scopeNote,
}: {
  monthLabel: string;
  monthTokensIn: number;
  monthTokensOut: number;
  monthCostUsd: number;
  accumulatedTokens: number;
  accumulatedCostUsd: number;
  accumulatedLabel: string;
  scopeNote?: string | null;
}) {
  const monthTotal = monthTokensIn + monthTokensOut;
  return (
    <div className="rounded-lg border border-line-soft bg-bg-1 p-3">
      <div className="mb-3 flex items-baseline justify-between">
        <span className="text-[11px] uppercase tracking-wide text-text-4">
          Shared usage · {monthLabel}
        </span>
        {scopeNote ? (
          <span className="text-[11px] text-text-4">{scopeNote}</span>
        ) : null}
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <HeroStat
          caption="This month · tokens"
          value={fmtTokens(monthTotal)}
          sub={`${fmtTokens(monthTokensIn)} in · ${fmtTokens(monthTokensOut)} out`}
        />
        <HeroStat
          caption="This month · cost"
          value={fmtCost(monthCostUsd)}
          accent="var(--color-accent)"
        />
        <HeroStat
          caption={accumulatedLabel}
          value={fmtTokens(accumulatedTokens)}
          sub={fmtCost(accumulatedCostUsd)}
        />
      </div>
    </div>
  );
}

export type TrendPoint = { label: string; value: number };

/** A calm cumulative area-line over real points. Hand-rolled SVG; the fill
 *  uses the accent at low opacity like the activity strip, the stroke is the
 *  accent at full opacity. Renders nothing meaningful (a flat baseline) when
 *  there's only one point, and is omitted by the parent below 2 points. */
export function CumulativeTrend({
  points,
  caption,
}: {
  points: TrendPoint[];
  caption: string;
}) {
  const gradId = useId();
  const W = 640;
  const H = 96;
  const PAD_X = 4;
  const PAD_Y = 8;

  const { linePath, areaPath, peak } = useMemo(() => {
    const n = points.length;
    if (n === 0) {
      return { linePath: "", areaPath: "", peak: 0 };
    }
    // Build a running cumulative series so the line only ever rises — the
    // "cumulative" promise. Each point's value is its incremental spend.
    let running = 0;
    const cum = points.map((p) => {
      running += Math.max(0, p.value);
      return running;
    });
    const max = cum[cum.length - 1] || 1;
    const innerW = W - PAD_X * 2;
    const innerH = H - PAD_Y * 2;
    const stepX = n > 1 ? innerW / (n - 1) : 0;
    const xy = cum.map((v, i) => {
      const x = PAD_X + (n > 1 ? i * stepX : innerW / 2);
      const y = PAD_Y + innerH - (v / max) * innerH;
      return [x, y] as const;
    });
    const line = xy
      .map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`)
      .join(" ");
    const firstX = xy[0][0];
    const lastX = xy[xy.length - 1][0];
    const baseY = PAD_Y + innerH;
    const area = `${line} L${lastX.toFixed(1)},${baseY.toFixed(1)} L${firstX.toFixed(
      1,
    )},${baseY.toFixed(1)} Z`;
    return { linePath: line, areaPath: area, peak: max };
  }, [points]);

  if (points.length === 0) return null;

  return (
    <div className="rounded-lg border border-line-soft bg-bg-1 p-3">
      <div className="mb-2 flex items-baseline justify-between">
        <span className="text-[11px] uppercase tracking-wide text-text-4">
          {caption}
        </span>
        <span className="font-mono text-[11px] text-text-4">
          {fmtTokens(peak)} cumulative
        </span>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        height={H}
        preserveAspectRatio="none"
        role="img"
        aria-label={caption}
      >
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop
              offset="0%"
              stopColor="var(--color-accent)"
              stopOpacity="0.28"
            />
            <stop
              offset="100%"
              stopColor="var(--color-accent)"
              stopOpacity="0.02"
            />
          </linearGradient>
        </defs>
        {areaPath ? <path d={areaPath} fill={`url(#${gradId})`} /> : null}
        {linePath ? (
          <path
            d={linePath}
            fill="none"
            stroke="var(--color-accent)"
            strokeWidth="1.5"
            strokeOpacity="0.9"
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        ) : null}
      </svg>
      <div className="mt-1.5 flex items-center justify-between text-[11px] text-text-4">
        <span>{points[0]?.label ?? ""}</span>
        <span>{points[points.length - 1]?.label ?? ""}</span>
      </div>
    </div>
  );
}

/** A single stacked horizontal bar splitting total spend across providers,
 *  each segment tinted with the provider's brand accent, plus a legend with
 *  the real AgentIcon logo per provider. Calm: segments sit at 0.85 opacity
 *  like the by-agent bars. */
export function ModelSplitBar({
  slices,
  caption,
}: {
  slices: ModelSlice[];
  caption: string;
}) {
  const ranked = useMemo(() => {
    const withTotal = slices
      .map((s) => ({ ...s, total: s.tokensIn + s.tokensOut }))
      .filter((s) => s.total > 0 || s.costUsd > 0)
      .sort((a, b) => b.total - a.total);
    const grand = withTotal.reduce((sum, s) => sum + s.total, 0);
    return { withTotal, grand };
  }, [slices]);

  if (ranked.withTotal.length === 0) return null;

  return (
    <div className="rounded-lg border border-line-soft bg-bg-1 p-3">
      <div className="mb-2.5 text-[11px] uppercase tracking-wide text-text-4">
        {caption}
      </div>
      <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-bg-2">
        {ranked.withTotal.map((s) => {
          const pct = ranked.grand > 0 ? (s.total / ranked.grand) * 100 : 0;
          if (pct <= 0) return null;
          return (
            <span
              key={s.key}
              className="block h-full"
              title={`${s.label} · ${fmtTokens(s.total)} tokens · ${fmtCost(
                s.costUsd,
              )}`}
              style={{
                width: `${pct}%`,
                background: providerAccent(s.providerId),
                opacity: 0.85,
              }}
            />
          );
        })}
      </div>
      <div className="mt-3 flex flex-col gap-1.5">
        {ranked.withTotal.map((s) => {
          const pct = ranked.grand > 0 ? (s.total / ranked.grand) * 100 : 0;
          return (
            <div
              key={`legend-${s.key}`}
              className="flex items-center gap-2 text-[12px]"
            >
              <AgentIcon agentId={s.providerId} size={14} />
              <span className="min-w-0 flex-1 truncate text-text-2">
                {modelLabel(s.label)}
              </span>
              <span className="shrink-0 font-mono text-[11px] text-text-4">
                {fmtTokens(s.total)}
              </span>
              <span className="w-9 shrink-0 text-right font-mono text-[11px] text-text-3">
                {pct.toFixed(0)}%
              </span>
              <span className="w-14 shrink-0 text-right font-mono text-[11px] text-text-3">
                {fmtCost(s.costUsd)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Build ModelSlices from a local usage report's byModel array. Exported so
 *  the parent can reuse the canonical providerForModel mapping. */
export function slicesFromLocalModels(
  byModel: { model: string; inputTokens: number; outputTokens: number; costUsd: number }[],
): ModelSlice[] {
  return byModel.map((m) => ({
    key: m.model,
    providerId: providerForModel(m.model),
    label: m.model,
    tokensIn: m.inputTokens,
    tokensOut: m.outputTokens,
    costUsd: m.costUsd,
  }));
}
