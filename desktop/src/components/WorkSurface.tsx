// The big middle pane when files are open: tabs across the top, editor
// below. A toggle in the toolbar swaps the editor for a side-by-side
// diff against HEAD. ⌘S saves the active tab. Empty state (no tabs) is
// rendered by the parent — this component only fires when at least one
// file is open.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { Tabs } from "./Tabs";
import { MonacoEditor as Editor } from "./MonacoEditor";
import { DiffView } from "./DiffView";
import { EditorBreadcrumbs } from "./EditorBreadcrumbs";
import { EditorInlineComposer } from "./editor/EditorInlineComposer";
import { MarkdownView } from "./MarkdownView";
import { SegmentedControl } from "./ui/segmented";
import { AsciiSpinner } from "./ui/ascii-spinner";
import { Input } from "./ui/input";
import { FileInsightStrip } from "./FileInsightStrip";
import { AgentSurface, buildAgentTabMenuItems, type AgentTabMenuItem } from "./agent/AgentSurface";
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
import { WorkspaceSetupFeed } from "./workpanes/WorkspaceSetupFeed";
import { useInFlight, dismissInFlight } from "../lib/workspaceInFlightStore";
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
  treeLeafNodes,
  treeAllRefs,
  treePaneCount,
  sessionsViewFromId,
  openBrowserTab,
  newBrowserTabId,
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
import {
  useBrowserTabTitles,
  type BrowserTabMeta,
} from "../lib/browserTabTitles";
import { hostOf } from "../lib/browserEngine";
import { BrowserTab, reapBrowserTabs } from "./workpanes/BrowserTab";

/** Background for a terminal that lives inside a split. A hair cooler +
 *  darker than the editor panes (bg-content ≈ #161618) and the default xterm
 *  (#1e1e1e), so a split terminal reads as its own surface. Only the split
 *  path passes this; single-pane + bottom-panel terminals keep exact VSCode
 *  parity (#1e1e1e). */
const SPLIT_TERMINAL_BG = "#1a1a1f";

/** Smallest fraction of a split axis a single pane may shrink to while the
 *  user drags a divider — keeps a pane from collapsing to nothing. */
const MIN_PANE_FRACTION = 0.1;

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
  const inFlight = useInFlight();
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

  // Reap browser webviews whose tab left the layout. Only the active tab in a
  // leaf is mounted, so a BrowserTab body unmounting can't tell "switched away"
  // from "closed" — it always just hides. This central pass, keyed on the set
  // of browser ids STILL present (every tab, not just active), is the one place
  // a browser webview is actually destroyed.
  const browserIdsKey = useMemo(() => {
    if (!splitLayout) return "";
    const ids = treeAllRefs(splitLayout)
      .filter((r) => r.kind === "browser")
      .map((r) => (r as { id: string }).id);
    return ids.sort().join("|");
  }, [splitLayout]);
  useEffect(() => {
    const active = new Set(browserIdsKey ? browserIdsKey.split("|") : []);
    reapBrowserTabs(active);
  }, [browserIdsKey]);
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
    const renderTree = (node: WorkSplitTree, path: number[] = []): ReactNode => {
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
      // Split node — a resizable flex container. Each child is wrapped in a
      // flex-grow cell (weights from `node.sizes`, equal when absent) with a
      // draggable divider between siblings. The divider commits new weights
      // to the store on drop (persisted via SPLIT_LAYOUT_VERSION v3). `path`
      // addresses this node so the commit targets the right split.
      return (
        <SplitContainer
          key={`split-${path.join(".")}-${node.direction}-${node.children.length}`}
          direction={node.direction}
          sizes={node.sizes}
          onCommitSizes={(w) => store.setSplitSizes(path, w)}
        >
          {node.children.map((child, i) => renderTree(child, [...path, i]))}
        </SplitContainer>
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

  // Setup-feed gate: the moment you're switched INTO a freshly created copy,
  // show the Conductor-style provisioning feed full-pane (in place of the
  // empty chat / booting agent) until the launch resolves, then hand off to
  // the live workspace. Matched by the new worktree's own path so it only
  // ever fires in the new copy — never nags the workspace you launched from.
  // `worktreePath` is set at "spawning", i.e. the instant the switch happens.
  // Guard `worktreePath !== repoRoot(source)`: a non-git folder launch runs
  // the agent in the folder itself (path === source), where nothing was
  // branched or copied — showing the "new copy" feed there would be a lie and
  // would cover the workspace you're standing in. Only a real managed copy
  // (a distinct path) gets the feed.
  const provisioning = inFlight.find(
    (e) =>
      !!e.worktreePath &&
      e.worktreePath.replace(/\/+$/, "") !== e.repoRoot.replace(/\/+$/, "") &&
      e.worktreePath.replace(/\/+$/, "") === repoRoot.replace(/\/+$/, ""),
  );
  if (provisioning) {
    const fallbackName = projectName ?? repoRoot.split("/").pop() ?? repoRoot;
    return (
      <WorkspaceSetupFeed
        entry={provisioning}
        projectName={fallbackName}
        onEnter={() => dismissInFlight(provisioning.key)}
      />
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
            <div className="absolute bottom-20 left-1/2 -translate-x-1/2 z-10 rounded-md shadow-lg shadow-black/30">
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
          {active.status === "ok" && !showDiff && (
            <EditorInlineComposer
              repoRoot={repoRoot}
              filePath={active.path}
              fileLabel={
                active.path.startsWith(repoRoot + "/")
                  ? active.path.slice(repoRoot.length + 1)
                  : active.name
              }
            />
          )}
          {active.status !== "ok" ? (
            <FilePreviewOrPlaceholder file={active} />
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
          // Split-only: a hair cooler/darker than the editor panes (bg-content
          // #161618) and the default xterm (#1e1e1e), so a terminal reads as a
          // distinct surface once the work area is split. Single-pane + panel
          // terminals never get this and keep exact VSCode parity.
          bgTint={SPLIT_TERMINAL_BG}
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
    if (pane.kind === "browser") {
      return (
        <BrowserTab
          tabId={pane.id}
          initialUrl={pane.url}
          onNewTab={() => openBrowserTab()}
          onClose={closePane}
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
      // The Team navigator remains in the sidebar. This workpane owns only
      // the selected conversation and its synchronized detail/canvas panes.
      return (
        <TeamSurface
          repoRoot={pane.repoRoot}
          projectName={channelsName}
          mode="detail"
        />
      );
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
  | { kind: "pages"; ref: WorkPaneRef; repoRoot: string }
  | { kind: "browser"; ref: WorkPaneRef; id: string; url?: string };

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
  if (ref.kind === "browser") {
    return { kind: "browser", ref, id: ref.id, url: ref.url };
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

/** Coerce a persisted `sizes` array into a valid weight list of length `n`.
 *  Falls back to equal weights when absent, wrong-length, or non-finite. */
function normalizeWeights(sizes: number[] | undefined, n: number): number[] {
  if (
    sizes &&
    sizes.length === n &&
    sizes.every((x) => typeof x === "number" && isFinite(x) && x > 0)
  ) {
    return sizes.slice();
  }
  return Array(n).fill(1);
}

/** The 1px divider between two split cells, widened into a grabbable gutter.
 *  Shows the accent while hovered or dragging. Pointer capture (set by the
 *  parent's onDown) keeps the drag alive when the cursor leaves the line. */
function ResizeHandle({
  isRow,
  dragging,
  onDown,
  onMove,
  onUp,
}: {
  isRow: boolean;
  dragging: boolean;
  onDown: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onMove: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onUp: (e: ReactPointerEvent<HTMLDivElement>) => void;
}) {
  return (
    <div
      role="separator"
      aria-orientation={isRow ? "vertical" : "horizontal"}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      className={`relative flex-shrink-0 z-10 group/resize ${
        isRow ? "w-px cursor-col-resize" : "h-px cursor-row-resize"
      }`}
    >
      {/* Invisible hit zone, ~13px wide, centered on the 1px line. */}
      <div
        className={`absolute ${
          isRow ? "inset-y-0 -left-1.5 -right-1.5" : "inset-x-0 -top-1.5 -bottom-1.5"
        }`}
      />
      {/* The visible divider line. */}
      <div
        className={`absolute ${isRow ? "inset-y-0 left-0 w-px" : "inset-x-0 top-0 h-px"} ${
          dragging
            ? "bg-[var(--accent-blue,#3b82f6)]"
            : "bg-line-soft group-hover/resize:bg-[var(--accent-blue,#3b82f6)]"
        }`}
      />
    </div>
  );
}

/** A resizable N-way split. Each child sits in a flex-grow cell (weights from
 *  `sizes`, equal when absent) with a draggable divider between siblings. A
 *  drag adjusts only the two panes it sits between (their combined weight is
 *  held constant, so the rest don't move), updates local weights live, and
 *  commits the final proportions via `onCommitSizes` on release — which the
 *  store persists. Children are stable elements, so live weight changes
 *  re-render only this container, not the panes inside it. */
function SplitContainer({
  direction,
  sizes,
  onCommitSizes,
  children,
}: {
  direction: WorkSplitDirection;
  sizes?: number[];
  onCommitSizes: (weights: number[]) => void;
  children: ReactNode;
}) {
  const kids = Array.isArray(children) ? (children as ReactNode[]) : [children];
  const n = kids.length;
  const isRow = direction === "row";
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [weights, setWeights] = useState<number[]>(() => normalizeWeights(sizes, n));
  const [activeBoundary, setActiveBoundary] = useState<number | null>(null);
  // Re-seed on a persisted-sizes change or a child-count change: a structural
  // mutation (split / close / reorder) arrives as a new count and resets to
  // equal; a restore or a just-committed drag arrives as new `sizes`.
  const sizesKey = sizes ? sizes.join(",") : "";
  useEffect(() => {
    setWeights(normalizeWeights(sizes, n));
  }, [sizesKey, n]);

  const drag = useRef<
    | null
    | { boundary: number; startPos: number; axisPx: number; base: number[] }
  >(null);

  const onDown = (boundary: number) => (e: ReactPointerEvent<HTMLDivElement>) => {
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const axisPx = isRow ? rect.width : rect.height;
    if (axisPx <= 0) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drag.current = {
      boundary,
      startPos: isRow ? e.clientX : e.clientY,
      axisPx,
      base: weights.slice(),
    };
    setActiveBoundary(boundary);
    e.preventDefault();
  };

  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const total = d.base.reduce((a, b) => a + b, 0);
    const deltaPx = (isRow ? e.clientX : e.clientY) - d.startPos;
    const deltaW = (deltaPx / d.axisPx) * total;
    const a = d.boundary - 1;
    const b = d.boundary;
    const pairSum = d.base[a] + d.base[b];
    // Floor each pane in the pair. Cap the floor at 40% of the pair so an
    // already-small pair can't invert the clamp bounds into a negative weight.
    const minW = Math.min(total * MIN_PANE_FRACTION, pairSum * 0.4);
    let wa = d.base[a] + deltaW;
    wa = Math.max(minW, Math.min(pairSum - minW, wa));
    const next = d.base.slice();
    next[a] = wa;
    next[b] = pairSum - wa;
    setWeights(next);
  };

  const onUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    setActiveBoundary(null);
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    setWeights((w) => {
      onCommitSizes(w);
      return w;
    });
  };

  return (
    <div
      ref={containerRef}
      className={`flex-1 min-h-0 min-w-0 flex ${isRow ? "flex-row" : "flex-col"}`}
    >
      {kids.map((child, i) => {
        const cell = (
          <div
            key={`cell-${i}`}
            className="flex min-h-0 min-w-0 overflow-hidden"
            style={{ flexGrow: weights[i] ?? 1, flexBasis: 0 }}
          >
            {child}
          </div>
        );
        if (i === 0) return cell;
        return [
          <ResizeHandle
            key={`rh-${i}`}
            isRow={isRow}
            dragging={activeBoundary === i}
            onDown={onDown(i)}
            onMove={onMove}
            onUp={onUp}
          />,
          cell,
        ];
      })}
    </div>
  );
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
      {/* No corner grip. The pane's tab strip is itself the drag handle
          (PerPaneTabStrip makes its empty area draggable and emits this same
          `application/x-aura-split-pane` mime), which keeps the strip's
          top-right corner clear for the "+" button — a grip pinned there sat
          on top of "+" and swallowed its clicks. SplitPaneShell stays the
          drop target via the onDragOver/onDrop above; `canDrag` still gates
          that. */}
      {children}
    </div>
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
  bgTint,
}: {
  tab: TerminalTab;
  /** Workspace root — keys scrollback save/prune and resolves the launch
   *  profile, so an editor-area terminal restores exactly like a panel one. */
  repoRoot: string;
  /** Split-only background override (see Terminal's `bgTint`) — makes a
   *  terminal pane read as a distinct surface from the editor panes beside
   *  it. Absent for single-pane / panel terminals. */
  bgTint?: string;
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
    <div
      className="h-full w-full flex flex-col bg-bg-content"
      style={bgTint ? { backgroundColor: bgTint } : undefined}
    >
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
          bgTint={bgTint}
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
        ) : file.status === "binary" && isImagePath(file.path) ? (
          <ImagePreview path={file.path} name={fileBasename(file.path)} />
        ) : (
          <FilePreviewOrPlaceholder file={file} />
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

/** Basename of a path — the file's own name, no directory. */
function fileBasename(path: string): string {
  return path.split("/").pop() || path;
}

// Image extensions we can preview inline. The editor loads these as `binary`
// (they aren't text), so without this they'd dead-end on "Binary file".
const IMAGE_EXTS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "ico",
  "avif",
  "svg",
]);

/** Does this path point at an image we can render inline? Extension-based —
 *  matches how a file browser decides, and cheap (no byte read). */
function isImagePath(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_EXTS.has(ext);
}

/** Inline image preview for a binary image file. Reads the bytes as base64
 *  (`read_file_base64`) and renders the real picture, contained to the pane —
 *  so screenshots, logos and design assets show like they do in any file
 *  browser instead of a "Binary file" dead end. A non-image or unreadable
 *  file falls back to the plain "Binary file" line. */
function ImagePreview({ path, name }: { path: string; name: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    setSrc(null);
    setFailed(false);
    api
      .readFileBase64(path)
      .then((f) => {
        if (!alive) return;
        if (f.is_image && f.data_base64) {
          setSrc(`data:${f.media_type};base64,${f.data_base64}`);
        } else {
          setFailed(true);
        }
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [path]);

  if (failed) {
    return (
      <div className="h-full w-full flex items-center justify-center bg-bg-content text-text-4 text-[12px]">
        Binary file
      </div>
    );
  }
  if (!src) {
    return (
      <div className="h-full w-full flex items-center justify-center bg-bg-content">
        <AsciiSpinner />
      </div>
    );
  }
  return (
    <div className="h-full w-full overflow-auto bg-bg-content p-4 flex items-center justify-center">
      <img
        src={src}
        alt={name}
        className="max-w-full max-h-full object-contain rounded"
      />
    </div>
  );
}

type PreviewFile = { status: string; size: number; name: string; path: string };

function previewKind(path: string): "image" | "pdf" | "audio" | "video" | null {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif"].includes(ext)) {
    return "image";
  }
  if (ext === "pdf") return "pdf";
  if (["mp3", "wav", "m4a", "aac", "ogg", "flac"].includes(ext)) return "audio";
  if (["mp4", "mov", "webm", "m4v"].includes(ext)) return "video";
  return null;
}

/** Preview common design/reference assets directly from disk through Tauri's
 *  scoped asset protocol. Unknown binary formats retain the honest fallback. */
function FilePreviewOrPlaceholder({ file }: { file: PreviewFile }) {
  const kind = previewKind(file.path);
  if (!kind) return <UnreadablePlaceholder file={file} />;
  const src = convertFileSrc(file.path);
  if (kind === "image") {
    return (
      <div className="h-full w-full overflow-auto flex items-center justify-center bg-bg-content p-6">
        <img
          src={src}
          alt={file.name}
          className="max-w-full max-h-full object-contain rounded-md shadow-lg"
        />
      </div>
    );
  }
  if (kind === "pdf") {
    return (
      <iframe
        src={src}
        title={file.name}
        className="h-full w-full border-0 bg-white"
      />
    );
  }
  return (
    <div className="h-full w-full flex items-center justify-center bg-bg-content p-8">
      {kind === "audio" ? (
        <audio src={src} controls className="w-full max-w-xl" />
      ) : (
        <video src={src} controls className="max-h-full max-w-full rounded-md shadow-lg" />
      )}
    </div>
  );
}

function UnreadablePlaceholder({ file }: { file: PreviewFile }) {
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
    case "browser":
      return "Browser";
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
  browserTitles?: Record<string, BrowserTabMeta>,
): PaneTabPillData | null {
  const data = describeRefRaw(
    ref,
    store,
    currentRepoRoot,
    pagesActiveTitle,
    browserTitles,
  );
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
  browserTitles?: Record<string, BrowserTabMeta>,
): PaneTabPillData | null {
  if (ref.kind === "browser") {
    // Label tracks the live page: title first, then host, then a plain
    // "New tab" for a blank start page. `sub` shows the host so the pill
    // reads e.g. "Aura docs · auravcs.com".
    const meta = browserTitles?.[ref.id];
    const host = meta?.url ? hostOf(meta.url) : ref.url ? hostOf(ref.url) : "";
    const title = meta?.title?.trim();
    return {
      ref,
      label: title && title.length > 0 ? title : host || "New tab",
      sub: host || "Browser",
      foreign: false,
    };
  }
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
  const browserTitles = useBrowserTabTitles();

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

  // Sibling panes (targets for "Move to pane …") and the total pane count
  // (gates "Close this pane"). Numbered 1-based by their order in the tree.
  const allLeaves = store.splitLayout ? treeLeafNodes(store.splitLayout) : [];
  const paneCount = allLeaves.length;
  const otherPanes = allLeaves
    .map((l, i) => ({ paneId: l.paneId, ordinal: i + 1 }))
    .filter((p) => p.paneId !== leaf.paneId)
    .map((p) => ({ paneId: p.paneId, label: `pane ${p.ordinal}` }));

  // Right-click menu for ANY tab kind. Agent/manager tabs keep their rich
  // surface-specific controls; every kind additionally gets the universal
  // tab ops (close / close others / move between panes). Only non-specialized
  // menus append "Close this pane" — the agent/manager builders already have
  // their own pane-close item, so we don't double it up.
  const buildTabMenu = (ref: WorkPaneRef, idx: number): AgentTabMenuItem[] => {
    const specialized: AgentTabMenuItem[] =
      ref.kind === "agent"
        ? buildAgentTabMenuItems({
            sessionId: ref.id,
            inSplit: true,
            canClosePane: paneCount > 2,
          })
        : ref.kind === "manager"
          ? buildManagerTabMenuItems({ sessionId: ref.id })
          : [];
    const single = leaf.tabs.length <= 1;
    const generic: AgentTabMenuItem[] = [];
    // Split on any side. Only offered for non-specialized kinds (file,
    // browser, terminal, views) — agent/manager tabs carry their own split
    // controls in the specialized block above. Splitting extracts THIS tab
    // into its own pane and drops an empty picker pane on the chosen side.
    if (specialized.length === 0) {
      generic.push(
        { kind: "item", label: "Split left", onSelect: () => store.splitWithEmpty(ref, "row", "before") },
        { kind: "item", label: "Split right", onSelect: () => store.splitWithEmpty(ref, "row", "after") },
        { kind: "item", label: "Split up", onSelect: () => store.splitWithEmpty(ref, "column", "before") },
        { kind: "item", label: "Split down", onSelect: () => store.splitWithEmpty(ref, "column", "after") },
        { kind: "separator" },
      );
    }
    generic.push(
      {
        kind: "item",
        label: "Close tab",
        tone: "danger",
        onSelect: () => store.closeTabInPane(leaf.paneId, idx),
      },
      {
        kind: "item",
        label: "Close other tabs",
        disabled: single,
        onSelect: () => store.closeOtherTabsInPane(leaf.paneId, idx),
      },
    );
    if (otherPanes.length > 0) {
      generic.push({ kind: "separator" });
      for (const op of otherPanes) {
        generic.push({
          kind: "item",
          label: `Move to ${op.label}`,
          // A lone tab CAN move now — moveTabBetweenPanes collapses the
          // emptied source pane rather than refusing.
          onSelect: () => store.moveTabBetweenPanes(leaf.paneId, idx, op.paneId),
        });
      }
    }
    if (specialized.length === 0 && paneCount > 2) {
      generic.push({ kind: "separator" });
      generic.push({
        kind: "item",
        label: "Close this pane",
        tone: "danger",
        onSelect: () => store.removeSplitPane(paneIndex),
      });
    }
    return specialized.length
      ? [...specialized, { kind: "separator" }, ...generic]
      : generic;
  };

  return (
    <div
      className={`flex items-stretch h-8 flex-shrink-0 bg-bg-chrome border-b border-line-soft ${
        overTab ? "outline outline-1 outline-accent-blue -outline-offset-1" : ""
      }`}
      // This strip is the cross-pane tab DROP target: a tab dragged from
      // another pane lands anywhere on it → moveTabBetweenPanes. The pane-
      // REORDER drag SOURCE is the empty spacer after the tabs (below), NOT
      // this container. A `draggable` container is an ANCESTOR of the tab
      // buttons, so a tab's `dragstart` bubbles into its handler and corrupts
      // the drag with the split-pane mime — which silently broke tab moves.
      // Keeping the reorder source a SIBLING of the tabs keeps the two drags
      // cleanly separate.
      onDragOver={onStripDragOver}
      onDragLeave={() => setOverTab(false)}
      onDrop={onStripDrop}
    >
      <div className="flex items-stretch min-w-0 overflow-x-auto no-scrollbar">
        {leaf.tabs
          // Unified tab bar: every opened page is a visible tab and nothing is
          // ever hidden. Agent/manager tabs (the Claude session) pin leftmost so
          // they're never lost; everything else keeps open order. The mapped
          // `idx` stays the real leaf index, so click/close/drag stay correct.
          .map((ref, idx) => ({ ref, idx }))
          .sort((a, b) => pinRank(a.ref) - pinRank(b.ref))
          .map(({ ref, idx }) => {
          const data = describeRef(
            ref,
            store,
            currentRepoRoot,
            pagesActiveTitle,
            browserTitles,
          );
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
          // Every tab kind gets a right-click menu now (agents/managers keep
          // their surface-specific controls via the pane-action bridge; all
          // kinds get the universal close / close-others / move-to-pane ops).
          const menuItems = buildTabMenu(ref, idx);
          return (
            <ContextMenu key={`${leaf.paneId}-${idx}-${data.label}`}>
              <ContextMenuTrigger asChild>{tabButton}</ContextMenuTrigger>
              <ContextMenuContent className="min-w-[12rem]">
                {menuItems.map((item, i) =>
                  item.kind === "separator" ? (
                    <ContextMenuSeparator key={`sep-${i}`} />
                  ) : (
                    <ContextMenuItem
                      key={`${item.label}-${i}`}
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
        })}
      </div>
      {/* Empty strip background = the pane-REORDER drag handle. It's a SIBLING
          of the tab buttons (not their ancestor), so dragging a tab never
          triggers a pane reorder and dragging here never sets the tab mime —
          the two drags stay cleanly separate. `flex-1` fills the leftover strip
          width; the tabs row scrolls first when tabs overflow. */}
      <div
        className="flex-1 min-w-[16px] self-stretch cursor-grab active:cursor-grabbing"
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData(
            "application/x-aura-split-pane",
            String(paneIndex),
          );
          e.dataTransfer.effectAllowed = "move";
        }}
        title="Drag to reorder pane"
      />
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
      {/* Spawn a brand-new surface into THIS pane. The existing-tabs list
          below only re-homes things already open, so without this the in-app
          browser was unreachable while split (the global "+" menu that hosts
          it isn't drawn in split mode). Lands + focuses via addTabToPane. */}
      <div className="px-2 py-1.5 border-b border-line-soft">
        <button
          type="button"
          onClick={() => {
            store.addTabToPane(leaf.paneId, {
              kind: "browser",
              id: newBrowserTabId(),
            });
            onClose();
          }}
          className="w-full flex items-center gap-2 px-2 h-8 rounded text-left hover:bg-bg-2 transition-colors"
        >
          <span className="w-4 h-4 flex items-center justify-center flex-shrink-0 text-text-3">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2">
              <circle cx="8" cy="8" r="6.2" />
              <ellipse cx="8" cy="8" rx="2.6" ry="6.2" />
              <path d="M2 6.2h12M2 9.8h12" strokeLinecap="round" />
            </svg>
          </span>
          <span className="text-[12px] text-text-1">New browser</span>
          <span className="ml-auto text-[10px] text-text-5 font-mono">⌘⇧B</span>
        </button>
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
