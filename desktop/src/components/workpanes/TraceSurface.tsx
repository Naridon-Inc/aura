// Trace surface — the center-pane host for one Trace view.
//
// Each top-level view (Overview / My sessions / Team activity / Cost & usage)
// is its own workpane tab; this renders the one view its tab carries.
// Switching views is switching tabs, and cross-links inside a view (Overview
// → every session, cost & usage) open the sibling tab via `onOpenView`.
//
// Every view is the same story column: moments newest first, one line of
// facts under each. Opening a moment puts that session's story in the page's
// place; Back returns to the same view with the same moment still marked. A
// link in the story opens the session's deep view on the part it names (the
// conversation, a file's changes, the seal), and its Back returns to the
// story. Each step keeps the one under it mounted and hidden, so going back
// lands on the same scroll, filter and focus the reader left.
//
// Cost & usage has no cell of its own on the Trace strip. Spend is a reading
// of the runs rather than a fifth subject, so the views carry the door into it
// and the pane carries the way back.

import { useCallback, useEffect, useRef, useState } from "react";
import { type IntentRow } from "../../lib/api";
import { type TraceView } from "../../lib/editorStore";
import { captureFocus } from "../../lib/focusReturn";
import { TEAM_ACTIVITY_ENABLED } from "../../lib/featureFlags";
import {
  OPEN_SESSION_DETAIL_EVENT,
  clearPendingSessionDetail,
  takePendingSessionDetail,
} from "../../lib/traceNav";
import { CostUsagePane } from "./CostUsagePane";
import { momentKey } from "../trace/story/StoryDays";
import { SessionStory } from "../trace/story/SessionStory";
import { OverviewPane } from "./OverviewPane";
import { SessionsPane } from "./SessionsPane";
import { SessionDetailPane, type SessionDetailView } from "./SessionDetailPane";
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
  // The moment last opened stays marked after Back, so the reader sees which
  // row they just read and ↑/↓ carries on from it.
  const [lastOpened, setLastOpened] = useState<string | null>(null);
  // The deep view under the story: which part of the session, and the file.
  const [deep, setDeep] = useState<{ view: SessionDetailView; file?: string } | null>(null);
  // Focus is remembered as each step opens, while what was pressed is still
  // on screen, and handed back when that step closes.
  const listFocus = useRef<() => void>(() => {});
  const storyFocus = useRef<() => void>(() => {});
  const openSession = useCallback((row: IntentRow) => {
    listFocus.current = captureFocus(document.activeElement, document.body);
    setLastOpened(momentKey(row));
    setDeep(null);
    setSelected(row);
  }, []);
  const openDeep = useCallback((view: SessionDetailView, file?: string) => {
    storyFocus.current = captureFocus(document.activeElement, document.body);
    setDeep({ view, file });
  }, []);
  // "Year in review" rides as a local overlay layered over Overview — opening
  // and closing it never disturbs anything else, so Esc lands you right back
  // on the Overview tab underneath.
  const [wrapped, setWrapped] = useState(false);

  // Cross-surface "open this run's Session detail" — a session deep link that
  // App has already resolved to a row. Two arrival paths:
  //   • live event — this surface is already mounted when the request fires;
  //   • pending cell — the request fired before this surface mounted (App was
  //     still opening the Sessions tab), so we drain it on mount.
  // Whichever resolves first clears the other so the row never opens twice.
  useEffect(() => {
    const pending = takePendingSessionDetail();
    if (pending) openSession(pending);
    function onOpen(e: Event) {
      const row = (e as CustomEvent<{ row?: IntentRow }>).detail?.row;
      if (row) {
        clearPendingSessionDetail();
        openSession(row);
      }
    }
    window.addEventListener(OPEN_SESSION_DETAIL_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_SESSION_DETAIL_EVENT, onOpen);
  }, [openSession]);

  const closeDetail = useCallback(() => {
    setDeep(null);
    setSelected(null);
  }, []);
  const closeDeep = useCallback(() => setDeep(null), []);
  useEffect(() => {
    if (selected) return;
    listFocus.current();
    listFocus.current = () => {};
  }, [selected]);
  useEffect(() => {
    if (deep) return;
    storyFocus.current();
    storyFocus.current = () => {};
  }, [deep]);

  return (
    <div className="ui-trace-page-body">
      <div className="ui-trace-page-body" hidden={!!selected}>
        {view === "overview" ? (
          <OverviewPane
            repoRoot={repoRoot}
            activeKey={lastOpened}
            onOpenSessions={() => onOpenView("sessions")}
            // A moment opens in place of the page rather than switching tabs,
            // so Back puts the reader exactly where they were reading.
            onOpenSession={openSession}
            onOpenWrapped={() => setWrapped(true)}
            onOpenCostUsage={() => onOpenView("usage")}
          />
        ) : view === "team" && TEAM_ACTIVITY_ENABLED ? (
          <TeamActivityFeed repoRoot={repoRoot} activeKey={lastOpened} onOpenSession={openSession} />
        ) : view === "usage" ? (
          <CostUsagePane
            repoRoot={repoRoot}
            onBack={() => onOpenView("sessions")}
          />
        ) : (
          <SessionsPane
            repoRoot={repoRoot}
            activeKey={lastOpened}
            onOpenSession={openSession}
            onOpenCostUsage={() => onOpenView("usage")}
          />
        )}
      </div>
      {wrapped ? (
        <TraceWrapped repoRoot={repoRoot} onClose={() => setWrapped(false)} />
      ) : null}
      {selected ? (
        <div className="ui-trace-page-body" hidden={!!deep}>
          <SessionStory
            key={momentKey(selected)}
            repoRoot={repoRoot}
            row={selected}
            paused={!!deep}
            onBack={closeDetail}
            onOpenDeep={openDeep}
          />
        </div>
      ) : null}
      {selected && deep ? (
        <SessionDetailPane
          inline
          repoRoot={repoRoot}
          row={selected}
          initialTab={deep.view}
          initialFile={deep.file ?? null}
          onBack={closeDeep}
        />
      ) : null}
    </div>
  );
}
