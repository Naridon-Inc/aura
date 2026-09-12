// Feature Map — one flow, drawn in place.
//
// Trigger box → a spine of step boxes → bus → outcome. "Also calls" lean
// out to the right as small branch boxes so the reader sees where the
// path could have gone without the map pretending it went there. Every
// word comes from the payload: the step sentence, the where-label, the
// branch names, the outcome. Nothing is narrated.

import type { KgFlow } from "../../../lib/api";
import { whereLabel } from "./model";
import { G, type FlowGeom } from "./layout";
import { statusColor } from "./MapSvg";

type Props = {
  geom: FlowGeom;
  flow: KgFlow;
  selectedStep: number | null;
  onStep: (index: number) => void;
  onBranch: (file: string, line: number) => void;
  mono: string;
};

const ARROW_ID = "fm-arrow";

export function FlowDiagram({ geom, flow, selectedStep, onStep, onBranch, mono }: Props) {
  const status = geom.steps[0]?.status ?? "traced";
  const accent = statusColor(status);
  return (
    <g>
      <defs>
        <marker
          id={ARROW_ID}
          viewBox="0 0 8 8"
          refX={7}
          refY={4}
          markerWidth={7}
          markerHeight={7}
          orient="auto-start-reverse"
        >
          <path d="M0 0.5 L7 4 L0 7.5 Z" fill="var(--color-text-4)" />
        </marker>
      </defs>

      {/* paths */}
      <g fill="none" strokeWidth={1.25}>
        {geom.paths.map((p, i) => (
          <path
            key={i}
            d={p.d}
            stroke={p.kind === "branch" ? "var(--color-line)" : "var(--color-text-5)"}
            strokeDasharray={p.kind === "branch" ? "3 3" : undefined}
            markerEnd={p.kind === "spine" ? `url(#${ARROW_ID})` : undefined}
          />
        ))}
      </g>

      {/* trigger */}
      <g>
        <rect
          x={geom.trigger.x}
          y={geom.trigger.y}
          width={geom.trigger.w}
          height={geom.trigger.h}
          rx={13}
          fill="var(--color-bg-2)"
          stroke="var(--color-line)"
        />
        <rect
          x={geom.trigger.x + 4}
          y={geom.trigger.y + 4}
          width={badgeWidth(geom.trigger.badge)}
          height={geom.trigger.h - 8}
          rx={9}
          fill="var(--color-accent)"
          opacity={0.9}
        />
        <text
          x={geom.trigger.x + 4 + badgeWidth(geom.trigger.badge) / 2}
          y={geom.trigger.y + 17}
          textAnchor="middle"
          fill="var(--color-bg-0)"
          fontSize={10}
          fontWeight={600}
        >
          {geom.trigger.badge}
        </text>
        <text
          x={geom.trigger.x + 10 + badgeWidth(geom.trigger.badge)}
          y={geom.trigger.y + 17}
          fill="var(--color-text-1)"
          fontSize={11.5}
        >
          {clip(geom.trigger.text, 30)}
        </text>
      </g>

      {/* steps */}
      {geom.steps.map((s) => {
        const selected = selectedStep === s.index;
        const area = flowAreaHint(flow, s.step.feature);
        return (
          <g key={s.index} className="cursor-pointer" onClick={() => onStep(s.index)}>
            <rect
              x={s.x}
              y={s.y}
              width={s.w}
              height={s.h}
              rx={6}
              fill={selected ? "var(--color-state-selected)" : "var(--color-bg-1)"}
              stroke={selected ? "var(--color-accent)" : "var(--color-line)"}
              strokeWidth={selected ? 1.5 : 1}
            />
            <text
              x={s.x + 12}
              y={s.y + 12}
              fill="var(--color-text-5)"
              fontSize={10}
              fontFamily={mono}
            >
              {s.index + 1}
            </text>
            {s.lines.map((line, li) => (
              <text
                key={li}
                x={s.x + 28}
                y={s.y + 17 + li * 14}
                fill="var(--color-text-1)"
                fontSize={12}
              >
                {line}
              </text>
            ))}
            <text
              x={s.x + 28}
              y={s.y + s.h - 8}
              fill="var(--color-text-4)"
              fontSize={10}
            >
              {whereLabel(s.step.where, area)}
              {s.step.changed ? " · changed recently" : ""}
            </text>
            {s.step.changed && (
              <circle cx={s.x + s.w - 12} cy={s.y + 12} r={3} fill="var(--color-amber)" />
            )}
          </g>
        );
      })}

      {/* branches */}
      {geom.branches.map((b, i) => (
        <g
          key={i}
          className="cursor-pointer"
          onClick={(e) => {
            e.stopPropagation();
            onBranch(b.file, b.line);
          }}
        >
          <title>{`also calls ${b.label} — click to open ${b.file}:${b.line}`}</title>
          <rect
            x={b.x}
            y={b.y}
            width={b.w}
            height={b.h}
            rx={4}
            fill="var(--color-bg-0)"
            stroke="var(--color-line-soft)"
          />
          <text
            x={b.x + 8}
            y={b.y + 14}
            fill="var(--color-text-3)"
            fontSize={10.5}
            fontFamily={mono}
          >
            {b.label}
          </text>
        </g>
      ))}
      {[...geom.more.entries()].map(([stepIndex, n]) => {
        const last = geom.branches.filter((b) => b.stepIndex === stepIndex).pop();
        if (!last) return null;
        return (
          <text
            key={`more-${stepIndex}`}
            x={last.x + 8}
            y={last.y + last.h + 12}
            fill="var(--color-text-5)"
            fontSize={10}
          >
            +{n} more
          </text>
        );
      })}

      {/* outcomes */}
      {geom.outcomes.map((o, i) => {
        const goal = o.kind === "goal";
        const stroke = goal ? accent : "var(--color-line)";
        return (
          <g key={i}>
            <rect
              x={o.x}
              y={o.y}
              width={o.w}
              height={o.h}
              rx={6}
              fill="var(--color-bg-2)"
              stroke={stroke}
              strokeWidth={goal ? 1.5 : 1}
            />
            <text
              x={o.x + 10}
              y={o.y + 16}
              fill={goal ? accent : "var(--color-text-2)"}
              fontSize={10}
              fontWeight={600}
              letterSpacing={0.3}
            >
              {o.title.toUpperCase()}
            </text>
            <text x={o.x + 10} y={o.y + 31} fill="var(--color-text-1)" fontSize={11.5}>
              {clip(o.text, 24)}
            </text>
          </g>
        );
      })}
    </g>
  );
}

function badgeWidth(badge: string): number {
  return Math.max(30, badge.length * 6.2 + 12);
}

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}

/** The area hint for a step's where-label when it says "other": the
 *  step's own feature if it crossed into one, else the flow's. Feature
 *  ids read "area/feature", so the first segment is the area. */
function flowAreaHint(flow: KgFlow, stepFeature: string | null): string {
  const id = stepFeature ?? flow.feature;
  return id.split("/")[0] ?? "";
}

export const FLOW_SCALE = G;
