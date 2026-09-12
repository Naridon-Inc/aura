// Feature Map — the tree, drawn.
//
// Root, bus, area columns, feature blocks, flow rows and the in-place flow
// diagram all live in one <g> that the viewport transforms. Every shape
// takes its colour from the theme tokens so the map follows light mode
// and the accent packs; Aura green marks the selected path and the
// proved state, red marks a flow that a prover run said stops short.

import type { KgFlow } from "../../../lib/api";
import { flowStatus, statusCopy } from "./model";
import { type FlowGeom, type TreeLayout, T } from "./layout";
import { FlowDiagram } from "./FlowDiagram";

type Props = {
  tree: TreeLayout;
  diagram: FlowGeom | null;
  openFlow: KgFlow | null;
  projectName: string;
  totals: { features: number; symbols: number };
  builtAt: number;
  now: number;
  selectedStep: number | null;
  onFeature: (id: string) => void;
  onFeatureDrill: (path: string) => void;
  onFlow: (id: string) => void;
  onStep: (index: number) => void;
  onBranch: (file: string, line: number) => void;
};

const FONT = "var(--font-sans, ui-sans-serif, system-ui, sans-serif)";
const MONO = "var(--font-mono, ui-monospace, monospace)";

export function statusColor(status: ReturnType<typeof flowStatus>): string {
  switch (status) {
    case "proved":
      return "var(--color-green)";
    case "gap":
      return "var(--color-red)";
    case "seen":
      return "var(--color-amber)";
    default:
      return "var(--color-text-4)";
  }
}

export function MapSvg({
  tree,
  diagram,
  openFlow,
  projectName,
  totals,
  builtAt,
  now,
  selectedStep,
  onFeature,
  onFeatureDrill,
  onFlow,
  onStep,
  onBranch,
}: Props) {
  return (
    <g fontFamily={FONT} fontSize={12}>
      {/* connectors underneath everything */}
      <g fill="none" stroke="var(--color-line)" strokeWidth={1.25}>
        {tree.paths.map((d, i) => (
          <path key={i} d={d} />
        ))}
      </g>

      {/* root */}
      <g>
        <rect
          x={tree.root.x}
          y={tree.root.y}
          width={tree.root.w}
          height={tree.root.h}
          rx={6}
          fill="var(--color-bg-1)"
          stroke="var(--color-line)"
        />
        <text
          x={tree.root.x + 12}
          y={tree.root.y + 17}
          fill="var(--color-text-1)"
          fontWeight={600}
        >
          {clipText(projectName, 26)}
        </text>
        <text
          x={tree.root.x + 12}
          y={tree.root.y + 32}
          fill="var(--color-text-4)"
          fontSize={10.5}
        >
          {totals.features} features · {totals.symbols.toLocaleString()} pieces of code
        </text>
      </g>

      {/* area headers */}
      {tree.areas.map((a) => (
        <g key={a.area.id}>
          <rect
            x={a.x}
            y={a.y}
            width={a.w}
            height={a.h}
            rx={5}
            fill="var(--color-bg-2)"
            stroke="var(--color-line-soft)"
          />
          <text
            x={a.x + 10}
            y={a.y + 18}
            fill="var(--color-text-2)"
            fontSize={11}
            fontWeight={600}
            letterSpacing={0.4}
          >
            {clipText(a.area.name.toUpperCase(), 20)}
          </text>
        </g>
      ))}

      {/* feature blocks */}
      {tree.features.map((f) => {
        const n = f.feature.flows.length;
        const sub =
          n > 0
            ? `${n} ${n === 1 ? "flow" : "flows"}${f.feature.entries > n ? ` of ${f.feature.entries}` : ""}`
            : `${f.feature.files} files`;
        return (
          <g
            key={f.feature.id}
            className="cursor-pointer"
            onClick={() => onFeature(f.feature.id)}
            onDoubleClick={(e) => {
              e.stopPropagation();
              onFeatureDrill(f.feature.path);
            }}
          >
            <title>{f.feature.blurb ?? `Double-click to see the pieces inside ${f.feature.name}`}</title>
            <rect
              x={f.x}
              y={f.y}
              width={f.w}
              height={f.h}
              rx={6}
              fill={f.open ? "var(--color-state-selected)" : "var(--color-bg-1)"}
              stroke={f.open ? "var(--color-accent)" : "var(--color-line)"}
              strokeWidth={f.open ? 1.5 : 1}
            />
            <text
              x={f.x + 10}
              y={f.y + 17}
              fill="var(--color-text-1)"
              fontWeight={500}
            >
              {clipText(f.feature.name, 20)}
            </text>
            <text x={f.x + 10} y={f.y + 31} fill="var(--color-text-4)" fontSize={10.5}>
              {sub}
            </text>
            {n > 0 && (
              <text
                x={f.x + f.w - 10}
                y={f.y + 25}
                textAnchor="end"
                fill={f.open ? "var(--color-accent)" : "var(--color-text-5)"}
                fontSize={11}
              >
                {f.open ? "▾" : "▸"}
              </text>
            )}
          </g>
        );
      })}

      {/* flow rows under the open feature */}
      {tree.flowRows.map((r) => {
        const color = statusColor(r.status);
        return (
          <g key={r.flow.id} className="cursor-pointer" onClick={() => onFlow(r.flow.id)}>
            <title>{statusCopy(r.flow, builtAt, now)}</title>
            <rect
              x={r.x}
              y={r.y}
              width={r.w}
              height={r.h}
              rx={4}
              fill={r.open ? "var(--color-state-selected)" : "var(--color-bg-1)"}
              stroke={r.open ? "var(--color-accent)" : "var(--color-line-soft)"}
            />
            <circle cx={r.x + 10} cy={r.y + r.h / 2} r={3} fill={color} />
            <text
              x={r.x + 20}
              y={r.y + 16}
              fill={r.open ? "var(--color-text-1)" : "var(--color-text-2)"}
              fontSize={11.5}
            >
              {clipText(r.flow.name, 19)}
            </text>
          </g>
        );
      })}

      {/* the open flow, in place */}
      {diagram && openFlow && tree.diagramAt && (
        <g transform={`translate(${tree.diagramAt.x} ${tree.diagramAt.y})`}>
          <FlowDiagram
            geom={diagram}
            flow={openFlow}
            selectedStep={selectedStep}
            onStep={onStep}
            onBranch={onBranch}
            mono={MONO}
          />
        </g>
      )}
    </g>
  );
}

export function clipText(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}

// Keep the layout constants referenced so a future edit that drops a block
// still has the tree's scale in one place.
export const TREE_SCALE = T;
