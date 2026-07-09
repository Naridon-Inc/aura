// ContributionsScatter — the Overview centerpiece, modeled on entire.io's
// "Contributions over time" bubble chart but scoped to a single repo.
//
// HONESTY RULE (inherited from OverviewPane): every bubble is ONE real intent
// row. x = when it landed (calendar time across the span we actually have),
// y = local hour of day (a punchcard, so timing reads at a glance), bubble
// size = that row's real +/- churn, and color = the agent that authored it.
// Nothing is interpolated or invented — empty data renders nothing.
//
// Interactivity: the chart is mouse-tracked, not reliant on native SVG <title>
// (which renders slowly and unstyled inside the WKWebview). Hovering anywhere
// snaps to the nearest run and floats a Medusa-styled tooltip card explaining
// exactly what it is. The legend is a focus control — hover or click an agent
// to spotlight its runs and dim the rest. A one-line encoding key makes the
// punchcard self-explanatory.

import { useEffect, useMemo, useRef, useState } from "react";
import type { IntentRow } from "../../lib/api";
import { agentDisplayLabel, canonicalAgentId } from "../../lib/agentIdentity";
import { colorForName } from "../../lib/identityColors";
import { providerAccent, providerForModel } from "./usageProviders";

const KNOWN_AGENTS = new Set([
  "claude",
  "gemini",
  "codex",
  "cursor",
  "openai-compat",
]);

/** A stable color for an agent id. Known coding agents reuse their brand
 *  accent (so dots match the logos elsewhere); the Aura built-in agent uses
 *  the app accent; everyone else (humans) gets their deterministic identity
 *  color — the same hash used by the team chat avatars. */
function colorForAgent(agentId: string): string {
  const s = (agentId ?? "").toLowerCase().trim();
  if (s === "ai" || s.startsWith("ai@") || s.includes("aura")) {
    return "var(--color-accent)";
  }
  const prov = providerForModel(agentId);
  if (KNOWN_AGENTS.has(prov)) return providerAccent(prov);
  return colorForName(agentId || "unknown");
}

/** A friendly display name for an agent id — delegates to the shared registry
 *  so the legend agrees with the AgentBadge everywhere else ("MCP Agent" →
 *  "Claude Code", "gemini" → "Gemini CLI", a human handle → its local part). */
function agentName(agentId: string): string {
  return agentDisplayLabel(agentId);
}

/** Split a row's changeset into real additions / deletions (null-safe). */
function rowChurn(row: IntentRow): { adds: number; dels: number } {
  const files = row.changeset?.files ?? [];
  let adds = 0;
  let dels = 0;
  for (const f of files) {
    if (typeof f.additions === "number") adds += f.additions;
    if (typeof f.deletions === "number") dels += f.deletions;
  }
  return { adds, dels };
}

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function shortDate(d: Date): string {
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

function clock(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(
    d.getMinutes(),
  ).padStart(2, "0")}`;
}

/** Full, human-readable stamp for the tooltip header. */
function longStamp(d: Date): string {
  return `${shortDate(d)} · ${clock(d)}`;
}

type Dot = {
  key: string;
  /** Pixel x (calendar position). */
  cx: number;
  /** Pixel y (hour-of-day position). */
  cy: number;
  r: number;
  color: string;
  /** Canonical agent id — matches the legend focus key. */
  agentId: string;
  agentLabel: string;
  adds: number;
  dels: number;
  intent: string;
  intentType: string | null;
  signed: boolean;
  date: Date;
};

type Legend = { id: string; label: string; color: string; count: number };

const H = 196;
const PAD_L = 38;
const PAD_R = 12;
const PAD_T = 12;
const PAD_B = 22;
const HOURS = [0, 6, 12, 18, 24];
const HOUR_LABEL: Record<number, string> = {
  0: "00:00",
  6: "06:00",
  12: "12:00",
  18: "18:00",
  24: "24:00",
};

/** Contributions bubble chart for the populated Overview. `rows` is the same
 *  honest intent log the rest of the pane folds; we only read timestamp,
 *  agent_id, intent, intent_type, signature and changeset churn off each row.
 *  Renders null when there's nothing real to plot. */
export function ContributionsScatter({ rows }: { rows: IntentRow[] }) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [w, setW] = useState(0);
  // Index into the draw-ordered `dots` array that the cursor is nearest to.
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  // Cursor position in container space, for floating the tooltip.
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  // Legend focus: clicking pins an agent (spotlight its runs); hovering a
  // legend chip previews the same without committing. Hover wins for preview.
  const [pinnedAgent, setPinnedAgent] = useState<string | null>(null);
  const [hoverAgent, setHoverAgent] = useState<string | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    setW(el.clientWidth);
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setW(e.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const { rawPoints, minTs, maxTs, maxChurn, legend, xTicks } = useMemo(() => {
    const pts = rows
      .filter((r) => Number.isFinite(r.timestamp) && r.timestamp > 0)
      .map((r) => {
        const ms = r.timestamp * 1000;
        const d = new Date(ms);
        const id = canonicalAgentId((r.agent_id ?? "").trim()) || "unknown";
        const { adds, dels } = rowChurn(r);
        return {
          ts: ms,
          hour: d.getHours() + d.getMinutes() / 60,
          adds,
          dels,
          churn: adds + dels,
          agent: id,
          intent: (r.intent ?? "").trim(),
          intentType: (r.intent_type ?? "").trim() || null,
          signed: !!r.signed_block_id,
          date: d,
        };
      });

    if (pts.length === 0) {
      return {
        rawPoints: [] as typeof pts,
        minTs: 0,
        maxTs: 0,
        maxChurn: 0,
        legend: [] as Legend[],
        xTicks: [] as { ts: number; label: string }[],
      };
    }

    let lo = pts[0].ts;
    let hi = pts[0].ts;
    let maxC = 0;
    const counts = new Map<string, number>();
    for (const p of pts) {
      if (p.ts < lo) lo = p.ts;
      if (p.ts > hi) hi = p.ts;
      if (p.churn > maxC) maxC = p.churn;
      counts.set(p.agent, (counts.get(p.agent) ?? 0) + 1);
    }
    // A single-day span gets ±12h of breathing room so dots don't stack on
    // one vertical line.
    if (hi === lo) {
      lo -= 12 * 3_600_000;
      hi += 12 * 3_600_000;
    }

    const leg: Legend[] = [...counts.entries()]
      .map(([id, count]) => ({
        id,
        label: agentName(id),
        color: colorForAgent(id),
        count,
      }))
      .sort((a, b) => b.count - a.count);

    // 3 evenly spaced date ticks across the real span.
    const ticks: { ts: number; label: string }[] = [];
    const STEPS = 3;
    for (let i = 0; i < STEPS; i++) {
      const ts = lo + ((hi - lo) * i) / (STEPS - 1);
      ticks.push({ ts, label: shortDate(new Date(ts)) });
    }

    return {
      rawPoints: pts,
      minTs: lo,
      maxTs: hi,
      maxChurn: maxC,
      legend: leg,
      xTicks: ticks,
    };
  }, [rows]);

  const innerW = Math.max(0, w - PAD_L - PAD_R);
  const innerH = H - PAD_T - PAD_B;
  const span = maxTs - minTs || 1;

  // Pixel-space dots, drawn biggest-first so small runs stay legible on top.
  const dots: Dot[] = useMemo(() => {
    const xOf = (ts: number) =>
      PAD_L + (innerW > 0 ? ((ts - minTs) / span) * innerW : 0);
    const yOf = (hour: number) => PAD_T + innerH - (hour / 24) * innerH;
    const rOf = (churn: number) => {
      if (maxChurn <= 0) return 2.5;
      return 2.5 + Math.sqrt(Math.max(0, churn) / maxChurn) * 9;
    };
    return rawPoints
      .map((p, i) => ({
        key: `${p.ts}-${i}`,
        cx: xOf(p.ts),
        cy: yOf(p.hour),
        r: rOf(p.churn),
        color: colorForAgent(p.agent),
        agentId: p.agent,
        agentLabel: agentName(p.agent),
        adds: p.adds,
        dels: p.dels,
        intent: p.intent,
        intentType: p.intentType,
        signed: p.signed,
        date: p.date,
      }))
      .sort((a, b) => b.r - a.r);
  }, [rawPoints, innerW, innerH, span, minTs, maxChurn]);

  const yOfHour = (hour: number) => PAD_T + innerH - (hour / 24) * innerH;

  // The agent currently spotlit — legend hover previews, a pinned click holds.
  const focusAgent = hoverAgent ?? pinnedAgent;
  const hovered = hoverIdx != null ? dots[hoverIdx] ?? null : null;

  // Nearest-run hit test in pixel space. Tiny, overlapping dots are unhittable
  // with per-circle events, so we track the pointer over the whole plot and
  // snap to the closest run within a forgiving radius.
  function onMove(e: React.MouseEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < dots.length; i++) {
      const d = dots[i];
      // Respect the legend focus: a pinned/hovered agent makes only its runs
      // hittable, so the spotlight and the tooltip agree.
      if (focusAgent != null && d.agentId !== focusAgent) continue;
      const dx = mx - d.cx;
      const dy = my - d.cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const hit = Math.max(d.r + 5, 11);
      if (dist < hit && dist < bestD) {
        bestD = dist;
        best = i;
      }
    }
    setHoverIdx(best >= 0 ? best : null);
    setCursor({ x: mx, y: my });
  }

  function onLeave() {
    setHoverIdx(null);
    setCursor(null);
  }

  if (rawPoints.length === 0) return null;

  const visibleLegend = legend.slice(0, 6);
  const overflow = legend.length - visibleLegend.length;

  // Tooltip placement: flip to the cursor's left near the right edge, clamp
  // vertically so it never spills past the plot.
  const TT_W = 208;
  const ttLeft =
    cursor != null
      ? cursor.x + TT_W + 16 > w
        ? Math.max(6, cursor.x - TT_W - 12)
        : cursor.x + 14
      : 0;
  const ttTop = cursor != null ? Math.min(Math.max(6, cursor.y - 12), H - 96) : 0;

  return (
    <div className="rounded-lg border border-line-soft bg-bg-1 p-3">
      <div className="mb-0.5 flex items-baseline justify-between">
        <span className="text-[11px] uppercase tracking-wide text-text-4">
          Contributions · over time
        </span>
        <span className="font-mono text-[11px] text-text-4">
          {rawPoints.length} {rawPoints.length === 1 ? "run" : "runs"}
        </span>
      </div>
      {/* Self-explanatory encoding key — what the punchcard actually encodes. */}
      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] text-text-5">
        <span>each dot = one run</span>
        <span className="flex items-center gap-1">
          <span className="inline-flex items-end gap-px" aria-hidden>
            <span className="inline-block h-1 w-1 rounded-full bg-text-4" />
            <span className="inline-block h-2 w-2 rounded-full bg-text-4" />
          </span>
          size = lines changed
        </span>
        <span>height = time of day</span>
        <span>color = agent</span>
      </div>

      <div ref={wrapRef} className="relative w-full">
        {w > 0 ? (
          <svg
            width={w}
            height={H}
            viewBox={`0 0 ${w} ${H}`}
            role="img"
            aria-label="Contributions over time, colored by agent. Hover a run for details."
            onMouseMove={onMove}
            onMouseLeave={onLeave}
          >
            {/* Horizontal hour gridlines + y labels */}
            {HOURS.map((hr) => {
              const y = yOfHour(hr);
              return (
                <g key={`grid-${hr}`}>
                  <line
                    x1={PAD_L}
                    y1={y}
                    x2={w - PAD_R}
                    y2={y}
                    stroke="var(--color-line-soft)"
                    strokeWidth="1"
                    strokeOpacity={hr === 0 || hr === 24 ? 0.8 : 0.45}
                  />
                  <text
                    x={PAD_L - 6}
                    y={y + 3}
                    textAnchor="end"
                    fill="var(--color-text-4)"
                    style={{ fontSize: 9 }}
                  >
                    {HOUR_LABEL[hr]}
                  </text>
                </g>
              );
            })}

            {/* Vertical guide dropped from the hovered run to the time axis —
                helps read the punchcard hour off the y-grid. */}
            {hovered ? (
              <line
                x1={hovered.cx}
                y1={PAD_T}
                x2={hovered.cx}
                y2={H - PAD_B}
                stroke="var(--color-accent)"
                strokeWidth="1"
                strokeOpacity={0.28}
                strokeDasharray="2 3"
              />
            ) : null}

            {/* Bubbles — one per real intent row */}
            {dots.map((d, i) => {
              const dimmed = focusAgent != null && d.agentId !== focusAgent;
              const isHover = i === hoverIdx;
              return (
                <circle
                  key={d.key}
                  cx={d.cx}
                  cy={d.cy}
                  r={d.r}
                  fill={d.color}
                  fillOpacity={dimmed ? 0.1 : isHover ? 0.78 : 0.5}
                  stroke={d.color}
                  strokeWidth="1"
                  strokeOpacity={dimmed ? 0.18 : 0.85}
                  style={{ pointerEvents: "none" }}
                />
              );
            })}

            {/* Highlight ring for the hovered run, drawn on top. */}
            {hovered ? (
              <circle
                cx={hovered.cx}
                cy={hovered.cy}
                r={hovered.r + 3}
                fill="none"
                stroke="var(--color-text-1)"
                strokeWidth="1.4"
                strokeOpacity={0.9}
                style={{ pointerEvents: "none" }}
              />
            ) : null}

            {/* X date ticks */}
            {xTicks.map((t, i) => (
              <text
                key={`xt-${t.ts}`}
                x={PAD_L + (innerW > 0 ? ((t.ts - minTs) / span) * innerW : 0)}
                y={H - 6}
                textAnchor={
                  i === 0 ? "start" : i === xTicks.length - 1 ? "end" : "middle"
                }
                fill="var(--color-text-4)"
                style={{ fontSize: 9 }}
              >
                {t.label}
              </text>
            ))}
          </svg>
        ) : (
          <div style={{ height: H }} />
        )}

        {/* Floating tooltip — a Medusa-styled card, not a native <title>. */}
        {hovered && cursor ? (
          <div
            className="pointer-events-none absolute z-20 w-[208px] rounded-md border border-line-soft bg-bg-content p-2.5 shadow-sm"
            style={{ left: ttLeft, top: ttTop }}
          >
            <div className="flex items-center gap-1.5">
              <span
                className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ background: hovered.color }}
              />
              <span className="truncate text-[12px] font-medium text-text-1">
                {hovered.agentLabel}
              </span>
              {hovered.signed ? (
                <span
                  className="ml-auto shrink-0 text-text-4"
                  title="Sealed — a genuine, tamper-proof record of this change"
                  aria-label="Sealed — a genuine, tamper-proof record of this change"
                >
                  <MiniLock />
                </span>
              ) : null}
            </div>
            <div className="mt-1 text-[11px] tabular-nums text-text-4">
              {longStamp(hovered.date)}
            </div>
            <div className="mt-1.5 flex items-center gap-2 font-mono text-[11px]">
              <span className="text-accent-green">+{hovered.adds}</span>
              <span className="text-text-3">−{hovered.dels}</span>
              <span className="text-text-5">
                {hovered.adds + hovered.dels}{" "}
                {hovered.adds + hovered.dels === 1 ? "line" : "lines"}
              </span>
            </div>
            {hovered.intentType ? (
              <div className="mt-1.5">
                <span className="rounded border border-line-soft px-1.5 py-px text-[10px] text-text-3">
                  {hovered.intentType}
                </span>
              </div>
            ) : null}
            {hovered.intent ? (
              <div className="mt-1.5 line-clamp-2 text-[11px] leading-snug text-text-3">
                {hovered.intent}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* Agent legend — also a focus control. Hover previews, click pins a
          spotlight; clicking the pinned chip (or anywhere off it) clears. */}
      <div className="mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-1.5">
        {visibleLegend.map((l) => {
          const active = pinnedAgent === l.id;
          const dim = focusAgent != null && focusAgent !== l.id;
          return (
            <button
              key={l.id}
              type="button"
              onMouseEnter={() => setHoverAgent(l.id)}
              onMouseLeave={() =>
                setHoverAgent((cur) => (cur === l.id ? null : cur))
              }
              onClick={() =>
                setPinnedAgent((cur) => (cur === l.id ? null : l.id))
              }
              title={
                active
                  ? `Showing ${l.label} only — click to clear`
                  : `Spotlight ${l.label}`
              }
              className={`flex items-center gap-1.5 rounded px-1.5 py-0.5 text-[11px] transition-colors ${
                active
                  ? "bg-bg-2 text-text-1"
                  : "text-text-2 hover:bg-bg-2"
              } ${dim ? "opacity-45" : ""}`}
            >
              <span
                className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ background: l.color, opacity: 0.9 }}
              />
              <span>{l.label}</span>
              <span className="font-mono text-text-4">{l.count}</span>
            </button>
          );
        })}
        {overflow > 0 ? (
          <span className="px-1 text-[11px] text-text-4">+{overflow} more</span>
        ) : null}
      </div>
    </div>
  );
}

function MiniLock() {
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
