// Trace surface (Trace v2) — the center-pane host for one Trace view.
//
// Each top-level view (Overview / My sessions / Team activity / Cost & usage)
// is now its OWN openable workpane tab; this component renders exactly the one
// view its tab carries (decoded from the pane id by WorkSurface and handed in
// as `view`). The old in-pane segmented toggle is gone — switching views is
// switching tabs. Cross-links inside a view (Overview → sessions / usage) open
// the sibling tab via `onOpenView`. Real data only throughout: Overview shows
// intent-log aggregates, My sessions the per-run list, detail renders purely
// from the chosen row.

import { useEffect, useState } from "react";
import { type IntentRow } from "../../lib/api";
import { type TraceView } from "../../lib/editorStore";
import { TEAM_ACTIVITY_ENABLED } from "../../lib/featureFlags";
import {
  OPEN_SESSION_DETAIL_EVENT,
  clearPendingSessionDetail,
  takePendingSessionDetail,
} from "../../lib/traceNav";
import { CostUsagePane } from "./CostUsagePane";
import { OverviewPane } from "./OverviewPane";
import { SessionsPane } from "./SessionsPane";
import { SessionDetailPane } from "./SessionDetailPane";
import { TeamActivityFeed } from "./TeamActivityFeed";
import { TraceWrapped } from "./TraceWrapped";

export function TraceSurface({
  repoRoot,
  view,
  onOpenView,
}: {
  repoRoot: string;
  view: TraceView;
  onOpenView: (view: TraceView) => void;
}) {
  const [selected, setSelected] = useState<IntentRow | null>(null);
  // "Year in review" rides as a local overlay layered over Overview — opening
  // and closing it never disturbs anything else, so Esc lands you right back
  // on the Overview tab underneath.
  const [wrapped, setWrapped] = useState(false);

  // Cross-surface "open this run's Session detail" (e.g. the Project Timeline
  // jumping from a moment to its full session). Two arrival paths:
  //   • live event — this surface is already mounted when the request fires;
  //   • pending cell — the request fired before this surface mounted (App was
  //     still opening the Sessions tab), so we drain it on mount.
  // Whichever resolves first clears the other so the row never opens twice.
  useEffect(() => {
    const pending = takePendingSessionDetail();
    if (pending) setSelected(pending);
    function onOpen(e: Event) {
      const row = (e as CustomEvent<{ row?: IntentRow }>).detail?.row;
      if (row) {
        clearPendingSessionDetail();
        setSelected(row);
      }
    }
    window.addEventListener(OPEN_SESSION_DETAIL_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_SESSION_DETAIL_EVENT, onOpen);
  }, []);

  // A drilled-in session opens as a proper focus surface (FullscreenOverlay
  // wizard, the same shell task / PR detail use) layered over the list, so its
  // Esc/close returns to the list underneath rather than swapping the pane out.
  return (
    <div className="h-full w-full flex flex-col bg-bg-content">
      <div className="flex-1 min-h-0">
        {view === "overview" ? (
          <OverviewPane
            repoRoot={repoRoot}
            onOpenSessions={() => onOpenView("sessions")}
            onOpenWrapped={() => setWrapped(true)}
            onOpenCostUsage={() => onOpenView("usage")}
          />
        ) : view === "team" && TEAM_ACTIVITY_ENABLED ? (
          <TeamActivityFeed repoRoot={repoRoot} onOpenSession={setSelected} />
        ) : view === "usage" ? (
          <CostUsagePane repoRoot={repoRoot} />
        ) : (
          <SessionsPane repoRoot={repoRoot} onOpenSession={setSelected} />
        )}
      </div>
      {wrapped ? (
        <TraceWrapped repoRoot={repoRoot} onClose={() => setWrapped(false)} />
      ) : null}
      {selected ? (
        <SessionDetailPane
          repoRoot={repoRoot}
          row={selected}
          onBack={() => setSelected(null)}
        />
      ) : null}
    </div>
  );
}
