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
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import type { TraceActions } from "./trace/traceActions";
import { TraceTabs } from "./trace/TraceTabs";
import { TraceToolSurface } from "./trace/TraceToolSurface";
import type { TraceKey } from "./trace/traceDestinations";
import { startWindowDrag } from "./TopBar";
import { AgentTabMark, ManagerTabStatus } from "./TabStatus";
// AURA-1296 — draft pencil on chat/agent tabs.
import { DraftMark } from "./TabStatus";
import { AGENT_DRAFT_PREFIX, MANAGER_DRAFT_PREFIX, composerKey } from "./composer/composerDrafts";
import { TabMoreButton, tabContextItems } from "./TabMenu";
import { useTabStripScroll } from "./tabStripScroll";
import { MonacoEditor as Editor } from "./MonacoEditor";
import { DiffView } from "./DiffView";
import { EditorBreadcrumbs } from "./EditorBreadcrumbs";
import { EditorInlineComposer } from "./editor/EditorInlineComposer";
import {
  FileModeSwitch,
  PreviewFileBody,
  MediaFileView,
  TextFileView,
  fileTabLabel,
  defaultMdView,
  isPreviewablePath,
  useMarkdownView,
  type MdView,
} from "./workpanes/FileTabView";
import { Toggle } from "./ui/toggle";
// AURA-1298
import { FileInsightStrip } from "./FileInsightStrip";
import { AgentSurface, buildAgentTabMenuItems, type AgentTabMenuItem } from "./agent/AgentSurface";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
} from "./ui/context-menu";
import { Button } from "./ui/button";
import { dropTarget, usePointerDrag, usePointerDragState } from "./ui/use-pointer-drag";
import {
  PANE_DRAG_SCOPE,
  TAB_DRAG_SCOPE,
  paneDropIndex,
  tabDropAction,
  tabDropKey,
  type TabDrag,
} from "../lib/workTabDrag";
import {
  ChevronLeft,
  ChevronRight,
  Columns2,
  GitCompareArrows,
  ListTree,
  PanelBottomOpen,
  PanelTop,
  Rows2,
  SquareSplitHorizontal,
  X,
} from "lucide-react";
import { EmptyState } from "./ui/state";
import "./ui/log-note.css";
import "./ui/pane-tools.css";
import { ManagerSurface, buildManagerTabMenuItems } from "./manager/ManagerSurface";
import { useUnreadTabs } from "../lib/tabUnread";
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
import { activeRefForLeaf, dropEmptyCells } from "./splitPaneCells";
import { AURA_MANAGER_ENABLED, COMMONS_ENABLED } from "../lib/featureFlags";
import { TasksBoard } from "./TasksBoard";
import { openPopout } from "../lib/popout";
import { TaskDetailPane } from "./tasks/TaskDetailPane";
import { CloudThreadPane } from "./cloud/CloudThreadPane";
import { StandupView } from "./standup/StandupView";
import { AutomationsSurface } from "./automations/AutomationsSurface";
import { CommonsSurface } from "./commons/CommonsSurface";
import { AppPaneSurface } from "./plugins/AppPaneSurface";
import { ScreenshareTab } from "./chat/ScreenshareTab";
import { LiveSessionPane } from "./collab";
// Read, not subscribed: the tab label is recomputed on every layout render
// anyway, so it can take the current value without the pane's own hook.
import { getSessionLive } from "../lib/sessionLiveRegistry";
import {
  useEditorStore,
  MAX_SPLIT_PANES,
  treeLeaves,
  treeLeafNodes,
  treeAllRefs,
  sessionsViewFromId,
  openBrowserTab,
  focusOrAppendRef,
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
import { traceToolLabel } from "../lib/traceToolLabels";
import { TabMark, projectName, tabMarkKey } from "./TabMark";
import { RevealMark, TitleReveal } from "./ui/title-reveal";
import { NewTabMenu } from "./workpanes/NewTabMenu";
import { api, type OutlineNode, type StrictModeInfo } from "../lib/api";
import { useTeammatePresence } from "../lib/usePresence";
import {
  useBrowserTabTitles,
  type BrowserTabMeta,
} from "../lib/browserTabTitles";
import { useAgentTerminalTitles } from "../lib/agentTerminalTitles";
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
  /** Strict-mode posture, forwarded to AgentSurface so its
   *  SessionInfoCard can show a matching pill. */
  strictMode?: StrictModeInfo["mode"];
  /** Spawn an agent PTY tab. Forwarded to Tabs so the tab strip's `+`
   *  popover and the optional preset bar can launch agents directly,
   *  matching the EmptyState launcher. */
  /** Quick-action openers used by FileInsightStrip when an Aura-tracked
   *  file is shown in diff mode. App.tsx already owns the dialog state
   *  for each of these, so we just forward callbacks. */
  onOpenRewind?: (filePath?: string) => void;
  onLogIntent?: (filePath?: string) => void;
  onSnapshot?: (filePath: string) => void;
  /** Trace's own switcher, rendered ON the surface above every Trace pane.
   *
   *  Trace used to be reachable only through a 232px rail: you clicked Trace in
   *  the nav, a second column appeared listing ten destinations, and it stayed
   *  open the whole time you read a wide table so you could reach the other
   *  nine. Workspaces and Mission Control already put their view switch on the
   *  surface; this is Trace catching up, and it hands the column back to the
   *  work. Same shape as `onOpenRewind` and friends — the handlers live in
   *  App.tsx (two of them ask the ambient manager a question and need its busy
   *  state), so they arrive here as a bag rather than being rebuilt. Omitted,
   *  Trace panes render bare and the rail is the only way in. */
  traceActions?: TraceActions;
  /** Window chrome that rides in the tab row, either side of the strip.
   *
   *  The work column used to carry a band of its own above this surface,
   *  holding two icons and nothing else across the rest of a full-width row,
   *  stacked directly on top of the tab strip and its controls. The band is
   *  gone; what it held arrives here and sits on the one row. See TopBar's
   *  `SidebarPeek` (leading — the traffic-light gutter and the control that
   *  brings the sidebar back, present only while the sidebar is collapsed)
   *  and `PaneToggles` (trailing — terminal and review).
   *
   *  They are nodes rather than props because this component has no business
   *  knowing what window chrome is: it owns the row, and the row has two
   *  ends. Per-surface toolbars (the terminal's, the editor's) keep their own
   *  place in that row, inboard of the trailing slot. */
  chromeLeading?: ReactNode;
  chromeTrailing?: ReactNode;
};

export function WorkSurface({
  repoRoot,
  projectName,
  strictMode,
  onOpenRewind,
  onLogIntent,
  onSnapshot,
  traceActions,
  chromeLeading,
  chromeTrailing,
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
  // Which split file panes are showing the diff instead of the editor.
  // The toggle draws in the pane's TAB STRIP now, not in a header band
  // inside the pane body, and those two are siblings — so the state that
  // links them has to sit above both. Keyed by path + the view the file was
  // OPENED with, so re-opening the same file from Changes (defaultView
  // "diff") lands on the diff again even if you'd toggled that path back to
  // the editor earlier — which is what the effect this replaced did.
  const [splitDiffOn, setSplitDiffOn] = useState<Record<string, boolean>>({});
  const splitDiffKey = (f: OpenFile) => `${f.path}::${f.defaultView ?? ""}`;
  const splitDiffFor = (f: OpenFile) =>
    splitDiffOn[splitDiffKey(f)] ?? f.defaultView === "diff";

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
        ref.kind === "commons" ||
        ref.kind === "app" ||
        ref.kind === "screenshare" ||
        ref.kind === "live" ||
        ref.kind === "trace" ||
        ref.kind === "sessions" ||
        ref.kind === "inspector" ||
        ref.kind === "replay" ||
        ref.kind === "prove" ||
        ref.kind === "graph" ||
        ref.kind === "planBuilder" ||
        ref.kind === "cloudJob" ||
        ref.kind === "inbox"
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

  // The window's top row when there is no layout to draw a tab strip from —
  // which now means: no tabs are open at all. Every opener seeds a layout and
  // both restore paths seed one from what they restored (seedLayoutForState),
  // so a tab always has a tree to live in and PerPaneTabStrip always draws it.
  //
  // This row is still the top edge of the window, so it keeps the shell's
  // chrome at either end and moves the window from the empty middle. It keeps
  // the same ＋ every real tab strip carries, where the first tab would end:
  // this row appears exactly when every tab is gone, and a bar with no tabs and
  // no way to open one read as broken. A start here seeds a fresh layout.
  const chromeBand = (surfaceActions?: ReactNode) => (
    <div className="ui-workspace-tabs">
      {chromeLeading}
      <NewTabMenu repoRoot={repoRoot} place={focusOrAppendRef} />
      <div
        className="flex-1 min-w-0 self-stretch"
        data-tauri-drag-region
        onMouseDown={startWindowDrag}
      />
      {surfaceActions}
      {chromeTrailing}
    </div>
  );

  // Plan Builder is a workpane tab (`kind: "planBuilder"`) like everything
  // else — the split path below renders it. It used to return here, above
  // that path, which meant opening the wizard swapped the whole window's tab
  // strip for the legacy one. `activePlanBuilder` survives as the rail mirror.

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

  // PR triage is likewise a workpane tab (`kind: "inbox"`), so it opens
  // beside your agents instead of replacing the strip they live on. It is
  // still the entry point to a PR: a row inside sets selectedPr and flips
  // activePrDetail, handled just below.

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
  // `kind: "plan"` has been a tree kind for a while — resolveSplitPane and
  // renderSplitPane have handled it all along — but this branch sat above
  // the split path and won, so plans were the third way to end up on the
  // legacy strip. `activePlanTab` is now only a focus hint (activeSplitRef).

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
    // Which pane strips actually touch the top edge of the window — because
    // those are the ones that have to carry the window's chrome. The leading
    // cluster goes on the top-LEFT pane, which is always the first leaf in DFS
    // order; the trailing cluster on the top-RIGHT one, found by walking right
    // at every row split and up at every column split. With a column split at
    // the root the top pane spans the full width and takes both.
    //
    // Without this the chrome simply vanished: a workspace with tabs is a
    // one-leaf split, so this branch — not the global strip — is what draws
    // the top of the window nearly all of the time.
    const leafTotal = (n: WorkSplitTree): number =>
      n.kind === "leaf"
        ? 1
        : n.children.reduce((sum, c) => sum + leafTotal(c), 0);
    const topRightLeaf = (() => {
      let node: WorkSplitTree = splitLayout;
      let base = 0;
      while (node.kind !== "leaf") {
        if (!node.children.length) return 0;
        if (node.direction === "row") {
          const last = node.children.length - 1;
          for (let i = 0; i < last; i++) base += leafTotal(node.children[i]);
          node = node.children[last];
        } else {
          node = node.children[0];
        }
      }
      return base;
    })();

    let leafCursor = 0;
    const renderTree = (node: WorkSplitTree, path: number[] = []): ReactNode => {
      if (node.kind === "leaf") {
        const idx = leafCursor++;
        // A leaf with no tabs at all is dead weight — render nothing and let
        // SplitContainer skip its cell entirely. Every other leaf gets drawn,
        // because the alternative is the bug described below.
        const activeRef = activeRefForLeaf(node);
        if (!activeRef) return null;
        const pane = resolveSplitPane(
          activeRef,
          store.files,
          store.agentTabs,
          store.terminalTabs,
          store.managerTabs,
          store.planTabs,
        );
        // `pane` is null when the ref points at an agent / terminal / manager /
        // plan / file that is no longer in the store — a tab closed through a
        // path that didn't also prune this leaf. That used to `return null`,
        // which did NOT remove the pane: SplitContainer still gave the null
        // child a full flex cell, so the layout kept a blank column with no tab
        // strip, no content and therefore no close button and nothing for the
        // resize handle to move. The pane was unremovable without clearing the
        // whole layout. It keeps its shell and its strip now, and the body
        // below says so and offers the way out.
        return (
          <SplitPaneShell
            key={`leaf-${node.paneId}`}
            active={pane ? paneIsActive(pane.ref, activeSplitRef) : false}
            index={idx}
            direction="row"
          >
            <div className="h-full w-full flex flex-col">
              <PerPaneTabStrip
                leaf={node}
                paneIndex={idx}
                currentRepoRoot={repoRoot}
                trailing={pane ? paneTrailingControls(pane) : undefined}
                chromeLeading={idx === 0 ? chromeLeading : undefined}
                chromeTrailing={
                  idx === topRightLeaf ? chromeTrailing : undefined
                }
              />
              <div className="flex-1 min-h-0 min-w-0 flex">
                {pane ? (
                  renderSplitPane(pane, idx)
                ) : (
                  <PaneUnavailable
                    reason="gone"
                    onClosePane={() => store.removeSplitPane(idx)}
                  />
                )}
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
  // show the provisioning feed full-pane (in place of the
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
        {chromeBand()}
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
        {chromeBand(
          <>
            {/* Terminal actions ride in the tab row, the same place the file
                path puts its editor actions. The band that used to carry them
                — inside the pane, under this strip — also printed the
                terminal's name a second time, so it is gone. */}
            <div className="ui-pane-tools">
              <ToolbarBtn
                onClick={() => store.demoteTerminalToPanel(activeTermTab.termId)}
                title="Move terminal to panel"
              >
                <PanelBottomOpen />
              </ToolbarBtn>
              <ToolbarBtn
                onClick={() => splitTerminal(activeTermTab, "row")}
                title="Split right"
              >
                <Columns2 />
              </ToolbarBtn>
              <ToolbarBtn
                onClick={() => splitTerminal(activeTermTab, "column")}
                title="Split down"
              >
                <Rows2 />
              </ToolbarBtn>
            </div>
          </>,
        )}
        <div className="flex-1 min-h-0">
          <TerminalPaneSurface
            tab={activeTermTab}
            repoRoot={repoRoot}
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
        {chromeBand()}
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
        {chromeBand()}
        <div className="flex-1 min-h-0">
          {AURA_MANAGER_ENABLED ? (
            <ManagerDashboardSurface repoRoot={repoRoot} projectName={fallbackName} />
          ) : (
            // Native chat is gated off — the dashboard slot becomes the calm
            // empty surface so opening a workspace (and ⌘N) lands here, not in
            // a Manager chat. Coding agents launch from the preset bar above.
            <WorkSurfaceEmpty repoRoot={repoRoot} />
          )}
        </div>
      </div>
    );
  }
  if (!active) {
    return (
      <div className="h-full w-full flex flex-col bg-bg-content">
        {chromeBand()}
        <div className="flex-1 min-h-0">
          <WorkSurfaceEmpty repoRoot={repoRoot} />
        </div>
      </div>
    );
  }

  // File-tab path: the shared file view, its header carrying this tab's
  // controls (markdown view, changes, split, outline) and Save.
  const isMd = isPreviewablePath(active.path);
  const mdView: MdView = isMd ? mdViewMap[active.path] ?? defaultMdView(active.path) : "raw";
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
  const fileLabel = fileTabLabel(active.path, repoRoot);
  // key={path} — remount a fresh Monaco editor per file, the same way DiffView
  // is keyed. Reusing one instance and swapping the model in place leaves the
  // viewport unpainted under WKWebView (the blank-file report: tiny files
  // blank, the diff editor — which IS keyed — renders the same file fine). A
  // fresh mount always paints. MonacoEditor still keeps per-file models alive
  // (keepCurrentModel) so the remount restores cursor/scroll/undo.
  const editor = (
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
  );

  return (
    <div className="h-full w-full flex flex-col bg-bg-content">
      {chromeBand()}
      <div className="flex-1 min-h-0 flex flex-col">
        {active.status !== "ok" ? (
          <MediaFileView file={active} label={fileLabel} />
        ) : (
          <TextFileView
            file={active}
            label={fileLabel}
            dirty={store.isDirty(active.path)}
            onSave={() => store.saveFile(active.path)}
            actions={
              <>
                {isMd && !showDiff && <FileModeSwitch value={mdView} onChange={setMdView} />}
                <Toggle
                  size="sm"
                  pressed={showDiff}
                  onPressedChange={setShowDiff}
                  aria-label="Show changes"
                  title="Show what changed since your last commit"
                >
                  <GitCompareArrows />
                </Toggle>
                <Button
                  size="iconXs"
                  variant="ghost"
                  aria-label="Split right"
                  title="Split right"
                  onClick={() => splitFile(active, "row")}
                >
                  <Columns2 />
                </Button>
                <Button
                  size="iconXs"
                  variant="ghost"
                  aria-label="Split down"
                  title="Split down"
                  onClick={() => splitFile(active, "column")}
                >
                  <Rows2 />
                </Button>
                <Toggle
                  size="sm"
                  pressed={showOutline}
                  onPressedChange={setShowOutline}
                  aria-label="Code outline"
                  title="Toggle code outline"
                >
                  <ListTree />
                </Toggle>
              </>
            }
          >
            <div className="relative flex-1 min-w-0 flex flex-col">
              {showDiff ? (
                <FileInsightStrip
                  repoRoot={repoRoot}
                  absPath={active.path}
                  fileLabel={fileLabel}
                  onOpenRewind={onOpenRewind ? () => onOpenRewind(active.path) : undefined}
                  onLogIntent={onLogIntent ? () => onLogIntent(active.path) : undefined}
                  onSnapshot={onSnapshot ? () => onSnapshot(active.path) : undefined}
                />
              ) : (
                <>
                  <EditorBreadcrumbs
                    repoRoot={repoRoot}
                    filePath={active.path}
                    fileLabel={fileLabel}
                    buffer={active.current}
                    cursorLine={cursorLine}
                  />
                  <EditorInlineComposer
                    repoRoot={repoRoot}
                    filePath={active.path}
                    fileLabel={fileLabel}
                  />
                </>
              )}
              <div className="flex-1 min-h-0 flex">
                {showDiff ? (
                  <DiffView
                    key={active.path}
                    repoRoot={repoRoot}
                    path={active.path}
                    current={active.current}
                    baseline={active.baseline}
                    loadOriginal={(root, file) =>
                      active.diffOriginal !== undefined
                        ? Promise.resolve(active.diffOriginal)
                        : api.gitShowHead(root, file)
                    }
                  />
                ) : isMd ? (
                  <PreviewFileBody
                    view={mdView}
                    path={active.path}
                    label={fileLabel}
                    source={active.current}
                    repoRoot={repoRoot}
                    editor={editor}
                  />
                ) : (
                  editor
                )}
              </div>
            </div>
            {showOutline && (
              <OutlinePanel repoRoot={repoRoot} file={active.path} text={active.current} />
            )}
          </TextFileView>
        )}
      </div>
    </div>
  );

  /** The lit tab's own controls, drawn at the right end of its pane's tab
   *  strip. Only kinds with an action the tab strip and the right-click menu
   *  can't already express get one — everything structural (split, add pane,
   *  close pane) lives in the menu, so this stays a very short list rather
   *  than the toolbar-per-pane it replaced. */
  function paneTrailingControls(pane: ResolvedSplitPane): ReactNode {
    if (pane.kind === "file" && pane.file.status === "ok") {
      const on = splitDiffFor(pane.file);
      const key = splitDiffKey(pane.file);
      return (
        <ToolbarBtn
          active={on}
          onClick={() => setSplitDiffOn((prev) => ({ ...prev, [key]: !on }))}
          title="Show what changed since your last commit"
        >
          <SquareSplitHorizontal />
        </ToolbarBtn>
      );
    }
    if (pane.kind === "terminal") {
      return (
        <ToolbarBtn
          onClick={() => store.demoteTerminalToPanel(pane.tab.termId)}
          title="Move terminal to panel"
        >
          <PanelBottomOpen />
        </ToolbarBtn>
      );
    }
    return null;
  }

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
    if (pane.kind === "cloudJob") {
      return (
        <CloudThreadPane threadKey={pane.threadKey} repoRoot={pane.repoRoot} />
      );
    }
    if (pane.kind === "standup") {
      return <StandupView repoRoot={pane.repoRoot} embedded />;
    }
    if (pane.kind === "automations") {
      return <AutomationsSurface repoRoot={pane.repoRoot} />;
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
    if (pane.kind === "live") {
      // Closing the tab is not leaving the session — see the pane's own
      // "Leave". `closePane` drops the tab and nothing else.
      return <LiveSessionPane sessionId={pane.sessionId} onClose={closePane} />;
    }
    if (pane.kind === "trace") {
      // The dialog's own × closes just this trace tab (drops it from the
      // leaf), not the whole pane — the sibling agent/Tasks tabs stay.
      return inTrace(
        pane.tool,
        <TraceToolSurface
          tool={pane.tool}
          arg={pane.arg}
          repoRoot={repoRoot}
          onClose={store.closeTraceTool}
        />,
      );
    }
    if (pane.kind === "sessions") {
      // Each Trace view (Overview / My sessions / Team activity / Cost &
      // usage) is its own real tab now — the view is encoded in the pane id,
      // so the surface renders exactly one view and the old in-pane segmented
      // toggle is gone. Cross-links (Overview → sessions/usage) open the
      // sibling tab via openSessions.
      return inTrace(
        // Cost & usage has no cell of its own — it is a reading of the runs,
        // reached from them — so the Sessions cell stays lit rather than the
        // strip going blank under it.
        pane.view === "usage" ? "sessions" : pane.view,
        <TraceSurface
          repoRoot={repoRoot}
          view={pane.view}
          onOpenView={store.openSessions}
        />,
      );
    }
    if (pane.kind === "inspector") {
      return inTrace(
        "intent",
        <IntentInspector repoRoot={repoRoot} onClose={store.closeInspector} />,
      );
    }
    if (pane.kind === "replay") {
      // Provenance replay has no entry in the strip — it opens from a session,
      // not from the menu — so nothing lights. The strip still rides along so
      // the rest of Trace stays one click away.
      return inTrace(
        null,
        <ProvenanceReplay repoRoot={repoRoot} onClose={store.closeReplay} />,
      );
    }
    if (pane.kind === "prove") {
      // Likewise: "Goals" on the strip hands a question to Aura rather than
      // opening this pane, so it stays unlit while the pane is up.
      return inTrace(
        null,
        <ProvePane repoRoot={repoRoot} onClose={store.closeProve} />,
      );
    }
    if (pane.kind === "graph") {
      return inTrace(
        "codemap",
        <SemanticGraphPane repoRoot={repoRoot} onClose={store.closeGraph} />,
      );
    }
    if (pane.kind === "planBuilder") {
      return <PlanBuilderSurface repoRoot={repoRoot} onClose={store.closePlanBuilder} />;
    }
    if (pane.kind === "inbox") {
      return <InboxPane repoRoot={repoRoot} onClose={store.closeInbox} />;
    }
    // file pane — buffer through the Editor, with a Diff/Edit toggle + the
    // Aura insight strip (story behind the change) when opened from Changes.
    return (
      <FilePaneSurface
        file={pane.file}
        onChange={(text) => store.updateBuffer(pane.file.path, text)}
        showDiff={splitDiffFor(pane.file)}
        dirty={store.isDirty(pane.file.path)}
        onSave={() => store.saveFile(pane.file.path)}
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

  /** Wrap a Trace pane in Trace's own strip.
   *
   *  Every Trace destination renders through here, so the switcher is present
   *  wherever you land — which is the whole point of moving it out of the rail.
   *  It is one strip per Trace pane rather than one for the window because
   *  Trace panes can be split side by side, and a switcher that changed the
   *  pane you weren't looking at would be worse than the rail was.
   *
   *  Without `traceActions` (a host that hasn't wired them) the pane renders
   *  exactly as it did before — no strip, no gap. */
  function inTrace(activeKey: TraceKey | null, body: JSX.Element): JSX.Element {
    if (!traceActions) return body;
    return (
      <div className="flex h-full min-h-0 flex-col">
        <TraceTabs
          // Named, not switchable: this pane reads the window's repo, so a
          // picker here would move the shared scope and leave the pane on the
          // project you were already looking at. Trace-as-a-page is the one
          // that follows it.
          repoRoot={repoRoot}
          handlers={traceActions}
          activeKey={activeKey}
          impactsCount={traceActions.impactsCount}
          busyKey={traceActions.busyKey}
        />
        <div className="min-h-0 flex-1">{body}</div>
      </div>
    );
  }

  function splitTerminal(tab: TerminalTab, direction: WorkSplitDirection) {
    // Splitting now opens an empty sibling pane — the user picks what
    // goes there from the EmptyPanePicker (cross-workspace agents,
    // terminals, files, managers, or a freshly spawned one).
    store.splitWithEmpty({ kind: "terminal", id: tab.termId }, direction);
  }

  function splitFile(file: OpenFile, direction: WorkSplitDirection) {
    store.splitWithEmpty({ kind: "file", path: file.path }, direction);
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
  | { kind: "cloudJob"; ref: WorkPaneRef; threadKey: string; repoRoot: string }
  | { kind: "standup"; ref: WorkPaneRef; repoRoot: string }
  | { kind: "automations"; ref: WorkPaneRef; repoRoot: string }
  | { kind: "commons"; ref: WorkPaneRef; repoRoot: string }
  | { kind: "app"; ref: WorkPaneRef; appKey: string }
  | { kind: "screenshare"; ref: WorkPaneRef; huddleKey: string }
  | { kind: "live"; ref: WorkPaneRef; sessionId: string }
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
  | { kind: "browser"; ref: WorkPaneRef; id: string; url?: string }
  | { kind: "planBuilder"; ref: WorkPaneRef }
  | { kind: "inbox"; ref: WorkPaneRef };

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
  if (ref.kind === "cloudJob") {
    return { kind: "cloudJob", ref, threadKey: ref.id, repoRoot: ref.repoRoot };
  }
  if (ref.kind === "standup") {
    return { kind: "standup", ref, repoRoot: ref.id };
  }
  if (ref.kind === "automations") {
    return { kind: "automations", ref, repoRoot: ref.id };
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
  if (ref.kind === "live") {
    return { kind: "live", ref, sessionId: ref.id };
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
  if (ref.kind === "planBuilder") {
    return { kind: "planBuilder", ref };
  }
  if (ref.kind === "inbox") {
    return { kind: "inbox", ref };
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
  // Drop children that rendered to nothing BEFORE counting cells. Each kid
  // gets its own flex-grow cell below, so a null child used to reserve a
  // full-height column that showed nothing and could not be closed or
  // resized — the pane was stuck until the whole layout was cleared. Weights
  // are normalized against the surviving count, which is the same fallback a
  // dropped child already triggers on restore (length mismatch → equal).
  const kids = dropEmptyCells(
    Array.isArray(children) ? (children as ReactNode[]) : [children],
  );
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
  children,
}: {
  active: boolean;
  /** Stage 9H — pane index in splitLayout.panes (for drag-reorder). */
  index?: number;
  /** Layout orientation: "row" → horizontal panes, drop handle on left
   *  edge; "col" → vertical, handle on top edge. */
  direction?: WorkSplitDirection;
  children: ReactNode;
}) {
  // A pane is carried by its tab strip's empty area and lands here; the
  // strip makes the move (see PerPaneTabStrip), this marks the place and
  // lights it while another pane is over it.
  const carried = usePointerDragState<number>(PANE_DRAG_SCOPE);
  const canDrag = typeof index === "number";
  const over = canDrag && paneDropIndex(carried.dragged, carried.over) === index;
  // direction "row" → horizontal layout, insertion line on the left
  // edge of the drop target; "column" → vertical, line on the top edge.
  const insertOnLeading = direction !== "column";
  return (
    <div
      {...(canDrag ? dropTarget(PANE_DRAG_SCOPE, String(index)) : {})}
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
          (PerPaneTabStrip carries the pane from its empty area), which keeps
          the strip's top-right corner clear for the "+" button — a grip
          pinned there sat on top of "+" and swallowed its clicks.
          SplitPaneShell stays the place a pane lands, marked above;
          `canDrag` still gates that. */}
      {children}
    </div>
  );
}


function TerminalPaneSurface({
  tab,
  repoRoot,
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
  /** Record the daemon session id once the PTY opens, so this terminal
   *  reconnects to its live process on the next app launch (parity with
   *  the bottom panel — without this an editor terminal always cold-starts). */
  onSessionOpened: (termId: string, daemonSessionId: string) => void;
}) {
  // No header band. This surface used to open with a 36px full-width bar
  // carrying a ">_" glyph, the terminal's label and its cwd — directly under
  // a tab that already carried a terminal glyph and the same label. The tab
  // is the title; the controls that were pinned to the right of that band
  // now ride at the right end of the tab strip itself (see the `trailing`
  // slot on PerPaneTabStrip and the global strip's toolbar), and the split /
  // add-pane / close-pane ops live in the tab's right-click menu.
  return (
    <div
      className="h-full w-full flex flex-col bg-bg-content"
      style={bgTint ? { backgroundColor: bgTint } : undefined}
    >
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
 *  each file pane is a *view*, not a copy. Drawn as the shared file view:
 *  its header names where the file lives (the half of the path the tab
 *  can't show), carries the markdown view switch and Save; the diff toggle
 *  rides at the right end of the pane's tab strip; split / add-pane /
 *  close-pane live in the tab's right-click menu. */
function FilePaneSurface({
  file,
  onChange,
  showDiff,
  dirty,
  onSave,
  repoRoot,
  onOpenRewind,
  onLogIntent,
  onSnapshot,
}: {
  file: OpenFile;
  onChange: (text: string) => void;
  /** Diff-vs-HEAD instead of the editor. Owned by the pane's tab strip,
   *  which draws the toggle — the strip and this body are siblings, so the
   *  state that links them lives above both. */
  showDiff: boolean;
  dirty: boolean;
  onSave: () => Promise<void>;
  repoRoot: string;
  onOpenRewind?: () => void;
  onLogIntent?: () => void;
  onSnapshot?: () => void;
}) {
  const label = shortPath(file.path, repoRoot);
  const isMd = isPreviewablePath(file.path);
  const [mdView, setMdView] = useMarkdownView(repoRoot, file.path);

  if (file.status !== "ok") {
    return (
      <div className="h-full w-full flex flex-col bg-bg-content">
        <MediaFileView file={file} label={label} />
      </div>
    );
  }
  if (!showDiff && isPlanMarkdownPath(file.path)) {
    return (
      <div className="h-full w-full flex flex-col bg-bg-content">
        <PlanMarkdownTab
          file={file}
          dirty={dirty}
          onSave={onSave}
          onChange={onChange}
          repoRoot={repoRoot}
        />
      </div>
    );
  }
  const editor = (
    <Editor
      key={file.path}
      value={file.current}
      language={file.language}
      onChange={onChange}
      filePath={file.path}
      repoRoot={repoRoot}
    />
  );

  return (
    <div className="h-full w-full flex flex-col bg-bg-content">
      <TextFileView
        file={file}
        label={label}
        dirty={dirty}
        onSave={onSave}
        actions={
          isMd && !showDiff ? <FileModeSwitch value={mdView} onChange={setMdView} /> : undefined
        }
      >
        <div className="flex-1 min-w-0 flex flex-col">
          {showDiff && (
            <FileInsightStrip
              repoRoot={repoRoot}
              absPath={file.path}
              fileLabel={label}
              onOpenRewind={onOpenRewind}
              onLogIntent={onLogIntent}
              onSnapshot={onSnapshot}
            />
          )}
          <div className="flex-1 min-h-0 flex">
            {showDiff ? (
              <DiffView
                key={file.path}
                repoRoot={repoRoot}
                path={file.path}
                current={file.current}
                baseline={file.baseline}
                loadOriginal={(root, f) =>
                  file.diffOriginal !== undefined
                    ? Promise.resolve(file.diffOriginal)
                    : api.gitShowHead(root, f)
                }
              />
            ) : isMd ? (
              <PreviewFileBody
                view={mdView}
                path={file.path}
                label={label}
                source={file.current}
                repoRoot={repoRoot}
                editor={editor}
              />
            ) : (
              editor
            )}
          </div>
        </div>
      </TextFileView>
    </div>
  );
}

function shortPath(path: string, repoRoot: string): string {
  if (path.startsWith(repoRoot + "/")) return path.slice(repoRoot.length + 1);
  return path;
}

/** The repo-relative FOLDER a file sits in — "" at the repo root.
 *
 *  For a header whose title is already the basename, this is the half of the
 *  path that carries new information. `shortPath` returns the whole thing,
 *  basename included, which under such a title just says the title again. */
function folderPath(path: string, repoRoot: string): string {
  const rel = shortPath(path, repoRoot);
  const cut = rel.lastIndexOf("/");
  return cut < 0 ? "" : rel.slice(0, cut);
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
    <aside className="ui-outline" aria-label="Outline">
      <div className="ui-log-note-files-head">
        <span>Outline</span>
        <span className="ui-log-note-count">{loading ? "…" : nodes.length}</span>
      </div>
      {!loading && nodes.length === 0 && <div className="ui-pattern-empty">No pieces here</div>}
      {nodes.map((n, i) => (
        <button
          key={`${n.line}-${n.name}-${i}`}
          type="button"
          className="ui-menu-row ui-outline-row"
          onClick={() =>
            window.dispatchEvent(
              new CustomEvent("aura:scroll-to-line", {
                detail: { filePath: file, line: n.line },
              }),
            )
          }
          title={`Jump to ${n.kind} · line ${n.line}`}
        >
          <small data-kind={n.kind}>{n.kind}</small>
          <span>{n.name}</span>
          <small>{n.line}</small>
        </button>
      ))}
    </aside>
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
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      title={title}
      aria-label={title}
      aria-pressed={active === undefined ? undefined : active}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </Button>
  );
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
  /** The project a foreign tab belongs to, in the words the project switcher
   *  uses. Set wherever `foreign` is — the badge names the place. */
  foreignName?: string;
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
    // A nameless CLI session is a "Chat"; a nameless ORCHESTRATOR session is
    // "Aura". They shared one word here, which is half of why the same tab
    // could read "Aura" via one door and "Chat" via another.
    case "agent":
      return "Chat";
    case "manager":
      return "Aura";
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
  browserTitles?: Record<string, BrowserTabMeta>,
  agentTitles?: Record<string, string>,
): PaneTabPillData | null {
  const data = describeRefRaw(
    ref,
    store,
    currentRepoRoot,
    browserTitles,
    agentTitles,
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
  browserTitles?: Record<string, BrowserTabMeta>,
  agentTitles?: Record<string, string>,
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
    // Same rule as a browser tab: what the thing itself says it is beats what
    // we called it when we opened it. An agent rewrites its terminal title as
    // the session takes shape, so the pill can say "fixing the retry backoff"
    // instead of a third identical "Claude Code". The brand still shows — the
    // agent's glyph is on the pill and `agentId` is right below this line.
    const live = agentTitles?.[ref.id]?.trim();
    return {
      ref,
      label: live && live.length > 0 ? live : t.agentLabel,
      sub: shortRoot(t.repoRoot),
      agentId: t.agentId,
      foreign: t.repoRoot !== currentRepoRoot,
      foreignName:
        t.repoRoot !== currentRepoRoot ? projectName(t.repoRoot) : undefined,
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
      foreignName: t.cwd !== currentRepoRoot ? projectName(t.cwd) : undefined,
    };
  }
  if (ref.kind === "manager") {
    const t = store.managerTabs.find((x) => x.sessionId === ref.id);
    if (!t) return null;
    return {
      ref,
      label: t.label || "Manager",
      // A plain descriptor, never the raw session hash: this string is the
      // tab's tooltip, and "019ec07e" answers no question the reader has.
      sub: "Aura chat",
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
    // Where the file LIVES, repo-relative — the half of the path the tab's
    // own label can't carry, and the only thing the pane header band under
    // this tab used to add before it was deleted for repeating the label.
    // "" at the repo root, where there is genuinely nothing left to say.
    // Files opened from outside the workspace keep their absolute folder,
    // since a relative path would be a lie about where they came from.
    const folder = ref.path.startsWith(currentRepoRoot + "/")
      ? folderPath(ref.path, currentRepoRoot)
      : dirName(ref.path);
    return {
      ref,
      label: f?.name ?? baseName(ref.path),
      sub: folder,
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
  if (ref.kind === "live") {
    // Whose session this is, because that is the fact that distinguishes it
    // from every other tab in the strip: the work is happening on someone
    // else's machine. The raw external id would answer no question a reader
    // has, so it stays out of both lines — the host's name IS the identity of
    // a joined session. Read straight from the plane rather than remembered at
    // open time, so a session joined before `presence` landed stops saying
    // "Shared session" as soon as it knows better.
    const host = getSessionLive(ref.id).participants.find((p) => p.role === "host");
    return {
      ref,
      label: host?.name ? `${host.name}'s session` : "Shared session",
      sub: "Joined",
      // Never dimmed as another project's: it belongs to no project of yours.
      foreign: false,
    };
  }
  if (ref.kind === "trace") {
    // One shared table, not a second ternary chain — the chain this replaced
    // had no `impacts` arm, so "Impacts on me" opened as "Project health".
    const label = traceToolLabel(ref.tool);
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
  if (ref.kind === "planBuilder") {
    return { ref, label: "Plan", sub: "Draft a plan before you build", foreign: false };
  }
  if (ref.kind === "inbox") {
    return { ref, label: "Reviews", sub: "Pull requests waiting on you", foreign: false };
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
  if (ref.kind === "cloudJob") {
    // Named for where the work is, not for the record it's read from: "In the
    // cloud" is the phrase every other surface uses for it, and the thread's
    // own title is on the pane's header two lines below the pill.
    return {
      ref,
      label: "In the cloud",
      sub:
        ref.repoRoot && ref.repoRoot !== currentRepoRoot
          ? shortRoot(ref.repoRoot)
          : "Work running on another machine",
      foreign: !!ref.repoRoot && ref.repoRoot !== currentRepoRoot,
    };
  }
  if (ref.kind === "empty") {
    return { ref, label: "New tab", sub: "pick something", foreign: false };
  }
  return { ref, label: "Untitled", sub: "pick something", foreign: false };
}

/** What a tab IS, for the name reveal: its pane ref, never its label, so the
 *  same chat renamed is a reveal and a different chat in the same slot is not.
 *  A tab moving between panes keeps its key, so a split never replays one. */
function tabRevealKey(ref: WorkPaneRef): string {
  return `tab:${ref.kind}:${"id" in ref ? ref.id : ref.path}`;
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
  trailing,
  chromeLeading,
  chromeTrailing,
}: {
  leaf: WorkSplitLeaf;
  paneIndex: number;
  currentRepoRoot: string;
  /** Controls belonging to the tab that's currently lit — the diff toggle on
   *  a file, "move to panel" on a terminal. They ride at the right end of
   *  this strip because that is the row that already names the thing they
   *  act on. They used to sit in a 36px full-width band directly beneath it,
   *  a band whose other content was the tab's own icon and the tab's own
   *  name, printed again at the same size 35px lower. */
  trailing?: ReactNode;
  /** Window chrome, for whichever pane strip touches the window's top edge.
   *  Not pane controls: these belong to the WINDOW (show the sidebar, show
   *  the terminal, show the review rail) and only ride here because this row
   *  is the top of it. Handed down from the shell — see the split branch. */
  chromeLeading?: ReactNode;
  chromeTrailing?: ReactNode;
}) {
  const store = useEditorStore();
  // Each tab's menu is built as the strip renders, so the strip follows the
  // unread flags: a flagged chat tab's menu says "Mark as read".
  const unreadTabs = useUnreadTabs();
  const browserTitles = useBrowserTabTitles();
  // What each running agent last called itself, straight off its terminal.
  const agentTitles = useAgentTerminalTitles();
  // Keep the lit tab on screen and say which edge is hiding the rest — the
  // strip hides its scrollbar, so without this a tab is just cut off mid-word.
  const strip = useTabStripScroll(`${leaf.paneId}:${leaf.activeIndex}`);

  // A tab is carried with a pointer drag: to another pane's strip, or, when
  // it is a terminal, onto the terminal panel's list (lib/workTabDrag.ts).
  // This strip is one of the places a tab lands, lit while a tab it would
  // take is over it.
  const stripKey = tabDropKey.pane(leaf.paneId);
  const tabDrag = usePointerDrag<TabDrag>(
    (item, key) => {
      const action = tabDropAction(item, key);
      if (action?.kind === "move") {
        store.moveTabBetweenPanes(action.srcPaneId, action.srcIndex, action.dstPaneId);
      } else if (action?.kind === "merge") {
        store.mergeTerminalIntoGroup(action.termId, action.groupId, "row");
      } else if (action?.kind === "demote") {
        store.demoteTerminalToPanel(action.termId);
      }
    },
    { scope: TAB_DRAG_SCOPE },
  );
  const overTab = tabDrag.over === stripKey && !!tabDropAction(tabDrag.dragged, stripKey);
  // The strip's empty area carries the whole pane to another place in the
  // split; the pane it lands on is a SplitPaneShell.
  const paneDrag = usePointerDrag<number>(
    (from, key) => {
      const to = paneDropIndex(from, key);
      if (to !== undefined) store.reorderSplitPanes(from, to);
    },
    { scope: PANE_DRAG_SCOPE },
  );

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
  // tab ops (move between panes, then close / close others, last, as the
  // reference tab menu ends). Only non-specialized menus add "Close this
  // pane" — the agent/manager builders already have their own pane-close
  // item, so we don't double it up.
  const buildTabMenu = (ref: WorkPaneRef, idx: number, title: string): AgentTabMenuItem[] => {
    const specialized: AgentTabMenuItem[] =
      ref.kind === "agent"
        ? buildAgentTabMenuItems({
            sessionId: ref.id,
            // There is nothing to leave when this is the only pane. Offering
            // it anyway was how "Leave split view" got clicked on a layout
            // that had already collapsed to one pane.
            inSplit: paneCount > 1,
            canClosePane: paneCount > 2,
          })
        : ref.kind === "manager"
          ? buildManagerTabMenuItems({
              sessionId: ref.id,
              title,
              unread: unreadTabs.has(ref.id),
            })
          : [];
    const single = leaf.tabs.length <= 1;
    const generic: AgentTabMenuItem[] = [];
    // A separator between groups — never first, never twice in a row.
    const groupBreak = () => {
      const last = generic[generic.length - 1];
      if (last && last.kind !== "separator") generic.push({ kind: "separator" });
    };
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
      );
    }
    if (otherPanes.length > 0) {
      groupBreak();
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
    // Pane-level ops. "Add empty pane" used to be reachable only from the
    // overflow menu inside each pane's own header band; with the band gone
    // it belongs here, beside the other things you can do to a pane.
    if (specialized.length === 0) {
      const paneOps: AgentTabMenuItem[] = [];
      if (paneCount < MAX_SPLIT_PANES) {
        paneOps.push({
          kind: "item",
          label: "Add empty pane",
          onSelect: () => store.addEmptySplitPane(),
        });
      }
      if (paneCount > 2) {
        paneOps.push({
          kind: "item",
          label: "Close this pane",
          tone: "danger",
          onSelect: () => store.removeSplitPane(paneIndex),
        });
      }
      if (paneOps.length) {
        groupBreak();
        generic.push(...paneOps);
      }
    }
    // The close block ends every tab's menu, the two rows together.
    groupBreak();
    generic.push(
      {
        kind: "item",
        label: "Close tab",
        shortcut: "⌘W",
        onSelect: () => store.closeTabInPane(leaf.paneId, idx),
      },
      {
        kind: "item",
        label: "Close others",
        disabled: single,
        onSelect: () => store.closeOtherTabsInPane(leaf.paneId, idx),
      },
    );
    return specialized.length
      ? [...specialized, { kind: "separator" }, ...generic]
      : generic;
  };

  // The library tab strip's keys, on a focused tab: ← → step through the
  // tabs in the order drawn (wrapping), Home and End jump to the ends, and
  // Delete closes the tab, leaving focus on the one that takes its place.
  const onTabKey = (e: ReactKeyboardEvent<HTMLButtonElement>, idx: number) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const list = e.currentTarget.closest('[role="tablist"]');
    const tabs = Array.from(
      list?.querySelectorAll<HTMLButtonElement>('[role="tab"][data-tab-index]') ?? [],
    );
    const pos = tabs.indexOf(e.currentTarget);
    if (["ArrowRight", "ArrowLeft", "Home", "End"].includes(e.key)) {
      e.preventDefault();
      const to =
        e.key === "Home"
          ? 0
          : e.key === "End"
            ? tabs.length - 1
            : pos + (e.key === "ArrowRight" ? 1 : -1);
      const next = tabs[(to + tabs.length) % tabs.length];
      if (!next) return;
      store.setActiveTabInPane(leaf.paneId, Number(next.dataset.tabIndex));
      next.focus();
    } else if (e.key === "Delete") {
      e.preventDefault();
      store.closeTabInPane(leaf.paneId, idx);
      requestAnimationFrame(() =>
        list?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')?.focus(),
      );
    }
  };

  return (
    <div
      className="ui-workspace-tabs"
      style={
        overTab
          ? { outline: "1px solid var(--ui-ring)", outlineOffset: -1 }
          : undefined
      }
      {...tabDrag.target(stripKey)}
    >
      {chromeLeading}
      {strip.edges.start && (
        <Button
          size="iconXs"
          variant="ghost"
          aria-label="Scroll tabs left"
          onClick={() => strip.scrollStep(-1)}
        >
          <ChevronLeft />
        </Button>
      )}
      <div
        ref={strip.scrollRef}
        // Hug the tabs, shrink only when they overflow. The library's `flex: 1`
        // assumes the strip owns the row; here the drag-region filler after it
        // is flex-1 too, and two flex-1s split the row in half — an
        // overflowing strip hid tabs behind its chevron with half the row empty.
        style={{ flex: "0 1 auto" }}
        className="ui-workspace-tab-scroll"
        role="tablist"
        aria-label="Open tabs"
      >
        {leaf.tabs
          .map((ref, idx) => ({ ref, idx }))
          .sort((a, b) => pinRank(a.ref) - pinRank(b.ref))
          .map(({ ref, idx }) => {
            const data = describeRef(
              ref,
              store,
              currentRepoRoot,
              browserTitles,
              agentTitles,
            );
            if (!data) return null;
            const isActive = idx === leaf.activeIndex;
            const agentTab =
              ref.kind === "agent"
                ? store.agentTabs.find((t) => t.sessionId === ref.id)
                : undefined;
            const menuItems = buildTabMenu(ref, idx, data.label);
            const revealKey = tabRevealKey(ref);
            const foreign =
              data.foreignName && data.foreignName !== data.label
                ? data.foreignName
                : null;
            return (
              <ContextMenu key={`${leaf.paneId}-${idx}-${data.label}`}>
                <ContextMenuTrigger asChild>
                  <div
                    className="ui-workspace-tab group"
                    data-selected={isActive}
                    title={foreign ? `${data.sub} — ${foreign}` : data.sub}
                    // A middle click closes the tab, as it does a browser's.
                    onAuxClick={(e) => {
                      if (e.button !== 1) return;
                      e.preventDefault();
                      e.stopPropagation();
                      store.closeTabInPane(leaf.paneId, idx);
                    }}
                  >
                    <button
                      ref={isActive ? strip.activeRef : undefined}
                      type="button"
                      role="tab"
                      data-tab-index={idx}
                      aria-selected={isActive}
                      tabIndex={isActive ? 0 : -1}
                      onKeyDown={(e) => onTabKey(e, idx)}
                      {...tabDrag.source({
                        from: { paneId: leaf.paneId, index: idx },
                        termId: ref.kind === "terminal" ? ref.id : undefined,
                      })}
                      onMouseDown={(e) => {
                        if (e.button === 0)
                          store.setActiveTabInPane(leaf.paneId, idx);
                      }}
                    >
                      {/* Each tab wears the mark its destination wears
                          everywhere else in the app — `TabMark` is shared with
                          the "+" picker and the empty-pane picker. */}
                      <span className="w-3.5 h-3.5 flex items-center justify-center flex-shrink-0">
                        {/* When the tab learns what it is about, the mark that
                            fits builds in on the same beat its name reveals. */}
                        <RevealMark
                          revealKey={revealKey}
                          markKey={tabMarkKey(ref, data.label, data.agentId)}
                        >
                          {agentTab ? (
                            <AgentTabMark tab={agentTab} agentId={data.agentId} />
                          ) : (
                            <TabMark
                              refr={ref}
                              label={data.label}
                              agentId={data.agentId}
                            />
                          )}
                        </RevealMark>
                      </span>
                      <span
                        style={
                          agentTab?.attention
                            ? { fontWeight: 600, color: "var(--ui-fg)" }
                            : undefined
                        }
                      >
                        <TitleReveal revealKey={revealKey} text={data.label} />
                      </span>
                      {/* A tab from another repository names it on the same
                          line, muted — otherwise it reads as this one's. */}
                      {foreign && (
                        <span
                          style={{
                            fontSize: 12,
                            color: "var(--ui-muted-fg)",
                            maxWidth: 96,
                          }}
                        >
                          {foreign}
                        </span>
                      )}
                      {ref.kind === "manager" && (
                        <ManagerTabStatus sessionId={ref.id} />
                      )}
                      {/* A pencil on a tab whose message box holds a draft. */}
                      {ref.kind === "manager" && (
                        <DraftMark
                          draftKey={composerKey(MANAGER_DRAFT_PREFIX, ref.id)}
                        />
                      )}
                      {ref.kind === "agent" && (
                        <DraftMark
                          draftKey={composerKey(AGENT_DRAFT_PREFIX, ref.id)}
                        />
                      )}
                    </button>
                    {/* Every action this tab has, on a control you can see:
                        the webview has eaten context menus on these tabs, so
                        right-click alone is not a reliable route to split,
                        move-to-pane or close-others. */}
                    <TabMoreButton items={menuItems} reserveSpace={false} />
                    <button
                      type="button"
                      className="ui-tab-close"
                      aria-label={`Close ${data.label}`}
                      onMouseDown={(e) => {
                        if (e.button !== 0) return;
                        e.stopPropagation();
                        store.closeTabInPane(leaf.paneId, idx);
                      }}
                    >
                      <X size={12} />
                    </button>
                  </div>
                </ContextMenuTrigger>
                <ContextMenuContent className="ui-tab-menu">
                  {tabContextItems(menuItems)}
                </ContextMenuContent>
              </ContextMenu>
            );
          })}
      </div>
      {strip.edges.end && (
        <Button
          size="iconXs"
          variant="ghost"
          aria-label="Scroll tabs right"
          onClick={() => strip.scrollStep(1)}
        >
          <ChevronRight />
        </Button>
      )}
      {/* The ＋ sits where the tabs end: Chat, Terminal, Browser, and the
          launcher under "More…". */}
      <NewTabMenu
        repoRoot={currentRepoRoot}
        leaf={leaf}
        place={(r) => store.addTabToPane(leaf.paneId, r)}
      />
      {/* Empty strip background = the pane-REORDER drag handle when there are
          several panes, the window's drag region when there is one. It is a
          sibling of the tabs, so the two drags never mix. */}
      {paneCount > 1 ? (
        <div
          className="flex-1 min-w-[16px] self-stretch cursor-grab active:cursor-grabbing"
          {...paneDrag.source(paneIndex)}
          title="Drag to reorder pane"
        />
      ) : (
        <div
          className="flex-1 min-w-[16px] self-stretch"
          data-tauri-drag-region
          onMouseDown={startWindowDrag}
        />
      )}
      {trailing && (
        <div className="flex items-center gap-1 px-2 flex-shrink-0">
          {trailing}
        </div>
      )}
      {chromeTrailing}
    </div>
  );
}

/** Calm fallback when a pane can't show what it was pointed at. Two cases:
 *  "off" — the feature is gated off (e.g. a stale Commons / mini-app leaf
 *  after the community platform was hidden); "gone" — the tab it referenced
 *  is no longer open, so there is nothing left to resolve. The "gone" case
 *  carries its own close button: that pane has already proved it can outlive
 *  its content, and a user staring at a blank column needs an exit that does
 *  not depend on the tab strip being right. */
function PaneUnavailable({
  reason = "off",
  onClosePane,
}: {
  reason?: "off" | "gone";
  onClosePane?: () => void;
} = {}) {
  const gone = reason === "gone";
  return (
    <div className="ui-pane-unavailable">
      <EmptyState
        icon={PanelTop}
        title={gone ? "Nothing open here" : "Not available"}
        body={
          gone
            ? "This pane's tab was closed somewhere else."
            : "This surface is turned off. You can close this tab."
        }
        action={gone && onClosePane ? { label: "Close pane", onClick: onClosePane } : undefined}
      />
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
