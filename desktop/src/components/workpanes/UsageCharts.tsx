// UsageCharts — the figures and charts at the head of Cost & usage.
//
// Three honest pieces, drawn as trace sections (a quiet caption, no box) and
// hand-rolled SVG (no chart deps — recharts is NOT installed):
//   1. UsageHero        — current-month tokens + cost, plus an
//                          "accumulated" (all-time local) figure, as the
//                          trace stats row.
//   2. CumulativeTrend  — a calm filled area line over the last N usage
//                          buckets (period-derived, real points only).
//   3. ModelSplitBar    — a single stacked bar splitting spend by provider,
//                          tinted with each provider's brand accent.
//
// Every number is passed in from the parent, which sourced it from real api
// calls (cloud billing or local usage report). Nothing is invented here.

import { useId, useMemo } from "react";
import { AgentIcon } from "../agent/AgentIcon";
import { TraceSection } from "../ui/trace-report";
import { TraceStat, TraceStats } from "../ui/trace-stats";
import {
  modelLabel,
  providerAccent,
  providerForModel,
} from "./usageProviders";
import { compactNumber } from "../../lib/compactNumber";
import { formatCost } from "../../lib/money";
import { percent } from "../../lib/percent";
import "../trace/usage.css";

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

/** The month's figures: tokens and cost this month, and the all-time total,
 *  under a caption that says whose numbers they are. */
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
    <TraceSection
      title={`Shared usage · ${monthLabel}`}
      trailing={scopeNote ? <span className="ui-usage-scope">{scopeNote}</span> : null}
    >
      <div className="ui-usage-stats">
        <TraceStats label={`Usage in ${monthLabel}`}>
          <TraceStat
            label="Tokens this month"
            sub={`${compactNumber(monthTokensIn)} in · ${compactNumber(monthTokensOut)} out`}
          >
            {compactNumber(monthTotal)}
          </TraceStat>
          <TraceStat label="Cost this month">{formatCost(monthCostUsd)}</TraceStat>
          <TraceStat label={accumulatedLabel} sub={formatCost(accumulatedCostUsd)}>
            {compactNumber(accumulatedTokens)}
          </TraceStat>
        </TraceStats>
      </div>
    </TraceSection>
  );
}

export type TrendPoint = { label: string; value: number };

/** A calm cumulative area-line over real points. Hand-rolled SVG in the page's
 *  own ink: a quiet stroke over a fill that fades to nothing. Renders nothing
 *  meaningful (a flat baseline) when there's only one point, and is omitted by
 *  the parent below 2 points. */
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
    <TraceSection
      title={caption}
      trailing={<span className="ui-usage-scope">{compactNumber(peak)} cumulative</span>}
    >
      <svg
        className="ui-usage-trend"
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        height={H}
        preserveAspectRatio="none"
        role="img"
        aria-label={caption}
      >
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--ui-muted-fg)" stopOpacity="0.22" />
            <stop offset="100%" stopColor="var(--ui-muted-fg)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {areaPath ? <path d={areaPath} fill={`url(#${gradId})`} /> : null}
        {linePath ? (
          <path
            d={linePath}
            fill="none"
            stroke="var(--ui-muted-fg)"
            strokeWidth="1.5"
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        ) : null}
      </svg>
      <div className="ui-usage-axis">
        <span>{points[0]?.label ?? ""}</span>
        <span>{points[points.length - 1]?.label ?? ""}</span>
      </div>
    </TraceSection>
  );
}

/** A single stacked horizontal bar splitting total spend across providers,
 *  each segment tinted with the provider's brand accent, over one row per
 *  model with its real AgentIcon logo, tokens, share and cost. */
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
    <TraceSection title={caption}>
      <div className="ui-usage-split" role="img" aria-label={caption}>
        {ranked.withTotal.map((s) => {
          const pct = ranked.grand > 0 ? (s.total / ranked.grand) * 100 : 0;
          if (pct <= 0) return null;
          return (
            <span
              key={s.key}
              title={`${s.label} · ${compactNumber(s.total)} tokens · ${formatCost(
                s.costUsd,
              )}`}
              style={{ width: `${pct}%`, background: providerAccent(s.providerId) }}
            />
          );
        })}
      </div>
      <div className="ui-usage-rows">
        {ranked.withTotal.map((s) => (
          <div key={`legend-${s.key}`} className="ui-usage-row">
            <AgentIcon agentId={s.providerId} size={14} />
            <span className="ui-usage-row-label">{modelLabel(s.label)}</span>
            <span className="ui-usage-num" data-tone="faint">
              {compactNumber(s.total)}
            </span>
            <span className="ui-usage-num" data-width="pct">
              {percent(s.total, ranked.grand)}%
            </span>
            <span className="ui-usage-num" data-width="cost">
              {formatCost(s.costUsd)}
            </span>
          </div>
        ))}
      </div>
    </TraceSection>
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
