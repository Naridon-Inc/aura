// Trace, as a page.
//
// It was a set of workpane tabs: clicking "Project timeline" or "Code Map"
// added a tab to the same strip that holds your agents, your terminal and the
// file you were reading. That put a place in a row of documents. It also meant
// Trace showed you two switchers stacked — the tab you had just opened, and
// then Trace's own strip naming the same destination one line below it — plus
// a repo header above both, offering a branch menu and a review rail for a
// surface that is already about what happened to this repo.
//
// Workspaces, Mission Control and Aura are pages: they take the window, the
// chrome that frames a single repo's work comes off, and you leave by asking
// for somewhere else in the rail. Trace is the same kind of thing, so it is
// the same kind of surface. What is left above the content is one strip —
// TraceTabs — which is the switcher Trace actually needs.
//
// Nothing here is new: every body below is the component the workpane rendered.
// The only change is what frames them.

import type { JSX } from "react";

import { TraceTabs } from "./TraceTabs";
import { TraceToolSurface } from "./TraceToolSurface";
import type { TraceDest } from "./traceRoute";
import type { TraceKey } from "./traceDestinations";
import type { TraceActions } from "../AdeSidebar";
import { TraceSurface } from "../workpanes/TraceSurface";
import { IntentInspector } from "../workpanes/IntentInspector";
import { ProvenanceReplay } from "../workpanes/ProvenanceReplay";
import { ProvePane } from "../workpanes/ProvePane";
import { SemanticGraphPane } from "../workpanes/SemanticGraphPane";

/** Which strip entry lights for a destination.
 *
 *  `replay` and `prove` return null on purpose. Provenance opens from a
 *  session rather than the strip, and "Goals" on the strip hands a question to
 *  Aura instead of opening this pane — so in both cases nothing on the strip
 *  corresponds to what you are looking at, and lighting something would be a
 *  guess. */
function activeKeyFor(dest: TraceDest): TraceKey | null {
  switch (dest.kind) {
    case "sessions":
      return dest.view;
    case "inspector":
      return "intent";
    case "graph":
      return "codemap";
    case "tool":
      return dest.tool;
    default:
      return null;
  }
}

export function TracePage({
  repoRoot,
  dest,
  actions,
  onDest,
  onClose,
}: {
  /** The project Trace is reading — the shared place scope, NOT the folder the
   *  app has open. Trace's whole subject is what happened to a repo, so being
   *  pointed at the wrong one is the failure worth designing against, and the
   *  strip carries the switcher that moves it. */
  repoRoot: string;
  dest: TraceDest;
  /** The same handler bag the strip has always taken — one object, so the
   *  strip cannot drift from whatever else routes into Trace. */
  actions: TraceActions;
  /** Cross-links inside a destination (Overview → sessions, Overview → usage)
   *  move the page rather than opening a second one. */
  onDest: (next: TraceDest) => void;
  /** Leaving Trace. The bodies below each render their own close affordance;
   *  on a page that means "take me back to my work", not "drop a tab". */
  onClose: () => void;
}): JSX.Element {
  return (
    <div className="flex h-full min-h-0 flex-col bg-bg-content">
      <TraceTabs
        repoRoot={repoRoot}
        switchProject
        handlers={actions}
        activeKey={activeKeyFor(dest)}
        impactsCount={actions.impactsCount}
        busyKey={actions.busyKey}
      />
      <div className="min-h-0 flex-1">
        {dest.kind === "sessions" ? (
          <TraceSurface
            repoRoot={repoRoot}
            view={dest.view}
            onOpenView={(view) => onDest({ kind: "sessions", view })}
          />
        ) : dest.kind === "inspector" ? (
          <IntentInspector repoRoot={repoRoot} onClose={onClose} />
        ) : dest.kind === "replay" ? (
          <ProvenanceReplay repoRoot={repoRoot} onClose={onClose} />
        ) : dest.kind === "prove" ? (
          <ProvePane repoRoot={repoRoot} onClose={onClose} />
        ) : dest.kind === "graph" ? (
          <SemanticGraphPane repoRoot={repoRoot} onClose={onClose} />
        ) : (
          <TraceToolSurface
            tool={dest.tool}
            arg={dest.arg ?? null}
            repoRoot={repoRoot}
            onClose={onClose}
          />
        )}
      </div>
    </div>
  );
}
