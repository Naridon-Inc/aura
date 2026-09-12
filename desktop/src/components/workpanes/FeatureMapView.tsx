// Feature Map — the human-readable landing view of the Code Map.
//
// One canvas, no sidebars. The project sits at the top, its areas hang
// off a bus as columns, each column stacks the features that live there,
// and clicking a feature unfolds the flows found inside it. Clicking a
// flow draws its story right there under the row — what set it off, the
// functions it runs through in order, where it lands — and clicking a
// step opens a card with the code's own comment, what else it calls, who
// changed it last, and the file:line that proves it.
//
// Everything on screen traces to a field the engine produced. Steps
// follow only resolved call edges; where a prover run exists the flow
// carries its verdict; where none exists the map says "traced", never
// "proved". Composition lives in ./featureMap — this file wires the
// pieces together and owns selection.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KgFlow } from "../../lib/api";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { Button } from "../ui/button";
import { StatusChip } from "../ui/statusChip";
import { layoutFlow, layoutTree, type FlowGeom } from "./featureMap/layout";
import { MapSvg } from "./featureMap/MapSvg";
import {
  buildModel,
  needsALook,
  relativeTime,
  tallyChips,
} from "./featureMap/model";
import { NeedsALookMenu } from "./featureMap/NeedsALookMenu";
import { openInEditor, StepCard } from "./featureMap/StepCard";
import { useFeatureMap } from "./featureMap/useFeatureMap";
import { useViewport } from "./featureMap/useViewport";

type Props = {
  repoRoot: string;
  /** Bumped by the pane's Rebuild button — forces a graph rebuild. */
  rebuildSignal: number;
  /** Switch to the pieces view, pre-searched to this fragment. */
  onDrillDown: (query: string) => void;
};

type Selection = {
  featureId: string | null;
  flowId: string | null;
  step: number | null;
};

const NONE: Selection = { featureId: null, flowId: null, step: null };

export function FeatureMapView({ repoRoot, rebuildSignal, onDrillDown }: Props) {
  const { features, flows, loading, building, error, reload } = useFeatureMap(
    repoRoot,
    rebuildSignal,
  );
  const host = useRef<HTMLDivElement | null>(null);
  const vp = useViewport(host);
  const [sel, setSel] = useState<Selection>(NONE);
  const now = useMemo(() => Math.floor(Date.now() / 1000), [features?.built_at]);

  const model = useMemo(
    () => (features ? buildModel(features, flows) : null),
    [features, flows],
  );
  const openFlow: KgFlow | null = sel.flowId ? (model?.flowById.get(sel.flowId) ?? null) : null;
  const diagram: FlowGeom | null = useMemo(
    () => (openFlow ? layoutFlow(openFlow) : null),
    [openFlow],
  );
  const tree = useMemo(
    () =>
      model
        ? layoutTree(model, { featureId: sel.featureId, flowId: sel.flowId }, diagram)
        : null,
    [model, sel.featureId, sel.flowId, diagram],
  );

  // Fit the whole tree the first time it lays out (and after a rebuild).
  const fitted = useRef<string | null>(null);
  useEffect(() => {
    if (!tree || !features) return;
    const key = `${features.head_sha}:${features.built_at}`;
    if (fitted.current === key) return;
    fitted.current = key;
    setSel(NONE);
    vp.fit(tree.width, tree.height);
  }, [tree, features, vp]);

  // When a flow opens, bring its diagram on screen.
  useEffect(() => {
    if (!tree?.diagramAt || !diagram) return;
    vp.centerOn(
      tree.diagramAt.x - 24,
      tree.diagramAt.y - 60,
      diagram.width + 48,
      diagram.height + 84,
    );
  }, [tree?.diagramAt?.x, tree?.diagramAt?.y, diagram, vp]);

  // Esc walks back out: card → flow → feature.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setSel((s) => {
        if (s.step !== null) return { ...s, step: null };
        if (s.flowId) return { ...s, flowId: null };
        if (s.featureId) return NONE;
        return s;
      });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const onFeature = useCallback((id: string) => {
    if (vp.wasDrag()) return;
    setSel((s) => (s.featureId === id ? NONE : { featureId: id, flowId: null, step: null }));
  }, [vp]);

  const onFlow = useCallback((id: string) => {
    if (vp.wasDrag()) return;
    setSel((s) => (s.flowId === id ? { ...s, flowId: null, step: null } : { ...s, flowId: id, step: null }));
  }, [vp]);

  const onStep = useCallback((index: number) => {
    if (vp.wasDrag()) return;
    setSel((s) => ({ ...s, step: s.step === index ? null : index }));
  }, [vp]);

  const openFlowById = useCallback((flow: KgFlow) => {
    setSel({ featureId: flow.feature, flowId: flow.id, step: null });
  }, []);

  const onBranch = useCallback(
    (file: string, line: number) => {
      if (vp.wasDrag()) return;
      openInEditor(repoRoot, file, line);
    },
    [repoRoot, vp],
  );

  const chips = useMemo(() => tallyChips(flows), [flows]);
  const look = useMemo(
    () => needsALook(flows?.flows ?? [], now, flows?.change_window_days ?? 14),
    [flows, now],
  );
  const featureName = useCallback(
    (id: string | null) => (id ? (model?.featureById.get(id)?.name ?? null) : null),
    [model],
  );
  const areaOf = useCallback(
    (id: string | null) => (id ? (model?.areaOf.get(id) ?? "") : ""),
    [model],
  );

  // Step-card anchor in host pixels: the step rect through the viewport.
  const anchor = useMemo(() => {
    if (sel.step === null || !diagram || !tree?.diagramAt) return null;
    const s = diagram.steps[sel.step];
    if (!s) return null;
    const { tx, ty, s: k } = vp.view;
    return {
      left: (tree.diagramAt.x + s.x) * k + tx,
      top: (tree.diagramAt.y + s.y) * k + ty,
      width: s.w * k,
      height: s.h * k,
    };
  }, [sel.step, diagram, tree?.diagramAt, vp.view]);

  const projectName = repoRoot.replace(/\/$/, "").split("/").pop() || "This project";

  if (loading && !features) {
    return (
      <div className="flex-1 min-h-0 flex items-center justify-center text-text-4 text-sm gap-2">
        <AsciiSpinner />
        <span>
          {building
            ? "Reading the whole project for the first time — this takes a minute…"
            : "Reading the code map…"}
        </span>
      </div>
    );
  }
  if (error && !features) {
    return (
      <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
        <span className="text-red text-sm max-w-md">{error}</span>
        <Button variant="secondary" size="sm" onClick={reload}>
          Try again
        </Button>
      </div>
    );
  }
  if (!features || !model || !tree) {
    return (
      <div className="flex-1 min-h-0 flex items-center justify-center text-text-4 text-sm">
        Nothing to map here yet.
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="h-8 shrink-0 flex items-center gap-2 px-3 border-b border-line-soft text-xs">
        {chips.map((c) => (
          <StatusChip key={c.key} tone={c.tone} dot={c.tone !== "neutral"} dense>
            {c.label}
          </StatusChip>
        ))}
        <span className="text-text-4 truncate">
          {features.features.length} features · {features.stats.symbols.toLocaleString()} pieces ·
          read {relativeTime(features.built_at, now)}
          {flows && flows.tally.seen === 0 && flows.flows.length > 0 ? " · every flow traced from the code" : ""}
        </span>
        <div className="ml-auto flex items-center gap-1">
          {flows && (
            <NeedsALookMenu
              items={look}
              now={now}
              featureName={(id) => featureName(id) ?? id}
              onPick={openFlowById}
            />
          )}
          <span className="w-px h-4 bg-line-soft mx-1" />
          <Button variant="ghost" size="icon" onClick={() => vp.zoomBy(1 / 1.2)} title="Zoom out">
            −
          </Button>
          <span className="text-text-4 tabular-nums w-9 text-center">
            {Math.round(vp.view.s * 100)}%
          </span>
          <Button variant="ghost" size="icon" onClick={() => vp.zoomBy(1.2)} title="Zoom in">
            +
          </Button>
          <Button
            variant="ghost"
            size="xs"
            onClick={() => vp.fit(tree.width, tree.height)}
            title="Fit the whole map"
          >
            Fit
          </Button>
        </div>
      </div>

      <div
        ref={host}
        className="relative flex-1 min-h-0 overflow-hidden bg-bg-0 select-none"
        style={{ cursor: vp.dragging ? "grabbing" : "grab" }}
      >
        <svg
          className="w-full h-full block"
          onPointerDown={vp.onPointerDown}
          onPointerMove={vp.onPointerMove}
          onPointerUp={vp.onPointerUp}
          onPointerCancel={vp.onPointerUp}
        >
          <g transform={`translate(${vp.view.tx} ${vp.view.ty}) scale(${vp.view.s})`}>
            <MapSvg
              tree={tree}
              diagram={diagram}
              openFlow={openFlow}
              projectName={projectName}
              totals={{ features: features.features.length, symbols: features.stats.symbols }}
              builtAt={features.built_at}
              now={now}
              selectedStep={sel.step}
              onFeature={onFeature}
              onFeatureDrill={onDrillDown}
              onFlow={onFlow}
              onStep={onStep}
              onBranch={onBranch}
            />
          </g>
        </svg>

        {openFlow && sel.step !== null && anchor && (
          <StepCard
            flow={openFlow}
            index={sel.step}
            anchor={anchor}
            now={now}
            repoRoot={repoRoot}
            areaOf={areaOf}
            featureName={featureName}
            onClose={() => setSel((s) => ({ ...s, step: null }))}
            onStep={(i) => setSel((s) => ({ ...s, step: i }))}
          />
        )}

        <div className="absolute bottom-2 left-1/2 -translate-x-1/2 pointer-events-none text-2xs text-text-4 bg-bg-1/85 border border-line-soft rounded px-2 py-0.5 whitespace-nowrap">
          {sel.flowId
            ? "Click a step to read it · ← → to move along · Esc to step back out"
            : sel.featureId
              ? "Click a flow to trace it · Esc to close the feature"
              : "Click a feature to see its flows · scroll to pan · ⌘-scroll to zoom · double-click a feature for its pieces"}
        </div>
      </div>
    </div>
  );
}
