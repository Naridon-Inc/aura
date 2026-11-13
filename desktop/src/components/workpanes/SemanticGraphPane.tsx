// The Code Map — the trace's view of how the project's pieces connect.
//
// Two views. Features is the map in words: places in the product and the
// flows between them. Pieces is the raw network of files and functions,
// drawn as a force-directed canvas (semanticGraph/GraphCanvas) beside the
// same details column a run opens with.
//
// The full graph never crosses IPC: the pane asks `aura_kg_view` for a
// capped, ranked subgraph (overview = top hubs, search = ranked matches and
// their neighbours, focus = a neighbourhood), so a huge repo costs one small
// payload instead of a freeze. Selection details come from `aura_kg_explain`
// and chains from `aura_kg_path`, both computed against the whole graph.
//
// Wrapped in `GraphErrorBoundary` so a malformed payload or a NaN position
// doesn't take the shell down with it.

import { useState } from "react";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { TraceDetail } from "../ui/trace-detail";
import "../ui/code-map.css";
import { FeatureMapView } from "./FeatureMapView";
import { GraphErrorBoundary } from "./GraphErrorBoundary";
import { GraphAside } from "./semanticGraph/GraphAside";
import { GraphCanvas } from "./semanticGraph/GraphCanvas";
import { GraphToolbar } from "./semanticGraph/GraphToolbar";
import { useGraphView } from "./semanticGraph/useGraphView";

type Props = { repoRoot: string; onClose: () => void };

export function SemanticGraphPane(props: Props) {
  const [resetKey, setResetKey] = useState(0);
  return (
    <GraphErrorBoundary onRetry={() => setResetKey((k) => k + 1)}>
      <SemanticGraphInner key={resetKey} {...props} />
    </GraphErrorBoundary>
  );
}

function SemanticGraphInner({ repoRoot, onClose }: Props) {
  const g = useGraphView(repoRoot);
  const { selectedNode, explain, selectedId } = g;

  return (
    <div className="ui-graph">
      <GraphToolbar g={g} onClose={onClose} />
      {g.err && <div className="ui-graph-error">{g.err}</div>}

      {g.mode === "features" ? (
        <div className="ui-graph-features">
          <FeatureMapView
            repoRoot={repoRoot}
            rebuildSignal={g.featureRebuild}
            onDrillDown={(q) => {
              g.setSelectedId(null);
              g.setFocusId(null);
              g.setSearch(q);
              g.setMode("pieces");
            }}
          />
        </div>
      ) : (
        <TraceDetail
          main={
            <div className="ui-graph-stage">
              {g.loading || g.building ? (
                <div className="ui-graph-loading">
                  <AsciiSpinner />
                  {g.building ? "Building the map…" : "Loading…"}
                </div>
              ) : g.view ? (
                <GraphCanvas
                  nodes={g.view.nodes}
                  edges={g.view.edges}
                  hoverId={g.hoverId}
                  selectedId={g.selectedId}
                  fitSelectionSignal={g.fitSelectionSignal}
                  onHover={g.setHoverId}
                  onSelect={g.selectNode}
                  onClearSelection={() => g.setSelectedId(null)}
                />
              ) : null}
            </div>
          }
          aside={
            <GraphAside
              node={selectedNode}
              links={g.selectedLinks}
              linkTotals={
                explain && explain.node.id === selectedId
                  ? explain.inbound_total + explain.outbound_total
                  : null
              }
              hubs={g.gods}
              surprises={g.surprises}
              allNodes={g.view?.nodes ?? []}
              path={g.pathResult}
              pathBusy={g.pathBusy}
              onPick={g.focusNode}
              onFocus={() => {
                if (selectedNode) g.focusNode(selectedNode.id);
              }}
              onClear={() => g.setSelectedId(null)}
              onExpand={selectedNode ? () => g.setFocusId(selectedNode.id) : undefined}
              onRunPath={g.runPath}
              onClearPath={() => g.setPathResult(null)}
            />
          }
        />
      )}
    </div>
  );
}
