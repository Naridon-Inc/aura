// The Code Map's toolbar: which view, what to search, which kinds of piece
// and which cluster to show, and rebuild/close. The same toolbar, search and
// filter menus the trace lists use, so the map is filtered the same way.

import { ChevronDown, Layers, RefreshCw, X } from "lucide-react";
import { Button } from "../../ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../ui/dropdown-menu";
import { Segment } from "../../ui/segment";
import { TraceFilterMenu, TraceSearch, TraceToolbar } from "../../ui/trace-page";
import { countLabel } from "./graphModel";
import type { GraphView } from "./useGraphView";

const KINDS: Array<[string, string]> = [
  ["file", "Files"],
  ["fn", "Functions"],
  ["class", "Classes"],
  ["type", "Types"],
];

export function GraphToolbar({ g, onClose }: { g: GraphView; onClose: () => void }) {
  const pieces = g.mode === "pieces";
  const view = g.view;
  const searching = g.search.trim().length > 0 || g.focusId !== null;
  const clusters = view?.stats.communities ?? 0;

  return (
    <TraceToolbar
      search={
        <div className="ui-graph-lead">
          <Segment
            size="xs"
            value={g.mode}
            onChange={g.setMode}
            ariaLabel="View"
            options={[
              { value: "features", label: "Features", title: "The map, in words" },
              { value: "pieces", label: "Pieces", title: "The raw symbol network" },
            ]}
          />
          {pieces && (
            <TraceSearch
              value={g.search}
              onChange={g.setSearch}
              label="Search the map"
              placeholder="Search for a piece or file"
            />
          )}
          {pieces && view && view.matched > 0 && (
            <span
              className="ui-trace-toolbar-meta"
              title={`${view.stats.symbols} pieces · ${view.stats.files} files · ${view.stats.communities} clusters · ${view.stats.gods} hubs · ${view.stats.surprises} unexpected links`}
            >
              {countLabel(view, searching)}
            </span>
          )}
        </div>
      }
    >
      {pieces && (
        <>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="ghost" aria-label="Kinds of piece">
                <Layers />
                {kindsLabel(g.kindFilter, g.includeDocs)}
                <ChevronDown />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {KINDS.map(([k, label]) => (
                <DropdownMenuCheckboxItem
                  key={k}
                  checked={g.kindFilter.has(k)}
                  onCheckedChange={() => g.toggleKind(k)}
                  onSelect={(e) => e.preventDefault()}
                >
                  {label}
                </DropdownMenuCheckboxItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuCheckboxItem
                checked={g.includeDocs}
                onCheckedChange={(v) => g.setIncludeDocs(v === true)}
                onSelect={(e) => e.preventDefault()}
              >
                Include docs
              </DropdownMenuCheckboxItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {clusters > 1 && (
            <TraceFilterMenu
              label="Cluster"
              align="end"
              value={g.communityFilter == null ? "all" : String(g.communityFilter)}
              options={[
                { value: "all", label: `All clusters (${clusters})` },
                ...Array.from({ length: clusters }, (_, i) => ({
                  value: String(i),
                  label: `Cluster ${i}`,
                })),
              ]}
              onChange={(v) => g.setCommunityFilter(v === "all" ? null : parseInt(v, 10))}
            />
          )}
          {g.focusId && (
            <Button
              size="sm"
              variant="secondary"
              title="Back to the overview"
              onClick={() => g.setFocusId(null)}
            >
              Focused: {g.graphNodeById.get(g.focusId)?.name ?? g.focusId}
              <X />
            </Button>
          )}
        </>
      )}
      <Button size="sm" variant="ghost" onClick={g.rebuild} disabled={g.building}>
        <RefreshCw />
        {g.building ? "Rebuilding…" : "Rebuild"}
      </Button>
      <Button
        size="icon-sm"
        variant="ghost"
        title="Close the code map"
        aria-label="Close the code map"
        onClick={onClose}
      >
        <X />
      </Button>
    </TraceToolbar>
  );
}

/** What the Kinds button says: every kind is "All kinds", one kind names
 *  itself, otherwise a count, with docs noted when they ride along. */
function kindsLabel(kinds: Set<string>, docs: boolean): string {
  const on = KINDS.filter(([k]) => kinds.has(k));
  const base =
    on.length === KINDS.length
      ? "All kinds"
      : on.length === 0
        ? "No kinds"
        : on.length === 1
          ? on[0][1]
          : `${on.length} kinds`;
  return docs ? `${base} + docs` : base;
}
