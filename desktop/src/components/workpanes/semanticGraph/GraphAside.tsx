// The Code Map's details column: what the picked piece connects to, the
// hubs everything leans on, the links that cross clusters, and a chain
// between two pieces when one was asked for. The run detail's column, with
// its small tabs, so a piece is read the way a run is.

import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, ArrowRight, Crosshair, X } from "lucide-react";
import type { KgEdge, KgNode, KgPath } from "../../../lib/api";
import { AsciiSpinner } from "../../ui/ascii-spinner";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { TraceAside, TraceAsidePanel, TraceCaption, TraceNote } from "../../ui/trace-detail";
import { TraceMark } from "../../ui/trace-list";
import { communityColor, compactPath, type SelectedLink } from "./graphModel";

type AsideTab = "selection" | "hubs" | "unexpected" | "chain";

export function GraphAside({
  node,
  links,
  linkTotals,
  hubs,
  surprises,
  allNodes,
  path,
  pathBusy,
  onPick,
  onFocus,
  onClear,
  onExpand,
  onRunPath,
  onClearPath,
}: {
  node: KgNode | null;
  links: SelectedLink[];
  /** True whole-graph connection count from explain; null while loading. */
  linkTotals: number | null;
  hubs: KgNode[];
  surprises: KgEdge[];
  allNodes: KgNode[];
  path: KgPath | null;
  pathBusy: boolean;
  onPick: (id: string) => void;
  onFocus: () => void;
  onClear: () => void;
  onExpand?: () => void;
  onRunPath: (to: string) => void;
  onClearPath: () => void;
}) {
  const [tab, setTab] = useState<AsideTab>("selection");
  // A new pick, or a chain arriving, is what the reader just asked for, so
  // the column turns to it rather than leaving it a tab away.
  useEffect(() => {
    if (node) setTab("selection");
  }, [node?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (path) setTab("chain");
    else setTab((t) => (t === "chain" ? "selection" : t));
  }, [path]);

  const tabs = [
    { id: "selection" as const, label: "Selection" },
    { id: "hubs" as const, label: "Hubs", count: hubs.length },
    { id: "unexpected" as const, label: "Unexpected", count: surprises.length },
    ...(path ? [{ id: "chain" as const, label: "Chain" }] : []),
  ];

  return (
    <TraceAside label="Piece details" tabs={tabs} value={tab} onChange={setTab}>
      <TraceAsidePanel value="selection">
        <SelectionPanel
          node={node}
          links={links}
          linkTotals={linkTotals}
          pathBusy={pathBusy}
          onPick={onPick}
          onFocus={onFocus}
          onClear={onClear}
          onExpand={onExpand}
          onRunPath={onRunPath}
        />
      </TraceAsidePanel>
      <TraceAsidePanel value="hubs">
        {hubs.length === 0 ? (
          <TraceNote title="No hubs yet">Not enough connections here to form one.</TraceNote>
        ) : (
          <>
            <TraceCaption>Pieces lots of others depend on</TraceCaption>
            {hubs.map((n) => (
              <NodeRow key={n.id} node={n} trailing={n.degree} onPick={onPick} />
            ))}
          </>
        )}
      </TraceAsidePanel>
      <TraceAsidePanel value="unexpected">
        <SurprisesList edges={surprises} allNodes={allNodes} onPick={onPick} />
      </TraceAsidePanel>
      {path && (
        <TraceAsidePanel value="chain">
          <ChainList path={path} onPick={onPick} onClear={onClearPath} />
        </TraceAsidePanel>
      )}
    </TraceAside>
  );
}

function SelectionPanel({
  node,
  links,
  linkTotals,
  pathBusy,
  onPick,
  onFocus,
  onClear,
  onExpand,
  onRunPath,
}: {
  node: KgNode | null;
  links: SelectedLink[];
  linkTotals: number | null;
  pathBusy: boolean;
  onPick: (id: string) => void;
  onFocus: () => void;
  onClear: () => void;
  onExpand?: () => void;
  onRunPath: (to: string) => void;
}) {
  const [pathTo, setPathTo] = useState("");
  if (!node) {
    return (
      <TraceNote title="Nothing selected">
        Click a piece on the map to see what it connects to.
      </TraceNote>
    );
  }
  const total = linkTotals ?? node.degree;
  return (
    <>
      <div className="ui-graph-picked">
        <div className="ui-graph-picked-head">
          <span
            className="ui-graph-dot"
            style={{ background: communityColor(node.community_id) }}
            title="Colour groups pieces that work closely together"
          />
          <strong title={node.name}>{node.name}</strong>
          <Button variant="ghost" size="iconXs" type="button" title="Fit selection" aria-label="Fit selection" onClick={onFocus}>
            <Crosshair />
          </Button>
          <Button variant="ghost" size="iconXs" type="button" title="Clear selection" aria-label="Clear selection" onClick={onClear}>
            <X />
          </Button>
        </div>
        <p className="ui-graph-picked-where" title={node.file}>
          {node.kind} · {compactPath(node.file, node.line)}
        </p>
        {node.provenance === "checkpoint" && (
          <p
            className="ui-graph-picked-id"
            title="Canonical id — the same identity Aura's history, Atlas and rewind cite for this symbol"
          >
            {node.id}
          </p>
        )}
        <div className="ui-graph-picked-marks">
          <TraceMark title="How many other pieces connect to this one">
            {total} {total === 1 ? "link" : "links"}
          </TraceMark>
          {node.provenance === "checkpoint" && (
            <TraceMark tone="good" title="Verified identity — this piece is tracked in Aura's semantic history under the id shown above">
              tracked
            </TraceMark>
          )}
          {node.god && (
            <TraceMark tone="warn" title="A hub — lots of other pieces depend on this one, so changes here ripple wide">
              hub
            </TraceMark>
          )}
          {onExpand && (
            <Button variant="outline" size="xs" type="button" onClick={onExpand} title="Load this piece's neighbourhood into the map">
              Expand
            </Button>
          )}
        </div>
        <form
          className="ui-graph-path-form"
          onSubmit={(e) => {
            e.preventDefault();
            onRunPath(pathTo);
          }}
        >
          <Input
            size="small"
            value={pathTo}
            onChange={(e) => setPathTo(e.target.value)}
            placeholder="Find the path to another piece…"
            title="Find the shortest chain of links from this piece to another"
            aria-label="Path to another piece"
          />
          <Button variant="secondary" size="xs" type="submit" disabled={pathBusy || !pathTo.trim()}>
            {pathBusy ? <AsciiSpinner size={10} /> : "Go"}
          </Button>
        </form>
      </div>
      <TraceCaption>Connects to</TraceCaption>
      {links.length === 0 ? (
        <p className="ui-graph-empty">Nothing connects to this piece.</p>
      ) : (
        links.map(({ edge, other, direction }, i) => (
          <button
            key={`${edge.from}-${edge.to}-${i}`}
            type="button"
            className="ui-graph-row"
            onClick={() => onPick(other.id)}
            title={`${edge.kind} ${direction === "out" ? "to" : "from"} ${other.id}`}
          >
            <span className="ui-graph-row-head">
              {direction === "out" ? <ArrowRight /> : <ArrowLeft />}
              <span className="ui-graph-row-name">{other.name}</span>
              {edge.surprise && (
                <TraceMark tone="warn" title="An unexpected link — these two pieces sit in different clusters but still depend on each other">
                  unexpected
                </TraceMark>
              )}
            </span>
            <span className="ui-graph-row-sub">
              {edge.kind} · {other.kind} · {compactPath(other.file, other.line)}
            </span>
          </button>
        ))
      )}
    </>
  );
}

function NodeRow({
  node,
  trailing,
  lead,
  onPick,
}: {
  node: KgNode;
  trailing?: number;
  lead?: string;
  onPick: (id: string) => void;
}) {
  return (
    <button type="button" className="ui-graph-row" onClick={() => onPick(node.id)} title={node.id}>
      <span className="ui-graph-row-head">
        {lead && <span className="ui-graph-row-via">{lead}</span>}
        <span className="ui-graph-row-name">{node.name}</span>
        {trailing != null && <span className="ui-graph-row-count">{trailing}</span>}
      </span>
      <span className="ui-graph-row-sub">
        {node.kind} · {node.file}
        {node.line > 0 && `:${node.line}`}
      </span>
    </button>
  );
}

function SurprisesList({
  edges,
  allNodes,
  onPick,
}: {
  edges: KgEdge[];
  allNodes: KgNode[];
  onPick: (id: string) => void;
}) {
  const byId = useMemo(() => new Map(allNodes.map((n) => [n.id, n] as const)), [allNodes]);
  if (edges.length === 0) {
    return (
      <TraceNote title="Nothing unexpected">The clusters stay nicely separate.</TraceNote>
    );
  }
  return (
    <>
      <TraceCaption>Links that cross between clusters</TraceCaption>
      {edges.map((e, i) => {
        const a = byId.get(e.from);
        const b = byId.get(e.to);
        if (!a || !b) return null;
        return (
          <div key={i} className="ui-graph-row" data-static>
            <span className="ui-graph-row-head">
              <button type="button" className="ui-graph-row-link" onClick={() => onPick(a.id)}>
                {a.name}
              </button>
              <ArrowRight />
              <button type="button" className="ui-graph-row-link" onClick={() => onPick(b.id)}>
                {b.name}
              </button>
            </span>
            <span className="ui-graph-row-sub">
              {e.kind} · cluster {a.community_id} ↔ cluster {b.community_id}
            </span>
          </div>
        );
      })}
    </>
  );
}

function ChainList({
  path,
  onPick,
  onClear,
}: {
  path: KgPath;
  onPick: (id: string) => void;
  onClear: () => void;
}) {
  return (
    <>
      <TraceCaption
        trailing={
          <span className="ui-graph-chain-trailing">
            {path.found && (
              <span title="Confidence — the product of every link's confidence along the chain">
                {Math.round(path.confidence * 100)}%{!path.directed && " · either direction"}
              </span>
            )}
            <Button variant="ghost" size="iconXs" type="button" title="Dismiss this chain" aria-label="Dismiss this chain" onClick={onClear}>
              <X />
            </Button>
          </span>
        }
      >
        Connection chain
      </TraceCaption>
      {!path.found && (
        <p className="ui-graph-empty">No chain of links found between those two pieces.</p>
      )}
      {path.hops.map((hop, i) => (
        <NodeRow
          key={hop.node.id}
          node={hop.node}
          onPick={onPick}
          lead={
            i > 0
              ? `${hop.via_kind ?? "linked"}${
                  hop.via_confidence != null ? ` ${Math.round(hop.via_confidence * 100)}%` : ""
                } →`
              : undefined
          }
        />
      ))}
    </>
  );
}
