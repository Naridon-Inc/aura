//! Claude subscription usage ring — the user's rolling 5-hour + weekly
//! subscription usage, exactly as Claude Code reports it, read from the same
//! statusline data the Aura CLI shows (`~/.aura/usage/statusline.jsonl`).
//!
//! A compact circular ring (5-hour window is the primary outer fill, weekly is
//! a thinner inner arc); hover reveals the full breakdown (provider/model, 5h %,
//! weekly %, session cost, freshness). Nothing here is estimated — off-
//! subscription or idle, it simply doesn't render.
//!
//! Factored out of the old bottom-of-composer ChatUsageStrip so it can live in
//! the app footer (StatusBar) as one more compact chip without duplicating the
//! SVG ring code.

import { useEffect, useRef, useState } from "react";

import { api, type ClaudeUsageSnapshot } from "../../../lib/api";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../ui/tooltip";
import { relativeAgeFromDelta } from "../../../lib/relativeTime";
import { formatCost } from "../../../lib/money";
import { percentOf } from "../../../lib/percent";

/** How often to re-read the Claude usage snapshot. Cheap (a bounded tail read)
 *  and the windows move slowly, so a relaxed cadence is plenty. */
const POLL_MS = 20_000;

/** Warm a fill past ~75% (amber) and ~90% (red) — the same near-the-wall cue
 *  the context meter uses, so the whole readout reads consistently. Usage is a
 *  STATUS signal, so the calm base is a neutral status tone, never the arctic
 *  primary accent. */
function meterColor(pct: number): string {
  if (pct >= 90) return "var(--color-red)";
  if (pct >= 75) return "var(--color-amber)";
  return "var(--color-text-3)";
}

/** Geometry for the ring, shared by both arcs. Small viewBox + currentColor
 *  matches the app's other hand-rolled SVG glyphs. */
const RING_SIZE = 17;
const RING_VB = 20; // viewBox is square; stroke widths are in viewBox units.
const OUTER_R = 8; // 5-hour window arc.
const INNER_R = 5; // weekly arc, tucked inside.
const OUTER_W = 2.4;
const INNER_W = 1.6;
const TRACK_W = 1.4;

/** One arc of the ring, drawn from 12 o'clock clockwise to `pct` of a full
 *  turn. Renders a muted full-circle track behind it so an empty arc still
 *  reads as "0% used", not "missing". */
function RingArc({
  r,
  width,
  pct,
  color,
}: {
  r: number;
  width: number;
  pct: number | null;
  color: string;
}) {
  const c = RING_VB / 2;
  const circ = 2 * Math.PI * r;
  const clamped = pct == null ? 0 : Math.max(0, Math.min(100, pct));
  const dash = (clamped / 100) * circ;
  return (
    <>
      <circle
        cx={c}
        cy={c}
        r={r}
        fill="none"
        stroke="var(--color-line-soft)"
        strokeWidth={TRACK_W}
      />
      {pct != null && (
        <circle
          cx={c}
          cy={c}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={width}
          strokeLinecap="round"
          strokeDasharray={`${dash} ${circ - dash}`}
          strokeDashoffset={0}
          // Start the sweep at 12 o'clock and run it clockwise.
          transform={`rotate(-90 ${c} ${c})`}
          style={{
            transition:
              "stroke-dasharray var(--motion-fast), stroke var(--motion-fast)",
          }}
        />
      )}
    </>
  );
}

/** Compact circular usage ring: outer arc = 5-hour window, inner thinner arc =
 *  weekly. Primary figure (the larger of the two) is echoed as the ring's
 *  status color so the warning cue is visible without expanding. */
function UsageRing({
  five,
  seven,
}: {
  five: number | null;
  seven: number | null;
}) {
  const primary = Math.max(five ?? 0, seven ?? 0);
  return (
    <svg
      width={RING_SIZE}
      height={RING_SIZE}
      viewBox={`0 0 ${RING_VB} ${RING_VB}`}
      fill="none"
      aria-hidden
      className="flex-shrink-0"
    >
      <RingArc r={OUTER_R} width={OUTER_W} pct={five} color={meterColor(primary)} />
      <RingArc r={INNER_R} width={INNER_W} pct={seven} color={meterColor(primary)} />
    </svg>
  );
}

/** One label/value line inside the hover breakdown. */
function TipRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-xs leading-tight">
      <span className="section-label">
        {label}
      </span>
      <span className="text-text-1 tabular-nums">{value}</span>
    </div>
  );
}

/** Poll the Claude usage snapshot on a relaxed cadence; guarded so a slow read
 *  never overlaps the next tick. Returns the latest reading (or null). */
export function useClaudeUsage(): ClaudeUsageSnapshot | null {
  const [snap, setSnap] = useState<ClaudeUsageSnapshot | null>(null);
  const inFlight = useRef(false);
  useEffect(() => {
    let alive = true;
    async function poll() {
      if (inFlight.current) return;
      inFlight.current = true;
      try {
        const s = await api.claudeUsageSnapshot();
        if (alive) setSnap(s);
      } catch {
        // Best-effort peripheral signal — keep the last reading on error.
      } finally {
        inFlight.current = false;
      }
    }
    void poll();
    const id = window.setInterval(() => void poll(), POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, []);
  return snap;
}

/** "just now" / "3m ago" / "2h ago" for the reading's freshness. */
function ageLabel(secs: number): string {
  // One ladder for the whole app — see lib/relativeTime.
  return relativeAgeFromDelta(secs);
}

/** The ring + its hover breakdown. Renders nothing until the reading is fresh
 *  and carries at least one real percentage, so an idle / off-subscription user
 *  never sees an empty chip.
 *
 *  `variant="footer"` adapts the trigger to sit as one of the StatusBar's inset
 *  chips (the ~20px rounded hover cell), so the footer reads consistently with
 *  the version / strict / model chips around it. The default `"inline"` keeps
 *  the original bare-trigger look for any in-flow placement. */
export function ClaudeUsageRing({
  variant = "inline",
}: {
  variant?: "inline" | "footer";
}) {
  const snap = useClaudeUsage();

  const has5h = !!snap?.fresh && typeof snap.five_h_pct === "number";
  const has7d = !!snap?.fresh && typeof snap.seven_d_pct === "number";
  if (!snap || (!has5h && !has7d)) return null;

  const five = has5h ? snap.five_h_pct! : null;
  const seven = has7d ? snap.seven_d_pct! : null;

  const triggerClass =
    variant === "footer"
      ? "inline-flex items-center justify-center h-[20px] px-2 rounded-[6px] flex-none select-none cursor-default transition-colors hover:bg-state-hover"
      : "flex items-center select-none cursor-default opacity-80 hover:opacity-100 transition-opacity";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={triggerClass} aria-label="Claude subscription usage">
          <UsageRing five={five} seven={seven} />
        </span>
      </TooltipTrigger>
      <TooltipContent
        side="top"
        className="max-w-[240px] bg-bg-2 border border-line-soft text-text-1 shadow-lg"
      >
        <div className="section-label mb-1">
          {snap.model ? `Claude · ${snap.model}` : "Claude"}
        </div>
        <div className="flex flex-col gap-0.5">
          {has5h && (
            <TipRow label="5h window" value={`${percentOf(snap.five_h_pct! / 100)}%`} />
          )}
          {has7d && (
            <TipRow label="this week" value={`${percentOf(snap.seven_d_pct! / 100)}%`} />
          )}
          {typeof snap.cost_usd === "number" && (
            <TipRow label="session" value={formatCost(snap.cost_usd)} />
          )}
        </div>
        <div className="text-2xs text-text-5 mt-1.5">
          from Claude Code · {ageLabel(snap.age_secs)}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
