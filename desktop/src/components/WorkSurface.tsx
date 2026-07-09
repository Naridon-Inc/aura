// The big middle pane when files are open: tabs across the top, editor
// below. A toggle in the toolbar swaps the editor for a side-by-side
// diff against HEAD. ⌘S saves the active tab. Empty state (no tabs) is
// rendered by the parent — this component only fires when at least one
// file is open.

import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Tabs } from "./Tabs";
import { MonacoEditor as Editor } from "./MonacoEditor";
import { DiffView } from "./DiffView";
import { EditorBreadcrumbs } from "./EditorBreadcrumbs";
import { MarkdownView } from "./MarkdownView";
import { SegmentedControl } from "./ui/segmented";
import { Input } from "./ui/input";
import { FileInsightStrip } from "./FileInsightStrip";
import { AgentSurface, buildAgentTabMenuItems } from "./agent/AgentSurface";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from "./ui/context-menu";
import { ManagerSurface, buildManagerTabMenuItems } from "./manager/ManagerSurface";
import { ManagerDashboardSurface } from "./manager/ManagerDashboardSurface";
import { WorkSurfaceEmpty } from "./workpanes/WorkSurfaceEmpty";
import { Terminal } from "./Terminal";
import { IntentInspector } from "./workpanes/IntentInspector";
import { ProvenanceReplay } from "./workpanes/ProvenanceReplay";
import { PlanBuilderSurface } from "./workpanes/PlanBuilderSurface";
import { ProvePane } from "./workpanes/ProvePane";
import { SemanticGraphPane } from "./workpanes/SemanticGraphPane";
import { InboxPane } from "./workpanes/InboxPane";
import { TraceSurface } from "./workpanes/TraceSurface";
import { PlanTab } from "./workpanes/PlanTab";
import { PlanMarkdownTab } from "./workpanes/PlanMarkdownTab";
import { EmptyPanePicker } from "./EmptyPanePicker";
import {
  AURA_MANAGER_ENABLED,
  COMMONS_ENABLED,
  MEMORY_SURFACE_ENABLED,
} from "../lib/featureFlags";
import { TasksBoard } from "./TasksBoard";
import { openPopout } from "../lib/popout";
import { TaskDetailPane } from "./tasks/TaskDetailPane";
import { StandupView } from "./standup/StandupView";
import { AutomationsSurface } from "./automations/AutomationsSurface";
import { CommonsSurface } from "./commons/CommonsSurface";
import { AppPaneSurface } from "./plugins/AppPaneSurface";
import { TeamSurface } from "./team/TeamSurface";
import { ScreenshareTab } from "./chat/ScreenshareTab";
import { PagesSurface } from "./pages2/PagesSurface";
import { ReviewDialog } from "./dialogs/ReviewDialog";
import { TimeMachinePane } from "./workpanes/TimeMachinePane";
import { AttestationsDialog } from "./dialogs/AttestationsDialog";
import { DoctorDialog } from "./dialogs/DoctorDialog";
import { MemoryDialog } from "./dialogs/MemoryDialog";
import { ImpactsPane } from "./workpanes";
import { PaneOverflowMenu, type PaneMenuItem } from "./PaneOverflowMenu";
import {
  useEditorStore,
  MAX_SPLIT_PANES,
  samePaneRef,
  treeContains,
  treeLeaves,
  treePaneCount,
  sessionsViewFromId,
  type AgentTab,
  type OpenFile,
  type PlanTabData,
  type TerminalTab,
  type WorkPaneRef,
  type WorkSplitDirection,
  type WorkSplitLeaf,
  type WorkSplitTree,
  type TraceToolKind,
  type TraceView,
  isPlanMarkdownPath,
} from "../lib/editorStore";
import { AgentIcon } from "./agent/AgentIcon";
import { api, type OutlineNode, type StrictModeInfo, type ZoneRule } from "../lib/api";
import { forgetAgentSession } from "../lib/agentSessionStore";
import { useTeammatePresence } from "../lib/usePresence";
import { usePagesActiveTitle } from "../lib/pagesActiveTitle";

type WorkSurfaceProps = {
  repoRoot: string;
  /** Project label for the dashboard header. Defaults to the basename
   *  of repoRoot when absent. */
  projectName?: string;
  /** Active zone rules from App.tsx's poll. Forwarded into Tabs so each
   *  FileTab can show a zone-owner pill when its file is owned by
   *  another agent's session. */
  zones?: ZoneRule[];
  /** Strict-mode posture, forwarded to AgentSurface so its
   *  SessionInfoCard can show a matching pill. */
  strictMode?: StrictModeInfo["mode"];
  /** Spawn an agent PTY tab. Forwarded to Tabs so the tab strip's `+`
   *  popover and the optional preset bar can launch agents directly,
   *  matching the EmptyState launcher. */
  onLaunchAgent?: (agentId: string, label: string) => void;
  /** Quick-action openers used by FileInsightStrip when an Aura-tracked
   *  file is shown in diff mode. App.tsx already owns the dialog state
   *  for each of these, so we just forward callbacks. */
  onOpenRewind?: (filePath?: string) => void;
  onLogIntent?: (filePath?: string) => void;
  onSnapshot?: (filePath: string) => void;
};

export function WorkSurface({
  repoRoot,
  projectName,
  zones,
  strictMode,
  onLaunchAgent,
  onOpenRewind,
  onLogIntent,
  onSnapshot,
}: WorkSurfaceProps) {
  const store = useEditorStore();
  const [showDiff, setShowDiff] = useState(false);
  const [showOutline, setShowOutline] = useState<boolean>(() => {
    return localStorage.getItem("aura.outline.open") !== "0";
  });
  // Per-file markdown view preference. Only used when active file is
  // *.md / *.markdown / *.mdx. Persisted per (repoRoot, path) so a user
  // who prefers rendered for README.md doesn't lose the choice.
  const [mdViewMap, setMdViewMap] = useState<Record<string, MdView>>(() => {
    try {
      const raw = localStorage.getItem(`aura.md.${repoRoot}`);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  });
  const active = store.files.find((f) => f.path === store.activePath) ?? null;
  const activeAgentTab =
    store.agentTabs.find((t) => t.sessionId === store.activeAgentId) ?? null;
  const activeTermTab =
    store.terminalTabs.find((t) => t.termId === store.activeTermId) ?? null;
  const activeManagerTab =
    store.managerTabs.find((t) => t.sessionId === store.activeManagerId) ?? null;
  const activePlanTab =
    store.planTabs.find((t) => t.id === store.activePlanId) ?? null;
  const [cursorLine, setCursorLine] = useState(1);
  const presenceMarkers = useTeammatePresence(
    repoRoot,
    active?.status === "ok" ? active.path : null,
    active?.current ?? "",
  );
  // Tasks / Standup / Screenshare workpane tabs (#266, #279 BB.2,
  // V.Y.4) are identified purely by their presence in the split
  // layout — there's no `activeTasksId` flag. When none of the
  // file/agent/terminal/manager/plan slots are active but the layout
  // exists with such a tab in its active leaf, fall back to that ref
  // so the split-render path can claim the surface. Without this the
  // "Open full board" affordance updated the layout but the surface
  // fell through to WorkSurfaceEmpty because activeSplitRef was null.
  const splitFallbackRef: WorkPaneRef | null = (() => {
    if (!store.splitLayout) return null;
    const leaves = treeLeaves(store.splitLayout);
    for (const ref of leaves) {
      if (
        ref.kind === "tasks" ||
        ref.kind === "task" ||
        ref.kind === "standup" ||
        ref.kind === "automations" ||
        ref.kind === "channels" ||
        ref.kind === "commons" ||
        ref.kind === "app" ||
        ref.kind === "screenshare" ||
        ref.kind === "trace" ||
        ref.kind === "sessions" ||
        ref.kind === "inspector" ||
        ref.kind === "replay" ||
        ref.kind === "prove" ||
        ref.kind === "graph" ||
        ref.kind === "pages"
      ) {
        return ref;
      }
    }
    return null;
  })();
  const activeSplitRef: WorkPaneRef | null = activeAgentTab
    ? { kind: "agent", id: activeAgentTab.sessionId }
    : activeTermTab
      ? { kind: "terminal", id: activeTermTab.termId }
      : activeManagerTab
        ? { kind: "manager", id: activeManagerTab.sessionId }
        : activePlanTab
          ? { kind: "plan", id: activePlanTab.id }
          : active
            ? { kind: "file", path: active.path }
            : splitFallbackRef;
  // Render the split layout whenever one exists. The treeContains check
  // we used to do here collapsed the entire layout the moment the user
  // clicked a tab that wasn't *currently* the active ref — turning every
  // plan/manager/agent tab in the layout invisible just because focus
  // moved. activeSplitRef is a focus hint, not a visibility gate.
  const splitLayout = store.splitLayout ?? null;
  // DFS leaf order — resolves every leaf in the tree to its concrete
  // surface (or null if the underlying tab/file vanished). The render
  // path walks the tree and looks up each leaf in this list by index;
  // store mutators (replaceSplitPaneAt / removeSplitPane / reorder)
  // also address panes by this same DFS order.
  const flatLeafRefs: WorkPaneRef[] = splitLayout ? treeLeaves(splitLayout) : [];
  const resolvedPanes: ResolvedSplitPane[] = flatLeafRefs
    .map((ref) =>
      resolveSplitPane(
        ref,
        store.files,
        store.agentTabs,
        store.terminalTabs,
        store.managerTabs,
        store.planTabs,
      ),
    )
    .filter((p): p is ResolvedSplitPane => p !== null);
  // Take the split path as long as the layout has at least one leaf that
  // still resolves. We used to require EVERY leaf resolve
  // (resolvedPanes.length === flatLeafRefs.length), but that let a single
  // stale ref — a tab closed a tick before the layout pruned it — blank
  // the WHOLE split instead of just its own slot. `renderTree` below
  // already null-guards each leaf independently, so a dead leaf degrades
  // to an empty slot while its siblings keep rendering; this matches the
  // "render the split whenever one exists" philosophy noted above. Zero
  // resolved ⇒ fall through to the single-pane path (the layout is fully
  // stale and the store's own collapse will catch up).
  const splitOk = !!splitLayout && resolvedPanes.length > 0;

  // When the active file's defaultView changes (e.g. user clicked a row
  // in the Git sidebar that opens straight into diff), honor it once. We
  // key off (path, defaultView) so re-clicking a Git row for an already-
  // open tab still flips back to diff if the user toggled to edit.
  const activePath = active?.path;
  const activeDefaultView = active?.defaultView;
  useEffect(() => {
    if (activeDefaultView === "diff") setShowDiff(true);
    else if (activeDefaultView === "edit") setShowDiff(false);
  }, [activePath, activeDefaultView]);

  useEffect(() => {
    localStorage.setItem("aura.outline.open", showOutline ? "1" : "0");
  }, [showOutline]);

  // ⌘S anywhere on the work surface saves the active tab. saveActive is
  // a stable module-level function; depend on it specifically (not the
  // whole `store` object) so the listener isn't churned on every render.
  const saveActive = store.saveActive;
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === "s") {
        e.preventDefault();
        saveActive().catch((err) => console.error("save failed:", err));
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [saveActive]);

  // The main strip is the EDITOR area's tab bar — it must list only the
  // terminals that live in the editor (opened here directly, or pulled in
  // via "Move Terminal into Editor Area"), never the ones owned by the
  // bottom Terminal panel. Both kinds share the single `terminalTabs`
  // roster (it's the PTY list), so without this filter every panel
  // terminal also rendered as a main tab — and surfaced in the strip the
  // moment the surrounding code tabs were closed, looking like the
  // terminals "jumped" up from the panel on their own. A terminal is
  // panel-owned iff it appears in some `terminalGroups` layout; promoting
  // one to the editor removes it from those groups, so it correctly
  // reappears in the strip only when the user explicitly moves it.
  const panelOwnedTermIds = new Set<string>();
  for (const g of store.terminalGroups) {
    for (const ref of treeLeaves(g.layout)) {
      if (ref.kind === "terminal") panelOwnedTermIds.add(ref.id);
    }
  }
  const editorTerminalTabs = store.terminalTabs.filter(
    (t) => !panelOwnedTermIds.has(t.termId),
  );

  const tabsCommonProps = {
    files: store.files,
    agentTabs: store.agentTabs,
    terminalTabs: editorTerminalTabs,
    managerTabs: store.managerTabs,
    prTabs: store.prTabs,
    activePrTabId: store.activePrTabId,
    onActivatePr: store.setActivePrTab,
    onClosePr: store.closePrTab,
    inspectorOpen: store.inspectorOpen,
    inspectorActive: store.activeInspector,
    replayOpen: store.replayOpen,
    replayActive: store.activeReplay,
    planBuilderOpen: store.planBuilderOpen,
    planBuilderActive: store.activePlanBuilder,
    proveOpen: store.proveOpen,
    proveActive: store.activeProve,
    graphOpen: store.graphOpen,
    graphActive: store.activeGraph,
    inboxOpen: store.inboxOpen,
    inboxActive: store.activeInbox,
    activePath: store.activePath,
    activeAgentId: store.activeAgentId,
    activeTermId: store.activeTermId,
    activeManagerId: store.activeManagerId,
    dashboardActive: store.activeDashboard,
    onActivateDashboard: store.setActiveDashboard,
    isDirty: store.isDirty,
    repoRoot,
    zones,
    onActivateFile: store.setActive,
    onActivateAgent: store.setActiveAgent,
    onActivateTerminal: store.setActiveTerminal,
    onActivateManager: store.setActiveManager,
    onActivateInspector: store.setActiveInspector,
    onActivateReplay: store.setActiveReplay,
    onActivatePlanBuilder: store.setActivePlanBuilder,
    onActivateProve: store.setActiveProve,
    onActivateGraph: store.setActiveGraph,
    onActivateInbox: store.setActiveInbox,
    onCloseFile: store.close,
    onCloseAgent: (sid: string) => {
      // Closing the tab stops the agent by default: kill the underlying PTY so
      // a closed Claude Code (or other CLI) doesn't linger as an orphan, then
      // drop the live subscription cache. "Detach to window" keeps a session
      // alive on purpose (it hands the live PTY to a popout, using plain
      // closeAgent), so the kill lives here at the close call site, not in
      // closeAgent.
      store.stopAndCloseAgent(sid);
      forgetAgentSession(sid);
    },
    onCloseTerminal: store.closeTerminal,
    onCloseManager: store.closeManager,
    onCloseInspector: store.closeInspector,
    onCloseReplay: store.closeReplay,
    onClosePlanBuilder: store.closePlanBuilder,
    onCloseProve: store.closeProve,
    onCloseGraph: store.closeGraph,
    onCloseInbox: store.closeInbox,
    // Trace tools now live in the unified split leaf as `kind: "trace"`
    // tabs (rendered by PerPaneTabStrip), so the global strip never draws
    // a trace pill — that would double it up. Kept wired (open=false) so
    // the prop contract stays intact.
    traceToolOpen: false,
    traceToolKind: store.traceTool,
    onActivateTraceTool: () => {
      if (store.traceTool) store.openTraceTool(store.traceTool, store.traceToolArg ?? undefined);
    },
    onCloseTraceTool: store.closeTraceTool,
    splitActive: !!store.splitLayout,
    onAddToSplit: (ref: WorkPaneRef) => store.addSplitPane(ref),
    isInSplit: (ref: WorkPaneRef): boolean =>
      !!store.splitLayout && treeContains(store.splitLayout, ref),
    splitMemberCount: treePaneCount(store.splitLayout),
    onClearSplit: () => store.clearSplitLayout(),
    onReorderFile: store.reorderFileTabs,
    onReorderAgent: store.reorderAgentTabs,
    onReorderTerminal: store.reorderTerminalTabs,
    onReorderManager: store.reorderManagerTabs,
    onSplitTab: (ref: WorkPaneRef, direction: WorkSplitDirection) =>
      store.splitWithEmpty(ref, direction),
    onNewTerminal: () => store.openTerminal(repoRoot),
    onLaunchAgent,
  };

  // Plan Builder path: singleton wizard. Same shape as Inspector — the
  // tab strip stays so the user can pop back to other tabs without
  // losing the wizard buffer.
  if (store.activePlanBuilder) {
    return (
      <div className="h-full w-full flex flex-col bg-bg-content">
        <div className="flex items-stretch flex-shrink-0">
          <div className="flex-1 min-w-0">
            <Tabs {...tabsCommonProps} />
          </div>
        </div>
        <div className="flex-1 min-h-0">
          <PlanBuilderSurface repoRoot={repoRoot} onClose={store.closePlanBuilder} />
        </div>
      </div>
    );
  }

  // Trace verify tools (Review / Rewind / Attestations / Doctor / Memory)
  // are no longer a standalone surface — they live in the unified split
  // leaf as `kind: "trace"` tabs (see openTraceTool), so the split path
  // below renders them beside the agent/Tasks/Pages tabs and they persist
  // when the user switches between those. resolveSplitPane + renderSplitPane
  // handle the body; describeRef gives the tab its pill.

  // Trace/Studio insight pages (Semantic Graph, Prove/Goals, Intent↔AST,
  // Provenance) are no longer whole-area singletons — they live in the
  // unified split leaf as their own workpane tabs (kind: "graph" / "prove"
  // / "inspector" / "replay"; see openGraph/openProve/openInspector/
  // openReplay). The split path below renders them beside the agent/Tasks/
  // trace tabs and they persist when the user switches. resolveSplitPane +
  // renderSplitPane handle the body; describeRef gives each tab its pill;
  // the matching active* flag survives only as the Trace rail mirror.

  // Inbox path: singleton (Stage 8A). Graphite-style PR triage.
  // Highest priority among PR surfaces because it's the entry point —
  // user clicks a row inside, which sets selectedPr and flips to
  // activePrDetail.
  if (store.activeInbox) {
    return (
      <div className="h-full w-full flex flex-col bg-bg-content">
        <div className="flex items-stretch flex-shrink-0">
          <div className="flex-1 min-w-0">
            <Tabs {...tabsCommonProps} />
          </div>
        </div>
        <div className="flex-1 min-h-0">
          <InboxPane repoRoot={repoRoot} onClose={store.closeInbox} />
        </div>
      </div>
    );
  }

  // Sessions/Overview (Trace v2) is now a workpane tab (`kind: "sessions"`),
  // rendered through the leaf like every other page instead of taking over
  // the center here — so opening it no longer hides the agent/Tasks tabs.
  // `activeSessions` survives only as the Trace rail's highlight mirror.

  // PR Detail path: now an app-level FullscreenOverlay (mounted in App.tsx,
  // see PRDetailPane) so wide diffs get the whole window instead of the
  // squeezed ADE v2 center column. WorkSurface renders an empty surface
  // behind it — the opaque overlay covers the app while a PR is open.
  if (store.activePrDetail) {
    return <div className="h-full w-full bg-bg-content" />;
  }

  // (Intent↔AST inspector + Provenance replay moved into the split tree as
  // workpane tabs — see the note above the Inbox branch.)

  // Chat-first sweep — Manager sessions no longer get their own workspace
  // tab. They live in the right-rail "Aura" panel via AuraRailPanel.
  // Callers that previously called `openManager(sid, label)` now invoke
  // `focusAmbientManager(repoRoot, sid)` which flips the rail.
  //
  // Plan-tab path (Stage 11.4) — full-tab plan surface, mirrors Cursor.
  // Plans are session-only snapshots stored in the editor store, so this
  // tab keeps rendering even after the originating Manager session
  // resolves the plan.
  if (activePlanTab) {
    return (
      <div className="h-full w-full flex flex-col bg-bg-content">
        <div className="flex items-stretch flex-shrink-0">
          <div className="flex-1 min-w-0">
            <Tabs {...tabsCommonProps} />
          </div>
        </div>
        <div className="flex-1 min-h-0">
          <PlanTab plan={activePlanTab} />
        </div>
      </div>
    );
  }

  // Split path: N-pane workspace (2..MAX_SPLIT_PANES). Tabs remain
  // canonical; this branch composes the layout from already-open tabs.
  // Panes can be agent / terminal / file kinds — file panes mirror the
  // OpenFile buffer so edits round-trip through the canonical files
  // array without copies.
  if (splitLayout && splitOk) {
    // Walk the recursive split tree, rendering each split node as a
    // flex container with its own direction and each leaf as the
    // resolved pane. Leaves are looked up positionally in DFS order
    // so the existing `resolvedPanes` + index-based store mutators
    // keep working with no further changes.
    let leafCursor = 0;
    const renderTree = (node: WorkSplitTree): ReactNode => {
      if (node.kind === "leaf") {
        const idx = leafCursor++;
        const activeRef = node.tabs[node.activeIndex];
        if (!activeRef) return null;
        const pane = resolveSplitPane(
          activeRef,
          store.files,
          store.agentTabs,
          store.terminalTabs,
          store.managerTabs,
          store.planTabs,
        );
        if (!pane) return null;
        return (
          <SplitPaneShell
            key={`leaf-${node.paneId}`}
            active={paneIsActive(pane.ref, activeSplitRef)}
            index={idx}
            direction="row"
            onReorder={store.reorderSplitPanes}
          >
            <div className="h-full w-full flex flex-col">
              <PerPaneTabStrip
                leaf={node}
                paneIndex={idx}
                currentRepoRoot={repoRoot}
              />
              <div className="flex-1 min-h-0 min-w-0">
                {renderSplitPane(pane, idx)}
              </div>
            </div>
          </SplitPaneShell>
        );
      }
      // Split node — flex container, recursive children with dividers.
      return (
        <div
          key={`split-${leafCursor}-${node.direction}-${node.children.length}`}
          className={`flex-1 min-h-0 min-w-0 flex ${
            node.direction === "row" ? "flex-row" : "flex-col"
          }`}
        >
          {node.children.map((child, i) => (
            <Fragment key={`c-${i}`}>
              {i > 0 && (
                <div
                  className={
                    node.direction === "row"
                      ? "w-px bg-line-soft flex-shrink-0"
                      : "h-px bg-line-soft flex-shrink-0"
                  }
                />
              )}
              {renderTree(child)}
            </Fragment>
          ))}
        </div>
      );
    };
    return (
      <div className="h-full w-full flex flex-col bg-bg-content">
        {/* Stage 9I — when a split is active, each pane carries its own
            tab strip (PerPaneTabStrip below). The global strip is hidden
            so users don't see two parallel rows of the same tabs. */}
        {renderTree(splitLayout)}
      </div>
    );
  }

  // Agent-tab path: render the interactive surface in place of the
  // editor. The shared Tabs strip still renders all three tab kinds.
  if (activeAgentTab) {
    return (
      <div className="h-full w-full flex flex-col bg-bg-content">
        <div className="flex items-stretch flex-shrink-0">
          <div className="flex-1 min-w-0">
            <Tabs {...tabsCommonProps} />
          </div>
        </div>
        <div className="flex-1 min-h-0">
          <AgentSurface tab={activeAgentTab} strictMode={strictMode} />
        </div>
      </div>
    );
  }

  // Terminal-tab path: each terminal owns its own xterm.js + PTY, keyed
  // by termId so re-mounting a different terminal opens a fresh PTY.
  if (activeTermTab) {
    return (
      <div className="h-full w-full flex flex-col bg-bg-content">
        <div className="flex items-stretch flex-shrink-0">
          <div className="flex-1 min-w-0">
            <Tabs {...tabsCommonProps} />
          </div>
        </div>
        <div className="flex-1 min-h-0">
          <TerminalPaneSurface
            tab={activeTermTab}
            repoRoot={repoRoot}
            onSplit={(direction) => splitTerminal(activeTermTab, direction)}
            onMoveToPanel={() => store.demoteTerminalToPanel(activeTermTab.termId)}
            onSessionOpened={store.setTerminalDaemonSession}
          />
        </div>
      </div>
    );
  }

  // Manager-tab path — chat sessions render as a center workpane (ADE).
  // `openManager` re-homes a Manager session here; without this branch the
  // tab lands in the strip but the body falls through to WorkSurfaceEmpty,
  // so "start a chat" looked like a no-op. Sits above the dashboard/empty
  // fallbacks but below file/agent/terminal (each of those clears
  // activeManagerId on open, so this never shadows them).
  if (activeManagerTab) {
    // Chat renders in place of the editor under the SHARED `<Tabs>` strip —
    // same shape as the agent-tab path. The strip is now workspace-exclusive
    // (task #229), so it no longer drags in unrelated editor tabs. The chat
    // drops its own `.p-tabs` header (`tabChrome={false}`); split/history/
    // memory/cancel live on the chat tab's right-click menu instead of a
    // dedicated bar.
    return (
      <div className="h-full w-full flex flex-col bg-bg-content">
        <div className="flex items-stretch flex-shrink-0">
          <div className="flex-1 min-w-0">
            <Tabs {...tabsCommonProps} />
          </div>
        </div>
        <div className="flex-1 min-h-0">
          <ManagerSurface
            sessionId={activeManagerTab.sessionId}
            tabChrome={false}
            onSplit={(direction) =>
              store.splitWithEmpty(
                { kind: "manager", id: activeManagerTab.sessionId },
                direction,
              )
            }
          />
        </div>
      </div>
    );
  }

  // Aura dashboard path — catch-all. Default-active when a workspace
  // opens, and the fallback whenever no other tab is selected (e.g. user
  // closed the last tab). The Dashboard tile keeps the legacy
  // Manager-composer dashboard; the bare empty state (no tabs at all)
  // gets the new chat-first WorkSurfaceEmpty surface.
  if (store.activeDashboard) {
    const fallbackName = projectName ?? repoRoot.split("/").pop() ?? repoRoot;
    return (
      <div className="h-full w-full flex flex-col bg-bg-content">
        <div className="flex items-stretch flex-shrink-0">
          <div className="flex-1 min-w-0">
            <Tabs {...tabsCommonProps} />
          </div>
        </div>
        <div className="flex-1 min-h-0">
          {AURA_MANAGER_ENABLED ? (
            <ManagerDashboardSurface repoRoot={repoRoot} projectName={fallbackName} />
          ) : (
            // Native chat is gated off — the dashboard slot becomes the calm
            // empty surface so opening a workspace (and ⌘N) lands here, not in
            // a Manager chat. Coding agents launch from the preset bar above.
            <WorkSurfaceEmpty
              repoRoot={repoRoot}
              projectName={fallbackName}
              onOpenTerminal={() => store.openTerminal(repoRoot, { label: "Terminal" })}
              onOpenChat={() => store.openChannels(repoRoot)}
              onSearch={() => window.dispatchEvent(new CustomEvent("aura:open-search"))}
            />
          )}
        </div>
      </div>
    );
  }
  if (!active) {
    const fallbackName = projectName ?? repoRoot.split("/").pop() ?? repoRoot;
    return (
      <div className="h-full w-full flex flex-col bg-bg-content">
        <div className="flex items-stretch flex-shrink-0">
          <div className="flex-1 min-w-0">
            <Tabs {...tabsCommonProps} />
          </div>
        </div>
        <div className="flex-1 min-h-0">
          <WorkSurfaceEmpty
            repoRoot={repoRoot}
            projectName={fallbackName}
            onOpenTerminal={() => store.openTerminal(repoRoot, { label: "Terminal" })}
            onOpenChat={() => store.openChannels(repoRoot)}
            onSearch={() => window.dispatchEvent(new CustomEvent("aura:open-search"))}
          />
        </div>
      </div>
    );
  }

  // File-tab path (unchanged from before).
  const isMd = isMarkdownPath(active.path);
  const mdView: MdView = isMd ? mdViewMap[active.path] ?? "raw" : "raw";
  const setMdView = (v: MdView) => {
    setMdViewMap((prev) => {
      const next = { ...prev, [active.path]: v };
      try {
        localStorage.setItem(`aura.md.${repoRoot}`, JSON.stringify(next));
      } catch {
        /* quota — ignore */
      }
      return next;
    });
  };

  return (
    <div className="h-full w-full flex flex-col bg-bg-content">
      <div className="flex items-stretch flex-shrink-0">
        <div className="flex-1 min-w-0">
          <Tabs {...tabsCommonProps} />
        </div>
        <div className="flex items-center gap-1 px-2 bg-bg-chrome border-b border-line-soft">
          {/* The markdown Raw/Rendered/Split toggle used to live here; it
              now rides in the breadcrumb row right below (see the
              EditorBreadcrumbs `trailing` slot), next to the file path. */}
          <ToolbarBtn
            active={showDiff}
            onClick={() => setShowDiff((v) => !v)}
            title="Show what changed since your last commit"
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
              <line x1="8" y1="2" x2="8" y2="14" stroke="currentColor" strokeWidth="1.2" strokeDasharray="2 2" />
              <rect x="2" y="3" width="4" height="10" rx="0.5" stroke="currentColor" strokeWidth="1.2" fill="none" />
              <rect x="10" y="3" width="4" height="10" rx="0.5" stroke="currentColor" strokeWidth="1.2" fill="none" />
            </svg>
          </ToolbarBtn>
          <ToolbarBtn
            onClick={() => splitFile(active, "row")}
            title="Split right"
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
              <rect x="2.5" y="3" width="11" height="10" rx="1.2" stroke="currentColor" strokeWidth="1.2" />
              <line x1="8" y1="3.5" x2="8" y2="12.5" stroke="currentColor" strokeWidth="1.2" />
            </svg>
          </ToolbarBtn>
          <ToolbarBtn
            onClick={() => splitFile(active, "column")}
            title="Split down"
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
              <rect x="2.5" y="3" width="11" height="10" rx="1.2" stroke="currentColor" strokeWidth="1.2" />
              <line x1="3" y1="8" x2="13" y2="8" stroke="currentColor" strokeWidth="1.2" />
            </svg>
          </ToolbarBtn>
          <ToolbarBtn
            onClick={() => store.saveActive()}
            disabled={!store.isDirty(active.path)}
            title="Save (⌘S)"
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
              <path
                d="M3 2h8l2 2v10a1 1 0 01-1 1H3a1 1 0 01-1-1V3a1 1 0 011-1z"
                stroke="currentColor"
                strokeWidth="1.2"
                fill="none"
              />
              <rect x="5" y="2" width="6" height="4" stroke="currentColor" strokeWidth="1.2" fill="none" />
            </svg>
          </ToolbarBtn>
          {/* Theme toggle removed — lives in Settings dialog only. */}
          <ToolbarBtn
            active={showOutline}
            onClick={() => setShowOutline((v) => !v)}
            title="Toggle code outline"
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
              <line x1="3" y1="4" x2="13" y2="4" stroke="currentColor" strokeWidth="1.2" />
              <line x1="5" y1="8" x2="13" y2="8" stroke="currentColor" strokeWidth="1.2" />
              <line x1="3" y1="12" x2="13" y2="12" stroke="currentColor" strokeWidth="1.2" />
              <circle cx="2" cy="4" r="0.8" fill="currentColor" />
              <circle cx="4" cy="8" r="0.8" fill="currentColor" />
              <circle cx="2" cy="12" r="0.8" fill="currentColor" />
            </svg>
          </ToolbarBtn>
        </div>
      </div>

      {active.status === "ok" && !showDiff && (
        <EditorBreadcrumbs
          repoRoot={repoRoot}
          filePath={active.path}
          fileLabel={
            active.path.startsWith(repoRoot + "/")
              ? active.path.slice(repoRoot.length + 1)
              : active.name
          }
          buffer={active.current}
          cursorLine={cursorLine}
        />
      )}

      {active.status === "ok" && showDiff && (
        <FileInsightStrip
          repoRoot={repoRoot}
          absPath={active.path}
          fileLabel={
            active.path.startsWith(repoRoot + "/")
              ? active.path.slice(repoRoot.length + 1)
              : active.name
          }
          onOpenRewind={onOpenRewind ? () => onOpenRewind(active.path) : undefined}
          onLogIntent={onLogIntent ? () => onLogIntent(active.path) : undefined}
          onSnapshot={onSnapshot ? () => onSnapshot(active.path) : undefined}
        />
      )}

      <div className="flex-1 min-h-0 flex">
        <div className="relative flex-1 min-w-0 flex">
          {/* Floating view switcher for markdown — a pill over the bottom of
              the pane so Raw / Rendered / Split is reachable from any of the
              three views without hunting the chrome. Hidden in diff mode
              (the diff toggle owns the toolbar then). */}
          {isMd && !showDiff && active.status === "ok" && (
            <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-10 rounded-md shadow-lg shadow-black/30">
              <SegmentedControl
                ariaLabel="Markdown view"
                value={mdView}
                onChange={setMdView}
                options={[
                  { value: "raw", label: "Raw" },
                  { value: "rendered", label: "Rendered" },
                  { value: "split", label: "Split" },
                ]}
                className="bg-bg-card"
              />
            </div>
          )}
          {active.status !== "ok" ? (
            <UnreadablePlaceholder file={active} />
          ) : showDiff ? (
            <DiffView
              key={active.path}
              repoRoot={repoRoot}
              path={active.path}
              current={active.current}
              baseline={active.baseline}
              loadOriginal={(root, file) => api.gitShowHead(root, file)}
            />
          ) : isMd && mdView === "rendered" ? (
            <MarkdownView source={active.current} />
          ) : isMd && mdView === "split" ? (
            <>
              <div className="flex-1 min-w-0 border-r border-line-soft">
                <Editor
                  key={active.path}
                  value={active.current}
                  language={active.language}
                  onChange={(text) => store.updateBuffer(active.path, text)}
                  onCursor={setCursorLine}
                  presenceMarkers={presenceMarkers}
                  filePath={active.path}
                  repoRoot={repoRoot}
                />
              </div>
              <div className="flex-1 min-w-0">
                <MarkdownView source={active.current} />
              </div>
            </>
          ) : (
            // key={path} — remount a fresh Monaco editor per file, the same
            // way DiffView is keyed. Reusing one instance and swapping the
            // model in place leaves the viewport unpainted under WKWebView
            // (the blank-file report: tiny files blank, the diff editor —
            // which IS keyed — renders the same file fine). A fresh mount
            // always paints. MonacoEditor still keeps per-file models alive
            // (keepCurrentModel) so the remount restores cursor/scroll/undo.
            <Editor
              key={active.path}
              value={active.current}
              language={active.language}
              onChange={(text) => store.updateBuffer(active.path, text)}
              onCursor={setCursorLine}
              presenceMarkers={presenceMarkers}
              filePath={active.path}
              repoRoot={repoRoot}
            />
          )}
        </div>
        {showOutline && active.status === "ok" && (
          <OutlinePanel
            repoRoot={repoRoot}
            file={active.path}
            text={active.current}
          />
        )}
      </div>
    </div>
  );

  function renderSplitPane(pane: ResolvedSplitPane, index: number) {
    const closePane = () => store.removeSplitPane(index);
    if (pane.kind === "agent") {
      return (
        <AgentSurface
          tab={pane.tab}
          strictMode={strictMode}
          paneIndex={index}
          onClosePane={closePane}
        />
      );
    }
    if (pane.kind === "terminal") {
      return (
        <TerminalPaneSurface
          tab={pane.tab}
          repoRoot={repoRoot}
          onSplit={(direction) => splitTerminal(pane.tab, direction)}
          onAddPane={() => addSplitTerminal(pane.tab.cwd)}
          onClosePane={closePane}
          onMoveToPanel={() => store.demoteTerminalToPanel(pane.tab.termId)}
          onSessionOpened={store.setTerminalDaemonSession}
        />
      );
    }
    if (pane.kind === "manager") {
      return (
        <ManagerSurface
          sessionId={pane.sessionId}
          tabChrome={false}
          onSplit={(direction) =>
            store.splitWithEmpty({ kind: "manager", id: pane.sessionId }, direction)
          }
        />
      );
    }
    if (pane.kind === "plan") {
      return <PlanTab plan={pane.plan} />;
    }
    if (pane.kind === "empty") {
      return (
        <EmptyPanePicker
          paneIndex={index}
          currentRepoRoot={repoRoot}
          onClosePane={closePane}
        />
      );
    }
    if (pane.kind === "tasks") {
      return (
        <TasksBoard
          repoRoot={pane.repoRoot}
          embedded
          onClose={closePane}
          onPopOut={() => openPopout({ kind: "tasks", root: pane.repoRoot })}
        />
      );
    }
    if (pane.kind === "task") {
      return (
        <TaskDetailPane
          taskId={pane.taskId}
          repoRoot={pane.repoRoot}
          onClose={closePane}
          onDetach={() =>
            openPopout({ kind: "task", root: pane.repoRoot, taskId: pane.taskId })
          }
        />
      );
    }
    if (pane.kind === "standup") {
      return <StandupView repoRoot={pane.repoRoot} embedded />;
    }
    if (pane.kind === "automations") {
      return <AutomationsSurface repoRoot={pane.repoRoot} />;
    }
    if (pane.kind === "channels") {
      const channelsName =
        projectName ?? pane.repoRoot.split("/").pop() ?? pane.repoRoot;
      // The references-grade 3-pane TeamSurface is the center channels
      // render. Gating it at the render (not just the opener) keeps a stale
      // persisted layout snapshot from re-mounting any superseded surface.
      return <TeamSurface repoRoot={pane.repoRoot} projectName={channelsName} />;
    }
    if (pane.kind === "commons") {
      // Full-width Commons (Lounge + Plugin Exchange). Gated behind
      // COMMONS_ENABLED at the render — not just the opener — so a stale
      // persisted split-tree leaf can't re-mount the community surface when
      // the platform is hidden.
      return COMMONS_ENABLED ? (
        <CommonsSurface repoRoot={pane.repoRoot} />
      ) : (
        <PaneUnavailable />
      );
    }
    if (pane.kind === "app") {
      // Full-surface Commons mini-app (Reddit / Hacker News / …). Same gate:
      // mini-apps live inside the (now hidden) Commons platform, so a stale
      // persisted layout degrades to the calm empty pane instead of re-
      // mounting an app the user can no longer reach.
      return COMMONS_ENABLED ? (
        <AppPaneSurface appKey={pane.appKey} />
      ) : (
        <PaneUnavailable />
      );
    }
    if (pane.kind === "screenshare") {
      return <ScreenshareTab huddleKey={pane.huddleKey} />;
    }
    if (pane.kind === "trace") {
      // The dialog's own × closes just this trace tab (drops it from the
      // leaf), not the whole pane — the sibling agent/Tasks tabs stay.
      return (
        <TraceToolSurface
          tool={pane.tool}
          arg={pane.arg}
          repoRoot={repoRoot}
          onClose={store.closeTraceTool}
        />
      );
    }
    if (pane.kind === "sessions") {
      // Each Trace view (Overview / My sessions / Team activity / Cost &
      // usage) is its own real tab now — the view is encoded in the pane id,
      // so the surface renders exactly one view and the old in-pane segmented
      // toggle is gone. Cross-links (Overview → sessions/usage) open the
      // sibling tab via openSessions.
      return (
        <TraceSurface
          repoRoot={repoRoot}
          view={pane.view}
          onOpenView={store.openSessions}
        />
      );
    }
    if (pane.kind === "inspector") {
      return <IntentInspector repoRoot={repoRoot} onClose={store.closeInspector} />;
    }
    if (pane.kind === "replay") {
      return <ProvenanceReplay repoRoot={repoRoot} onClose={store.closeReplay} />;
    }
    if (pane.kind === "prove") {
      return <ProvePane repoRoot={repoRoot} onClose={store.closeProve} />;
    }
    if (pane.kind === "graph") {
      return <SemanticGraphPane repoRoot={repoRoot} onClose={store.closeGraph} />;
    }
    if (pane.kind === "pages") {
      return <PagesSurface repoRoot={pane.repoRoot} />;
    }
    // file pane — buffer through the Editor, with a Diff/Edit toggle + the
    // Aura insight strip (story behind the change) when opened from Changes.
    return (
      <FilePaneSurface
        file={pane.file}
        onChange={(text) => store.updateBuffer(pane.file.path, text)}
        onSplit={(direction) => splitFile(pane.file, direction)}
        onAddPane={() => addSplitFile(pane.file)}
        onClosePane={closePane}
        repoRoot={repoRoot}
        onOpenRewind={
          onOpenRewind ? () => onOpenRewind(pane.file.path) : undefined
        }
        onLogIntent={
          onLogIntent ? () => onLogIntent(pane.file.path) : undefined
        }
        onSnapshot={onSnapshot ? () => onSnapshot(pane.file.path) : undefined}
      />
    );
  }

  function splitTerminal(tab: TerminalTab, direction: WorkSplitDirection) {
    // Splitting now opens an empty sibling pane — the user picks what
    // goes there from the EmptyPanePicker (cross-workspace agents,
    // terminals, files, managers, or a freshly spawned one).
    store.splitWithEmpty({ kind: "terminal", id: tab.termId }, direction);
  }

  function addSplitTerminal(_cwd: string) {
    if (!store.splitLayout) return;
    if (treePaneCount(store.splitLayout) >= MAX_SPLIT_PANES) return;
    store.addEmptySplitPane();
  }

  function splitFile(file: OpenFile, direction: WorkSplitDirection) {
    store.splitWithEmpty({ kind: "file", path: file.path }, direction);
  }

  function addSplitFile(_file: OpenFile) {
    if (!store.splitLayout) return;
    if (treePaneCount(store.splitLayout) >= MAX_SPLIT_PANES) return;
    store.addEmptySplitPane();
  }
}

type ResolvedSplitPane =
  | { kind: "agent"; ref: WorkPaneRef; tab: AgentTab }
  | { kind: "terminal"; ref: WorkPaneRef; tab: TerminalTab }
  | { kind: "manager"; ref: WorkPaneRef; sessionId: string; label: string }
  | { kind: "plan"; ref: WorkPaneRef; plan: PlanTabData }
  | { kind: "file"; ref: WorkPaneRef; file: OpenFile }
  | { kind: "empty"; ref: WorkPaneRef; id: string }
  | { kind: "tasks"; ref: WorkPaneRef; repoRoot: string }
  | { kind: "task"; ref: WorkPaneRef; taskId: string; repoRoot: string }
  | { kind: "standup"; ref: WorkPaneRef; repoRoot: string }
  | { kind: "automations"; ref: WorkPaneRef; repoRoot: string }
  | { kind: "channels"; ref: WorkPaneRef; repoRoot: string }
  | { kind: "commons"; ref: WorkPaneRef; repoRoot: string }
  | { kind: "app"; ref: WorkPaneRef; appKey: string }
  | { kind: "screenshare"; ref: WorkPaneRef; huddleKey: string }
  | {
      kind: "trace";
      ref: WorkPaneRef;
      tool: TraceToolKind;
      arg: { identifier?: string; file?: string } | null;
    }
  | { kind: "sessions"; ref: WorkPaneRef; view: TraceView }
  | { kind: "inspector"; ref: WorkPaneRef }
  | { kind: "replay"; ref: WorkPaneRef }
  | { kind: "prove"; ref: WorkPaneRef }
  | { kind: "graph"; ref: WorkPaneRef }
  | { kind: "pages"; ref: WorkPaneRef; repoRoot: string };

function resolveSplitPane(
  ref: WorkPaneRef,
  files: OpenFile[],
  agentTabs: AgentTab[],
  terminalTabs: TerminalTab[],
  managerTabs: { sessionId: string; label: string }[],
  planTabs: PlanTabData[],
): ResolvedSplitPane | null {
  if (ref.kind === "agent") {
    const tab = agentTabs.find((t) => t.sessionId === ref.id);
    return tab ? { kind: "agent", ref, tab } : null;
  }
  if (ref.kind === "terminal") {
    const tab = terminalTabs.find((t) => t.termId === ref.id);
    return tab ? { kind: "terminal", ref, tab } : null;
  }
  if (ref.kind === "manager") {
    const tab = managerTabs.find((t) => t.sessionId === ref.id);
    return tab
      ? { kind: "manager", ref, sessionId: tab.sessionId, label: tab.label }
      : null;
  }
  if (ref.kind === "plan") {
    const plan = planTabs.find((p) => p.id === ref.id);
    return plan ? { kind: "plan", ref, plan } : null;
  }
  if (ref.kind === "empty") {
    return { kind: "empty", ref, id: ref.id };
  }
  if (ref.kind === "tasks") {
    return { kind: "tasks", ref, repoRoot: ref.id };
  }
  if (ref.kind === "task") {
    return { kind: "task", ref, taskId: ref.id, repoRoot: ref.repoRoot };
  }
  if (ref.kind === "standup") {
    return { kind: "standup", ref, repoRoot: ref.id };
  }
  if (ref.kind === "automations") {
    return { kind: "automations", ref, repoRoot: ref.id };
  }
  if (ref.kind === "channels") {
    return { kind: "channels", ref, repoRoot: ref.id };
  }
  if (ref.kind === "commons") {
    return { kind: "commons", ref, repoRoot: ref.id };
  }
  if (ref.kind === "app") {
    return { kind: "app", ref, appKey: ref.id };
  }
  if (ref.kind === "screenshare") {
    return { kind: "screenshare", ref, huddleKey: ref.id };
  }
  if (ref.kind === "trace") {
    return { kind: "trace", ref, tool: ref.tool, arg: ref.arg ?? null };
  }
  if (ref.kind === "sessions") {
    return { kind: "sessions", ref, view: sessionsViewFromId(ref.id) };
  }
  if (ref.kind === "inspector") {
    return { kind: "inspector", ref };
  }
  if (ref.kind === "replay") {
    return { kind: "replay", ref };
  }
  if (ref.kind === "prove") {
    return { kind: "prove", ref };
  }
  if (ref.kind === "graph") {
    return { kind: "graph", ref };
  }
  if (ref.kind === "pages") {
    return { kind: "pages", ref, repoRoot: ref.id };
  }
  const file = files.find((f) => f.path === ref.path);
  return file ? { kind: "file", ref, file } : null;
}

function paneIsActive(ref: WorkPaneRef, active: WorkPaneRef | null): boolean {
  if (!active || ref.kind !== active.kind) return false;
  if (ref.kind === "file" && active.kind === "file") return ref.path === active.path;
  // agent / terminal / manager all share the { id } shape
  if (ref.kind !== "file" && active.kind !== "file") return ref.id === active.id;
  return false;
}

function SplitPaneShell({
  active,
  index,
  direction,
  onReorder,
  children,
}: {
  active: boolean;
  /** Stage 9H — pane index in splitLayout.panes (for drag-reorder). */
  index?: number;
  /** Layout orientation: "row" → horizontal panes, drop handle on left
   *  edge; "col" → vertical, handle on top edge. */
  direction?: WorkSplitDirection;
  onReorder?: (srcIndex: number, dstIndex: number) => void;
  children: ReactNode;
}) {
  const [over, setOver] = useState(false);
  const canDrag = typeof index === "number" && !!onReorder;
  const mime = "application/x-aura-split-pane";
  // direction "row" → horizontal layout, insertion line on the left
  // edge of the drop target; "column" → vertical, line on the top edge.
  const insertOnLeading = direction !== "column";
  return (
    <div
      onDragOver={
        canDrag
          ? (e) => {
              if (!Array.from(e.dataTransfer.types).includes(mime)) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              if (!over) setOver(true);
            }
          : undefined
      }
      onDragLeave={canDrag ? () => setOver(false) : undefined}
      onDrop={
        canDrag
          ? (e) => {
              setOver(false);
              const raw = e.dataTransfer.getData(mime);
              if (raw === "") return;
              const src = parseInt(raw, 10);
              if (Number.isNaN(src) || src === index) return;
              e.preventDefault();
              onReorder!(src, index);
            }
          : undefined
      }
      className={`flex-1 min-h-0 min-w-0 overflow-hidden relative group/pane ${
        active ? "bg-bg-content" : "bg-bg-1"
      } ${
        over
          ? insertOnLeading
            ? "shadow-[inset_2px_0_0_0_var(--accent-blue,#3b82f6)]"
            : "shadow-[inset_0_2px_0_0_var(--accent-blue,#3b82f6)]"
          : ""
      }`}
    >
      {canDrag && (
        <div
          className="absolute right-1 top-1 z-20 opacity-0 group-hover/pane:opacity-100 transition-opacity"
          // The grip itself is the draggable element; SplitPaneShell stays
          // a normal container so terminal text-selection inside it isn't
          // hijacked by a parent draggable.
        >
          <PaneDragHandle index={index!} />
        </div>
      )}
      {children}
    </div>
  );
}

/** Drag handle for a split pane — placed in pane headers (Agent, Terminal,
 *  File overflow row). Initiates the drag with the source index encoded in
 *  dataTransfer; the target SplitPaneShell handles drop. */
function PaneDragHandle({
  index,
  title = "Drag to reorder pane",
}: {
  index: number;
  title?: string;
}) {
  const mime = "application/x-aura-split-pane";
  return (
    <span
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(mime, String(index));
        e.dataTransfer.effectAllowed = "move";
      }}
      title={title}
      className="cursor-grab active:cursor-grabbing inline-flex items-center justify-center w-5 h-5 text-text-4 hover:text-text-2 select-none"
    >
      <svg width="10" height="10" viewBox="0 0 8 8" fill="currentColor">
        <circle cx="2" cy="2" r="1" />
        <circle cx="6" cy="2" r="1" />
        <circle cx="2" cy="4" r="1" />
        <circle cx="6" cy="4" r="1" />
        <circle cx="2" cy="6" r="1" />
        <circle cx="6" cy="6" r="1" />
      </svg>
    </span>
  );
}

function TerminalPaneSurface({
  tab,
  repoRoot,
  onSplit,
  onAddPane,
  onClosePane,
  onMoveToPanel,
  onSessionOpened,
}: {
  tab: TerminalTab;
  /** Workspace root — keys scrollback save/prune and resolves the launch
   *  profile, so an editor-area terminal restores exactly like a panel one. */
  repoRoot: string;
  onSplit: (direction: WorkSplitDirection) => void;
  /** Append another terminal pane to the existing split. Only fires
   *  when the parent already has an active layout — falsy otherwise. */
  onAddPane?: () => void;
  /** Drop this pane from the active split. Only present when this
   *  surface is rendered inside a split layout. */
  onClosePane?: () => void;
  /** Move this terminal back into the bottom Terminal panel — inverse of
   *  the panel's "open in editor". Works even when the panel is closed (it
   *  re-opens), so a promoted terminal is always recoverable without a
   *  drop target. Also available by dragging the editor tab onto the
   *  panel's terminal list. */
  onMoveToPanel?: () => void;
  /** Record the daemon session id once the PTY opens, so this terminal
   *  reconnects to its live process on the next app launch (parity with
   *  the bottom panel — without this an editor terminal always cold-starts). */
  onSessionOpened: (termId: string, daemonSessionId: string) => void;
}) {
  const items: PaneMenuItem[] = [
    { kind: "item", label: "Split right", onSelect: () => onSplit("row") },
    { kind: "item", label: "Split down", onSelect: () => onSplit("column") },
  ];
  if (onMoveToPanel)
    items.push({ kind: "item", label: "Move terminal to panel", onSelect: onMoveToPanel });
  if (onAddPane) items.push({ kind: "item", label: "Add empty pane", onSelect: onAddPane });
  if (onClosePane) items.push({ kind: "item", label: "Close this pane", onSelect: onClosePane });
  return (
    <div className="h-full w-full flex flex-col bg-bg-content">
      <div className="h-9 px-3 border-b border-line-soft bg-bg-chrome flex items-center gap-2 flex-shrink-0">
        <span className="text-text-4 font-mono text-[11px]">{">_"}</span>
        <div className="min-w-0 flex-1">
          <div className="text-text-2 text-[12px] font-medium truncate">
            {tab.label ?? "Terminal"}
          </div>
          <div className="text-text-5 text-[10px] font-mono truncate">
            {shortRoot(tab.cwd)}
          </div>
        </div>
        {onMoveToPanel && (
          <ToolbarBtn onClick={onMoveToPanel} title="Move terminal to panel">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
              <rect x="2.5" y="2.5" width="11" height="11" rx="1.2" stroke="currentColor" strokeWidth="1.2" />
              <line x1="2.5" y1="9.8" x2="13.5" y2="9.8" stroke="currentColor" strokeWidth="1.2" />
              <path
                d="M8 4v3.4M6.5 6 8 7.5 9.5 6"
                stroke="currentColor"
                strokeWidth="1.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </ToolbarBtn>
        )}
        <SplitPaneButtons onSplit={onSplit} />
        <PaneOverflowMenu title="Pane actions" items={items} />
      </div>
      <div className="flex-1 min-h-0">
        <Terminal
          key={tab.termId}
          cwd={tab.cwd}
          instanceId={tab.termId}
          bootCommand={tab.bootCommand}
          shell={tab.shell}
          profile={tab.profileId}
          repoRoot={repoRoot}
          reconnectId={tab.daemonSessionId ?? null}
          onOpened={(ptyId) => onSessionOpened(tab.termId, ptyId)}
        />
      </div>
    </div>
  );
}

/** File pane inside an N-pane split. Mirrors the canonical OpenFile
 *  buffer so `updateBuffer` round-trips through editorStore.files —
 *  each file pane is a *view*, not a copy. The Editor component uses
 *  CodeMirror compartments internally, so multiple panes pointing at
 *  the same file each get their own EditorView without tearing the
 *  shared buffer state. */
function FilePaneSurface({
  file,
  onChange,
  onSplit,
  onAddPane,
  onClosePane,
  repoRoot,
  onOpenRewind,
  onLogIntent,
  onSnapshot,
}: {
  file: OpenFile;
  onChange: (text: string) => void;
  onSplit: (direction: WorkSplitDirection) => void;
  onAddPane?: () => void;
  onClosePane?: () => void;
  repoRoot: string;
  onOpenRewind?: () => void;
  onLogIntent?: () => void;
  onSnapshot?: () => void;
}) {
  // Honor the open intent: clicking a row in the Changes panel opens with
  // defaultView "diff", the file tree with "edit". The toggle then flips
  // between the Monaco diff (vs HEAD) + Aura insight strip and the editor.
  const [showDiff, setShowDiff] = useState(file.defaultView === "diff");
  useEffect(() => {
    if (file.defaultView === "diff") setShowDiff(true);
    else if (file.defaultView === "edit") setShowDiff(false);
  }, [file.path, file.defaultView]);

  const items: PaneMenuItem[] = [
    { kind: "item", label: "Split right", onSelect: () => onSplit("row") },
    { kind: "item", label: "Split down", onSelect: () => onSplit("column") },
  ];
  if (onAddPane) items.push({ kind: "item", label: "Add empty pane", onSelect: onAddPane });
  if (onClosePane) items.push({ kind: "item", label: "Close this pane", onSelect: onClosePane });

  const fileLabel = file.path.split("/").pop() ?? file.path;
  const diffable = file.status === "ok";

  return (
    <div className="h-full w-full flex flex-col bg-bg-content">
      <div className="h-9 px-3 border-b border-line-soft bg-bg-chrome flex items-center gap-2 flex-shrink-0">
        <span className="text-text-4 font-mono text-[11px]">{"≡"}</span>
        <div className="min-w-0 flex-1">
          <div className="text-text-2 text-[12px] font-medium truncate">
            {fileLabel}
          </div>
          <div className="text-text-5 text-[10px] font-mono truncate">
            {shortPath(file.path, repoRoot)}
          </div>
        </div>
        {diffable && (
          <ToolbarBtn
            active={showDiff}
            onClick={() => setShowDiff((v) => !v)}
            title="Show what changed since your last commit"
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
              <line x1="8" y1="2" x2="8" y2="14" stroke="currentColor" strokeWidth="1.2" strokeDasharray="2 2" />
              <rect x="2" y="3" width="4" height="10" rx="0.5" stroke="currentColor" strokeWidth="1.2" fill="none" />
              <rect x="10" y="3" width="4" height="10" rx="0.5" stroke="currentColor" strokeWidth="1.2" fill="none" />
            </svg>
          </ToolbarBtn>
        )}
        <SplitPaneButtons onSplit={onSplit} />
        <PaneOverflowMenu title="Pane actions" items={items} />
      </div>

      {diffable && showDiff && (
        <FileInsightStrip
          repoRoot={repoRoot}
          absPath={file.path}
          fileLabel={shortPath(file.path, repoRoot)}
          onOpenRewind={onOpenRewind}
          onLogIntent={onLogIntent}
          onSnapshot={onSnapshot}
        />
      )}

      <div className="flex-1 min-h-0">
        {file.status === "ok" ? (
          showDiff ? (
            <DiffView
              key={file.path}
              repoRoot={repoRoot}
              path={file.path}
              current={file.current}
              baseline={file.baseline}
              loadOriginal={(root, f) => api.gitShowHead(root, f)}
            />
          ) : isPlanMarkdownPath(file.path) ? (
            <PlanMarkdownTab
              filePath={file.path}
              buffer={file.current}
              language={file.language}
              onChange={onChange}
              repoRoot={repoRoot}
            />
          ) : (
            <Editor
              key={file.path}
              value={file.current}
              language={file.language}
              onChange={onChange}
              filePath={file.path}
              repoRoot={repoRoot}
            />
          )
        ) : (
          <div className="h-full w-full flex items-center justify-center text-text-4 text-[12px]">
            {file.status === "binary"
              ? "Binary file"
              : file.status === "too_large"
                ? "File too large"
                : "Unavailable"}
          </div>
        )}
      </div>
    </div>
  );
}

function shortPath(path: string, repoRoot: string): string {
  if (path.startsWith(repoRoot + "/")) return path.slice(repoRoot.length + 1);
  return path;
}

function shortRoot(root: string): string {
  const parts = root.split("/").filter(Boolean);
  if (parts.length <= 2) return root;
  return ".../" + parts.slice(-2).join("/");
}

// Right-edge collapsible panel. Surfaces what the semantic engine sees
// in the active file: top-level functions, classes, types. Clicking a
// row dispatches `aura:scroll-to-line` — the matching Editor (filtered
// by filePath) centers and selects that line.
function OutlinePanel({
  repoRoot,
  file,
  text,
}: {
  repoRoot: string;
  file: string;
  text: string;
}) {
  const [nodes, setNodes] = useState<OutlineNode[]>([]);
  const [loading, setLoading] = useState(true);

  // Re-fetch when the file changes OR the buffer's line count crosses a
  // threshold (cheap heuristic — real symbol-level changes need an AST
  // diff, but this catches "added/removed a function" cases.)
  const linesKey = text.split("\n").length;
  const refresh = useCallback(() => {
    setLoading(true);
    api
      .auraSemanticOutline(repoRoot, file)
      .then(setNodes)
      .catch(() => setNodes([]))
      .finally(() => setLoading(false));
  }, [repoRoot, file]);

  useEffect(() => {
    refresh();
  }, [refresh, linesKey]);

  return (
    <aside
      className="flex-shrink-0 border-l border-line-soft bg-bg-1 overflow-y-auto"
      style={{ width: 220 }}
    >
      <header className="flex items-center h-9 px-3 border-b border-line-soft">
        <span className="text-text-3 text-[10.5px] uppercase tracking-wider font-medium">
          Outline
        </span>
        <span className="ml-auto text-text-4 text-[10.5px]">
          {loading ? "…" : nodes.length}
        </span>
      </header>
      {!loading && nodes.length === 0 && (
        <div className="text-text-4 text-[11px] px-3 py-3">No pieces here</div>
      )}
      {nodes.map((n, i) => (
        <button
          key={`${n.line}-${n.name}-${i}`}
          type="button"
          onClick={() =>
            window.dispatchEvent(
              new CustomEvent("aura:scroll-to-line", {
                detail: { filePath: file, line: n.line },
              }),
            )
          }
          className="w-full text-left flex items-center gap-2 px-3 py-1 hover:bg-bg-2"
          title={`Jump to ${n.kind} · line ${n.line}`}
        >
          <KindBadge kind={n.kind} />
          <span className="text-text-1 text-[11.5px] font-mono truncate flex-1">
            {n.name}
          </span>
          <span className="text-text-4 text-[10px] tabular-nums">{n.line}</span>
        </button>
      ))}
    </aside>
  );
}

function KindBadge({ kind }: { kind: string }) {
  const tone =
    kind === "fn"
      ? "text-accent-green"
      : kind === "class"
        ? "text-violet"
        : kind === "type"
          ? "text-amber"
          : "text-text-3";
  return (
    <span className={`text-[9px] uppercase tracking-wider w-7 ${tone}`}>{kind}</span>
  );
}

function UnreadablePlaceholder({ file }: { file: { status: string; size: number; name: string } }) {
  const reason =
    file.status === "too_large"
      ? `file is too large (${(file.size / 1024 / 1024).toFixed(2)} MB cap is 2 MB)`
      : file.status === "binary"
        ? "file looks binary — won't render in the text editor"
        : `unreadable (${file.status})`;
  return (
    <div className="h-full w-full flex items-center justify-center bg-bg-content">
      <div className="text-center text-text-3 text-[12px] max-w-md">
        <div className="text-text-2 font-medium mb-1">{file.name}</div>
        <div>{reason}</div>
      </div>
    </div>
  );
}

/** Split-right / split-down buttons for a pane header — the universal
 *  "fan this pane into a split" affordance. Rendered on every pane kind
 *  (file, terminal, agent, chat) so the capability is consistent and
 *  one-click, not buried in an overflow menu (VS Code parity). */
function SplitPaneButtons({
  onSplit,
}: {
  onSplit: (direction: WorkSplitDirection) => void;
}) {
  return (
    <>
      <ToolbarBtn onClick={() => onSplit("row")} title="Split right">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
          <rect x="2.5" y="3" width="11" height="10" rx="1.2" stroke="currentColor" strokeWidth="1.2" />
          <line x1="8" y1="3.5" x2="8" y2="12.5" stroke="currentColor" strokeWidth="1.2" />
        </svg>
      </ToolbarBtn>
      <ToolbarBtn onClick={() => onSplit("column")} title="Split down">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
          <rect x="2.5" y="3" width="11" height="10" rx="1.2" stroke="currentColor" strokeWidth="1.2" />
          <line x1="3" y1="8" x2="13" y2="8" stroke="currentColor" strokeWidth="1.2" />
        </svg>
      </ToolbarBtn>
    </>
  );
}

function ToolbarBtn({
  children,
  title,
  active,
  disabled,
  onClick,
}: {
  children: ReactNode;
  title: string;
  active?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`w-7 h-7 rounded flex items-center justify-center transition-colors ${
        disabled
          ? "text-text-5"
          : active
            ? "bg-bg-card text-text-1"
            : "text-text-3 hover:text-text-1 hover:bg-bg-2"
      }`}
    >
      {children}
    </button>
  );
}

// Renders the open Trace verify tool inline (page mode). The dialog
// components share the `Dialog` scaffold's `inline` flag, so the same
// component backs both the (legacy) modal and this page — no body fork.
function TraceToolSurface({
  tool,
  arg,
  repoRoot,
  onClose,
}: {
  tool: TraceToolKind;
  arg: { identifier?: string; file?: string } | null;
  repoRoot: string;
  onClose: () => void;
}) {
  if (tool === "review") {
    return <ReviewDialog inline open repoRoot={repoRoot} onClose={onClose} />;
  }
  if (tool === "rewind") {
    // The old by-name Rewind form is replaced by the meaning-first Time
    // machine: a timeline of every moment your code changed, with one-click
    // bring-back of a single piece. Same engine call (`aura rewind`), same
    // right-click prefill (identifier + file) — just a recovery surface a
    // non-engineer can actually navigate.
    return (
      <TimeMachinePane
        repoRoot={repoRoot}
        defaultIdentifier={arg?.identifier ?? null}
        defaultFile={arg?.file ?? null}
        onExpand={() =>
          window.dispatchEvent(
            new CustomEvent("aura:open-time-machine", {
              detail: { identifier: arg?.identifier ?? null, file: arg?.file ?? null },
            }),
          )
        }
      />
    );
  }
  if (tool === "attest") {
    return <AttestationsDialog inline open repoRoot={repoRoot} onClose={onClose} />;
  }
  if (tool === "memory") {
    // Memory is hidden until it works end-to-end / folds into agent
    // customizations. Guard the render too, so a stale persisted "memory was
    // open" workpane can't re-mount the dialog past the hidden nav.
    if (!MEMORY_SURFACE_ENABLED) {
      return <div className="h-full w-full bg-bg-content" />;
    }
    return <MemoryDialog inline open repoRoot={repoRoot} onClose={onClose} />;
  }
  if (tool === "impacts") {
    // Cross-branch live impacts — the real home of cross-branch danger now
    // that the fake pr-review wall is gone. Reuses the same ImpactsPane the
    // sidebar tab renders (one component, one data source).
    return <ImpactsPane repoRoot={repoRoot} />;
  }
  return <DoctorDialog inline open repoRoot={repoRoot} onClose={onClose} />;
}

type MdView = "raw" | "rendered" | "split";

function isMarkdownPath(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith(".md") || lower.endsWith(".markdown") || lower.endsWith(".mdx");
}

// ── Stage 9I — per-pane tab strip ─────────────────────────────────────
//
// Each leaf in the split tree carries its own tab list (paneId + tabs[]
// + activeIndex). When a split is active, the global Tabs strip is
// hidden and each pane gets its own mini-strip showing only the tabs in
// that leaf — click a pill to focus, X to close, "+" to add a tab from
// any open workspace's tab list (cross-workspace via PaneAddPopover).

type PaneTabPillData = {
  ref: WorkPaneRef;
  label: string;
  sub: string;
  agentId?: string;
  foreign: boolean;
};

// A tab label must NEVER read as a raw machine id. A vibecoder seeing
// "019ec07e-b3f8-756…" on a tab has no idea what it is — a "don't make
// them think" violation. Some restore paths (a session persisted before
// title auto-generation, an imported run with no first prompt) can leave
// an opaque id in the label slot, so we guard at the single chokepoint
// every tab pill flows through rather than trusting ~20 producers.
const OPAQUE_ID_RE = /^[0-9a-f]{8}-?[0-9a-f]{4}|^[0-9a-f]{16,}$/i;

function looksLikeOpaqueId(s: string): boolean {
  return OPAQUE_ID_RE.test(s.trim());
}

// Plain-language stand-in when a producer handed us nothing usable.
// Keyed on the pane kind so the fallback still says *what* the tab is.
function fallbackLabelForKind(kind: WorkPaneRef["kind"]): string {
  switch (kind) {
    case "agent":
    case "manager":
      return "Chat";
    case "task":
      return "Task";
    case "terminal":
      return "Terminal";
    case "file":
      return "File";
    case "plan":
      return "Plan";
    default:
      return "Untitled";
  }
}

// Last-mile sanitizer: empty or id-shaped labels become a readable
// kind-based fallback; everything else passes through untouched.
function humanizeTabLabel(label: string, ref: WorkPaneRef): string {
  const trimmed = (label ?? "").trim();
  if (!trimmed || looksLikeOpaqueId(trimmed)) {
    return fallbackLabelForKind(ref.kind);
  }
  return trimmed;
}

function describeRef(
  ref: WorkPaneRef,
  store: ReturnType<typeof useEditorStore>,
  currentRepoRoot: string,
  pagesActiveTitle?: string | null,
): PaneTabPillData | null {
  const data = describeRefRaw(ref, store, currentRepoRoot, pagesActiveTitle);
  if (!data) return null;
  // One chokepoint so no pane kind — present or future — can leak a raw
  // id onto a tab pill.
  return { ...data, label: humanizeTabLabel(data.label, ref) };
}

function describeRefRaw(
  ref: WorkPaneRef,
  store: ReturnType<typeof useEditorStore>,
  currentRepoRoot: string,
  pagesActiveTitle?: string | null,
): PaneTabPillData | null {
  if (ref.kind === "agent") {
    const t = store.agentTabs.find((x) => x.sessionId === ref.id);
    if (!t) return null;
    return {
      ref,
      label: t.agentLabel,
      sub: shortRoot(t.repoRoot),
      agentId: t.agentId,
      foreign: t.repoRoot !== currentRepoRoot,
    };
  }
  if (ref.kind === "terminal") {
    const t = store.terminalTabs.find((x) => x.termId === ref.id);
    if (!t) return null;
    return {
      ref,
      label: t.label ?? "Terminal",
      sub: shortRoot(t.cwd),
      foreign: t.cwd !== currentRepoRoot,
    };
  }
  if (ref.kind === "manager") {
    const t = store.managerTabs.find((x) => x.sessionId === ref.id);
    if (!t) return null;
    return {
      ref,
      label: t.label || "Manager",
      sub: t.sessionId.slice(0, 8),
      agentId: "aura-manager",
      foreign: false,
    };
  }
  if (ref.kind === "plan") {
    const p = store.planTabs.find((x) => x.id === ref.id);
    if (!p) return null;
    return {
      ref,
      label: p.title || "Plan",
      sub: `${p.todos.length} todo${p.todos.length === 1 ? "" : "s"}`,
      agentId: "aura-manager",
      foreign: false,
    };
  }
  if (ref.kind === "file") {
    const f = store.files.find((x) => x.path === ref.path);
    return {
      ref,
      label: f?.name ?? baseName(ref.path),
      sub: dirName(ref.path),
      foreign: false,
    };
  }
  if (ref.kind === "tasks") {
    return {
      ref,
      label: "Tasks",
      sub: shortRoot(ref.id),
      foreign: ref.id !== currentRepoRoot,
    };
  }
  if (ref.kind === "standup") {
    return {
      ref,
      label: "Standup",
      sub: shortRoot(ref.id),
      foreign: ref.id !== currentRepoRoot,
    };
  }
  if (ref.kind === "automations") {
    return {
      ref,
      label: "Automations",
      sub: shortRoot(ref.id),
      foreign: ref.id !== currentRepoRoot,
    };
  }
  if (ref.kind === "channels") {
    return {
      ref,
      label: "Team",
      sub: shortRoot(ref.id),
      foreign: ref.id !== currentRepoRoot,
    };
  }
  if (ref.kind === "commons") {
    return {
      ref,
      label: "Commons",
      sub: shortRoot(ref.id),
      foreign: ref.id !== currentRepoRoot,
    };
  }
  if (ref.kind === "app") {
    // `<pluginId>:<appId>` — show the app id as the pill label so a
    // launched mini-app reads as e.g. "Gemini" not the raw composite.
    const sep = ref.id.lastIndexOf(":");
    const appId = sep > 0 ? ref.id.slice(sep + 1) : ref.id;
    const pluginId = sep > 0 ? ref.id.slice(0, sep) : ref.id;
    return {
      ref,
      label: appId,
      sub: pluginId,
      foreign: false,
    };
  }
  if (ref.kind === "screenshare") {
    // Parse `<repoRoot>::<channel>` for the sub-label so the tab pill
    // shows e.g. `Screen · #design` instead of the raw composite id.
    const sep = ref.id.indexOf("::");
    const channel = sep > 0 ? ref.id.slice(sep + 2) : ref.id;
    const refRoot = sep > 0 ? ref.id.slice(0, sep) : ref.id;
    return {
      ref,
      label: "Screen",
      sub: `#${channel}`,
      foreign: refRoot !== currentRepoRoot,
    };
  }
  if (ref.kind === "pages") {
    // The pages pane stays a single repoRoot-keyed tab; only its LABEL
    // tracks the open page. Falls back to "Pages" before the first
    // `aura:pages:summaries` fires or when no page is open.
    const title = pagesActiveTitle?.trim();
    return {
      ref,
      label: title && title.length > 0 ? title : "Pages",
      sub: shortRoot(ref.id),
      foreign: ref.id !== currentRepoRoot,
    };
  }
  if (ref.kind === "trace") {
    const label =
      ref.tool === "review"
        ? "Safety check"
        : ref.tool === "rewind"
          ? "Time machine"
          : ref.tool === "attest"
            ? "Genuine record"
            : ref.tool === "memory"
              ? "Memory"
              : "Repo health";
    return { ref, label, sub: label, foreign: false };
  }
  if (ref.kind === "sessions") {
    // Label derives from the tab's OWN view (encoded in its id), not the
    // global traceView — that's what lets the four views coexist as
    // distinctly-labelled tabs in one strip.
    const v = sessionsViewFromId(ref.id);
    const label =
      v === "sessions"
        ? "My sessions"
        : v === "team"
          ? "Team activity"
          : v === "usage"
            ? "Cost & usage"
            : "Overview";
    return { ref, label, sub: label, foreign: false };
  }
  if (ref.kind === "inspector") {
    return { ref, label: "Change story", sub: "Change story", foreign: false };
  }
  if (ref.kind === "replay") {
    return { ref, label: "Proof trail", sub: "Proof every change is genuine", foreign: false };
  }
  if (ref.kind === "prove") {
    return { ref, label: "Goals", sub: "Prove a goal", foreign: false };
  }
  if (ref.kind === "graph") {
    return { ref, label: "Code Map", sub: "Map of your code", foreign: false };
  }
  if (ref.kind === "task") {
    // A task DETAIL pane. The task title isn't in `store` (the board owns
    // it), so the pill reads a plain "Task" — humanizeTabLabel would have
    // turned the raw UUID id into the same word anyway, but naming it here
    // keeps the hover sub honest (the id) instead of "pick something".
    return {
      ref,
      label: "Task",
      sub: ref.repoRoot !== currentRepoRoot ? shortRoot(ref.repoRoot) : "Task detail",
      foreign: ref.repoRoot !== currentRepoRoot,
    };
  }
  if (ref.kind === "empty") {
    return { ref, label: "New tab", sub: "pick something", foreign: false };
  }
  return { ref, label: "Untitled", sub: "pick something", foreign: false };
}

/** Pin rank for the unified tab strip: agent/manager tabs (the Claude
 *  session) sort first so they stay leftmost and are never lost behind a
 *  later-opened page; every other page keeps its open order. Array.sort is
 *  stable, so same-rank tabs hold their relative order. */
function pinRank(ref: WorkPaneRef): number {
  return ref.kind === "agent" || ref.kind === "manager" ? 0 : 1;
}

function PerPaneTabStrip({
  leaf,
  paneIndex,
  currentRepoRoot,
}: {
  leaf: WorkSplitLeaf;
  paneIndex: number;
  currentRepoRoot: string;
}) {
  const store = useEditorStore();
  const [addOpen, setAddOpen] = useState(false);
  const [overTab, setOverTab] = useState(false);
  // Live title of the currently-open page — the pages tab pill reads this
  // instead of the static word "Pages". Null until a page is open.
  const pagesActiveTitle = usePagesActiveTitle();

  // Cross-pane drag mime — encodes `{srcPaneId, srcIndex}` as
  // `<paneId>:<index>` so a drop on a different pane's strip can call
  // moveTabBetweenPanes. Independent from the per-strip
  // `application/x-aura-tab-*` reorder mimes, which are global-strip
  // scoped and don't speak in pane ids.
  const CROSS_PANE_MIME = "application/x-aura-cross-pane-tab";

  function onStripDragOver(e: React.DragEvent<HTMLDivElement>) {
    if (!Array.from(e.dataTransfer.types).includes(CROSS_PANE_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (!overTab) setOverTab(true);
  }
  function onStripDrop(e: React.DragEvent<HTMLDivElement>) {
    setOverTab(false);
    const raw = e.dataTransfer.getData(CROSS_PANE_MIME);
    if (!raw) return;
    const sep = raw.lastIndexOf(":");
    if (sep < 0) return;
    const srcPaneId = raw.slice(0, sep);
    const srcIndex = parseInt(raw.slice(sep + 1), 10);
    if (Number.isNaN(srcIndex)) return;
    if (srcPaneId === leaf.paneId) return;
    e.preventDefault();
    store.moveTabBetweenPanes(srcPaneId, srcIndex, leaf.paneId);
  }

  return (
    <div
      className={`flex items-stretch h-8 flex-shrink-0 bg-bg-chrome border-b border-line-soft ${
        overTab ? "outline outline-1 outline-accent-blue -outline-offset-1" : ""
      }`}
      onDragOver={onStripDragOver}
      onDragLeave={() => setOverTab(false)}
      onDrop={onStripDrop}
    >
      <div className="flex items-stretch flex-1 min-w-0 overflow-x-auto no-scrollbar">
        {leaf.tabs
          // Unified tab bar: every opened page is a visible tab and nothing is
          // ever hidden. Agent/manager tabs (the Claude session) pin leftmost so
          // they're never lost; everything else keeps open order. The mapped
          // `idx` stays the real leaf index, so click/close/drag stay correct.
          .map((ref, idx) => ({ ref, idx }))
          .sort((a, b) => pinRank(a.ref) - pinRank(b.ref))
          .map(({ ref, idx }) => {
          const data = describeRef(ref, store, currentRepoRoot, pagesActiveTitle);
          if (!data) return null;
          const isActive = idx === leaf.activeIndex;
          const tabButton = (
            <button
              key={`${leaf.paneId}-${idx}-${data.label}`}
              type="button"
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(
                  CROSS_PANE_MIME,
                  `${leaf.paneId}:${idx}`,
                );
                // A terminal tab also speaks the panel list's mime, so it
                // can be dragged back down into the bottom Terminal panel —
                // dropped on a group it tiles in; dropped on empty list
                // space it becomes its own row (TerminalTabsList handles
                // both via onMerge / onDemote).
                if (ref.kind === "terminal") {
                  e.dataTransfer.setData("application/x-aura-term", ref.id);
                }
                e.dataTransfer.effectAllowed = "move";
              }}
              // macOS WKWebView suppresses the synthetic `click` on elements
              // with `draggable=true` (it starts drag-tracking on mousedown and
              // never dispatches the click), so a plain onClick here silently
              // dropped tab activation — clicking a Pages/Tasks/file tab in a
              // split pane did nothing. Drive activation off mousedown (left
              // button only) instead, exactly like the global Tabs strip does;
              // a real drag still goes through onDragStart untouched.
              onMouseDown={(e) => {
                if (e.button === 0) store.setActiveTabInPane(leaf.paneId, idx);
              }}
              className={`group flex items-center gap-1.5 px-2 h-full text-[11.5px] border-r border-line-soft transition-colors ${
                isActive
                  ? "bg-bg-content text-text-1"
                  : "text-text-3 hover:text-text-1 hover:bg-bg-2"
              }`}
              title={data.sub}
            >
              <span className="w-3.5 h-3.5 flex items-center justify-center flex-shrink-0">
                {data.agentId ? (
                  <AgentIcon agentId={data.agentId} size={11} />
                ) : ref.kind === "terminal" ? (
                  <span className="text-[10px] opacity-70">▤</span>
                ) : ref.kind === "file" ? (
                  <span className="text-[10px] opacity-70">⌘</span>
                ) : null}
              </span>
              <span className="truncate max-w-[140px]">{data.label}</span>
              {data.foreign && (
                <span className="text-[9px] uppercase tracking-wider text-text-4 px-1 rounded bg-bg-2 border border-line-soft">
                  ext
                </span>
              )}
              <span
                role="button"
                tabIndex={-1}
                // Same WKWebView draggable-click drop as the parent button —
                // the × is inside the draggable tab, so onClick was unreliable.
                // Fire on mousedown (left button) and stop propagation so the
                // tab doesn't also activate.
                onMouseDown={(e) => {
                  if (e.button !== 0) return;
                  e.stopPropagation();
                  store.closeTabInPane(leaf.paneId, idx);
                }}
                className="ml-1 w-3.5 h-3.5 inline-flex items-center justify-center rounded text-text-5 opacity-0 group-hover:opacity-100 hover:bg-bg-3 hover:text-text-1 transition-opacity"
                title="Close tab"
              >
                ×
              </span>
            </button>
          );
          // Agent tabs in a split pane get the same right-click menu as the
          // global strip's agent tabs — the actions fire at the live
          // AgentSurface for this session via the pane-action bridge. A
          // pane here is by definition in the split, and "Close this pane"
          // is offered once the split has more than two panes.
          if (ref.kind === "agent") {
            const items = buildAgentTabMenuItems({
              sessionId: ref.id,
              inSplit: true,
              canClosePane: treePaneCount(store.splitLayout) > 2,
            });
            return (
              <ContextMenu key={`${leaf.paneId}-${idx}-${data.label}`}>
                <ContextMenuTrigger asChild>{tabButton}</ContextMenuTrigger>
                <ContextMenuContent className="min-w-[12rem]">
                  {items.map((item, i) =>
                    item.kind === "separator" ? (
                      <ContextMenuSeparator key={`sep-${i}`} />
                    ) : (
                      <ContextMenuItem
                        key={item.label}
                        disabled={item.disabled}
                        variant={item.tone === "danger" ? "destructive" : "default"}
                        onSelect={item.onSelect}
                      >
                        {item.label}
                      </ContextMenuItem>
                    ),
                  )}
                </ContextMenuContent>
              </ContextMenu>
            );
          }
          // Chat tabs in a split pane carry the same right-click controls the
          // old `.p-tabs` header bar held — split/details/loop/compare/cancel
          // fire at the live ManagerSurface via the pane-action bridge.
          if (ref.kind === "manager") {
            const items = buildManagerTabMenuItems({ sessionId: ref.id });
            return (
              <ContextMenu key={`${leaf.paneId}-${idx}-${data.label}`}>
                <ContextMenuTrigger asChild>{tabButton}</ContextMenuTrigger>
                <ContextMenuContent className="min-w-[12rem]">
                  {items.map((item, i) =>
                    item.kind === "separator" ? (
                      <ContextMenuSeparator key={`sep-${i}`} />
                    ) : (
                      <ContextMenuItem
                        key={item.label}
                        disabled={item.disabled}
                        variant={item.tone === "danger" ? "destructive" : "default"}
                        onSelect={item.onSelect}
                      >
                        {item.label}
                      </ContextMenuItem>
                    ),
                  )}
                </ContextMenuContent>
              </ContextMenu>
            );
          }
          return tabButton;
        })}
      </div>
      <div className="relative flex items-stretch flex-shrink-0">
        <button
          type="button"
          onClick={() => setAddOpen((v) => !v)}
          title="Add tab from any workspace"
          className="px-2 h-full text-[12px] text-text-3 hover:text-text-1 hover:bg-bg-2 transition-colors border-l border-line-soft"
        >
          +
        </button>
        {addOpen && (
          <PaneAddPopover
            leaf={leaf}
            paneIndex={paneIndex}
            currentRepoRoot={currentRepoRoot}
            onClose={() => setAddOpen(false)}
          />
        )}
      </div>
    </div>
  );
}

function PaneAddPopover({
  leaf,
  paneIndex: _paneIndex,
  currentRepoRoot,
  onClose,
}: {
  leaf: WorkSplitLeaf;
  paneIndex: number;
  currentRepoRoot: string;
  onClose: () => void;
}) {
  const store = useEditorStore();
  const [filter, setFilter] = useState("");
  const ref = useRef<HTMLDivElement | null>(null);

  // Outside-click + Esc close.
  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const candidates = useMemo<PaneTabPillData[]>(() => {
    const inThisPane = (r: WorkPaneRef) => leaf.tabs.some((x) => samePaneRef(x, r));
    const out: PaneTabPillData[] = [];
    for (const t of store.agentTabs) {
      const r: WorkPaneRef = { kind: "agent", id: t.sessionId };
      if (inThisPane(r)) continue;
      out.push({
        ref: r,
        label: t.agentLabel,
        sub: shortRoot(t.repoRoot),
        agentId: t.agentId,
        foreign: t.repoRoot !== currentRepoRoot,
      });
    }
    for (const t of store.terminalTabs) {
      const r: WorkPaneRef = { kind: "terminal", id: t.termId };
      if (inThisPane(r)) continue;
      out.push({
        ref: r,
        label: t.label ?? "Terminal",
        sub: shortRoot(t.cwd),
        foreign: t.cwd !== currentRepoRoot,
      });
    }
    for (const t of store.managerTabs) {
      const r: WorkPaneRef = { kind: "manager", id: t.sessionId };
      if (inThisPane(r)) continue;
      out.push({
        ref: r,
        label: t.label || "Manager",
        sub: t.sessionId.slice(0, 8),
        agentId: "aura-manager",
        foreign: false,
      });
    }
    for (const p of store.planTabs) {
      const r: WorkPaneRef = { kind: "plan", id: p.id };
      if (inThisPane(r)) continue;
      out.push({
        ref: r,
        label: p.title || "Plan",
        sub: `${p.todos.length} todo${p.todos.length === 1 ? "" : "s"}`,
        agentId: "aura-manager",
        foreign: false,
      });
    }
    for (const f of store.files) {
      const r: WorkPaneRef = { kind: "file", path: f.path };
      if (inThisPane(r)) continue;
      out.push({
        ref: r,
        label: f.name,
        sub: dirName(f.path),
        foreign: false,
      });
    }
    const q = filter.trim().toLowerCase();
    if (!q) return out;
    return out.filter(
      (c) =>
        c.label.toLowerCase().includes(q) || c.sub.toLowerCase().includes(q),
    );
  }, [
    leaf.tabs,
    store.agentTabs,
    store.terminalTabs,
    store.managerTabs,
    store.planTabs,
    store.files,
    currentRepoRoot,
    filter,
  ]);

  return (
    <div
      ref={ref}
      className="absolute right-0 top-full mt-1 z-30 w-72 max-h-80 overflow-hidden rounded-lg border border-line-soft bg-bg-1 shadow-[var(--shadow-flyout)] flex flex-col"
    >
      <div className="px-2 py-2 border-b border-line-soft">
        <Input
          autoFocus
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Add tab from any workspace…"
          className="h-7 text-[12px]"
        />
      </div>
      <div className="flex-1 overflow-y-auto">
        {candidates.length === 0 ? (
          <div className="px-3 py-4 text-center text-text-4 text-[11.5px]">
            Nothing else open. Spawn an agent or terminal in the workspace
            rail.
          </div>
        ) : (
          <ul className="py-1">
            {candidates.map((c) => (
              <li key={`${c.ref.kind}:${(c.ref as { id?: string; path?: string }).id ?? (c.ref as { path?: string }).path ?? ""}`}>
                <button
                  type="button"
                  onClick={() => {
                    store.addTabToPane(leaf.paneId, c.ref);
                    onClose();
                  }}
                  className="w-full flex items-center gap-2 px-3 h-8 text-left hover:bg-bg-2 transition-colors"
                >
                  <span className="w-4 h-4 flex items-center justify-center flex-shrink-0">
                    {c.agentId ? (
                      <AgentIcon agentId={c.agentId} size={12} />
                    ) : c.ref.kind === "terminal" ? (
                      <span className="text-[11px] opacity-70">▤</span>
                    ) : (
                      <span className="text-[11px] opacity-70">⌘</span>
                    )}
                  </span>
                  <span className="text-[12px] text-text-1 truncate">{c.label}</span>
                  <span className="text-[10.5px] text-text-5 font-mono truncate ml-auto">
                    {c.sub}
                  </span>
                  {c.foreign && (
                    <span className="ml-1 text-[9px] uppercase tracking-wider text-text-4 px-1 rounded bg-bg-2 border border-line-soft">
                      ext
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** Calm fallback when a persisted pane references a feature that is gated off
 *  (e.g. a stale Commons / mini-app leaf after the community platform was
 *  hidden). Keeps a restored split-tree from showing a broken pane. */
function PaneUnavailable() {
  return (
    <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-1 text-center px-6 bg-bg-0">
      <div className="text-[13px] text-text-2">Not available</div>
      <div className="text-[11px] text-text-3 max-w-[260px]">
        This surface is turned off. You can close this tab.
      </div>
    </div>
  );
}

function baseName(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

function dirName(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}
