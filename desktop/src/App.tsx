// Shell wiring — composes the three-column window: the AdeSidebar column
// (its own header at y=0), the work column (WorkSurface: tab strip at y=0,
// body, composer), and the review rail (its own header at y=0). No band
// spans the top any more; the window chrome that used to need one rides in
// the tab row instead (see `chromeLeading`/`chromeTrailing` below).
//
// Project root resolution: prefer `current_dir()` (the cwd the shell was
// launched from — typically the repo the user wants), fall back to home.
// Branch + last-modified are best-effort; missing repo just hides them.
//
// File selection state lives here so opening a file from the tree can be
// promoted to a real editor in W3 without touching the layout primitives.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Layout } from "./components/Layout";
import { letterMark } from "./lib/monogram";
import { ScreenshareFloating } from "./components/chat/ScreenshareFloating";
import { WorkspaceCreateComposer } from "./components/workspace/WorkspaceCreateComposer";
import { accentForRoot, type WorktreeRef } from "./lib/workspaceRef";
import { WorkspaceRoster } from "./components/WorkspaceRoster";
import { PeopleRailMount } from "./components/collab/rail/PeopleRailMount";
import { BuildNav } from "./components/BuildNav";
import { useWorktreeBadges } from "./lib/useWorktreeBadges";
import { useChatNotifier } from "./lib/useChatNotifier";
import { usePagesSync } from "./lib/usePagesSync";
import { openPopout } from "./lib/popout";
import { requestRun } from "./lib/runRequest";
import { onIdle } from "./lib/idle";
import { Button } from "./components/ui/button";
import { AsciiSpinner } from "./components/ui/ascii-spinner";
import { installInAppFileDropRouter, installOsFileDropRouter } from "./lib/osFileDrop";
import {
  AdeSidebar,
  type AdeSection,
  type TraceActions,
} from "./components/AdeSidebar";
import { TracePage } from "./components/trace/TracePage";
import { TRACE_GO_EVENT, type TraceDest } from "./components/trace/traceRoute";
import { PLACE_GO_EVENT, type CollabPlace } from "./lib/placeRoute";
import {
  NO_REMOTE_PLACES,
  blurRemotePlaces,
  enterRemotePlace,
  focusedRemotePlace,
  leaveRemotePlace,
  remotePlaceKey,
  type RemotePlaces,
} from "./lib/remotePlaces";
import { syncMachines } from "./lib/activeMachine";
import { placeForNewWork, writeAmbientSid } from "./lib/ambientSession";
import {
  placeProjectName,
  useKnownProjects,
  usePlaceRoot,
} from "./lib/projectRoots";
import { PlacePage } from "./components/places/PlacePage";
import {
  WORK_GO_EVENT,
  goToWork,
  readWorkLens,
  writeWorkLens,
  type WorkLens,
} from "./lib/workRoute";
import { TasksPlace } from "./components/tasks/TasksPlace";
import { PagesSurface } from "./components/pages2/PagesSurface";
import { useWorkspaceCustomization } from "./lib/workspaceCustomization";
import {
  pluginRightRailPanels,
  pluginStatusPills,
  usePluginContributes,
} from "./lib/pluginContributesStore";
import { PaneToggles, SidebarPeek } from "./components/TopBar";
import { StatusPills } from "./components/topbar/StatusPills";
import { StatusBar } from "./components/StatusBar";
import { managerBootCommand } from "./lib/managerBoot";
import { refreshPluginContributes } from "./lib/pluginContributesStore";
import {
  bootExtensionHost,
  executeExtCommand,
} from "./lib/vscodeExt/extHostRuntime";
import {
  configurePluginRuntime,
  dispatchPluginPillClick,
} from "./lib/pluginRuntime";
import { PluginToastHost } from "./components/PluginToastHost";
import { HuddleErrorToast } from "./components/HuddleErrorToast";
import { RecordingNotice } from "./components/RecordingNotice";
import { TelemetryConsent } from "./components/TelemetryConsent";
import { MobileWaitlistDialog } from "./components/mobile/MobileWaitlistDialog";
import { GetStartedTour } from "./components/tour/GetStartedTour";
import { markTourSeen } from "./lib/tour/tourState";
import {
  markWhatsNewSeen,
  pendingWhatsNew,
  type ReleaseCta,
  type WhatsNewPending,
} from "./lib/releaseNotes";
import { trackActivation, trackFeature } from "./lib/track";
import { autoEnableCapture } from "./lib/autoCapture";
import { WorkSurface } from "./components/WorkSurface";
import { PRDetailPane } from "./components/workpanes/PRDetailPane";
import { useAgents } from "./lib/agents";
import { TerminalPanel } from "./components/terminal/TerminalPanel";
import { TeamSurface } from "./components/team/TeamSurface";
import { TeamChatProvider } from "./components/team/application/TeamChatContext";
import { SidebarHeader } from "./components/SidebarHeader";
import { isWorktreeRoot } from "./lib/workspaceLabel";
import { CallPanel } from "./components/chat/CallPanel";
import {
  RightRail,
  type RightRailTab,
  type PluginRightRailPanelDescriptor,
} from "./components/rightrail/RightRail";
import { ReviewStateHeader } from "./components/rightrail/ReviewStateHeader";
import { ChecksPanel } from "./components/rightrail/ChecksPanel";
import { ScribblePanel } from "./components/rightrail/scribble/ScribblePanel";
import { RailBrowser } from "./components/rightrail/RailBrowser";
import { CommandPalette, type PaletteEntry } from "./components/CommandPalette";
import { ShortcutsDialog } from "./components/dialogs/ShortcutsDialog";
import { OpLogDialog } from "./components/dialogs/OpLogDialog";
import { ConflictsDialog } from "./components/dialogs/ConflictsDialog";
import { CompareWorktreesDialog } from "./components/dialogs/CompareWorktreesDialog";
import { LogIntentDialog } from "./components/dialogs/LogIntentDialog";
import { IntentSplitMergeDialog } from "./components/dialogs/IntentSplitMergeDialog";
import { SnapshotDialog } from "./components/dialogs/SnapshotDialog";
import { PrAuthoringDialogHost } from "./components/dialogs/PrAuthoringDialog";
import { KnowledgeDialog } from "./components/dialogs/KnowledgeDialog";
import { RemoteDialog } from "./components/dialogs/RemoteDialog";
import { PairPhoneDialog } from "./components/dialogs/PairPhoneDialog";
import { SettingsDialog } from "./components/dialogs/SettingsDialog";
import { TimeMachineWizard } from "./components/workpanes/TimeMachineWizard";
import { TimelineWizard } from "./components/workpanes/timeline/TimelineWizard";
import { ChecksPane } from "./components/workpanes/ChecksPane";
import { GitView } from "./components/git/GitView";
import { SignInWizard } from "./components/account/SignInWizard";
import { AgentCustomizations } from "./components/commons/AgentCustomizations";
import type { CustomizeViewId } from "./components/commons/agentCustomize/customizeShared";
import { WorkspacesSurface } from "./components/workspaces/WorkspacesSurface";
import {
  RemoteWorkspace,
  type RemoteWorkspaceEntry,
} from "./components/cloud/RemoteWorkspace";
import { PublishRepoDialog } from "./components/workpanes/workspaces/PublishRepoDialog";
import { SearchWorkpane } from "./components/SearchWorkpane";
import { ShareCodeDialog } from "./components/ShareCodeDialog";
import { askConfirm, askNotice } from "./components/ui/ask";
import { ChannelNotesPanel } from "./components/chat/ChannelNotesPanel";
import { OnboardingDialog } from "./components/OnboardingDialog";
import { OnboardingFlow } from "./components/onboarding/OnboardingFlow";
import { AgentGateHost } from "./components/agent/AgentGateHost";
import { PlanWizardHost } from "./components/workpanes/PlanWizard";
import { OutputDialog } from "./components/dialogs/OutputDialog";
import { AskDialog } from "./components/dialogs/AskDialog";
import { StrictCommitDialog } from "./components/dialogs/StrictCommitDialog";
import { IntentVerificationDialog } from "./components/dialogs/IntentVerificationDialog";
import { ManagerLauncher } from "./components/manager/ManagerLauncher";
import { ManagerTabTitles } from "./components/manager/ManagerTabTitles";
import { checkStrictModeReadiness } from "./lib/strictModeGate";
import {
  FilesSidebar,
  GitSidebar,
  type HistoryEvent,
} from "./components/sidebars";
import { CommonsRailPanel } from "./components/rightrail/CommonsRailPanel";
import { PagesSidebarMount } from "./components/pages/PagesSidebar";
import { useEditorStore, armWorkspaceSnapshots, readPersistedAgents, readPersistedManagers, pendingFilePaths, openFileImperative, treeLeafNodes, openBrowserTab } from "./lib/editorStore";
import { useIdeTabBridge } from "./lib/ideBridge/useIdeTabBridge";
import { sectionForRef } from "./lib/paneSection";
import {
  clubHolds,
  clubMemberKeys,
  getClub,
  getClubState,
  subscribeClub,
  setActiveClub,
} from "./lib/workspaceClubStore";
import {
  isRemotePlace,
  placeRepoRoot,
  remotePlaceOf,
  type PlaceRef,
} from "./lib/placeRef";
import { ClubRailMount } from "./components/places/ClubRailMount";
import {
  focusAmbientManager,
  FOCUS_MANAGER_EVENT,
  sendToAmbientManager,
} from "./lib/focusManager";
import { safetyCheckPrompt, proveGoalsPrompt } from "./lib/worktreeActions";
import { sendAmbientManagerTurn } from "./lib/managerTurn";
import { useAmbientTurnBusy } from "./lib/managerStore";
import {
  resolveOrchestratorSession,
  startNewOrchestratorSession,
} from "./lib/orchestratorSession";
import { AuraSurface } from "./components/manager/AuraSurface";
import { landNewWorkspace } from "./lib/workspaceLanding";
import { labelForAgentId } from "./lib/useLiveAgentSessions";
import type { SelectedModel } from "./lib/modelCatalog";
import { HudPublisher } from "./lib/hudPublisher";
import { onHudSelectProject, onHudSend } from "./lib/hud";
import { AURA_MANAGER_ENABLED, COMMONS_ENABLED, ONBOARDING_V2 } from "./lib/featureFlags";
import { useAppActions, type AppActionId } from "./lib/keymap";
import { findSlash } from "./lib/slashCommands";
import {
  api,
  type AuraCliCheck,
  type ClaudeSession,
  type DiffStats,
  type IntentVerdict,
  type ReasoningEffort,
  type StrictModeInfo,
  type UsageSummary,
} from "./lib/api";
import { resumeCwdOf } from "./lib/agentSessionScope";
import { fetchManagerList } from "./lib/managerCache";
import { fetchPrList } from "./lib/prsCache";
import { useApplyThemeClass } from "./lib/themeStore";
import { useIsFullscreen } from "./lib/useIsFullscreen";
import { useApplyVsCodeChrome } from "./lib/vscodeThemesStore";
import { loadSettings } from "./lib/settingsStore";
import {
  bindChannelMeta,
  forgetAgentStream,
  forgetPersistedSession,
  getChannelEvents,
  getChannelMeta,
  getPermissionMode,
  getResumeSession,
  markTurnStarted,
  pushEvent,
  readPersistedSession,
  streamChannel,
} from "./lib/agentStreamStore";
import { ResumeDialog } from "./components/agent/ResumeDialog";
import { AuraImpactsBanner } from "./components/AuraImpactsBanner";
import { AgentMutationGuard } from "./components/AgentMutationGuard";
import { AuraTrackingNotice } from "./components/AuraTrackingNotice";
import { CrashRecoveryToast } from "./components/CrashRecoveryToast";
import { CliUpdateToast } from "./components/CliUpdateToast";
import { Toaster } from "./components/Toaster";
import { UpdateBanner } from "./components/UpdateBanner";
import { useDocumentVisibility } from "./lib/useDocumentVisibility";
import { relativeAgeFromDelta } from "./lib/relativeTime";
import { titleCaseName } from "./lib/textCase";
import { truncate } from "./lib/truncate";
import {
  fetchAstConflicts,
  fetchConflicts,
  fetchImpacts,
} from "./lib/ambientCache";

type Project = {
  root: string;
  name: string;
  branch: string;
  lastModified: string;
};

type OutputState = {
  open: boolean;
  title: string;
  body: string;
  loading: boolean;
  error: string | null;
};

// Zoom is applied via document.body.style.zoom — WebKit/Chromium scale
// the entire document, layout included. Persisted so the user's choice
// survives reload. 50%–200% range matches what every browser allows.
const ZOOM_KEY = "aura.zoom";
// Left sidebar open/closed. Persisted so a deliberately-closed rail stays
// closed across an app restart instead of springing back open.
const SIDEBAR_OPEN_KEY = "aura.sidebar.open";
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2.0;
const ZOOM_STEP = 0.1;

function clampZoom(z: number) {
  return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(z * 100) / 100));
}

/** Read the persisted zoom without touching React state. */
function storedZoom(): number {
  const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(ZOOM_KEY);
  const n = raw ? parseFloat(raw) : NaN;
  return Number.isFinite(n) ? clampZoom(n) : 1;
}

/** Publish the zoom to CSS as `--webview-zoom`, so a length that must stay
 *  constant in WINDOW points can divide it back out — see
 *  `windowControlsInset`. Zoom multiplies every CSS px on its way to the
 *  window, which is right for text and icons and wrong for anything measured
 *  against something macOS draws itself.
 *
 *  Published here at module load as well as from the zoom effect, because the
 *  effect runs after the first paint: without this, the traffic-light gutter
 *  would render one frame at its un-divided width and the search button would
 *  visibly jump left as the app finished starting. */
function publishZoomToCss(z: number): void {
  if (typeof document === "undefined") return;
  document.documentElement.style.setProperty("--webview-zoom", String(z));
}

publishZoomToCss(storedZoom());


type AppProps = {
  /** Set in a detached "workspace" popout window — the App boots pinned to
   *  THIS repo root instead of the persisted `aura.lastWorkspace`, and never
   *  writes `aura.lastWorkspace` itself, so a second window onto another
   *  project doesn't move the main window's last-workspace pointer. Undefined
   *  in the main window — and also in a detached window standing on a machine
   *  this laptop has no checkout of, which is why `isDetached` below is the
   *  thing the "don't move the shared pointer" rules turn on. */
  bootRootOverride?: string;
  /** WHERE a detached window stands, when that is not simply this laptop's
   *  checkout at `bootRootOverride`.
   *
   *  Popping out a machine has to open a window that comes up standing IN that
   *  machine — its shell, its sessions, its agents — not merely in the local
   *  project it is a copy of. So the place is restored at boot, into the same
   *  entered-places set every other way in writes to (lib/remotePlaces), and
   *  from there the window behaves exactly like one you walked into by hand:
   *  leaving uncovers the local workspace underneath, and entering a second box
   *  holds both.
   *
   *  Nothing is taken from the window that popped it. A second window has its
   *  own module scope and therefore its own editor store, its own live-place
   *  registry and its own tab slots — so the parent keeps standing where it
   *  was, which is the difference between detaching a place and handing one
   *  over. Undefined in the main window. */
  bootPlaceOverride?: PlaceRef;
};

function App({ bootRootOverride, bootPlaceOverride }: AppProps = {}) {
  // True while this is a detached whole-workspace window (popout=workspace).
  // Held in a ref so the []-dep boot effect can read it without re-running.
  const bootRootOverrideRef = useRef<string | undefined>(bootRootOverride);
  bootRootOverrideRef.current = bootRootOverride;
  // …and whether this window is detached AT ALL, which is not the same
  // question. A popped-out machine may name no local checkout, so its
  // `bootRootOverride` is undefined and it falls back to `aura.lastWorkspace`
  // for a project to file work under — exactly like the main window does, and
  // therefore indistinguishable from it by that flag alone. Writing the shared
  // pointer or publishing to the HUD off that reading would let a second window
  // yank the first one on its next restart.
  const isDetached = !!bootRootOverride || !!bootPlaceOverride;
  const isDetachedRef = useRef(isDetached);
  isDetachedRef.current = isDetached;
  // Mirror the resolved theme to a class on <html> so .light/.dark
  // scopes in styles.css activate. CSS-only primitives (shadcn Dialog/
  // Popover/etc.) need this since they read CSS vars rather than
  // taking a theme prop.
  useApplyThemeClass();
  // When an imported VS Code theme is active AND set to reskin the app, push
  // its derived CSS variables onto the document root (inline → wins over the
  // variant tokens). No-op otherwise; clears cleanly when turned off.
  useApplyVsCodeChrome();

  // Reconcile the durable ~/.aura/settings.toml against the localStorage
  // boot cache once at startup (seeds the TOML on first run, otherwise
  // adopts it + re-applies the live theme). Fire-and-forget; the boot
  // cache already painted the right theme synchronously.
  useEffect(() => {
    void loadSettings();
  }, []);

  // Re-probe the installed agent CLIs for their real model lists once per app
  // launch (`force` skips the 24h catalog cache), so a model a freshly
  // installed/updated CLI added shows up without waiting the day out. This just
  // refreshes the on-disk cache in the background; the picker reads that cache
  // when it opens. Fire-and-forget — offline/no-CLI simply leaves the cache.
  useEffect(() => {
    void api.agentModelsList(true).catch(() => {});
  }, []);

  const [project, setProject] = useState<Project | null>(null);
  // Always-current project root for stable ([]-dep) callbacks/effects
  // (keyboard shortcuts, window listeners) that must not capture a stale
  // root after a workspace switch. (Distinct from `projectRootRef` below,
  // which holds the OUTGOING root for snapshot bookkeeping on switch.)
  const currentRootRef = useRef<string | null>(null);
  currentRootRef.current = project?.root ?? null;
  // Latest "new session" action — assigned once newSessionAction is
  // defined further down. Lets the ⌘N effect (declared earlier) call it
  // without a forward reference or per-render re-subscription.
  const newSessionActionRef = useRef<() => void>(() => {});
  // Latest folder picker — assigned once `pickAndOpenFolder` is defined further
  // down. Same forward-reference trick as `newSessionActionRef`: the Aura door
  // (declared earlier) needs somewhere to send a user who has no workspace open
  // at all, and "open a folder" is that somewhere.
  const pickAndOpenFolderRef = useRef<() => void>(() => {});
  // Latest "step off whatever full-page view is up" — assigned once
  // `leavePages` is defined further down. The focus-manager listener
  // (declared earlier, subscribed once) needs it so a chat it opens lands
  // somewhere the user can actually see.
  const leavePagesRef = useRef<() => void>(() => {});
  const [bootError, setBootError] = useState<string | null>(null);
  // `terminalOpen` is store-backed (`editor.terminalPanelOpen`, derived
  // below once `useEditorStore()` is in scope) so the bottom panel's
  // open/closed state persists across restart and is workspace-scoped —
  // it comes back the way each workspace left it. `terminalMaximized`
  // stays ephemeral (a transient view mode, not worth persisting).
  const [terminalMaximized, setTerminalMaximized] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    // Restore the rail's last open/closed state; default open when unset.
    try {
      return localStorage.getItem(SIDEBAR_OPEN_KEY) !== "0";
    } catch {
      return true;
    }
  });
  const [reviewOpen, setReviewOpen] = useState(true);
  // Stage 8H — when entering a single PR detail, collapse the left
  // sidebar + right comms pane so the diff + threads have full width.
  // Restore prior state on close. Refs hold the values that were active
  // *before* PR detail opened so we don't clobber a user-driven collapse.
  // Tracks the active workspace root so loadProjectAt can hand the
  // OUTGOING root to switchWorkspace before we overwrite project state.
  // Without this ref the snapshot would never be written for the previous
  // workspace, so its tabs would vanish on switch-back.
  const projectRootRef = useRef<string | null>(null);
  // Live handle to `loadProjectAt` (defined far below) so effects declared
  // ABOVE it — e.g. the workspace-launch listener — can navigate without a
  // forward reference. Kept current by an effect right after the callback.
  const loadProjectAtRef = useRef<((root: string) => Promise<void>) | null>(
    null,
  );
  const [rightRailTab, setRightRailTab] = useState<RightRailTab>(() => {
    // Stage 11 — default to Aura (always-on Manager). The right-rail
    // tab is restored from localStorage so user choices persist across
    // sessions; legacy "chat" / "story" / "tasks" keys still resolve.
    // W1.4 — plugin tabs are persisted too (id format `plugin:<a>:<b>`).
    // The rail is Files · Changes · Checks (+ Commons + plugin panels). The
    // old aura/chat/story/tasks tabs are re-homed, and Trust + Review folded
    // into Trace. Checks and PRs are one surface now (the PR list sits at the
    // bottom of Checks), so a persisted "prs" restores into Checks. Never
    // restore into a tab that no longer exists — fall back to Files.
    const raw = localStorage.getItem("aura.rightRail.tab");
    if (raw === "prs" || raw === "checks") return "checks";
    if (
      raw === "files" ||
      raw === "changes" ||
      (raw === "commons" && COMMONS_ENABLED) ||
      raw === "scribble" ||
      raw === "browser"
    )
      return raw;
    if (raw && raw.startsWith("plugin:")) return raw as RightRailTab;
    return "files";
  });
  useEffect(() => {
    localStorage.setItem("aura.rightRail.tab", rightRailTab);
  }, [rightRailTab]);

  // Single global router for OS file drops (Finder/desktop → app). With
  // `dragDropEnabled: true`, every external file drop arrives here with real
  // absolute paths; the router hit-tests the drop position and hands it to the
  // terminal or chat composer under the cursor. Installed once for the app.
  useEffect(() => installOsFileDropRouter(), []);
  // In-app HTML5 file drags (Files sidebar → terminal / composer) surface as
  // real DOM events; a single window-level capture router lands them past the
  // xterm canvas and past webview payload-stripping. Installed once.
  useEffect(() => installInAppFileDropRouter(), []);

  // Any caller wanting a Manager session in focus (post-launch, plan handoff,
  // dashboard click) dispatches aura:focus-manager. The manager lives in a
  // center pane, not the right rail, so the requested session opens as a
  // workpane tab rather than popping a modal.
  //
  // "In focus" has to mean visible. Trace, Workspaces and Mission Control cover
  // the work surface opaquely, so a tab opened underneath one of them is
  // focused, in the strip, and entirely off screen — which is what Trace's
  // Goals and Safety check looked like: the question really did go to the
  // brain, the answer really did stream into a chat, and the page you clicked
  // from never changed by a pixel. Step off the cover first; every other "take
  // me to X in the main area" path already does.
  useEffect(() => {
    function onFocus(e: Event) {
      const detail = (e as CustomEvent<{ repoRoot: string; sessionId: string }>)
        .detail;
      if (detail?.sessionId) {
        leavePagesRef.current();
        // "Aura", not "Chat" — the orchestrator goes by one name, the one the
        // sidebar and the quick-launch pill already use. Clicking the pill
        // labelled "Aura" used to open a tab labelled "Chat" carrying the Aura
        // mark, two rows apart on the same screen.
        editorRef.current.openManager(detail.sessionId, "Aura");
      } else {
        // No session yet — e.g. the empty-state "Start a chat" card fires
        // focusAmbientManager(root, ""). Spin up a fresh blank chat inline
        // instead of silently dropping the click.
        newSessionActionRef.current();
      }
    }
    window.addEventListener(FOCUS_MANAGER_EVENT, onFocus as EventListener);
    return () =>
      window.removeEventListener(FOCUS_MANAGER_EVENT, onFocus as EventListener);
  }, []);

  // Same cover, every other door through it. Drilling from a list into one
  // record — a task, a pull request, a cloud conversation — opens a workpane,
  // and the store announces it rather than reaching into this component. A
  // cloud row clicked in the sidebar while the Workspaces page was up did
  // exactly what it promised and looked completely dead, because the page it
  // was clicked from is opaque and stayed up. Leaving is the point of the
  // click.
  useEffect(() => {
    const onDetail = () => leavePagesRef.current();
    window.addEventListener("aura:detail-tab-opened", onDetail);
    return () => window.removeEventListener("aura:detail-tab-opened", onDetail);
  }, []);

  // Entering a machine. The opposite move to the one above: not "bring that
  // record into this workspace" but "go and work on that machine".
  //
  // It used to clear every cover first, and that one call was what made places
  // mutually exclusive: walking into a box cost you Aura, the fleet page, Trace
  // and whichever place you had up, and walking into a SECOND box cost you the
  // first. Nothing is cleared now. The machine you are in renders on top of the
  // covers rather than in place of them (see the remote layer at the bottom of
  // the tree), so entering is purely additive and leaving uncovers exactly what
  // you left — including the fleet page you clicked the row from.
  useEffect(() => {
    const onEnter = (e: Event) => {
      const detail = (e as CustomEvent<RemoteWorkspaceEntry>).detail ?? {};
      setRemotePlaces((cur) => enterRemotePlace(cur, detail));
    };
    window.addEventListener("aura:open-remote-workspace", onEnter);
    return () =>
      window.removeEventListener("aura:open-remote-workspace", onEnter);
  }, []);

  // Window-level paste capture — any image on the clipboard pasted
  // anywhere in Aura is shoved into the clipboard tray and made
  // addressable by an absolute path agents can read.
  useEffect(() => {
    let cleanup: (() => void) | null = null;
    void (async () => {
      const mod = await import("./components/clips/ClipsTray");
      cleanup = mod.installClipsPasteCapture();
    })();
    return () => {
      cleanup?.();
    };
  }, []);

  // Boot the plugin contributes store once per shell — slash commands
  // + rail tiles + right-rail panels + status pills declared in any
  // enabled native plugin's manifest become available to in-app
  // catalogs. Subsequent refreshes happen via Settings → Plugins.
  // The runtime is configured FIRST so the reconcile pass kicked by the
  // refresh spawns workers with a working repo-root getter
  // (projectRootRef tracks the active workspace root — see loadProjectAt).
  useEffect(() => {
    configurePluginRuntime({ getRepoRoot: () => projectRootRef.current });
    void refreshPluginContributes();
    // Boot the VS Code web-extension host — it reconciles itself against the
    // enabled extension set and only spawns a worker when there's one to run.
    bootExtensionHost();
  }, []);

  // Live plugin contributes snapshot — drives the second-rail tile
  // list (W1.4). The callback + selector both depend on `editor`, so
  // the wiring is hoisted below `useEditorStore()` (search the file
  // for the matching block).
  const pluginContribs = usePluginContributes();
  const [paletteOpen, setPaletteOpen] = useState(false);
  // ⌘/ keyboard-shortcuts cheat-sheet (Conductor parity).
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  // Live agent registry for the @ scope in the command palette.
  const { agents: discoveredAgents } = useAgents();
  const [opLogOpen, setOpLogOpen] = useState(false);
  const [conflictsOpen, setConflictsOpen] = useState(false);
  const [remoteOpen, setRemoteOpen] = useState(false);
  const [pairPhoneOpen, setPairPhoneOpen] = useState(false);
  const [knowledgeOpen, setKnowledgeOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [timeMachine, setTimeMachine] = useState<
    { identifier: string | null; file: string | null } | null
  >(null);
  const [checksOpen, setChecksOpen] = useState(false);
  const [timelineOpen, setTimelineOpen] = useState(false);
  const [sourceControlOpen, setSourceControlOpen] = useState(false);
  const [signInOpen, setSignInOpen] = useState(false);
  const [agentCustomizeOpen, setAgentCustomizeOpen] = useState(false);
  // Which drawing of the work you're looking at. Three over the backlog (List,
  // Board, Sprint) and two over what the crew is doing about it (Plan, Graph).
  //
  // There is no separate "Mission Control" page any more: a crew node carries
  // `board_task_id` back to the board card it was projected from, so the two
  // boards were always one store seen twice. See lib/workRoute. Remembered, so
  // the destination reopens on the lens you left it on.
  const [workLens, setWorkLens] = useState<WorkLens>(readWorkLens);
  const chooseWorkLens = useCallback((next: WorkLens) => {
    setWorkLens(next);
    writeWorkLens(next);
  }, []);
  // The full-screen Workspaces view — the "cool view" for the whole fleet of
  // parallel copies, so the Build sidebar stays a curated few. `wsFilter`
  // scopes it to one project when opened from that project's disclosure.
  const [wsOpen, setWsOpen] = useState(false);
  // Aura's own page. Holds the orchestrator session id while open; null =
  // closed. Deliberately NOT a workpane tab — Aura spans every project, so it
  // must not render inside one project's frame.
  const [auraSid, setAuraSid] = useState<string | null>(null);
  // Mirror, so the Aura door can tell "open it" from "I'm already here, take me
  // back" without re-creating its callback on every session change.
  const auraSidRef = useRef<string | null>(null);
  useEffect(() => {
    auraSidRef.current = auraSid;
  }, [auraSid]);
  // Trace's page. Holds the destination you asked for; null = you are not in
  // Trace. Its destinations used to be workpane tabs, which put a PLACE in the
  // row that holds your open documents — so Trace drew its own switcher above
  // a tab naming the same destination, under a header offering a branch menu
  // for a surface that is already about this repo's history.
  const [tracePage, setTracePage] = useState<TraceDest | null>(null);
  // Pages, Tasks and Team — see lib/placeRoute. Each brings its own
  // navigation, so each takes the window rather than sharing it with a
  // frame about one repo.
  const [place, setPlace] = useState<CollabPlace | null>(null);
  // The machines this window is holding open — see lib/remotePlaces. Plural,
  // because a window that can only be in one place at a time is a window that
  // charges you your whole workspace to look at a box. Each one takes the
  // window while it is focused (its own tabs, its own shell, its own agents);
  // the rest stay open behind it, in the sidebar and one click away. An empty
  // focus means you are here, on this laptop, with whatever you had up.
  //
  // A detached window standing on a machine starts the set with that machine
  // already in it, so the window comes up IN the place it was popped out of
  // rather than on the local checkout with a box to go and find. It goes in
  // through `enterRemotePlace` — the same door the sidebar's rows use — so the
  // popped window has no second notion of "entered" the rest of the app doesn't
  // know about: leaving is the same Leave, blurring is the same blur, and
  // entering a second box from here holds both exactly as it does in the window
  // that spawned it.
  const [remotePlaces, setRemotePlaces] = useState<RemotePlaces>(() =>
    bootPlaceOverride && isRemotePlace(bootPlaceOverride)
      ? enterRemotePlace(NO_REMOTE_PLACES, remotePlaceOf(bootPlaceOverride))
      : NO_REMOTE_PLACES,
  );
  const remoteEntry = focusedRemotePlace(remotePlaces);
  // Tell the sidebar which places the window is holding and which it is looking
  // at. Only the requests are known here — a resolved box is published by the
  // workspace that resolved it (lib/activeMachine), and this never overwrites
  // that.
  useEffect(() => {
    syncMachines(
      remotePlaces.entered.map((p) => ({
        key: remotePlaceKey(p),
        machineId: p.machineId ?? null,
        threadKey: p.threadKey ?? null,
        repoRoot: p.repoRoot ?? null,
      })),
      remotePlaces.focusedKey,
    );
  }, [remotePlaces]);
  // The project a place is pointed at. The place rails carry the picker — the
  // things they list belong to a project — and it writes one shared scope, so
  // Pages and Team follow the same choice the Tasks rail offers rather than
  // being stuck on whatever folder happens to be open.
  const placeRoot = usePlaceRoot(project?.root ?? "");
  // …and what to call it. Team's chat model takes a name beside the root, and
  // it used to get the OPEN project's — so following the picker to another
  // project labelled that project's conversations with the name of the one you
  // left. The open project's own name is only offered as a fallback when the
  // place is still pointed at it.
  const placeProjects = useKnownProjects(project?.root ?? "");
  const placeName = placeProjectName(
    placeRoot,
    placeProjects,
    placeRoot === project?.root ? project?.name : undefined,
  );
  // Which Trace question is out with the brain. Goals and Safety check don't
  // open a pane — they send a prompt into the ambient Aura chat — so nothing on
  // screen said the first click had landed, and a second click queued the
  // identical question and burnt another turn (the brain answered "Already ran
  // this in-session… Re-running", then interrupted itself). This names the row
  // that asked, so only that row spins; `traceAskSending` covers the gap
  // between the click and the turn arming, and `ambientBusy` the turn itself.
  const [traceAsk, setTraceAsk] = useState<"goals" | "review" | null>(null);
  const [traceAskSending, setTraceAskSending] = useState(false);
  // Both the question and the spinner follow the project Trace's own strip
  // names — `placeRoot`, the one the picker writes — not the folder that
  // happens to be open. They are the same right up until you use the picker,
  // and after that the old wiring proved the wrong repo's goals while the row
  // watched a third project's chat for an answer that was never coming.
  const ambientBusy = useAmbientTurnBusy(placeRoot || null);
  // Release the row once the dispatch has settled AND the brain is done. Until
  // both are true the answer hasn't landed in the chat yet.
  useEffect(() => {
    if (traceAsk && !traceAskSending && !ambientBusy) setTraceAsk(null);
  }, [traceAsk, traceAskSending, ambientBusy]);
  // Step off whichever full-page view is up. Aura, Workspaces, Mission Control
  // and Trace render as an opaque cover *over* the work surface, so anything
  // opened as a workpane while one of them is showing really does open —
  // focused, in the tab strip, entirely invisible. Every "take me to X in the
  // main area" path calls this first: asking for somewhere else is leaving
  // here.
  const leavePages = useCallback(() => {
    setAuraSid(null);
    setWsOpen(false);
    setTracePage(null);
    setPlace(null);
    // A machine is *blurred*, not left. Asking for a workpane means the box has
    // to stop covering the window, but it does not mean you are done with the
    // box — its sessions keep running, its row stays lit as open in the rail,
    // and one click puts you back in front of it. Leaving for real is the
    // workspace's own Leave button, which is the only thing that drops it.
    setRemotePlaces(blurRemotePlaces);
  }, []);
  leavePagesRef.current = leavePages;
  // Going to Trace. Every door — the rail's Trace row, the strip on the page,
  // a symbol row asking for the time machine — arrives here, so there is one
  // Trace rather than one per entrance.
  const goTrace = useCallback(
    (dest: TraceDest) => {
      leavePages();
      setTracePage(dest);
    },
    [leavePages],
  );
  // The deep callers (a session card, a symbol inside an intent story) ask by
  // event rather than by prop — see components/trace/traceRoute.
  useEffect(() => {
    const onGo = (e: Event) => {
      const dest = (e as CustomEvent<TraceDest>).detail;
      if (dest) goTrace(dest);
    };
    window.addEventListener(TRACE_GO_EVENT, onGo);
    return () => window.removeEventListener(TRACE_GO_EVENT, onGo);
  }, [goTrace]);
  // Going to Pages / Tasks / Team. Same single door as Trace: the rail row,
  // a keyboard shortcut, a palette command, a page mention and an empty
  // pane's "open chat" all arrive here.
  const goPlace = useCallback(
    (next: CollabPlace) => {
      leavePages();
      setPlace(next);
    },
    [leavePages],
  );
  useEffect(() => {
    const onGoPlace = (e: Event) => {
      const next = (e as CustomEvent<CollabPlace>).detail;
      if (next) goPlace(next);
    };
    window.addEventListener(PLACE_GO_EVENT, onGoPlace);
    return () => window.removeEventListener(PLACE_GO_EVENT, onGoPlace);
  }, [goPlace]);
  const [wsFilter, setWsFilter] = useState<string | null>(null);
  // Which section the agent-customize overlay lands on. A bare open (account
  // menu / palette) uses "overview"; a deep-link row in the Build rail passes
  // `{ pane }` so Skills / Instructions / Connections open in one click.
  const [agentCustomizeView, setAgentCustomizeView] =
    useState<CustomizeViewId>("overview");
  // Full-height ADE sidebar owns the traffic-light corner; the header drops
  // its own left inset in fullscreen (lights vanish) via this probe.
  const fullscreen = useIsFullscreen();
  // In-rail browser: the far-edge globe tab + RailBrowser. Restored by request.
  const BROWSER_RAIL_ENABLED = true;
  // If the rail is parked on the (now absent) browser tab, fall back so the
  // rail body isn't blank.
  useEffect(() => {
    if (!BROWSER_RAIL_ENABLED && rightRailTab === "browser") {
      setRightRailTab("files");
    }
  }, [rightRailTab, BROWSER_RAIL_ENABLED]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [translocationBannerDismissed, setTranslocationBannerDismissed] =
    useState(false);
  const [appLocation, setAppLocation] = useState<{
    translocated: boolean;
    writable: boolean;
    bundle_path?: string;
  } | null>(null);
  const [logIntentOpen, setLogIntentOpen] = useState(false);
  const [logIntentPrefill, setLogIntentPrefill] = useState<string | undefined>(
    undefined,
  );
  const [logIntentSource, setLogIntentSource] = useState<string | undefined>(
    undefined,
  );
  const [logIntentDefaultPaths, setLogIntentDefaultPaths] = useState<
    string[] | undefined
  >(undefined);
  const [intentEditTs, setIntentEditTs] = useState<number | null>(null);
  // Strict-mode commit-guard state. The guard is invoked synchronously
  // from GitSidebar's commit handler via a Promise — we hold the
  // resolver here so the dialog buttons can decide the outcome.
  const [strictGuard, setStrictGuard] = useState<{
    open: boolean;
    readiness: import("./lib/strictModeGate").StrictReadiness | null;
    resolve: ((proceed: boolean) => void) | null;
  }>({ open: false, readiness: null, resolve: null });
  // The semantic commit gate. Same shape as the strict guard above, and it
  // runs first: "what you asked for and what the agent did disagree" is a
  // stronger, checkable claim than "this file has no note", so when both
  // would fire the person should read the one that names the broken caller.
  const [intentGuard, setIntentGuard] = useState<{
    open: boolean;
    verdict: IntentVerdict | null;
    tests: string | null;
    busy: string | null;
    resolve: ((proceed: boolean) => void) | null;
  }>({ open: false, verdict: null, tests: null, busy: null, resolve: null });
  // Decoupled summon for LogIntentDialog with optional prefill — used
  // by the in-stream watchdog warning bubble (B2) and the AuraWatch
  // nudge bubble (C5). Mirrors the aura:open-resume idiom.
  useEffect(() => {
    function open(e: Event) {
      const detail = (e as CustomEvent).detail as
        | { defaultText?: string; source?: string; defaultPaths?: string[] }
        | undefined;
      setLogIntentPrefill(detail?.defaultText);
      setLogIntentSource(detail?.source);
      setLogIntentDefaultPaths(detail?.defaultPaths);
      setLogIntentOpen(true);
    }
    window.addEventListener("aura:open-log-intent", open);
    return () => window.removeEventListener("aura:open-log-intent", open);
  }, []);
  // V0.2.22 — UserIdentityBar settings-gear dispatches
  // `aura:open-settings`. Route it into the existing SettingsDialog
  // open state instead of threading a callback prop into the identity
  // bar (which would force it to know about App.tsx state).
  useEffect(() => {
    function onEvent() {
      setSettingsOpen(true);
    }
    window.addEventListener("aura:open-settings", onEvent);
    return () => window.removeEventListener("aura:open-settings", onEvent);
  }, []);
  // `aura:open-extensions` — the Commons Apps banner and the command palette
  // both dispatch this. Extensions no longer own a standalone wizard; they now
  // live inside the unified "Agents & extensions" surface, so route the event
  // there and land directly on the Extensions pane. One home, opened from
  // anywhere.
  useEffect(() => {
    function onEvent() {
      setAgentCustomizeView("extensions");
      setAgentCustomizeOpen(true);
    }
    window.addEventListener("aura:open-extensions", onEvent);
    return () => window.removeEventListener("aura:open-extensions", onEvent);
  }, []);
  // `aura:open-time-machine` — the in-pane expand affordance, ⌘⌥T, and the
  // command palette all dispatch this; route it into the immersive full-screen
  // Time machine wizard. An optional { identifier, file } detail carries a
  // right-click prefill straight to the moment that touched it.
  useEffect(() => {
    function onEvent(e: Event) {
      const detail = (e as CustomEvent).detail as
        | { identifier?: string | null; file?: string | null }
        | undefined;
      setTimeMachine({
        identifier: detail?.identifier ?? null,
        file: detail?.file ?? null,
      });
    }
    window.addEventListener("aura:open-time-machine", onEvent);
    return () => window.removeEventListener("aura:open-time-machine", onEvent);
  }, []);
  // `aura:open-timeline` — the Trace rail's "Project timeline" row (and any
  // future entry point) dispatches this; route it into the immersive full-screen
  // Project Timeline wizard. One overlay, opened from anywhere, mirroring the
  // Time machine / Extensions wiring.
  useEffect(() => {
    function onEvent() {
      setTimelineOpen(true);
    }
    window.addEventListener("aura:open-timeline", onEvent);
    return () => window.removeEventListener("aura:open-timeline", onEvent);
  }, []);
  // `aura:open-checks` — the BuildNav "Checks" row (and any future entry point)
  // dispatches this; route it into the full-screen Semantic CI surface. One
  // overlay, opened from anywhere, mirroring the Extensions wiring.
  useEffect(() => {
    function onEvent() {
      setChecksOpen(true);
    }
    window.addEventListener("aura:open-checks", onEvent);
    return () => window.removeEventListener("aura:open-checks", onEvent);
  }, []);
  // `aura:open-source-control` — clicking the branch name in the footer status
  // bar opens the full-screen Source Control surface (Changes + History) rather
  // than only a tiny branch-switch popover. One overlay, opened from anywhere.
  useEffect(() => {
    function onEvent() {
      setSourceControlOpen(true);
    }
    window.addEventListener("aura:open-source-control", onEvent);
    return () =>
      window.removeEventListener("aura:open-source-control", onEvent);
  }, []);
  // `aura:open-files-panel` — the Changes panel's "All files" tab routes to the
  // right rail's Files surface (sibling tabs; one nav, opened from anywhere).
  useEffect(() => {
    function onEvent() {
      setRightRailTab("files");
    }
    window.addEventListener("aura:open-files-panel", onEvent);
    return () => window.removeEventListener("aura:open-files-panel", onEvent);
  }, []);
  // `aura:open-signin` — clicking "Sign in" anywhere (titlebar avatar, Settings
  // row, a team-chat nudge) opens the full-screen welcome surface rather than a
  // cramped popover. One overlay, opened from anywhere.
  useEffect(() => {
    function onEvent() {
      setSignInOpen(true);
    }
    window.addEventListener("aura:open-signin", onEvent);
    return () => window.removeEventListener("aura:open-signin", onEvent);
  }, []);
  // `aura:open-pair-phone` — Account menu → "Pair phone" opens the QR the
  // mobile companion scans to sign in. Single overlay, opened from anywhere.
  useEffect(() => {
    function onEvent() {
      setPairPhoneOpen(true);
    }
    window.addEventListener("aura:open-pair-phone", onEvent);
    return () => window.removeEventListener("aura:open-pair-phone", onEvent);
  }, []);
  // `aura:open-agent-customizations` — the full-screen home for shaping how the
  // AI works on this project (agents, skills, instructions, safety checks,
  // connections, plugins). Opened from the account menu / command palette.
  useEffect(() => {
    function onEvent(e: Event) {
      const pane = (e as CustomEvent<{ pane?: CustomizeViewId }>).detail?.pane;
      setAgentCustomizeView(pane ?? "overview");
      setAgentCustomizeOpen(true);
    }
    window.addEventListener("aura:open-agent-customizations", onEvent);
    return () =>
      window.removeEventListener("aura:open-agent-customizations", onEvent);
  }, []);
  // `aura:work:go` — Tasks, the one place the work lives. Fired by the rail's
  // row (no lens: take me back where I was), by the rail's map door (`map`),
  // and by the crew page when it has just set agents running (`list`: watch
  // them land on the work). Clicking the row again goes back to the work you
  // left, the way a nav destination does — a second click on where you already
  // are is a way out, not a no-op.
  useEffect(() => {
    function onEvent(e: Event) {
      const lens = (e as CustomEvent<WorkLens | undefined>).detail;
      setAuraSid(null);
      setWsOpen(false);
      setTracePage(null);
      if (lens) {
        setWorkLens(lens);
        writeWorkLens(lens);
        setPlace("tasks");
        return;
      }
      setPlace((p) => (p === "tasks" ? null : "tasks"));
    }
    window.addEventListener(WORK_GO_EVENT, onEvent);
    return () => window.removeEventListener(WORK_GO_EVENT, onEvent);
  }, []);
  // `aura:open-workspaces` — the Workspaces page (time list + status board over
  // every parallel copy). Fired by the roster's "…more parallel copies"
  // disclosure (carrying a projectId to scope the view) and by a plain "View
  // all" affordance (no detail = every open project). A scoped re-open
  // re-scopes rather than toggling shut — the click means "show me this
  // project", not "close".
  useEffect(() => {
    function onEvent(e: Event) {
      const projectId = (e as CustomEvent<{ projectId?: string }>).detail
        ?.projectId;
      setAuraSid(null);
      setPlace(null);
      setWsFilter(projectId ?? null);
      setWsOpen((open) => (projectId ? true : !open));
    }
    window.addEventListener("aura:open-workspaces", onEvent);
    return () => window.removeEventListener("aura:open-workspaces", onEvent);
  }, []);
  // Deep-links carried in auto-DMs + page mentions: a task assignment opens the
  // task detail, an @mention of a person opens the DM thread (the Team sidebar
  // focuses it via `aura:open-dm` in useTeamChat), and a page mention opens the
  // Pages surface on that page (routed through the legacy `aura:pages:open`
  // bridge once the surface mounts). Defined after `selectSidebarTab` so the
  // effect's deps don't hit the TDZ.
  // B8 — AuraWatch moved from a modal dialog into the Settings →
  // AuraWatch pane. When the user changes mode there, the pane fires
  // `aura:aurawatch-mode`; resync App's own `auraWatchMode` so the
  // footer chip and the lifecycle effect (keyed on auraWatchMode) follow
  // along without re-reading localStorage on dialog-close.
  useEffect(() => {
    function onMode(e: Event) {
      const mode = (e as CustomEvent<{ mode?: typeof auraWatchMode }>).detail
        ?.mode;
      if (mode) setAuraWatchMode((prev) => (prev === mode ? prev : mode));
    }
    window.addEventListener("aura:aurawatch-mode", onMode);
    return () => window.removeEventListener("aura:aurawatch-mode", onMode);
  }, []);
  // Tasks + Standup workpane shortcuts are now registered below, after
  // `useEditorStore()` is in scope. See the "Cmd+Shift+T / Cmd+Shift+U"
  // block further down in this component for #266 wiring.
  // Cmd+Shift+N → see the RR.3 effect below, after `editor` is in
  // scope. The shortcut needs `editor.openPages`, which can't reference
  // the store before `useEditorStore()` is called.

  // v0.2.28 — ⌘⇧F opens the project-wide Search workpane. Bounce an
  // `aura:open-search` event with `{ query }` to prefill it (e.g. from a
  // future right-click context menu or chat code block).
  useEffect(() => {
    function onEvent(e: Event) {
      const detail = (
        e as CustomEvent<{
          query?: string;
          regex?: boolean;
          caseSensitive?: boolean;
          wholeWord?: boolean;
        }>
      ).detail;
      setSearchOpen(true);
      // Forward the whole detail (query + the VS Code-style match toggles)
      // so an entry point like the Files-panel search box can preload the
      // full Search workpane with its case/word/regex state, not just text.
      if (detail) {
        window.setTimeout(() => {
          window.dispatchEvent(
            new CustomEvent("aura:prefill-search", { detail }),
          );
        }, 50);
      }
    }
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setSearchOpen(true);
      }
      // ⌘⌥T — summon the immersive Time machine from anywhere.
      if ((e.metaKey || e.ctrlKey) && e.altKey && e.key.toLowerCase() === "t") {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("aura:open-time-machine"));
      }
    }
    window.addEventListener("aura:open-search", onEvent);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("aura:open-search", onEvent);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  // v0.2.28 — App-bundle location probe (translocation banner). Runs once
  // on mount; if macOS App Translocation moved the bundle to a read-only
  // location, the updater can't auto-install, so we surface a banner with
  // a "Move to Applications" hint.
  useEffect(() => {
    let cancelled = false;
    api
      .appBundleLocation()
      .then((loc) => {
        if (!cancelled) setAppLocation(loc);
      })
      .catch(() => {
        /* dev mode / non-macOS — no banner */
      });
    return () => {
      cancelled = true;
    };
  }, []);
  // Cmd+N starts a new chat (ADE: inline center-pane tab; legacy: the
  // launcher modal). Skip when the event would land on a text input —
  // typing "n" inside the composer or a dialog shouldn't fire it.
  useEffect(() => {
    function onEvent() {
      newSessionActionRef.current();
    }
    function onKey(e: KeyboardEvent) {
      if (e.shiftKey || e.altKey) return;
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key.toLowerCase() !== "n") return;
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.isContentEditable)
      ) {
        return;
      }
      e.preventDefault();
      newSessionActionRef.current();
    }
    window.addEventListener("aura:new-session", onEvent);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("aura:new-session", onEvent);
      window.removeEventListener("keydown", onKey);
    };
  }, []);
  // Cmd+Shift+B opens a new in-app browser tab (superset parity). Also
  // openable from the command palette / port list via `aura:open-browser-tab`,
  // with an optional `{ url }` to jump straight to an address.
  useEffect(() => {
    function onEvent(e: Event) {
      const url = (e as CustomEvent<{ url?: string }>).detail?.url;
      openBrowserTab(url);
    }
    function onKey(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey) || !e.shiftKey || e.altKey) return;
      if (e.key.toLowerCase() !== "b") return;
      e.preventDefault();
      openBrowserTab();
    }
    window.addEventListener("aura:open-browser-tab", onEvent);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("aura:open-browser-tab", onEvent);
      window.removeEventListener("keydown", onKey);
    };
  }, []);
  // Cmd+/ pops the keyboard-shortcuts cheat-sheet (Conductor parity). Also
  // openable from the command palette via `aura:open-shortcuts`. Fires even
  // inside inputs — ⌘/ never types a literal slash, and you often want the
  // map while mid-composer. Pressing it again toggles the sheet closed.
  useEffect(() => {
    function openSheet() {
      setShortcutsOpen(true);
    }
    function onKey(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
      if (e.key !== "/") return;
      e.preventDefault();
      setShortcutsOpen((v) => !v);
    }
    window.addEventListener("aura:open-shortcuts", openSheet);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("aura:open-shortcuts", openSheet);
      window.removeEventListener("keydown", onKey);
    };
  }, []);
  // Conductor-parity roster shortcuts (also shown as hints in the project
  // right-click menu, so they must be real):
  //   ⌘⇧N → new workspace "from…" (opens the create composer on the base
  //          picker for the active project)
  //   ⌘,  → repository settings (Copies & agents pane for the active repo)
  // Both defer to the same window events the menu items dispatch, so there's
  // one code path. Skipped while typing so ⌘, / ⌘⇧N inside a field is inert.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      const el = e.target as HTMLElement | null;
      const typing =
        !!el &&
        (el.tagName === "INPUT" ||
          el.tagName === "TEXTAREA" ||
          el.isContentEditable);
      if (e.shiftKey && e.key.toLowerCase() === "n" && !typing) {
        e.preventDefault();
        window.dispatchEvent(
          new CustomEvent("aura:new-workspace", { detail: { createFrom: true } }),
        );
        return;
      }
      if (!e.shiftKey && e.key === "," && !typing) {
        e.preventDefault();
        window.dispatchEvent(
          new CustomEvent("aura:open-settings", { detail: { pane: "copies" } }),
        );
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  // Right-click on an intent row in HistorySidebar pops the split/merge
  // editor with the row's timestamp. Cleared on dialog close.
  useEffect(() => {
    function open(e: Event) {
      const detail = (e as CustomEvent).detail as
        | { intentTs?: number }
        | undefined;
      if (typeof detail?.intentTs === "number") {
        setIntentEditTs(detail.intentTs);
      }
    }
    window.addEventListener("aura:open-intent-edit", open);
    return () => window.removeEventListener("aura:open-intent-edit", open);
  }, []);
  // Symbol-level rewind summon — fired by the SymbolContextMenu so the
  // user right-clicks a function name and lands in the Time machine with
  // identifier + file already filled.
  useEffect(() => {
    function open(e: Event) {
      const detail = (e as CustomEvent).detail as
        | { identifier?: string; file?: string }
        | undefined;
      goTrace({ kind: "tool", tool: "rewind", arg: detail ?? undefined });
    }
    window.addEventListener("aura:open-rewind", open);
    return () => window.removeEventListener("aura:open-rewind", open);
  }, []);
  // Generic Trace-surface deep-link — any caller (command palette, an agent
  // deep-link, an inline "open the safety check" help link) can summon a
  // specific Trace tool by name without prop-drilling a handler. detail.tool
  // is one of the TraceTool ids; detail.args is passed straight through.
  useEffect(() => {
    function open(e: Event) {
      const detail = (e as CustomEvent).detail as
        | { tool?: string; args?: { identifier?: string; file?: string } }
        | undefined;
      const tool = detail?.tool;
      if (
        tool === "review" ||
        tool === "rewind" ||
        tool === "attest" ||
        tool === "memory" ||
        tool === "impacts" ||
        tool === "doctor"
      ) {
        goTrace({ kind: "tool", tool, arg: detail?.args ?? undefined });
      }
    }
    window.addEventListener("aura:open-trace-tool", open);
    return () => window.removeEventListener("aura:open-trace-tool", open);
  }, []);
  // Op-log dialog summon — fired by the ⌘Z keymap (W1.4) and the
  // command palette so any surface can open it without prop-drilling.
  useEffect(() => {
    function open() {
      setOpLogOpen(true);
    }
    window.addEventListener("aura:open-op-log", open);
    return () => window.removeEventListener("aura:open-op-log", open);
  }, []);
  // Conflicts dialog summon — fired by the StatusBar chip and the
  // /conflicts slash command.
  useEffect(() => {
    function open() {
      setConflictsOpen(true);
    }
    window.addEventListener("aura:open-conflicts", open);
    return () => window.removeEventListener("aura:open-conflicts", open);
  }, []);
  const [snapshotOpen, setSnapshotOpen] = useState(false);
  const [compareOpen, setCompareOpen] = useState(false);
  // Compare-worktrees dialog summon — fired by the Manager surface
  // (right-click a task → "Compare with sibling worktrees") and by the
  // `/compare` slash command. Listed under workspace context too so
  // the user can launch it without going through Manager.
  useEffect(() => {
    function open() {
      setCompareOpen(true);
    }
    window.addEventListener("aura:open-compare", open);
    return () => window.removeEventListener("aura:open-compare", open);
  }, []);
  const [resumeOpen, setResumeOpen] = useState(false);
  // Listen for the SessionInfoCard's "switch" action so the deeply-
  // nested card can reopen this dialog without prop-drilling.
  useEffect(() => {
    function open() {
      setResumeOpen(true);
    }
    window.addEventListener("aura:open-resume", open);
    return () => window.removeEventListener("aura:open-resume", open);
  }, []);
  // "Show me the history" — a symbol's context menu, an agent tab's menu, a
  // recent-intent row. These used to flip the legacy sidebar to its History
  // body. Trace's Sessions feed is where that timeline lives now, so they go
  // there rather than setting a piece of state nothing reads.
  useEffect(() => {
    const open = () => goTrace({ kind: "sessions", view: "overview" });
    window.addEventListener("aura:open-history", open);
    return () => window.removeEventListener("aura:open-history", open);
  }, [goTrace]);
  // The Changes panel's branch-graph button. The graph is drawn by Source
  // Control's own History tab — that's the one place it exists.
  useEffect(() => {
    const open = () => setSourceControlOpen(true);
    window.addEventListener("aura:open-branch-graph", open);
    return () => window.removeEventListener("aura:open-branch-graph", open);
  }, []);
  const [askOpen, setAskOpen] = useState(false);
  const [askPrefill, setAskPrefill] = useState<string | undefined>(undefined);
  // `null` until a `git diff` has actually come back. It used to start at
  // `{changed_files: 0, ...}`, which is a real answer — "this tree is clean" —
  // so the footer opened every window with "0 changes" and a hover reading
  // "No changes yet", and the branch chip said nothing was uncommitted,
  // before anything had been read.
  const [diffStats, setDiffStats] = useState<DiffStats | null>(null);
  const [impactsCount, setImpactsCount] = useState(0);
  const [conflictsCount, setConflictsCount] = useState(0);
  // jj-style durable AST conflicts in `.aura/conflicts.jsonl`. Distinct
  // from `conflictsCount` above which scans sentinel + git markers.
  const [astConflictsOpen, setAstConflictsOpen] = useState(0);
  // Banner row dismissals are session-scoped — restart re-shows them
  // until the underlying alert flips to resolved.
  const [dismissedImpactIds, setDismissedImpactIds] = useState<Set<string>>(
    () => new Set(),
  );
  // Zone rules used to be polled here to draw an ownership chip on each file
  // tab in the old global strip. That strip is gone, and zones already have a
  // home the user can actually find — the Radar's Zones section, which fetches
  // its own. So this poll fetched, every four seconds, a list nothing rendered.
  // Strict-mode posture from ~/.aura/credentials.json. Long-cadence
  // poll (120s) — the field rarely changes. Drives the StatusBar +
  // SessionInfoCard pill, and the commit-time confirmation guard.
  const [strictMode, setStrictMode] = useState<StrictModeInfo["mode"]>("off");
  // Task #229 — installed `aura` CLI version vs. the version the shell
  // was built against. One-shot at boot + manual refresh via the chip
  // popover; no polling. `null` while the first check is in flight.
  const [cliVersion, setCliVersion] = useState<AuraCliCheck | null>(null);
  // What's-new after an update: a small dismissible card at the foot of the
  // sidebar (see lib/releaseNotes). Computed once on boot from the running app
  // version vs the last version we showed.
  const [whatsNew, setWhatsNew] = useState<WhatsNewPending | null>(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const { getVersion } = await import("@tauri-apps/api/app");
        const v = await getVersion();
        const pending = pendingWhatsNew(v);
        if (alive && pending) {
          setWhatsNew(pending);
          trackFeature("whats_new_shown", {
            version: pending.note.version,
          });
        }
      } catch {
        /* non-Tauri / version unavailable — show nothing */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);
  const dismissWhatsNew = useCallback(() => {
    setWhatsNew((cur) => {
      if (cur) markWhatsNewSeen(cur.note.version);
      return null;
    });
  }, []);
  // "Aura on your phone" — offered once by the release note's CTA, findable
  // afterwards from ⌘K or Settings → Connections.
  const [mobileWaitlistOpen, setMobileWaitlistOpen] = useState(false);
  const takeReleaseCta = useCallback((kind: ReleaseCta) => {
    if (kind === "mobile-waitlist") {
      setMobileWaitlistOpen(true);
      trackFeature("mobile_waitlist_opened", { from: "whats_new" });
    }
  }, []);
  // Get-started tour: no longer auto-opens on launch. First-run onboarding is
  // now the pre-populated "Get Started" workspace (Recipe Box) the app boots
  // onto — a real project beats a guided overlay — so the tour is opt-in only,
  // replayable anytime from Settings via `aura:start-tour`.
  const [tourOpen, setTourOpen] = useState(false);
  useEffect(() => {
    const replay = () => setTourOpen(true);
    window.addEventListener("aura:start-tour", replay);
    return () => window.removeEventListener("aura:start-tour", replay);
  }, []);
  const closeTour = useCallback(() => {
    markTourSeen();
    setTourOpen(false);
  }, []);
  // Tour hand-off: the final "Start building" step fires this. Switch to the
  // Build surface via the real section button (the same nav the tour's
  // `activate` steps use), then — once the composer has mounted — drop focus
  // into it so the user can type their first ask immediately. Double rAF gives
  // the surface swap a frame to render the composer before we focus it.
  useEffect(() => {
    const onFocusComposer = () => {
      document
        .querySelector<HTMLElement>('[data-tour="section-build"]')
        ?.click();
      requestAnimationFrame(() =>
        requestAnimationFrame(() =>
          window.dispatchEvent(new Event("aura:focus-composer")),
        ),
      );
    };
    window.addEventListener("aura:tour-focus-composer", onFocusComposer);
    return () =>
      window.removeEventListener("aura:tour-focus-composer", onFocusComposer);
  }, []);
  // AuraWatch chip state. Mode is the user's persisted choice; backend
  // is what the registry actually resolved. Polled every 30s alongside
  // the lifecycle effect — cheap, single Tauri call.
  const [auraWatchMode, setAuraWatchMode] = useState<
    "off" | "nudge" | "autonomous"
  >(
    () =>
      (localStorage.getItem("aura.aurawatch.mode") as
        | "off"
        | "nudge"
        | "autonomous"
        | null) ?? "nudge",
  );
  // The footer no longer surfaces the aurawatch backend / usage / intents-today
  // counts (moved to Settings, Cost & usage, and History respectively), so these
  // are write-only now: the status poll still refreshes them for their other
  // consumers / future readers, but nothing in App reads the value directly. The
  // read binding is dropped so `noUnusedLocals` stays clean while the setter's
  // fetch path is preserved.
  const [, setAuraWatchBackend] = useState<
    | "ollama"
    | "anthropic"
    | "openai"
    | "gemini"
    | "mercury"
    | "agent_cli"
    | "generic"
    | null
  >(null);
  const [, setUsage] = useState<UsageSummary>({
    tokens_in: 0,
    tokens_out: 0,
    cost_usd: 0,
    calls: 0,
    model: "",
  });
  const [, setIntentsToday] = useState(0);
  const [auditUnacked, setAuditUnacked] = useState(0);
  const [zoom, setZoom] = useState<number>(storedZoom);
  const [output, setOutput] = useState<OutputState>({
    open: false,
    title: "",
    body: "",
    loading: false,
    error: null,
  });
  const editor = useEditorStore();
  // Store-backed bottom-panel open state (persisted + workspace-scoped).
  const terminalOpen = editor.terminalPanelOpen;
  // Always-current editor handle — useEditorStore() returns a fresh
  // object each render, but its mutators (openManager, …) are stable
  // module-level fns. A ref lets the []-dep callbacks below call the
  // latest handle without re-subscribing on every render.
  const editorRef = useRef(editor);
  editorRef.current = editor;
  const windowVisible = useDocumentVisibility();

  // PRs live in the right rail's PRs tab in ADE (one home). The center
  // InboxPane is legacy-only now, but a workspace snapshot saved before
  // this change can restore `activeInbox: true` and surface the inbox in
  // the center too. Heal that on load: drop the stale center inbox and
  // point the rail at PRs instead, so PRs never show in two places.
  useEffect(() => {
    if (editor.activeInbox) {
      editor.closeInbox();
      setRightRailTab("prs");
    }
  }, [editor.activeInbox, editor]);

  // `aura:open-session-detail` — the Project Timeline (and any future surface)
  // asks to jump from a moment to its full Trace Session detail. We close the
  // immersive Timeline overlay and open the Sessions tab; TraceSurface itself
  // selects the right row (live event when already mounted, pending cell on
  // first mount). Stable []-deps via the always-current editor ref.
  useEffect(() => {
    function onOpenSessionDetail() {
      setTimelineOpen(false);
      editorRef.current.openSessions("sessions");
    }
    window.addEventListener("aura:open-session-detail", onOpenSessionDetail);
    return () =>
      window.removeEventListener(
        "aura:open-session-detail",
        onOpenSessionDetail,
      );
  }, []);

  // ── New-chat: inline, not a modal ──────────────────────────────────
  // "+" and ⌘N start a blank chat-only Manager session and open it as a
  // center workpane tab in the active workspace — no popup. The heavyweight
  // task-DAG launcher (ManagerLauncher) is an explicit "orchestrate" action,
  // not the everyday new-chat. Project root comes from a ref so these stay
  // correct as stable []-dep callbacks.
  // Where Aura opens when no workspace is loaded. The orchestrator is a *who*,
  // not a *where* — it spans every project — so the absence of an open folder
  // must never be the reason its door does nothing. Falls back to the most
  // recently opened workspace (`aura.recents` is append-ordered, so the tail is
  // newest); read straight from storage because the `recents` state is declared
  // further down this component.
  const lastKnownRoot = useCallback((): string | null => {
    try {
      const raw = localStorage.getItem("aura.recents");
      if (!raw) return null;
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return null;
      for (let i = arr.length - 1; i >= 0; i--) {
        const r = arr[i];
        if (typeof r === "string" && r && !isManagedWorktree(r)) return r;
      }
      return null;
    } catch {
      return null;
    }
  }, []);
  const startInlineChat = useCallback(() => {
    // Native Aura Manager gated off → never spin up a chat session; land on
    // the calm empty surface (the dashboard slot renders WorkSurfaceEmpty)
    // so the user reaches for a CLI agent / terminal / search instead.
    if (!AURA_MANAGER_ENABLED) {
      editorRef.current.setActiveDashboard();
      return;
    }
    const root = currentRootRef.current ?? lastKnownRoot();
    if (!root) {
      // Nothing has ever been opened on this machine — the one case where
      // there is genuinely no project to talk about. Ask for one instead of
      // swallowing the click.
      pickAndOpenFolderRef.current();
      return;
    }
    // Where the window is standing when the key was pressed. A new chat opened
    // while a machine is in front of you is a chat about the code on THAT
    // machine — the alternative is a conversation that looks identical to the
    // one you wanted and quietly reads a different copy of the project.
    const place = placeForNewWork(root);
    api
      .managerChatStart(root, "", place)
      .then((sid) => {
        editorRef.current.openManager(sid, "New chat");
        writeAmbientSid(root, place, sid);
      })
      .catch((e) => console.error("[manager] new chat failed:", e));
  }, [lastKnownRoot]);
  // Open Aura — THE orchestrator conversation, on its own window-owning
  // surface. Behind the sidebar's Aura row, ⌘⌥A, and `aura:open-aura`.
  //
  // Two things were wrong with the old behaviour, and they compounded.
  //
  // It resolved `aura.ambient.<current project>`, so the Aura row meant "the
  // chat about whatever workspace is in front of me" — open the bundled sample
  // and Aura handed back the sample's old thread. `resolveOrchestratorSession`
  // keeps one pointer instead, unqualified by repo, validated so a restart that
  // cleared the session behind it falls through to a fresh one rather than a
  // tab the backend can't load.
  //
  // And it opened as a workpane tab, which put a conversation that spans every
  // project inside one project's frame: that repo's file tree, its changed-file
  // count, its agent strip. Aura gets its own page across the whole shell, the
  // way Workspaces does.
  //
  // `root` is only an anchor for minting a fresh session; the brain's
  // control-plane tools reach every project regardless of which one it holds.
  const focusOrStartChat = useCallback(() => {
    if (!AURA_MANAGER_ENABLED) {
      editorRef.current.setActiveDashboard();
      return;
    }
    // Already on the Aura page → the click takes you back to your work.
    if (auraSidRef.current) {
      setAuraSid(null);
      return;
    }
    setWsOpen(false);
    setPlace(null);
    // No project needed to get here. Aura's conversation is stored unqualified
    // by repo, so if one exists it opens on its own terms — the folder picker
    // is only for the true first run, where there is no conversation yet and
    // nowhere to start one.
    void resolveOrchestratorSession(currentRootRef.current ?? lastKnownRoot())
      .then((sid) => {
        if (sid) setAuraSid(sid);
        else pickAndOpenFolderRef.current();
      })
      .catch((e) => console.error("[manager] open Aura failed:", e));
  }, [lastKnownRoot]);
  // "New thread" from inside the Aura surface — a fresh conversation that
  // becomes the one the Aura row opens from now on. The old one isn't deleted;
  // it just stops being the one behind the door.
  const startNewAuraThread = useCallback(() => {
    const root = currentRootRef.current ?? lastKnownRoot();
    if (!root) return;
    void startNewOrchestratorSession(root)
      .then((sid) => setAuraSid(sid))
      .catch((e) => console.error("[manager] new Aura thread failed:", e));
  }, [lastKnownRoot]);
  // Aura from anywhere: ⌘⌥A and the `aura:open-aura` event (command palette).
  // ⌘⇧A is already taken system-wide by the menu-bar HUD, which the OS
  // intercepts before the webview ever sees it — so the in-app door gets ⌥.
  // Declared after `focusOrStartChat` so the dep array doesn't hit its TDZ.
  useEffect(() => {
    function open() {
      focusOrStartChat();
    }
    function onKey(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey) || !e.altKey || e.shiftKey) return;
      // Option composes a different character on macOS (⌥A → "å"), and whether
      // Cmd suppresses that is inconsistent across WebKit versions — so match
      // the physical key too rather than trusting `key` alone.
      if (e.key.toLowerCase() !== "a" && e.code !== "KeyA") return;
      e.preventDefault();
      focusOrStartChat();
    }
    window.addEventListener("aura:open-aura", open);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("aura:open-aura", open);
      window.removeEventListener("keydown", onKey);
    };
  }, [focusOrStartChat]);
  // The "new session" action behind the + button, ⌘N, and aura:new-session.
  const newSessionAction = useCallback(() => {
    // Native chat gated off → no inline chat, no launcher modal; just reveal
    // the calm empty surface so + / ⌘N land on the action list.
    if (!AURA_MANAGER_ENABLED) {
      editorRef.current.setActiveDashboard();
      return;
    }
    startInlineChat();
  }, [startInlineChat]);
  newSessionActionRef.current = newSessionAction;

  // Cmd+T (or "aura:open-tasks") opens the Tasks board. Cmd+Shift+T
  // also works for users who learned the original binding. Standup
  // stays on Cmd+Shift+U — leaving the un-shifted Cmd+U slot free for
  // the platform's "view source" instinct. With a repo open the board
  // lands as a first-class workpane tab (#266); without one we fall
  // back to the legacy modal.
  useEffect(() => {
    function openTasks() {
      if (!projectRootRef.current) return;
      goPlace("tasks");
    }
    function openStandup() {
      const root = projectRootRef.current;
      if (!root) return;
      leavePages();
      editor.openStandup(root);
    }
    // V.Y.4 — open the active huddle's screenshare as a workpane tab.
    // CallPanel auto-fires `aura:open-screenshare` the first time a
    // new track shows up; the StatusBar pill's "View share" button
    // fires the same event with the same payload. The workpane id is
    // the composite huddle key so re-shares inside the same huddle
    // re-use the existing tab.
    function openScreenshare(ev: Event) {
      const detail = (ev as CustomEvent).detail as
        | { workpaneId?: string }
        | undefined;
      const id = detail?.workpaneId;
      if (!id) return;
      // Deliberately does NOT call `leavePages()`: CallPanel fires this by
      // itself the moment a track appears, and a teammate starting a share is
      // not a reason to yank you off the page you're reading.
      editor.openScreenshare(id);
    }
    // RR.3 — Cmd+Shift+N (or `aura:open-notes`) opens the Pages
    // workpane tab. No-op without a repo open — Pages needs a project
    // to read team notes from.
    function openPages() {
      if (!projectRootRef.current) return;
      goPlace("pages");
    }
    function onKey(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey)) return;
      const k = e.key.toLowerCase();
      const t = e.target as HTMLElement | null;
      const inEditable =
        !!t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.isContentEditable);
      if (inEditable) return;
      if (k === "t" && !e.shiftKey) {
        // Cmd+T opens the Tasks board — what users intuitively try first.
        e.preventDefault();
        openTasks();
      } else if (k === "t" && e.shiftKey) {
        // Cmd+Shift+T reopens the most-recently-closed tab (VS Code parity).
        // No-op when nothing reopenable was closed this session.
        e.preventDefault();
        editor.reopenClosedTab();
      } else if (k === "u" && e.shiftKey) {
        e.preventDefault();
        openStandup();
      }
      // ⌘⇧N used to also land here, on Pages. It is already the roster's
      // "new workspace from…" key (see the handler above), and both
      // listeners are on `window`, so one press ran both: you arrived on
      // Pages with a create-workspace composer open over it. ⌘⇧N belongs
      // to the creation family alongside ⌘N; Pages keeps the rail and the
      // command palette, which is how people reach it anyway.
    }
    window.addEventListener("aura:open-tasks", openTasks);
    window.addEventListener("aura:open-standup", openStandup);
    window.addEventListener("aura:open-screenshare", openScreenshare);
    window.addEventListener("aura:open-notes", openPages);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("aura:open-tasks", openTasks);
      window.removeEventListener("aura:open-standup", openStandup);
      window.removeEventListener(
        "aura:open-screenshare",
        openScreenshare,
      );
      window.removeEventListener("aura:open-notes", openPages);
      window.removeEventListener("keydown", onKey);
    };
  }, [editor, leavePages, goPlace]);

  // W1.4 — plugin right-rail panels. Each declared panel maps to a
  // tab on the right rail; tab id encodes the plugin so click handlers
  // can route back through the bridge.
  const pluginPanelDescriptors: PluginRightRailPanelDescriptor[] =
    pluginRightRailPanels(pluginContribs.rows).map((p) => ({
      id: `plugin:${p.pluginId}:${p.id}` as RightRailTab,
      pluginId: p.pluginId,
      panelId: p.id,
      title: p.title,
      entry: p.entry,
    }));
  // W1.4 — plugin status pills. Pass through to StatusBar so it can
  // render them after the built-in pill list.
  const pluginPillEntries = pluginStatusPills(pluginContribs.rows);
  // Deep-links carried in auto-DMs + page mentions (see the matching comment
  // up by the `aura:open-crew` listener).
  useEffect(() => {
    const onOpenTask = (e: Event) => {
      const id = (e as CustomEvent<{ id?: string }>).detail?.id;
      const root = projectRootRef.current;
      if (!id || !root) return;
      leavePages();
      editor.openTaskDetail(id, root);
    };
    const onOpenDm = () => {
      // Surface the Team activity pane; useTeamChat focuses the 1:1 by handle.
      leavePages();
      goTrace({ kind: "sessions", view: "team" });
    };
    const onOpenPage = (e: Event) => {
      const d = (
        e as CustomEvent<{ scope?: string; bucket?: string; id?: string }>
      ).detail;
      const root = projectRootRef.current;
      if (!d?.id || !d.scope || !root) return;
      goPlace("pages");
      const key = `${d.scope}|${d.bucket ?? ""}|${d.id}`;
      window.setTimeout(() => {
        window.dispatchEvent(
          new CustomEvent("aura:pages:open", { detail: { key } }),
        );
      }, 160);
    };
    window.addEventListener("aura:open-task", onOpenTask as EventListener);
    window.addEventListener("aura:open-dm", onOpenDm);
    window.addEventListener("aura:open-page", onOpenPage as EventListener);
    return () => {
      window.removeEventListener("aura:open-task", onOpenTask as EventListener);
      window.removeEventListener("aura:open-dm", onOpenDm);
      window.removeEventListener("aura:open-page", onOpenPage as EventListener);
    };
  }, [editor, leavePages]);

  // ADE — the left AdeSidebar section (Build/Team/Plan/Trace) auto-
  // follows whatever the user is actually looking at in the center
  // pane: a Claude Code / terminal / file pane → Build, the Tasks board
  // or a Page → Plan, a huddle screenshare → Team, the moat surfaces
  // (Inspector / Replay / Code Map / Prove / PR Inbox) → Trace. Manual
  // footer clicks still win until the next pane switch — AdeSidebar only
  // re-syncs when this derived value actually changes. Mirrors the
  // render precedence in WorkSurface: the flat trace/inbox surfaces draw
  // ahead of the split tree, so we resolve them first here too. The
  const adeSection = useMemo<AdeSection>(() => {
    // The page first — it covers the work surface, so whatever tab is open
    // underneath is not where the user is.
    if (tracePage) return "trace";
    // Pages is Plan, Team is Team, and Tasks is Build — it is one of Build's
    // three rows, in the slot Mission Control used to hold. This said Tasks
    // was Team, which was true back when a board could only be reached as a
    // tab under Team's umbrella; after the merge it meant clicking Tasks lit
    // Team, so the rail disagreed with the page for the whole time you were
    // on it. BuildNav lights the Tasks row inside the group; this lights the
    // group.
    if (place === "pages") return "plan";
    if (place === "tasks") return "build";
    if (place) return "team";
    if (
      editor.activePlanBuilder ||
      editor.activeGraph ||
      editor.activeProve ||
      editor.activeInspector ||
      editor.activeReplay ||
      editor.activeDashboard ||
      editor.activeSessions ||
      editor.traceTool
    ) {
      // traceTool covers the verify pages (Review / Rewind / Attestations /
      // Doctor). Without it these surfaces leave the rail on Build, so the
      // Trace nav vanishes mid-task. PRs are intentionally absent: the Inbox
      // + PR detail live in the right rail's PRs tab, not Trace.
      return "trace";
    }
    const layout = editor.splitLayout;
    if (layout) {
      // Per-leaf active tabs; precedence plan > team > build. Trace can't
      // reach the tree — its surfaces are flat-flag singletons, handled
      // above. sectionForRef (lib/paneSection) is shared with WorkSurface's
      // per-pane tab strip so the left-nav section and that strip never
      // diverge — a Tasks board reads as Team from both.
      const rank: Record<AdeSection, number> = {
        plan: 0,
        team: 1,
        build: 2,
        trace: 3,
      };
      let section: AdeSection | null = null;
      for (const leaf of treeLeafNodes(layout)) {
        const active = leaf.tabs[leaf.activeIndex];
        if (!active) continue;
        const sec: AdeSection = sectionForRef(active);
        if (section === null || rank[sec] < rank[section]) section = sec;
      }
      return section ?? "build";
    }
    if (editor.activePlanId) return "plan";
    return "build";
  }, [
    editor.splitLayout,
    editor.activePlanBuilder,
    editor.activeGraph,
    editor.activeProve,
    editor.activeInspector,
    editor.activeReplay,
    editor.activeDashboard,
    editor.activeSessions,
    editor.activePlanId,
    editor.traceTool,
    tracePage,
    place,
  ]);
  // Persist the rail's open/closed state so it comes back exactly the way
  // the user left it after an app restart, rather than defaulting to open.
  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_OPEN_KEY, sidebarOpen ? "1" : "0");
    } catch {
      /* localStorage quota — non-fatal */
    }
  }, [sidebarOpen]);
  // Managed-agent review. Agent tabs, status chips and review actions
  // dispatch this instead of opening a duplicate Changes surface.
  useEffect(() => {
    function open(e: Event) {
      const detail = (e as CustomEvent<{ filePath?: string }>).detail;
      setSourceControlOpen(true);
      const filePath = detail?.filePath;
      if (!project?.root || !filePath || !isReviewableGitPath(filePath)) return;
      const absPath = filePath.startsWith("/")
        ? filePath
        : `${project.root}/${filePath}`;
      editor
        .open(absPath, { defaultView: "diff" })
        .catch((err) => console.error("open failed:", err));
    }
    window.addEventListener("aura:open-changes-panel", open);
    return () => window.removeEventListener("aura:open-changes-panel", open);
  }, [editor, project?.root]);
  useEffect(() => {
    function open() {
      // There is no "story" rail tab — the intent/edit timeline lives in the
      // Trace section, and the Intent↔AST inspector is its browse home.
      goTrace({ kind: "inspector" });
    }
    window.addEventListener("aura:open-story", open);
    window.addEventListener("aura:open-edit-view", open);
    return () => {
      window.removeEventListener("aura:open-story", open);
      window.removeEventListener("aura:open-edit-view", open);
    };
  }, [editor]);
  // Provenance lock badge in agent turns dispatches `aura:open-replay`
  // so any assistant message can drop the user into the Replay pane
  // without prop-drilling editor state through 4 layers of agent UI.
  useEffect(() => {
    function open() {
      goTrace({ kind: "replay" });
    }
    window.addEventListener("aura:open-replay", open);
    return () => window.removeEventListener("aura:open-replay", open);
  }, [editor]);
  // MemoryDialog's "Resume in agent" dispatches `aura:resume-session`.
  // Spawn a PTY with `--resume <sid>` (handled backend-side when
  // resumeSessionId is non-null) and open an agent tab keyed on the
  // returned handle id so the user lands in a continued conversation.
  useEffect(() => {
    function onResume(e: Event) {
      const detail = (e as CustomEvent).detail as
        | { sessionId: string; repoRoot: string; agentId: string }
        | undefined;
      if (!detail) return;
      (async () => {
        try {
          const pm = getPermissionMode(
            streamChannel(detail.agentId, detail.repoRoot),
          );
          const handle = await api.agentPtyOpen(
            detail.agentId,
            detail.repoRoot,
            80,
            24,
            detail.sessionId,
            true,
            undefined,
            pm === "default" ? undefined : pm,
          );
          editor.openAgent({
            sessionId: handle.id,
            agentId: detail.agentId,
            agentLabel: detail.agentId,
            agentMonogram: letterMark(detail.agentId),
            repoRoot: detail.repoRoot,
            mode: "pty",
          });
        } catch (err) {
          console.warn("[resume] failed:", err);
        }
      })();
    }
    window.addEventListener("aura:resume-session", onResume);
    return () => window.removeEventListener("aura:resume-session", onResume);
  }, [editor]);
  // Manager launcher modal — opened from the WorkspaceRail compass button.
  // The launcher resolves to a session id which we promote to a Manager
  // tab in the editor store; the tab itself subscribes to manager:<sid>.
  const [managerLauncherOpen, setManagerLauncherOpen] = useState(false);

  // Per-workspace emoji glyphs (replaces the auto-derived letter on the
  // WorkspaceRail tile). Stored in localStorage; the picker lives in
  // the tile's right-click menu.
  const workspaceCustomization = useWorkspaceCustomization();

  // Club state — opt-in cross-place pinning. The store lives in
  // `workspaceClubStore`; we mirror it into a render trigger so the
  // rail tile re-paints when membership changes. Empty `clubs` = none
  // exists; `activeClubId` names the one being viewed, if any.
  const [clubState, setClubState] = useState(() => getClubState());
  useEffect(() => {
    return subscribeClub(() => setClubState(getClubState()));
  }, []);

  // Recent project roots, oldest→newest. Persisted to localStorage so the
  // workspace rail rehydrates with the same tiles every launch. Capped to
  // keep the rail readable.
  const [recents, setRecents] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem("aura.recents");
      if (!raw) return [];
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return [];
      const clean = arr
        .filter((s) => typeof s === "string" && !isManagedWorktree(s))
        // Newest-8 (append order puts newest at the end), matching the
        // eviction rule the write paths use.
        .slice(-8);
      // Self-heal: if a managed worktree had leaked into the persisted
      // list (the agent-worktree-as-workspace bug), drop it for good so
      // it doesn't reappear on the next boot.
      if (clean.length !== arr.length) {
        try {
          localStorage.setItem("aura.recents", JSON.stringify(clean));
        } catch {
          /* quota — ignore */
        }
      }
      return clean;
    } catch {
      return [];
    }
  });

  // Per-root worktree list, keyed by repo root. Populated lazily — only
  // the active project gets refreshed automatically; the rail also picks
  // up siblings of every recent root on first paint so the right-click
  // popover is ready before the user reaches for it.
  const [worktreesByRoot, setWorktreesByRoot] = useState<Record<string, WorktreeRef[]>>({});
  // Roots whose enumeration threw, and how many times. A failure must never be
  // cached as an empty list: `[]` means "this project has no worktrees", and
  // once written it is indistinguishable from the truth and never refetched —
  // so one hiccup emptied the rail for the rest of the session and looked
  // exactly like the worktrees had been deleted. Retry a few times, then stop
  // (a path that genuinely isn't a repo must not spawn git forever).
  const worktreeFailures = useRef<Map<string, number>>(new Map());
  // Roots with a fetch already in the air. This effect re-runs whenever
  // `worktreesByRoot` changes identity, which happens on every successful
  // batch — without this guard a root that failed while another succeeded
  // would be retried instantly by that re-run, spending its whole retry
  // budget inside the same load spike that caused the failure.
  const worktreeInFlight = useRef<Set<string>>(new Set());
  const [worktreeRetry, setWorktreeRetry] = useState(0);
  const MAX_WORKTREE_TRIES = 3;
  useEffect(() => {
    const activeRoot = project?.root ?? "";
    const roots = recents.length ? recents : activeRoot ? [activeRoot] : [];
    // Only fetch roots we haven't listed yet, aren't already fetching, and
    // haven't given up on.
    const missing = roots.filter(
      (root) =>
        worktreesByRoot[root] === undefined &&
        !worktreeInFlight.current.has(root) &&
        (worktreeFailures.current.get(root) ?? 0) < MAX_WORKTREE_TRIES,
    );
    if (missing.length === 0) return;
    for (const root of missing) worktreeInFlight.current.add(root);
    // Defer to idle + fan out in parallel. The old serial `for…await` fired one
    // `git worktree list` subprocess after another (up to 8 on launch, each
    // re-running this effect through its own setState) — a chain of blocking
    // IPC round-trips competing with first paint. This pre-warms the sibling /
    // right-click popover data off the launch-critical path and collapses N
    // serial calls into one parallel batch merged in a single state update.
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const cancelIdle = onIdle(() => {
      void Promise.all(
        missing.map((root): Promise<readonly [string, WorktreeRef[] | null]> =>
          api
            .gitWorktreeList(root)
            .then((list) => [root, list] as readonly [string, WorktreeRef[] | null])
            // null, not [] — "couldn't look", which is not the same claim as
            // "nothing there" and must not be written into the cache.
            .catch(() => [root, null] as readonly [string, WorktreeRef[] | null]),
        ),
      ).then((pairs) => {
        // Released before anything else, and unconditionally: a root left
        // marked in-flight after its fetch settled can never be listed again.
        for (const [root] of pairs) worktreeInFlight.current.delete(root);
        let retryable = false;
        for (const [root, list] of pairs) {
          if (list !== null) {
            worktreeFailures.current.delete(root);
            continue;
          }
          const tries = (worktreeFailures.current.get(root) ?? 0) + 1;
          worktreeFailures.current.set(root, tries);
          if (tries < MAX_WORKTREE_TRIES) retryable = true;
        }
        setWorktreesByRoot((prev) => {
          let next: Record<string, WorktreeRef[]> | null = null;
          for (const [root, list] of pairs) {
            if (list === null || prev[root] !== undefined) continue;
            if (next === null) next = { ...prev };
            next[root] = list;
          }
          // `prev` when nothing was added, never a fresh empty copy. This
          // effect depends on `worktreesByRoot`, so handing back a new object
          // identity for an all-failure batch re-runs it immediately and burns
          // the whole retry budget inside the same load spike that caused the
          // failure — the backoff below only holds if React can bail out here.
          return next ?? prev;
        });
        // Nothing else re-runs this effect on its own when a root stays
        // unlisted, so a transient failure would sit there looking permanent.
        // Back off and go round again.
        if (retryable) {
          retryTimer = setTimeout(() => setWorktreeRetry((n) => n + 1), 1500);
        }
      });
    });
    return () => {
      cancelIdle();
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [recents, project?.root, worktreesByRoot, worktreeRetry]);

  // Roster badges — per-worktree diff + PR pills. Each group falls back to a
  // synthetic root row (matching WorkspaceRoster) so a plain repo still gets
  // its own diff.
  const rosterBadgeGroups = useMemo(() => {
    const roots = recents.length ? recents : project?.root ? [project.root] : [];
    return roots.map((root) => {
      const wts = worktreesByRoot[root] ?? [];
      return {
        root,
        worktrees: (wts.length
          ? wts
          : [{ path: root, branch: "" }]
        ).map((w) => ({ path: w.path, branch: w.branch })),
      };
    });
  }, [recents, project?.root, worktreesByRoot]);
  const rosterBadges = useWorktreeBadges(rosterBadgeGroups);

  // Always-on chat notifications: fires an OS banner for every inbound
  // team-chat message (per-repo rooms + the cross-repo #aura channel),
  // even when the Team surface isn't mounted. The mention-only bridge
  // below now just flashes the title; this hook owns the OS notification.
  useChatNotifier(project?.root ?? null);

  // Same reasoning for pages: a teammate's note has to land on this machine
  // whether or not Pages is the screen you're on, so the poll belongs to the
  // open project. Pages joins this same poll when it mounts.
  usePagesSync(project?.root ?? null);

  // Warm the PR list cache as soon as a repo opens, before the user
  // navigates to the PR Inbox. `fetchPrList` is SWR-aware: if the cache
  // is fresh it's a no-op, if stale it returns stale data and kicks a
  // background refresh, if cold it does the blocking fetch off the UI
  // thread. We swallow errors — the consumer panels still surface
  // failures via their own refresh paths.
  useEffect(() => {
    const root = project?.root;
    if (!root) return;
    fetchPrList(root).catch(() => {});
  }, [project?.root]);

  useEffect(() => {
    // Use Tauri's webview-level zoom — that's the macOS-standard "increase
    // text size" behavior the user expects from ⌘+/⌘-, and it scales
    // fonts/icons cleanly without the layout-shift quirks the old
    // `document.body.style.zoom` produced.
    import("@tauri-apps/api/webview").then(({ getCurrentWebview }) => {
      getCurrentWebview().setZoom(zoom).catch(() => {});
    });
    localStorage.setItem(ZOOM_KEY, String(zoom));
    publishZoomToCss(zoom);
  }, [zoom]);

  // Run an aura CLI passthrough and surface the result in the OutputDialog.
  const runCli = useCallback(
    async (title: string, args: string[]) => {
      if (!project) return;
      setOutput({ open: true, title, body: "", loading: true, error: null });
      try {
        const res = await api.auraCli(project.root, args);
        const body = (res.stdout + (res.stderr ? `\n${res.stderr}` : "")).trim() || `(exit ${res.status})`;
        setOutput({
          open: true,
          title,
          body,
          loading: false,
          error: res.status !== 0 ? `exit ${res.status}` : null,
        });
      } catch (e) {
        setOutput({ open: true, title, body: "", loading: false, error: String(e) });
      }
    },
    [project],
  );

  // Invoke an external MCP server tool (~/.aura/mcp/<server>.json) and
  // render the result in OutputDialog. The shell handles `initialize`
  // + `tools/call` JSON-RPC under the hood — see `cmd_mcp_servers.rs`.
  const runMcp = useCallback(
    async (server: string, tool: string, args: Record<string, unknown>) => {
      const title = `${server}:${tool}`;
      setOutput({ open: true, title, body: "", loading: true, error: null });
      try {
        const res = await api.mcpToolInvoke(server, tool, args);
        if (res.ok) {
          setOutput({
            open: true,
            title,
            body: res.text || "(empty response)",
            loading: false,
            error: null,
          });
        } else {
          setOutput({
            open: true,
            title,
            body: "",
            loading: false,
            error: res.error ?? "mcp_tool_invoke failed",
          });
        }
      } catch (e) {
        setOutput({ open: true, title, body: "", loading: false, error: String(e) });
      }
    },
    [],
  );

  // History-row click handler — surfaces the full event in the existing
  // OutputDialog. Commits run `git show`, intents render the stored body,
  // snapshots ask aura for the diff (falls back to listing the file).
  const openHistoryEvent = useCallback(
    async (ev: HistoryEvent) => {
      if (!project) return;
      if (ev.kind === "commit") {
        const title = `commit ${ev.entry.sha} · ${ev.entry.subject}`;
        setOutput({ open: true, title, body: "", loading: true, error: null });
        try {
          const body = await api.gitShowCommit(project.root, ev.entry.sha);
          setOutput({
            open: true,
            title,
            body: body.trim() || "(no output)",
            loading: false,
            error: null,
          });
        } catch (e) {
          setOutput({ open: true, title, body: "", loading: false, error: String(e) });
        }
        return;
      }
      if (ev.kind === "intent") {
        const title = `intent · ${ev.entry.agent || "agent"}`;
        const body = [
          ev.entry.intent || "(empty)",
          "",
          `id: ${ev.entry.id || "—"}`,
          `agent: ${ev.entry.agent || "—"}`,
          `time: ${ev.entry.timestamp ? new Date(ev.entry.timestamp * 1000).toLocaleString() : "—"}`,
        ].join("\n");
        setOutput({ open: true, title, body, loading: false, error: null });
        return;
      }
      if (ev.kind === "audit") {
        const title = `audit · ${ev.entry.kind || "event"}`;
        const body = JSON.stringify(ev.entry, null, 2);
        setOutput({ open: true, title, body, loading: false, error: null });
        return;
      }
      // snapshot
      const title = `snapshot ${ev.entry.id} · ${ev.entry.file}`;
      setOutput({ open: true, title, body: "", loading: true, error: null });
      try {
        const r = await api.auraCli(project.root, ["snapshot", "show", ev.entry.id]);
        const body = r.stdout?.trim() || r.stderr?.trim() || "(no output)";
        setOutput({ open: true, title, body, loading: false, error: null });
      } catch (e) {
        setOutput({ open: true, title, body: "", loading: false, error: String(e) });
      }
    },
    [project],
  );

  // Open (or attach to) the agent in the current repo, surface it as a
  // tab in WorkSurface, then push the prompt to the right backend.
  //
  // Default mode is "pty": full interactive REPL hosted in xterm.js.
  // Every coding-agent CLI we ship (claude/gemini/codex/cursor) is a
  // TUI that depends on raw terminal control codes; stream-json bubble
  // parsing was the source of recurring drift bugs. Stream mode is
  // still reachable for legacy callers that pass mode === "stream"
  // but no UI surface selects it by default.
  const runAgentPrompt = useCallback(
    async (
      agentId: string,
      agentLabel: string,
      prompt: string,
      mode: "stream" | "pty" = "pty",
      attachments: import("./lib/api").ImageAttachment[] = [],
      repoRoot?: string,
    ) => {
      // The HUD can target an agent in a DIFFERENT project than the main
      // window's focused one — honour the target's repoRoot so a quick reply
      // continues THAT agent's session in its own project, instead of spawning
      // a fresh agent in whatever project happens to be focused. In-app callers
      // omit it and fall back to the active project, byte-identical to before.
      const root = repoRoot ?? project?.root ?? null;
      if (!root) return;
      try {
        if (agentId === "aura-manager") {
          // Manager is a peer agent in the picker — route to the
          // in-process Manager runtime instead of a generic terminal.
          // `manager_chat_start` stages a chat-only session seeded
          // with the user's prompt as objective; the Track B chat
          // router decides whether to call `aura ask` (trivial Q) or
          // `aura plan_discover` (objective with action verbs) on the
          // first follow-up. Empty prompt → blank Manager session
          // ready to receive the first chat turn.
          //
          // If `manager_chat_start` isn't built into this binary yet
          // (e.g. running an older shell), fall back to the legacy
          // terminal-with-bootCommand path so the picker tile still
          // lights up something useful.
          try {
            // Same question every door asks: where does this run? The HUD can
            // target a project other than the focused one, so the place is read
            // for THAT project rather than assumed from the window.
            const place = placeForNewWork(root);
            const sid = await api.managerChatStart(root, prompt, place);
            focusAmbientManager(root, sid, place);
          } catch (err) {
            console.warn(
              "[manager] chat-start unavailable, falling back to terminal",
              err,
            );
            editor.openTerminal(root, {
              label: "Manager",
              bootCommand: managerBootCommand(),
            });
          }
          return;
        }
        // Option 2 (implicit intent): if the user is sending a real
        // prompt to a coding agent, log it as an intent now with
        // source="agent_prompt" + an empty changeset. The agent's
        // subsequent Edit/Write/MultiEdit tool_uses (in agentStreamStore
        // or agentPtyStore) call `aura_intent_attribute` to bind the
        // touched paths to this intent. Net effect: a prompt-driven
        // session never has orphan changes at Save & Sync time.
        if (prompt.trim() && agentId !== "aura-manager") {
          api
            .auraLogIntent(root, prompt.trim(), agentId, {
              files: [],
              source: "agent_prompt",
            })
            .catch((e) => console.warn("[intent] auto-log failed", e));
        }
        if (mode === "stream") {
          const tabId = `stream:${agentId}@${root}`;
          editor.openAgent({
            sessionId: tabId,
            agentId,
            agentLabel,
            agentMonogram: letterMark(agentLabel),
            repoRoot: root,
            mode: "stream",
          });
          if (!prompt.trim() && attachments.length === 0) return;
          const channel = streamChannel(agentId, root);
          // Pin agent_id + repo_root on the store entry so applyEvent
          // can fire snapshots and read the intent log without yet
          // another lookup. The channel string sanitizes path
          // separators, so the original repo root has to be passed in.
          bindChannelMeta(channel, { agentId, repoRoot: root });
          console.log("[agent-stream] dispatch", { agentId, channel, prompt, attached: attachments.length });
          // Push the user-prompt bubble synchronously so it lands
          // before the backend can race the listener attach. Backend
          // does not emit user_prompt for this reason.
          const turnId = `turn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
          if (prompt.trim()) {
            pushEvent(channel, {
              kind: "user_prompt",
              text: prompt,
              turn_id: turnId,
              ts: Math.floor(Date.now() / 1000),
            });
          }
          // Echo each attachment as a synthetic image bubble — the
          // backend never replays user images, so without this the
          // user's own attachments would only ever be visible to claude.
          for (const a of attachments) {
            pushEvent(channel, {
              kind: "image",
              role: "user",
              data: a.data,
              media_type: a.media_type,
              turn_id: turnId,
            });
          }
          markTurnStarted(channel);
          // In-memory sessionId beats the persisted marker, but a fresh
          // shell after restart has no live state — fall back to
          // localStorage so the next prompt seamlessly continues the
          // last conversation via --resume.
          const resume =
            getResumeSession(channel) ??
            readPersistedSession(channel)?.session_id ??
            null;
          const permissionMode = getPermissionMode(channel);
          await api.agentStreamSend(
            agentId,
            root,
            prompt,
            resume,
            attachments.length > 0 ? attachments : undefined,
            permissionMode === "default" ? undefined : permissionMode,
          );
        } else {
          // Same autonomy the non-interactive stream path forwards (the
          // Approvals chip persists per channel) — without it the wrapped
          // interactive agent stops to ask the user to run every command by
          // hand instead of acting like a normal Claude Code session.
          const ptyChannel = streamChannel(agentId, root);
          const ptyPermissionMode = getPermissionMode(ptyChannel);
          // The same question the chat door asks a hundred lines up, and it has
          // to get the same answer: an agent started from the picker while the
          // window is standing in a machine belongs on that machine. Answered
          // per project, not per window — the picker can name a project other
          // than the focused one — and read once so the tab is filed under the
          // place the agent was really started in.
          const ptyPlace = placeForNewWork(root);
          const handle = await api.agentPtyOpen(
            agentId,
            root,
            80,
            24,
            undefined,
            true,
            undefined,
            ptyPermissionMode === "default" ? undefined : ptyPermissionMode,
            ptyPlace,
          );
          editor.openAgent({
            sessionId: handle.id,
            agentId,
            agentLabel,
            agentMonogram: letterMark(agentLabel),
            repoRoot: root,
            mode: "pty",
            machineId: ptyPlace,
          });
          if (prompt.trim()) {
            await api.agentPtySendPrompt(handle.id, prompt);
          }
        }
      } catch (e) {
        // Spawn failures are rare but real (binary moved out of PATH
        // between discovery and send). Surface in OutputDialog so the
        // user has a place to read the error.
        setOutput({
          open: true,
          title: `${agentLabel}. Failed to start`,
          body: "",
          loading: false,
          error: String(e),
        });
      }
    },
    [project, editor],
  );

  // Route the floating HUD's quick-send through the same dispatchers the
  // main UI uses. The HUD echoes back the `target` the publisher computed,
  // so a reply lands in exactly the conversation the user was glancing at —
  // a coding-agent tab (stream/pty) or the project's native Aura chat.
  //
  // Registered ONCE (empty deps) and dispatched through refs. The previous
  // version depended on `[runAgentPrompt, project]` — and `runAgentPrompt`
  // re-creates on every editor-store change — so the effect re-ran constantly.
  // Because `onHudSend` resolves async, a re-run could fire before the prior
  // `listen` promise resolved, leaving `un` undefined so cleanup couldn't
  // unlisten: listeners piled up and a single `hud:send` fanned out to N
  // handlers = N duplicate turns. Now: one stable listener, latest values via
  // refs, plus a `cancelled` guard so a late-resolving listen still unlistens.
  const runAgentPromptRef = useRef(runAgentPrompt);
  runAgentPromptRef.current = runAgentPrompt;
  useEffect(() => {
    let un: (() => void) | undefined;
    let cancelled = false;
    void onHudSend(({ text, target, ...cfg }) => {
      const body = text?.trim();
      if (!body) return;
      if (target?.kind === "agent" && (target.mode === "stream" || target.mode === "pty")) {
        // Coding-agent tab: the brain-only knobs (effort/fast/model/brain)
        // don't map to a PTY/stream agent; its own CLI interprets any leading
        // slash. A live PTY is interactive — write the reply straight to its
        // open handle so it CONTINUES that terminal instead of spawning a new
        // one. Stream agents (and a dead/unknown handle) fall back to
        // runAgentPrompt, pinned to the agent's OWN repoRoot so the reply lands
        // in that session's project, not whatever's focused.
        const { agentId, agentLabel, repoRoot, mode, sessionId } = target;
        const spawnFresh = () =>
          void runAgentPromptRef.current(agentId, agentLabel, body, mode, [], repoRoot);
        if (mode === "pty" && sessionId) {
          api
            .agentPtySendPrompt(sessionId, body)
            .catch((e) => {
              console.warn("[hud] pty handle dead, spawning fresh", e);
              spawnFresh();
            });
        } else {
          spawnFresh();
        }
      } else {
        const root =
          target?.kind === "native"
            ? target.repoRoot
            : target?.kind === "agent"
              ? target.repoRoot
              : currentRootRef.current;
        // Native Aura chat: full parity — same slash interpreter + the composer
        // chips (mode/effort/fast/approval/model/brain) threaded per turn.
        if (root)
          void sendAmbientManagerTurn(root, body, {
            mode: cfg.mode,
            effort: cfg.effort,
            fast: cfg.fast,
            approval: cfg.approval,
            model: cfg.model,
            longContext: cfg.longContext,
            brainId: cfg.brainId,
          }).catch((e) => console.warn("[hud] ambient send failed", e));
      }
    }).then((f) => {
      if (cancelled) f();
      else un = f;
    });
    return () => {
      cancelled = true;
      un?.();
    };
  }, []);

  // The HUD's project-switcher dropdown asks the main window to switch the
  // active project. Reuse `loadProjectAt` (via its forward-ref so this effect
  // can mount before it's defined) — an in-window swap, same as the in-app
  // WorkspaceSwitcher. The publisher then re-derives for the new root.
  useEffect(() => {
    let un: (() => void) | undefined;
    void onHudSelectProject(({ root }) => {
      if (root && root !== currentRootRef.current) {
        loadProjectAtRef.current?.(root)?.catch?.((e) =>
          console.error("HUD project switch failed:", e),
        );
      }
    }).then((f) => {
      un = f;
    });
    return () => un?.();
  }, []);

  // Wave B4 — pre-flight commit gate. Returns true to let the commit
  // proceed, false to abort. When strict mode is on AND the in-session
  // heuristic finds tool_uses without a matching intent, surface the
  // confirm dialog and resolve based on the user's choice. Strict mode
  // off → always proceed silently.
  const guardCommit = useCallback(async (): Promise<boolean> => {
    if (!project) return true;

    // The semantic gate runs before the note heuristic and independently of
    // strict mode. A repo with an approved contract has already said what the
    // agent may change; that promise should hold whether or not someone also
    // turned on note-nagging. Repos without a contract fall straight through.
    try {
      const verdict = await api.verifyIntentStaged(project.root);
      if (verdict && !verdict.passed) {
        const tests = await api.recordedTestSummary(project.root).catch(() => null);
        const proceed = await new Promise<boolean>((resolve) => {
          setIntentGuard({ open: true, verdict, tests, busy: null, resolve });
        });
        if (!proceed) return false;
      }
    } catch (e) {
      // A gate that cannot run must not silently become a gate that passes,
      // but it also must not strand someone mid-commit over a missing binary.
      // Say what happened and let the pre-commit hook have the final word.
      console.warn("intent verification did not run:", e);
    }

    if (strictMode === "off") return true;
    const channel = streamChannel("claude", project.root);
    const events = getChannelEvents(channel);
    const meta = getChannelMeta(channel);
    if (events.length === 0 || !meta.agentId) return true;
    const readiness = await checkStrictModeReadiness(
      project.root,
      events,
      meta.agentId,
    );
    if (!readiness.needsAttention) return true;
    return new Promise<boolean>((resolve) => {
      setStrictGuard({ open: true, readiness, resolve });
    });
  }, [project, strictMode]);

  // AuraWatch nudge accept → backend emits this with a pre-built
  // staged prompt; we route it through the same dispatch the Composer
  // uses so Claude calls the aura_log_intent MCP tool.
  // Agent-attention bridge: backend fires `agent-attention` when a PTY
  // session emits BEL (`\x07`) — claude-code permission prompts,
  // gemini tool approvals, codex stop. Mark the tab so the user sees
  // a red dot; the store auto-clears it when the tab is activated.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    import("@tauri-apps/api/event").then(({ listen }) => {
      listen<{ session_id: string; agent_id: string; repo_root?: string }>(
        "agent-attention",
        (ev) => {
          editor.markAgentAttention(ev.payload.session_id, ev.payload.repo_root);
        },
      )
        .then((un) => {
          if (cancelled) un();
          else unlisten = un;
        })
        .catch(() => {});
    });
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [editor]);

  // Chat mention bridge: CommsPanel dispatches `aura:chat-mention` on
  // each poll when a new message mentions the current user. We surface
  // it as an OS toast + a transient document-title flash so users
  // notice even when the panel is collapsed. Throttled per session so
  // a burst of mentions doesn't fire a notification per line.
  useEffect(() => {
    let lastNotify = 0;
    const originalTitle = document.title;
    let flashTimer: number | null = null;

    // Mentions get an in-app cue (a transient document-title flash) so the
    // user notices even with the Team panel collapsed. The OS notification
    // itself is now owned by `useChatNotifier` (always-on, all messages),
    // so we no longer fire one here — that would double-notify on mentions.
    function notifyMention(detail: { from: string; body: string; channel: string }) {
      const now = Date.now();
      if (now - lastNotify < 4000) return;
      lastNotify = now;

      document.title = `● mention from @${detail.from}`;
      if (flashTimer) window.clearTimeout(flashTimer);
      flashTimer = window.setTimeout(() => {
        document.title = originalTitle;
      }, 6000);
    }

    const handler = (e: Event) => {
      const ev = e as CustomEvent<{ from: string; body: string; channel: string }>;
      if (ev.detail) notifyMention(ev.detail);
    };
    window.addEventListener("aura:chat-mention", handler);
    // Warm the OS notification permission once at startup so the first
    // real mention doesn't pop a system dialog instead of a banner.
    (async () => {
      try {
        const { isPermissionGranted, requestPermission } = await import(
          "@tauri-apps/plugin-notification"
        );
        const ok = await isPermissionGranted();
        if (!ok) await requestPermission();
      } catch {
        /* plugin not loaded — non-fatal */
      }
    })();
    return () => {
      window.removeEventListener("aura:chat-mention", handler);
      if (flashTimer) window.clearTimeout(flashTimer);
      document.title = originalTitle;
    };
  }, []);

  // Let a coding agent running in a tab drive the editor: open a file, and
  // — the one that matters — put a change it wants to make in front of you
  // as a real diff you accept by saving or refuse by closing. Mounted here
  // and only here; a second mount would answer every request twice.
  useIdeTabBridge();

  // RepoFileChip + other chat affordances dispatch `aura:open-file` to
  // route a path (plus optional line number) to the active editor pane.
  // Open the file via the imperative editor API, then bounce a
  // `aura:scroll-to-line` so the Monaco wrapper can jump after the
  // buffer mounts.
  useEffect(() => {
    function onOpenFile(e: Event) {
      const detail = (e as CustomEvent<{ path: string; line?: number }>).detail;
      if (!detail?.path) return;
      void openFileImperative(detail.path).then(() => {
        if (detail.line && detail.line > 0) {
          window.dispatchEvent(
            new CustomEvent("aura:scroll-to-line", {
              detail: { path: detail.path, line: detail.line },
            }),
          );
        }
      });
    }
    window.addEventListener("aura:open-file", onOpenFile);
    return () => window.removeEventListener("aura:open-file", onOpenFile);
  }, []);

  // ActivityRow's "Show diff" button dispatches `aura:open-commit-diff` with
  // { sha, subject }. Route through openHistoryEvent so the existing
  // OutputDialog opens with `git show <sha>`.
  useEffect(() => {
    function onOpenCommitDiff(e: Event) {
      const detail = (e as CustomEvent<{ sha?: string; subject?: string }>).detail;
      if (!detail?.sha) return;
      void openHistoryEvent({
        kind: "commit",
        ts: 0,
        entry: {
          sha: detail.sha,
          subject: detail.subject || "",
          author: "",
          timestamp: 0,
          branch: "",
        },
      });
    }
    window.addEventListener("aura:open-commit-diff", onOpenCommitDiff);
    return () =>
      window.removeEventListener("aura:open-commit-diff", onOpenCommitDiff);
  }, [openHistoryEvent]);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    import("@tauri-apps/api/event").then(({ listen }) => {
      listen<{
        prompt: string;
        agent_id: string;
        repo_root: string;
      }>("aurawatch:stage-prompt", (ev) => {
        runAgentPrompt(
          ev.payload.agent_id,
          ev.payload.agent_id === "claude" ? "Claude" : ev.payload.agent_id,
          ev.payload.prompt,
          "pty",
        );
      })
        .then((un) => {
          if (cancelled) un();
          else unlisten = un;
        })
        .catch(() => {});
    });
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [runAgentPrompt]);

  // ExitPlanMode + AskUserQuestion buttons fire this — the chosen
  // option / approval text becomes the next user turn on the same
  // claude session via --resume <sid>. Hardcoded to claude since
  // these tools are claude-specific.
  useEffect(() => {
    function onFollowup(e: Event) {
      const detail = (e as CustomEvent).detail as
        | { text?: string }
        | undefined;
      if (!detail?.text) return;
      runAgentPrompt("claude", "Claude", detail.text, "pty");
    }
    window.addEventListener("aura:agent-followup", onFollowup);
    return () => window.removeEventListener("aura:agent-followup", onFollowup);
  }, [runAgentPrompt]);

  // Automations surface → launch a saved preset. The preset row carries
  // its agent + seed prompt; we route through the normal launcher so a
  // preset is exactly "what you'd have typed", nothing special-cased.
  useEffect(() => {
    function onPreset(e: Event) {
      const detail = (e as CustomEvent).detail as
        | { agentId?: string; agentLabel?: string; prompt?: string }
        | undefined;
      if (!detail?.agentId) return;
      runAgentPrompt(
        detail.agentId,
        detail.agentLabel || detail.agentId,
        detail.prompt || "",
        "pty",
      );
    }
    window.addEventListener("aura:run-agent-preset", onPreset);
    return () => window.removeEventListener("aura:run-agent-preset", onPreset);
  }, [runAgentPrompt]);

  // "Start agent" composer → a worktree workspace just launched. The roster
  // is built from `recents`, but the composer creates the workspace without
  // touching that list, so a freshly-launched project would never appear in
  // the sidebar. Promote its repo root here (same append-on-first-seen rule
  // as opening a project) so the new agent's home is immediately visible.
  // Worktree paths never enter `recents` — only the parent repo root does.
  useEffect(() => {
    function onLaunched(e: Event) {
      const detail = (
        e as CustomEvent<{
          repoRoot?: string;
          worktreePath?: string;
          createMore?: boolean;
          /** What the user typed into the composer — becomes the first
           *  message of the worktree's Aura chat. */
          mission?: string;
          /** The composer's model chip, applied to that chat. */
          model?: SelectedModel | null;
          effort?: ReasoningEffort | null;
          /** Agent tabs to place, for launches that DO spawn agents (the
           *  `/launch` verb's fleet). The composer's own launches leave this
           *  empty — their surface is Aura chat. */
          tabs?: {
            sessionId: string;
            agentId: string;
            agentLabel: string;
            agentMonogram: string;
            repoRoot: string;
          }[];
        }>
      ).detail;
      const root = detail?.repoRoot;
      if (!root) return;
      // Promote the parent repo into recents so its project tile is present
      // (no-op if already open; skipped if `root` is itself a worktree path).
      if (!isManagedWorktree(root)) {
        setRecents((prev) => {
          if (prev.includes(root)) return prev;
          // Keep the newest 8 (evict oldest), never drop the new root.
          const next = [...prev, root].slice(-8);
          try {
            localStorage.setItem("aura.recents", JSON.stringify(next));
          } catch {
            /* quota — ignore */
          }
          return next;
        });
      }
      // The worktree list is fetched once per root and then cached forever, so
      // the brand-new checkout has NO roster row until we re-fetch — that's the
      // "I started an agent but where did it go?" gap. Refresh now so the new
      // worktree (and its live-agent pip) surfaces immediately.
      void api
        .gitWorktreeList(root)
        .then((list) =>
          setWorktreesByRoot((prev) => ({ ...prev, [root]: list })),
        )
        .catch(() => {
          /* enumeration failed — row stays stale, no worse than before */
        });
      // Single launch (Create-more OFF): switch into the new worktree so the
      // user lands in the agent they just started instead of hunting for it in
      // the parallel-copies fold. Batch launches (createMore) stay put — their
      // passive tabs surface when the user switches over.
      const wt = detail?.worktreePath;
      if (wt && detail?.createMore === false) {
        loadProjectAtRef.current?.(wt)
          ?.then(async () => {
            // Now standing IN the worktree (switchWorkspace hydrated its empty
            // snapshot). Open the launched agent(s) ACTIVELY here so the user
            // lands directly in the running chat — with the query they typed
            // already seeding — instead of a blank workspace. Placement was
            // deferred at launch time on purpose: doing it before the switch
            // would file the tab under the OUTGOING workspace's snapshot.
            for (const tab of detail?.tabs ?? []) {
              editorRef.current.openAgent({ ...tab, repoRoot: wt });
            }
            const mission = detail?.mission?.trim();
            if (!mission) return;
            // No agents were spawned — so what the copy opens into is the
            // user's `[workspace] open_in` setting: nothing, an Aura chat, or
            // the agent CLI they named. Landed HERE, after the switch, for the
            // same reason tab placement is deferred: a session opened before
            // it would be filed under the workspace we just left.
            await landNewWorkspace({
              worktreePath: wt,
              mission,
              model: detail?.model ?? null,
              effort: detail?.effort ?? null,
              openAgent: (tab) => editorRef.current.openAgent(tab),
              labelForAgent: labelForAgentId,
            });
          })
          ?.catch?.((err) =>
            console.error("open launched worktree failed:", err),
          );
      }
    }
    window.addEventListener("aura:workspace-launched", onLaunched);
    return () => window.removeEventListener("aura:workspace-launched", onLaunched);
  }, []);

  // Automations surface → "New orchestrated run" opens the heavyweight
  // ManagerLauncher DAG. App owns the modal state; the surface lives in
  // the center pane and can't reach it directly, so it fires an event.
  useEffect(() => {
    function onOpenOrch() {
      setManagerLauncherOpen(true);
    }
    window.addEventListener("aura:open-orchestrator", onOpenOrch);
    return () => window.removeEventListener("aura:open-orchestrator", onOpenOrch);
  }, []);

  // Resume a Claude session from the Manager dashboard's "Resume recent"
  // list. Spawns a Claude PTY tab pinned to the picked session_id so
  // the chat continues where it left off.
  useEffect(() => {
    if (!project) return;
    function onResume(e: Event) {
      const detail = (e as CustomEvent).detail as
        | { session?: ClaudeSession }
        | undefined;
      const s = detail?.session;
      if (!s) return;
      void (async () => {
        try {
          const pm = getPermissionMode(streamChannel("claude", project!.root));
          // Claude finds `--resume <id>` by the directory it was launched in,
          // so a session the agent authored inside a worktree resumes from
          // that worktree. Spawning it at the project root instead handed the
          // user a blank REPL with none of the conversation in it.
          const spawnRoot = resumeCwdOf(s, project!.root);
          const handle = await api.agentPtyOpen(
            "claude",
            spawnRoot,
            96,
            32,
            s.session_id,
            true,
            undefined,
            pm === "default" ? undefined : pm,
          );
          const labelText = (s.last_prompt || s.first_prompt || "Claude").trim();
          const label = truncate(labelText, 24) || "Claude";
          editor.openAgent({
            sessionId: handle.id,
            agentId: "claude",
            agentLabel: label,
            agentMonogram: "C",
            repoRoot: project!.root,
            mode: "pty",
          });
        } catch (err) {
          console.warn("resume claude session failed:", err);
        }
      })();
    }
    window.addEventListener("aura:resume-claude-session", onResume);
    return () => window.removeEventListener("aura:resume-claude-session", onResume);
  }, [project, editor]);

  // "Open this chat in Claude Code" — the chat More-menu / tab menu fires this
  // with the Aura chat's session id. The backend decides between (1) a real
  // Claude session that already exists on disk (the chat ran on the Claude
  // CLI) → resume it verbatim, and (2) a mixed/native conversation → serialize
  // it into a fresh, valid Claude Code transcript. Either way it hands back a
  // resumable session id + the cwd to resume FROM (worktree-correct), and we
  // open a terminal tab running `claude --resume <id>` there.
  useEffect(() => {
    function onOpenInClaude(e: Event) {
      const detail = (e as CustomEvent<{ sessionId?: string }>).detail;
      const chatSessionId = detail?.sessionId;
      if (!chatSessionId) return;
      void (async () => {
        try {
          const out = await api.chatExportToClaudeCode(chatSessionId);
          if (!out.claude_installed) {
            await askNotice({
              title: "Claude Code isn't installed on this machine",
              body: "Install the Claude Code CLI (the `claude` command), then try again. Your conversation has been saved and is ready to resume.",
            });
            return;
          }
          // Resume from the cwd the session belongs to (a sibling worktree, or
          // the chat's bound project root) — Claude keys --resume by launch cwd.
          const pm = getPermissionMode(streamChannel("claude", out.cwd));
          const handle = await api.agentPtyOpen(
            "claude",
            out.cwd,
            96,
            32,
            out.session_id,
            true,
            undefined,
            pm === "default" ? undefined : pm,
          );
          editor.openAgent({
            sessionId: handle.id,
            agentId: "claude",
            agentLabel: out.synthesized ? "Claude Code (handoff)" : "Claude Code",
            agentMonogram: "C",
            repoRoot: out.cwd,
            mode: "pty",
          });
        } catch (err) {
          console.warn("[open-in-claude] failed:", err);
          await askNotice({
            title: "Couldn't open this chat in Claude Code",
            body: String(err),
          });
        }
      })();
    }
    window.addEventListener("aura:open-chat-in-claude-code", onOpenInClaude);
    return () =>
      window.removeEventListener("aura:open-chat-in-claude-code", onOpenInClaude);
  }, [editor]);

  // "Open this chat in <agent>" — the agent-agnostic generalization of the
  // Claude handler above. The chat menu fires this with the Aura chat's id +
  // the picked agent's registry id/label. The backend decides per agent
  // between a TRUE RESUME (claude/gemini/codex have on-disk resumable sessions
  // we write in their native format → spawn the REPL pointed at it) and a
  // CONTEXT HANDOFF (cursor/kimi/… have no resumable store → spawn a fresh
  // REPL, then inject a primer of the conversation as the opening prompt).
  // Either way we open ONE terminal tab continuing the work. Same editor/PTY
  // seam as the Claude path, parameterized by agent.
  useEffect(() => {
    function onOpenInAgent(e: Event) {
      const detail = (e as CustomEvent<{
        sessionId?: string;
        agentId?: string;
        agentLabel?: string;
      }>).detail;
      const chatSessionId = detail?.sessionId;
      const agentId = detail?.agentId;
      if (!chatSessionId || !agentId) return;
      void (async () => {
        try {
          const out = await api.chatExportForAgent(agentId, chatSessionId);
          if (!out.installed) {
            await askNotice({
              title: `${out.label} isn't installed on this machine`,
              body: `Install ${out.label}'s command-line tool, then try again. Your conversation has been saved and is ready to continue.`,
            });
            return;
          }
          // Resume from the cwd the chat belongs to (a sibling worktree, or the
          // bound project root) — agents that key resume by launch cwd need it.
          const pm = getPermissionMode(streamChannel(agentId, out.cwd));
          const isResume = out.mode === "resume";
          // True resume → hand the agent's resume target (uuid / session-file
          // path) through the PTY resume slot; the provider's PtyRepl builder
          // turns it into the right argv. Handoff → no resume arg; we seed the
          // primer after the tab mounts.
          const handle = await api.agentPtyOpen(
            agentId,
            out.cwd,
            96,
            32,
            isResume ? out.resume_arg ?? undefined : undefined,
            true,
            undefined,
            pm === "default" ? undefined : pm,
          );
          // Honest label: "(resume)" only when we truly continue the agent's
          // own session; "(handoff)" when we seed a fresh one with context.
          const baseLabel = (out.label || agentId).slice(0, 24);
          const tabLabel = isResume
            ? out.synthesized
              ? `${baseLabel} (handoff)`
              : baseLabel
            : `${baseLabel} (handoff)`;
          editor.openAgent({
            sessionId: handle.id,
            agentId,
            agentLabel: tabLabel,
            agentMonogram: letterMark(baseLabel, { empty: "A" }),
            repoRoot: out.cwd,
            mode: "pty",
          });
          // Handoff: the REPL started fresh, so push the conversation primer in
          // as its first prompt — the agent reads it as context and continues.
          if (!isResume && out.primer && out.primer.trim()) {
            await api.agentPtySendPrompt(handle.id, out.primer);
          }
        } catch (err) {
          console.warn("[open-in-agent] failed:", err);
          await askNotice({
            title: "Couldn't open this chat in that agent",
            body: String(err),
          });
        }
      })();
    }
    window.addEventListener("aura:open-chat-in-agent", onOpenInAgent);
    return () =>
      window.removeEventListener("aura:open-chat-in-agent", onOpenInAgent);
  }, [editor]);

  // B.3 — TaskDetail "Hand to agent" button. Spawns an agent tab seeded
  // with the task's title + body + recent comments. Agent name flows
  // through `detail.agent` (defaults to claude). The CLI also marks the
  // task claimed by that agent so the team activity feed shows pickup.
  useEffect(() => {
    function onHand(e: Event) {
      const detail = (e as CustomEvent).detail as
        | {
            agent?: string;
            label?: string;
            prompt?: string;
            taskId?: string;
            /** #7 — when set, hand the task to this ALREADY-RUNNING PTY
             *  session (an ongoing Claude Code / Gemini / Codex) instead
             *  of spawning a fresh one: focus its tab + inject the
             *  prompt. */
            sessionId?: string;
            /** When true, `sessionId` is a recent on-disk Claude session
             *  (not a live PTY): resume it (`claude --resume`) WITH the
             *  prompt instead of injecting into a live input. */
            resume?: boolean;
            /** Absolute cwd the session was authored in — resume must
             *  spawn from here so a sibling-worktree session resolves. */
            cwd?: string;
          }
        | undefined;
      if (!detail?.prompt) return;
      const id = detail.agent || "claude";
      const label = detail.label || id;
      const promptText = detail.prompt;
      if (detail.sessionId && detail.resume && project) {
        // Resume a recent on-disk Claude session WITH the task prompt:
        // `claude --resume <id>` from its own cwd (worktree-correct), or a
        // reattach if it's already live, then inject the prompt.
        const cwd = detail.cwd || project.root;
        const sid = detail.sessionId;
        void (async () => {
          try {
            const pm = getPermissionMode(streamChannel("claude", cwd));
            const handle = await api.agentPtyOpen(
              "claude",
              cwd,
              80,
              24,
              sid,
              false,
              undefined,
              pm === "default" ? undefined : pm,
            );
            editor.openAgent({
              sessionId: handle.id,
              agentId: "claude",
              agentLabel: label,
              agentMonogram: letterMark(label),
              repoRoot: cwd,
              mode: "pty",
            });
            if (promptText.trim()) {
              await api.agentPtySendPrompt(handle.id, promptText);
            }
          } catch (err) {
            console.warn("[hand-task] resume session failed", err);
          }
        })();
      } else if (detail.sessionId && project) {
        // Route into the running session: focus-or-mount its tab, then
        // push the prompt straight into that live PTY.
        editor.openAgent({
          sessionId: detail.sessionId,
          agentId: id,
          agentLabel: label,
          agentMonogram: letterMark(label),
          repoRoot: project.root,
          mode: "pty",
        });
        api
          .agentPtySendPrompt(detail.sessionId, promptText)
          .catch((err) =>
            console.warn("[hand-task] inject into running session failed", err),
          );
      } else {
        // Spawn fresh. `detail.cwd` (a worktree copy's path, from the copy
        // hover card's Commit&push / Create PR actions) pins the agent to
        // THAT copy so it acts on the right branch — not whatever project is
        // focused. In-app callers omit it and fall back to the active project.
        runAgentPrompt(id, label, promptText, "pty", [], detail.cwd);
      }
      if (detail.taskId && project) {
        api
          .auraCli(project.root, [
            "task",
            "claim",
            detail.taskId,
            "--as-who",
            id,
            "--json",
          ])
          .catch(() => {});
      }
    }
    window.addEventListener("aura:hand-task-to-agent", onHand);
    return () => window.removeEventListener("aura:hand-task-to-agent", onHand);
  }, [runAgentPrompt, project, editor]);

  // Mobile remote bridge — the LAN server in `cmd_remote.rs` emits
  // `remote:request` events with `{kind, body}` whenever a phone
  // sends a prompt. We translate those into the same calls the
  // Composer would make, so the phone drives the desktop session
  // through the renderer's existing code paths (auth, attachments,
  // workspace context all stay consistent).
  useEffect(() => {
    // StrictMode runs effects twice in dev. Track stale via closure flag
    // so the listener that resolves AFTER cleanup is unsubscribed too —
    // otherwise a single phone prompt fires the handler twice and spawns
    // duplicate Manager sessions.
    let cancelled = false;
    let unl: (() => void) | null = null;
    listen<{ kind: string; body: Record<string, unknown> }>("remote:request", (e) => {
      const { kind, body } = e.payload;
      const repoRoot =
        (body.repoRoot as string | undefined) || project?.root || "";
      if (kind === "send-prompt") {
        const agentId = (body.agentId as string) || "claude";
        const prompt = (body.prompt as string) || "";
        // Phone passes "stream" to resume an existing stream tab; new
        // sessions default to pty (matches the desktop's default).
        const mode = (body.mode as string) === "stream" ? "stream" : "pty";
        if (!repoRoot) return;
        runAgentPrompt(agentId, agentId, prompt, mode);
      } else if (kind === "manager-start") {
        const prompt = (body.prompt as string) || "";
        if (!repoRoot) return;
        runAgentPrompt("aura-manager", "Aura", prompt, "pty");
      } else if (kind === "manager-chat") {
        const sessionId = (body.sessionId as string) || "";
        const message = (body.message as string) || "";
        if (!sessionId || !message) return;
        api.managerChat(sessionId, message).catch((err) => {
          console.warn("[remote] manager_chat failed", err);
        });
      } else if (kind === "pty-write") {
        // Phone is sending keystrokes to a live PTY agent tab. We push
        // the bytes directly into the PTY — same path as user typing.
        const sessionId = (body.sessionId as string) || "";
        const data = (body.data as string) || "";
        if (!sessionId || !data) return;
        const bytes = Array.from(new TextEncoder().encode(data));
        api.agentPtyWrite(sessionId, bytes).catch((err) => {
          console.warn("[remote] pty_write failed", err);
        });
      } else if (kind === "pty-resize") {
        // Phone reporting its xterm dimensions. Resize the PTY so the
        // running TUI redraws at phone-friendly cols/rows instead of
        // wrapping mid-line.
        const sessionId = (body.sessionId as string) || "";
        const cols = Number(body.cols) | 0;
        const rows = Number(body.rows) | 0;
        if (!sessionId || cols <= 0 || rows <= 0) return;
        api.agentPtyResize(sessionId, cols, rows).catch((err) => {
          console.warn("[remote] pty_resize failed", err);
        });
      }
    })
      .then((u) => {
        if (cancelled) {
          u();
        } else {
          unl = u;
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      if (unl) unl();
    };
  }, [runAgentPrompt, project]);

  // Mirror tab + project state into the LAN remote server so phones
  // see the live list of running agent / manager sessions and can pick
  // which one to drive instead of always spawning new. Pushes are
  // idempotent — backend caches the latest and fans out to all WS.
  const pushSnapshot = useCallback(() => {
    const sessions = [
      ...editor.agentTabs.map((t) => {
        // Channels the phone must subscribe to when joining this tab.
        // Stream-mode topics use the same sanitized `{agentId}@{repo}`
        // key that cmd_agent_stream.rs::sanitize_channel produces — the
        // sessionId is a synthetic tab key, not the emit topic.
        const channels: string[] =
          t.mode === "pty"
            ? [`agent-pty:${t.sessionId}`]
            : (() => {
                const stream = streamChannel(t.agentId, t.repoRoot);
                return [`agent-stream:${stream}`, `agent-stream-done:${stream}`];
              })();
        return {
          id: t.sessionId,
          kind: "agent" as const,
          agentId: t.agentId,
          label: t.agentLabel,
          repoRoot: t.repoRoot,
          mode: t.mode,
          channels,
        };
      }),
      ...editor.managerTabs.map((t) => ({
        id: t.sessionId,
        kind: "manager" as const,
        agentId: "aura-manager",
        label: t.label,
        repoRoot: project?.root ?? "",
        mode: "stream" as const,
        // `manager:<sid>` carries full ManagerSession snapshots; the
        // chat reply tokens stream on `manager-stream:<sid>`. Phone
        // needs both to reconstruct desktop view.
        channels: [`manager:${t.sessionId}`, `manager-stream:${t.sessionId}`],
      })),
    ];
    const projects = (recents.length ? recents : project ? [project.root] : [])
      .filter(Boolean)
      .map((root) => ({
        root,
        name: root.split("/").filter(Boolean).pop() ?? root,
        active: project?.root === root,
      }));
    const payload = {
      activeRoot: project?.root ?? null,
      projects,
      sessions,
    };
    api.remoteSetSnapshot(payload).catch(() => {
      // Server may not be running — that's fine; the cache is only
      // used when a phone connects.
    });
  }, [editor.agentTabs, editor.managerTabs, project, recents]);

  useEffect(() => {
    pushSnapshot();
  }, [pushSnapshot]);

  // Heartbeat: re-push the snapshot every 60s even when nothing changes,
  // so the cloud's `last_activity_at` stays fresh. The cloud filters
  // `status="running"` rows that haven't ticked in 5min, so without this
  // a long-idle session would silently disappear from mobile / dashboard
  // even though it's still alive on the desktop.
  useEffect(() => {
    const id = window.setInterval(pushSnapshot, 60_000);
    return () => window.clearInterval(id);
  }, [pushSnapshot]);

  // Daemon-native handover (no shell hop). Falls back gracefully if the
  // daemon isn't up — the OutputDialog shows the error.
  const runHandover = useCallback(async () => {
    setOutput({ open: true, title: "Handover (claude)", body: "", loading: true, error: null });
    try {
      const xml = await api.daemonHandover("claude");
      setOutput({ open: true, title: "Handover (claude)", body: xml, loading: false, error: null });
    } catch (e) {
      setOutput({ open: true, title: "Handover (claude)", body: "", loading: false, error: String(e) });
    }
  }, []);

  // Hydrate project metadata for an arbitrary root. Used at boot (cwd /
  // home) and by the folder-picker action so switching projects refreshes
  // every panel that keys off `project`.
  const loadProjectAt = useCallback(async (root: string) => {
    const name = root.split("/").filter(Boolean).pop() ?? "project";
    const [branch, ageSecs] = await Promise.all([
      api.gitBranch(root).catch(() => ""),
      api.gitLastCommitAge(root).catch(() => -1),
    ]);
    // Capture the outgoing root BEFORE setProject so the workspace
    // switch can serialize that workspace's tabs into its own slot.
    const previousRoot = projectRootRef.current;
    // This deliberately does not touch `place` / `wsOpen` / `tracePage`: it is
    // the mechanical "make this root the open project" step, and some callers
    // (boot, an auto-followed worktree launch) must not yank the user's view.
    // Deciding where to *stand* afterwards belongs to the caller — clicking a
    // project in the roster goes through `goToProject`, which leaves the page.
    //
    // Second step of the activation funnel: they got a project open. Once per
    // install — the root itself never leaves the machine.
    trackActivation("project_opened");
    setProject({
      root,
      name,
      branch: branch || "—",
      lastModified: ageSecs >= 0 ? formatAge(ageSecs) : "no git history",
    });
    projectRootRef.current = root;
    // Park prev's live state, then stand in `root`. A place already open this
    // session comes back as a FOCUS — its buffers, unsaved edits and running
    // agents are handed straight back, nothing is read from disk. Only a place
    // seen for the first time is rebuilt from its snapshot, and only that case
    // owes the cold-restore work below.
    const switched = editor.switchWorkspace(previousRoot, root);
    if (switched === "hydrated") {
      // Restore file tabs from the new workspace's snapshot. The
      // snapshot stores paths only; openFile owns the disk read so a
      // changed file on disk shows its latest content. Skipped on a focus:
      // those tabs are already open, and re-reading disk over a live buffer
      // is how an unsaved edit would go missing.
      for (const path of pendingFilePaths(root)) {
        // Fire-and-forget; the editor handles tabs that fail to load by
        // showing an error tab. We don't block the workspace switch on
        // disk I/O across N files.
        void editor.open(path).catch((e) => {
          console.warn("[workspace] failed to reopen file:", path, e);
        });
      }
    }
    // Backwards-compat: if the user has no snapshot yet but does have
    // legacy `aura.openAgents.<root>` entries from before P1, surface
    // them so the transition isn't lossy. A focused place has already
    // answered this question — an empty agent list there means the user
    // closed those tabs, and re-adding them would undo that.
    if (switched === "hydrated" && editor.agentTabs.length === 0) {
      const persisted = readPersistedAgents(root);
      for (const entry of persisted) {
        editor.openAgent({
          sessionId: entry.sessionId,
          agentId: entry.agentId,
          agentLabel: entry.agentLabel,
          agentMonogram: entry.agentMonogram,
          repoRoot: root,
          mode: entry.mode === "chat" ? "chat" : "pty",
          openaiCompatProfile: entry.openaiCompatProfile,
          // The durable per-tab Claude session id, so a cold-restored tab
          // resumes its OWN conversation when the user Starts it (not the
          // repo's newest session shared across every Claude tab).
          resumeSessionId: entry.resumeSessionId,
          // And the place it was running in, so Starting it goes back to that
          // machine rather than to whichever one this window happens to be
          // standing in when the user clicks.
          machineId: entry.machineId,
          // Restored from persistence, not opened live — come back cold
          // so the workspace switch doesn't relaunch a Claude process.
          dormant: true,
        });
      }
    }
    // Manager (Aura native chat) has no per-workspace restore of its own — the
    // agent tabs above come back via readPersistedAgents, but the Manager
    // surface only reopens from the workspace snapshot or the boot effect. So a
    // workspace with real Aura conversations on disk but no snapshot (the
    // bundled Get Started project, or any repo whose chats were seeded/synced
    // rather than opened here) lands on an EMPTY Build→Chat. The first time we
    // open such a workspace, focus its most-recent conversation so the surface
    // shows real work instead of a blank composer. Marked per-root so a chat
    // the user later closes stays closed — we never force one back after this.
    if (editor.managerTabs.length === 0) {
      const openedKey = `aura.managerOpened.${root}`;
      let openedBefore = false;
      try {
        openedBefore = localStorage.getItem(openedKey) === "1";
      } catch {
        /* private mode — treat as first open; nothing persists anyway */
      }
      if (!openedBefore) {
        try {
          const sessions = await fetchManagerList(root);
          const newest = sessions
            .slice()
            .sort((a, b) => b.updated_at - a.updated_at)[0];
          if (newest) focusAmbientManager(root, newest.id);
        } catch (e) {
          console.warn("[manager] first-open focus failed:", e);
        }
        try {
          localStorage.setItem(openedKey, "1");
        } catch {
          /* private mode — ignore */
        }
      }
    }
    // Persist as the boot default so a restart lands here, not back at
    // the shell's cwd. A detached whole-workspace popout window does NOT do
    // this: it's a second window onto a (usually different) place, and
    // moving the shared last-workspace pointer would yank the MAIN window
    // there on its next restart. Gated on "detached", not on "has a root
    // override": a popped-out machine with no local checkout has no override
    // and still must not move the pointer it borrowed.
    if (!isDetachedRef.current) {
      try {
        localStorage.setItem("aura.lastWorkspace", root);
      } catch {
        /* quota — ignore */
      }
    }
    // Managed agent worktrees can be opened (e.g. to inspect what an agent
    // did) but must never be pinned as a top-level workspace tile or
    // mirrored into projects.json — they belong under their parent in the
    // roster's worktree list. Opening one still works above; we just don't
    // promote it to a recent/registered workspace.
    if (!isManagedWorktree(root)) {
      // Append-on-first-seen, preserve order. Switching back to an
      // existing recent should NOT shuffle the rail — that made tiles
      // jump around when the user just wanted a stable place to click.
      setRecents((prev) => {
        if (prev.includes(root)) return prev;
        // Keep the NEWEST 8, evicting the oldest from the front. Using
        // slice(0, 8) here silently dropped the just-opened folder once
        // the rail was already full — the new root landed at index 8 and
        // was truncated away, so it never got a sidebar tile and never
        // persisted into the roster.
        const next = [...prev, root].slice(-8);
        try {
          localStorage.setItem("aura.recents", JSON.stringify(next));
        } catch {
          /* quota — ignore */
        }
        return next;
      });
      // Mirror to backend `~/.aura/projects.json` so the Manager loop can
      // resolve `task.project_root` independently of the active workspace.
      api.projectsRegister(root, name).catch((e) => {
        console.warn("[projects] register failed:", e);
      });
      // Turn recording on for them the first time a real project opens, then
      // say so plainly (RecordingNotice). Skips git-less dirs, already-on
      // repos, and anyone who turned it off here before. Not a worktree —
      // we're inside the `!isManagedWorktree` branch.
      void autoEnableCapture(root, name, false);
    }
  }, [editor]);

  // Clicking a project means "take me to this project" — its code, its agents,
  // its tabs. Not "re-scope the page I happen to be standing on".
  //
  // Tasks, Team and Pages each carry their own project picker in their own
  // rail (PlaceRailScope → setProjectScope), which is the deliberate way to
  // ask one of those pages about a different project. The sidebar roster is
  // the other question, and it has exactly one honest answer: leave.
  //
  // `leavePages` runs even when the root is unchanged. Clicking the project
  // you are already in, from Tasks, used to do nothing whatsoever — the guard
  // below is about not reloading a workspace, not about whether to navigate.
  const goToProject = useCallback(
    (root: string) => {
      leavePages();
      if (root === projectRootRef.current) return;
      loadProjectAt(root).catch((e) => console.error("switch failed:", e));
    },
    [leavePages, loadProjectAt],
  );

  // Walking into a club — several places in one window, which is what the
  // rail's "Side by side" row asks for. The store has held N clubs over any
  // set of places since B4; this is the window actually going to one.
  //
  // Throws rather than returning a flag: the rail's row shows what went wrong
  // and offers another go, and "it didn't open and nothing said so" is the
  // exact failure a club row can't afford — the whole click is invisible until
  // the tabs change.
  const enterClubById = useCallback(
    async (clubId: string) => {
      const club = getClub(clubId);
      if (!club) {
        throw new Error(
          "This side-by-side no longer exists. It may have been broken up in another window.",
        );
      }
      // The club renders on the work surface, so whatever is covering it steps
      // aside first — same as going to a project. Machines are blurred, not
      // left: their tabs are what the club is about to union.
      leavePages();
      // Stand in one of its member projects first, so everything that reads a
      // repo root — the changes panel, the file tree, the board — points at
      // something in the club rather than at whichever project you happened to
      // be in. Skipped when the open one is already a member: entering a club
      // from one of its own places must not move you off it.
      const here = projectRootRef.current;
      if (!here || !clubHolds(club, here)) {
        const home = club.members
          .map(placeRepoRoot)
          .find((r): r is string => !!r);
        if (home && home !== here) await loadProjectAt(home);
      }
      // The union itself: park the concrete place, stand in the club's own
      // place, seed its slot from every member's snapshot. Members are place
      // KEYS, so a checkout on this laptop and a project on a box go through
      // exactly the same call.
      editorRef.current.enterClub(
        projectRootRef.current,
        clubId,
        clubMemberKeys(club),
      );
    },
    [leavePages, loadProjectAt],
  );

  // …and stepping off it. The tabs opened while clubbed are parked in the
  // club's own slot and each member place is handed back its own live state,
  // untouched — see editorStore's `exitClub`. The same two calls the roster's
  // project rows make when you leave a club by clicking a project.
  const leaveActiveClub = useCallback(() => {
    if (!getClubState().activeClubId) return;
    const back = projectRootRef.current;
    if (!back) return;
    editorRef.current.exitClub(back);
    setActiveClub(null);
  }, []);

  // Resolve a root into a tile letter — the canonical project name shown
  // on the workspace rail. Two roots can collide on first letter, but
  // hovering shows the full path so it's not actually ambiguous.
  const tileLetter = useCallback((root: string) => {
    // One letter mark for the whole app — see lib/monogram.
    return letterMark(root.split("/").filter(Boolean).pop(), { empty: "·" });
  }, []);

  // A folder picked from disk that turns out not to be tracked yet. Opening
  // it would give a shell with nothing to say — no history, no copies, nothing
  // to prove — so the setup question is asked first and the project only opens
  // once there is a repository behind it.
  const [publishGateDir, setPublishGateDir] = useState<string | null>(null);

  // Folder picker → switch project. Centralised so both the rail's `+`
  // tile and the File→Open menu can call the same code path.
  const pickAndOpenFolder = useCallback(() => {
    import("./lib/nativeDialog").then(async ({ pickPath }) => {
      const picked = await pickPath({ directory: true, multiple: false });
      if (typeof picked !== "string" || !picked) return;
      // A failed check must not become a locked door: if we can't tell
      // whether it's a repository, open it and let the app say so in
      // context rather than blocking on a question we can't answer.
      let tracked = true;
      try {
        tracked = (await api.repoState(picked)).is_repo;
      } catch (e) {
        console.error("repo check failed, opening anyway:", e);
      }
      if (!tracked) {
        setPublishGateDir(picked);
        return;
      }
      await loadProjectAt(picked);
    }).catch((e) => console.error("open folder failed:", e));
  }, [loadProjectAt]);

  // Keep the forward-reference ref pointed at the latest loadProjectAt so the
  // earlier-declared workspace-launch listener can navigate into a freshly
  // created worktree.
  useEffect(() => {
    loadProjectAtRef.current = loadProjectAt;
  }, [loadProjectAt]);

  // Same, for the folder picker: the Aura door falls back to it when there is
  // no workspace open and none was ever opened.
  useEffect(() => {
    pickAndOpenFolderRef.current = pickAndOpenFolder;
  }, [pickAndOpenFolder]);

  // Workspace back / forward — a lightweight visit history over the active
  // project root, driving the sidebar-header nav arrows (the top-level control,
  // not the Pages-scoped one). A programmatic back/forward navigation sets
  // `navSuppress` so it isn't re-pushed onto the stack; a user-initiated switch
  // (dropdown, launch) truncates any forward tail and appends, exactly like a
  // browser history.
  const navHistory = useRef<string[]>([]);
  const [navCursor, setNavCursor] = useState(-1);
  const navSuppress = useRef(false);
  useEffect(() => {
    const root = project?.root;
    if (!root) return;
    if (navSuppress.current) {
      navSuppress.current = false;
      return;
    }
    const truncated = navHistory.current.slice(0, navCursor + 1);
    if (truncated[truncated.length - 1] === root) return;
    truncated.push(root);
    navHistory.current = truncated;
    setNavCursor(truncated.length - 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.root]);
  const canWsBack = navCursor > 0;
  const canWsForward =
    navCursor >= 0 && navCursor < navHistory.current.length - 1;
  const wsGoBack = useCallback(() => {
    if (navCursor <= 0) return;
    const target = navHistory.current[navCursor - 1];
    if (!target) return;
    navSuppress.current = true;
    setNavCursor(navCursor - 1);
    void loadProjectAt(target).catch((e) => console.error("nav back failed:", e));
  }, [navCursor, loadProjectAt]);
  const wsGoForward = useCallback(() => {
    if (navCursor < 0 || navCursor >= navHistory.current.length - 1) return;
    const target = navHistory.current[navCursor + 1];
    if (!target) return;
    navSuppress.current = true;
    setNavCursor(navCursor + 1);
    void loadProjectAt(target).catch((e) => console.error("nav forward failed:", e));
  }, [navCursor, loadProjectAt]);

  // Next / previous workspace. Cmd+Option+Arrow walks the stable rail order
  // and wraps, so unread badges can be triaged without reaching for the mouse.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const meta = event.metaKey || event.ctrlKey;
      if (!meta || !event.altKey || event.shiftKey) return;
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      const target = event.target as HTMLElement | null;
      if (
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable
      ) {
        return;
      }
      const roots = recents.filter((root) => !isManagedWorktree(root));
      if (roots.length < 2 || !project?.root) return;
      const current = Math.max(0, roots.indexOf(project.root));
      const delta = event.key === "ArrowDown" ? 1 : -1;
      const next = roots[(current + delta + roots.length) % roots.length];
      if (!next || next === project.root) return;
      event.preventDefault();
      void loadProjectAt(next).catch((error) =>
        console.error("workspace keyboard navigation failed:", error),
      );
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [recents, project?.root, loadProjectAt]);

  // Onboarding's "Open folder…" button dispatches this event so the
  // dialog component doesn't need to import loadProjectAt directly.
  // `aura:open-repo-picker-path` (with detail.path) is used by the
  // onboarding ProjectPanel which runs the picker locally and just
  // needs us to load the resulting path.
  useEffect(() => {
    const fn = () => pickAndOpenFolder();
    const pathFn = (e: Event) => {
      const path = (e as CustomEvent<{ path?: string }>).detail?.path;
      if (typeof path === "string" && path) {
        void loadProjectAt(path);
      }
    };
    window.addEventListener("aura:open-repo-picker", fn);
    window.addEventListener("aura:open-repo-picker-path", pathFn);
    return () => {
      window.removeEventListener("aura:open-repo-picker", fn);
      window.removeEventListener("aura:open-repo-picker-path", pathFn);
    };
  }, [pickAndOpenFolder, loadProjectAt]);

  const dispatchAction = useCallback(
    (id: AppActionId) => {
      switch (id) {
        case "palette":
          setPaletteOpen(true);
          return;
        case "toggle_sidebar":
          setSidebarOpen((v) => !v);
          return;
        case "toggle_terminal":
          editor.toggleTerminalPanel();
          return;
        case "toggle_review":
          setReviewOpen((v) => !v);
          return;
        case "run_project": {
          // Run lives in the terminal panel, and the panel only exists while
          // it's open — so open it first, then ask. Pressing ⌘R and seeing
          // nothing happen is indistinguishable from the feature not working.
          // The request waits for the panel instead of racing it: it is held
          // until the panel mounts and claims it.
          if (!editor.terminalPanelOpen) editor.setTerminalPanelOpen(true);
          requestRun();
          return;
        }
        case "reload_app":
          // Hard refresh of the webview — recovers the UI when a broken HMR
          // update leaves it wedged, without needing to quit the app.
          window.location.reload();
          return;
        case "save":
          editor.saveActive().catch(() => {});
          return;
        case "close_tab":
          if (editor.activeAgentId) {
            // Cmd-W stops the agent too — same default as clicking the tab's X.
            editor.stopAndCloseAgent(editor.activeAgentId);
          } else if (editor.activePath) {
            editor.close(editor.activePath);
          }
          return;
        case "mobile_waitlist":
          setMobileWaitlistOpen(true);
          trackFeature("mobile_waitlist_opened", { from: "palette" });
          return;
        case "settings":
          setSettingsOpen(true);
          return;
        case "shortcuts":
          setShortcutsOpen(true);
          return;
        case "extensions":
          window.dispatchEvent(new CustomEvent("aura:open-extensions"));
          return;
        case "time_machine":
          window.dispatchEvent(new CustomEvent("aura:open-time-machine"));
          return;
        case "open_aura":
          window.dispatchEvent(new CustomEvent("aura:open-aura"));
          return;
        case "project_timeline":
          window.dispatchEvent(new CustomEvent("aura:open-timeline"));
          return;
        case "workspaces":
          // Unscoped on purpose — a keyboard/palette summon has no project in
          // mind, so it opens on the whole fleet.
          window.dispatchEvent(new CustomEvent("aura:open-workspaces"));
          return;
        case "tasks_board": {
          if (projectRootRef.current) goPlace("tasks");
          return;
        }
        case "notes": {
          if (projectRootRef.current) goPlace("pages");
          return;
        }
        case "open_prs":
          // The PR triage Inbox — the right rail's PRs tab, its one home.
          setRightRailTab("prs");
          return;
        case "zoom_in":
          setZoom((z) => clampZoom(z + ZOOM_STEP));
          return;
        case "zoom_out":
          setZoom((z) => clampZoom(z - ZOOM_STEP));
          return;
        case "zoom_reset":
          setZoom(1);
          return;
        case "aura_status":
          runCli("aura status", ["status"]);
          return;
        case "aura_doctor":
          goTrace({ kind: "tool", tool: "doctor" });
          return;
        case "aura_impacts":
          runCli("aura live impacts", ["live", "impacts"]);
          return;
        case "aura_pr_review":
          goTrace({ kind: "tool", tool: "review" });
          return;
        case "aura_snapshot":
          setSnapshotOpen(true);
          return;
        case "aura_rewind":
          goTrace({ kind: "tool", tool: "rewind" });
          return;
        case "aura_undo":
          setOpLogOpen(true);
          return;
        case "aura_log_intent":
          setLogIntentOpen(true);
          return;
        case "aura_handover":
          runHandover();
          return;
        case "aura_ask":
          setAskOpen(true);
          return;
        case "plan_builder":
          editor.openPlanBuilder();
          return;
        case "orchestrate":
          // Heavyweight DAG path. In ADE the +/⌘N open inline chat, so
          // this is the explicit way to stage a multi-step Manager run.
          setManagerLauncherOpen(true);
          return;
        case "aura_prove":
          goTrace({ kind: "prove" });
          return;
        case "open_file":
          // Same folder picker the workspace rail's `+` tile uses.
          pickAndOpenFolder();
          return;
      }
    },
    [editor, runCli, runHandover, pickAndOpenFolder],
  );

  useAppActions(dispatchAction);

  // Poll diff stats + ambient badge counts so the status bar and nav-rail
  // badges reflect reality. 4s interval is light enough that the user
  // never feels it; if perf gets tight we can fold this into a single
  // bus that all panes share.
  useEffect(() => {
    if (!project) return;
    let cancelled = false;
    async function tick() {
      try {
        // For an agent worktree the footer chip should reflect ALL the work
        // done in that copy since it forked from its base (committed AND
        // uncommitted), not just what's uncommitted-vs-HEAD; the main checkout
        // has no fork base, so it keeps the uncommitted-vs-HEAD behavior.
        const sinceBase = isWorktreeRoot(project!.root);
        // Every one of these lands in a chip that reads as a fact. A read
        // that failed must leave the last known number alone — `catch(() => [])`
        // published a zero, so one failed tick could take a paused risky
        // action off the footer and tell you there was nothing to look at.
        const [stats, impacts, conflicts, astConflicts, usageSum, intentCount, auditCount] =
          await Promise.all([
            api.gitDiffStats(project!.root, sinceBase).catch(() => null),
            fetchImpacts(project!.root).catch(() => null),
            fetchConflicts(project!.root).catch(() => null),
            fetchAstConflicts(project!.root).catch(() => null),
            api.auraUsageSummary(project!.root).catch(() => null),
            api.auraCountIntentsToday(project!.root).catch(() => null),
            api.auraCountAuditUnacked(project!.root).catch(() => null),
          ]);
        if (cancelled) return;
        if (stats) setDiffStats(stats);
        if (impacts) setImpactsCount(impacts.length);
        if (conflicts) setConflictsCount(conflicts.length);
        if (astConflicts)
          setAstConflictsOpen(astConflicts.filter((c) => c.resolved_at === null).length);
        if (usageSum) setUsage(usageSum);
        if (intentCount !== null) setIntentsToday(intentCount);
        if (auditCount !== null) setAuditUnacked(auditCount);
      } catch {
        /* swallow — these chips are best-effort */
      }
    }
    tick();
    if (!windowVisible) return () => { cancelled = true; };
    const id = window.setInterval(tick, 4000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [project, windowVisible]);

  // Task #229 — one-shot Aura CLI version check on shell startup. The
  // chip popover wires `onRefreshCliVersion` to `refreshCliVersion`
  // below so users can re-check after upgrading without restarting.
  const refreshCliVersion = useCallback(() => {
    api
      .auraCliVersionCheck()
      .then((v) => setCliVersion(v))
      .catch(() => {
        // Don't blow up the chip on a transient invoke failure — keep
        // whatever the previous result was. If the very first call
        // fails (cliVersion still null) the chip simply stays hidden.
      });
  }, []);
  // Manual one-click CLI update from the footer chip — installs the binary
  // bundled with this release in place, then refreshes the chip. Auto-install
  // on launch (CliUpdateToast) already covers the common case; this is the
  // explicit re-run. Rejects propagate so the chip can show a transient error.
  // interactive: a chip click is explicit user intent, so a root-owned
  // install dir (/usr/local/bin) may pop the macOS admin prompt.
  const updateCli = useCallback(async () => {
    const res = await api.auraCliInstallBundled(true);
    setCliVersion(res);
  }, []);
  useEffect(() => {
    refreshCliVersion();
  }, [refreshCliVersion]);

  // Strict-mode posture poll. Long cadence — the field rarely changes
  // (only when the human edits ~/.aura/credentials.json). On-load read
  // gives the StatusBar pill an answer before the first 120s window.
  useEffect(() => {
    if (!project) return;
    let cancelled = false;
    async function tickStrict() {
      try {
        const info = await api.auraStrictMode();
        if (!cancelled) setStrictMode(info.mode);
      } catch {
        /* ignore — pill just stays at "off" */
      }
    }
    tickStrict();
    const id = window.setInterval(tickStrict, 120_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [project]);

  useEffect(() => {
    (async () => {
      try {
        // A detached whole-workspace window boots straight into its pinned
        // root — never the persisted last-workspace — so two windows can sit on
        // two different projects at once. Otherwise restore the workspace the
        // user was last in, falling back to the shell cwd, then $HOME.
        let root: string | null = bootRootOverrideRef.current ?? null;
        if (!root) {
          try {
            root = localStorage.getItem("aura.lastWorkspace");
          } catch {
            /* private mode — ignore */
          }
        }
        // The bundled "Get Started" sample (Recipe Box) is Aura's Quickstart:
        // seeded on first launch (the Rust command is idempotent — it early-
        // returns once the folder exists) and pinned into the project list ONCE,
        // so it stays a permanent, one-click project in the switcher/roster the
        // way Conductor keeps a Quickstart around. A genuine first run — no
        // pinned window, no saved workspace — boots straight onto it with its
        // live sample chat focused, which is what replaces the old onboarding
        // walkthrough: real content instead of a guided tour. Returning users
        // keep their own workspace; Get Started still rides along in the list.
        // Never blocks boot.
        if (!bootRootOverrideRef.current) {
          let seeded = false;
          let pinned = false;
          try {
            seeded = localStorage.getItem("aura.sampleSeeded") === "1";
            pinned = localStorage.getItem("aura.samplePinned") === "1";
          } catch {
            /* private mode — treat as unseeded; the Rust side is idempotent */
          }
          // Fast path for a settled install: already seeded, already pinned, and
          // we already have a workspace to open — leave the common returning-user
          // boot untouched. Otherwise (re)seed so we have the sample root to pin
          // and/or open.
          if (!seeded || !pinned || !root) {
            let sampleRoot: string | null = null;
            let sampleAmbient: string | null = null;
            try {
              const sample = await api.seedSampleProject();
              sampleRoot = sample.root;
              sampleAmbient = sample.ambientSessionId;
              try {
                localStorage.setItem("aura.sampleSeeded", "1");
                // This same seed call already dropped the bundled Get Started
                // chats, so the one-time session heal below has nothing left to
                // do — mark it done so a later "settled" boot skips it.
                localStorage.setItem("aura.sampleSessionsSeeded", "1");
              } catch {
                /* private mode — ignore; the Rust side is idempotent */
              }
            } catch (e) {
              console.warn("[sample] seed failed:", e);
            }
            if (sampleRoot) {
              // Pin it as a project exactly once. After that, a user who closes
              // the Get Started tile has it stay closed — we never force it back.
              if (!pinned) {
                const sr = sampleRoot;
                setRecents((prev) => {
                  if (prev.includes(sr)) return prev;
                  // Sample leads the list; keep it plus the 7 newest others.
                  const next = [sr, ...prev.filter((r) => r !== sr).slice(-7)];
                  try {
                    localStorage.setItem("aura.recents", JSON.stringify(next));
                  } catch {
                    /* quota — ignore */
                  }
                  return next;
                });
                try {
                  localStorage.setItem("aura.samplePinned", "1");
                } catch {
                  /* private mode — ignore */
                }
              }
              // Genuine first run: boot onto Get Started + focus its live chat.
              if (!root) {
                root = sampleRoot;
                try {
                  focusAmbientManager(sampleRoot, sampleAmbient ?? "");
                } catch {
                  /* focus is best-effort; the chat is still openable */
                }
              }
            }
          } else {
            // Settled install (already seeded + pinned + has a workspace) that
            // predates the bundled Get Started chats — its recipe-box folder was
            // seeded before session-seeding existed, so it opens onto an empty
            // Build surface ("no chats, no transcript"). Re-seed ONCE to top up
            // the sample conversations: the Rust command now drops the bundled
            // chats before its project-tree idempotency guard, and never
            // clobbers an existing session file, so this only adds what's
            // missing and leaves the user's own workspace untouched. A one-time
            // marker keeps it from re-running every boot.
            let sessionsHealed = false;
            try {
              sessionsHealed =
                localStorage.getItem("aura.sampleSessionsSeeded") === "1";
            } catch {
              /* private mode — skip the heal; nothing persists anyway */
            }
            if (!sessionsHealed) {
              try {
                await api.seedSampleProject();
              } catch (e) {
                console.warn("[sample] session top-up failed:", e);
              }
              try {
                localStorage.setItem("aura.sampleSessionsSeeded", "1");
              } catch {
                /* private mode — ignore */
              }
            }
          }
        }
        if (!root) {
          root = await api.currentDir();
          if (!root || root === "/") root = await api.homeDir();
        }
        await loadProjectAt(root);
        // Boot hydration is done: the workspace snapshot has been restored into
        // live state and the synchronous global-layout restore has already run.
        // Arm the snapshot writer so every subsequent tab open/close/switch
        // keeps this workspace's scoped snapshot fresh — a tab the user closes
        // now stays closed across restarts instead of resurrecting from a stale
        // snapshot that was only ever rewritten on workspace switch-away.
        armWorkspaceSnapshots();
      } catch (e) {
        setBootError(String(e));
      }
    })();
    // Initial boot only — running this on every loadProjectAt change
    // would re-set the project to cwd whenever the user picked a folder.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Restore the ambient Manager chat on first boot. We scope `manager_list`
  // to THIS workspace's root — a session from another workspace (e.g. New
  // Git while Mixrank is open) must never be re-homed here, since the rail
  // would then show and operate on the wrong project. We intersect the
  // persisted tab roster against the scoped list to drop sessions whose
  // JSON was removed, then focus the most-recent survivor that actually
  // belongs to this workspace.
  useEffect(() => {
    (async () => {
      const persisted = readPersistedManagers();
      if (persisted.length === 0 || !project) return;
      try {
        const live = await fetchManagerList(project.root);
        const liveById = new Map(live.map((s) => [s.id, s]));
        const survivor = persisted.find((p) => liveById.has(p.sessionId));
        if (survivor) focusAmbientManager(project.root, survivor.sessionId);
      } catch (e) {
        console.warn("[manager] restore failed:", e);
      }
    })();
    // Initial boot only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // #222 — the workspace's OWN snapshot is the single source of truth for its
  // restored tab layout. `loadProjectAt` (above) already rehydrated it via
  // `switchWorkspace`, so there is no second, competing global-layout restore
  // here anymore. The old global `aura.splitLayout` boot-restore ran a beat
  // before that rehydrate landed and then got overwritten by it — a visible
  // flip (one layout, then another) and the root of the flat/split dual-model
  // confusion. One persisted layout per workspace, restored once, no flip.

  // (Removed) per-workspace bubble-UI session rehydration. With PTY as
  // the default agent surface, claude's own session log lives in
  // ~/.claude and is replayed natively by `claude --resume` when the
  // user picks one via the Resume dialog — no shell-side rehydration
  // into a stream channel needed.

  // AuraWatch lifecycle. Mode is persisted per-user (not per-repo) so
  // a workspace switch reuses the saved choice. Defaults to "nudge" —
  // the safest middle ground per the plan: surfaces missed intents
  // without writing on the user's behalf. Stop on unmount/switch so
  // the registry doesn't leak observers across roots. Polls status
  // every 30s so the StatusBar chip reflects backend changes (e.g.
  // user just started ollama).
  useEffect(() => {
    if (!project) return;
    const root = project.root;
    let cancelled = false;
    api
      .aurawatchStart(root, auraWatchMode)
      .then((s) => {
        if (cancelled) return;
        setAuraWatchBackend(s.backend);
      })
      .catch(() => {});
    const id = window.setInterval(() => {
      api
        .aurawatchStatus(root)
        .then((s) => {
          if (cancelled || !s) return;
          setAuraWatchBackend(s.backend);
          setAuraWatchMode(s.mode);
        })
        .catch(() => {});
    }, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
      api.aurawatchStop(root).catch(() => {});
    };
  }, [project, auraWatchMode]);

  // Workspace file watcher: subscribe once, swap roots when the user
  // picks a new project. The notify-backed backend is debounced 200 ms
  // so multi-write saves from formatters / language servers collapse.
  // We invalidate the matching open buffer (refreshing baseline if the
  // user has unsaved edits, full reload otherwise).
  const lastWatched = useRef<string | null>(null);
  useEffect(() => {
    if (!project) return;
    const root = project.root;
    if (lastWatched.current === root) return;
    const prev = lastWatched.current;
    lastWatched.current = root;
    (async () => {
      if (prev) {
        await api.unwatchRepo(prev).catch(() => {});
      }
      await api.watchRepo(root).catch((e) => console.warn("watch_repo:", e));
    })();
  }, [project]);

  useEffect(() => {
    let off: (() => void) | null = null;
    (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      const handle = await listen<{ path: string; kind: string }>(
        "fs:changed",
        (ev) => {
          const path = ev.payload?.path;
          if (!path) return;
          // Only refresh files we have open — the FileTree picks up
          // creates/removes via its own poll, so we don't need to fire
          // a tree-wide refresh here (which would be jittery).
          editor.reloadFromDisk(path).catch(() => {});
        },
      );
      off = handle;
    })();
    return () => {
      if (off) off();
    };
  }, [editor]);

  // The first frame of the app, both ways it can go. Neither had been given
  // the treatment every other surface in here got: the wait was a lowercase
  // "loading project…" with no loader, and the failure was `String(e)` in red
  // monospace with nothing to do about it — a dead end on the one screen a
  // reader has no context for yet.
  if (bootError) {
    return <BootFailed detail={bootError} />;
  }
  if (!project) {
    return <BootLoading />;
  }

  function onPalettePick(entry: PaletteEntry) {
    setPaletteOpen(false);
    if (entry.kind === "action") {
      dispatchAction(entry.id);
      return;
    }
    if (entry.kind === "file") {
      editor.open(entry.id).catch((e) => console.error("open failed:", e));
      return;
    }
    if (entry.kind === "extCommand") {
      void executeExtCommand(entry.command);
      return;
    }
    if (entry.kind === "match" || entry.kind === "symbol") {
      // Open the file, then scroll to the hit. Editor mount listens
      // for "aura:scroll-to-line" — fire after a beat so the model is
      // attached. Same plumbing the terminal-link clicks use.
      editor.open(entry.path).then(() => {
        window.setTimeout(() => {
          window.dispatchEvent(
            new CustomEvent("aura:scroll-to-line", {
              detail: { path: entry.path, line: entry.line, column: entry.column ?? 1 },
            }),
          );
        }, 120);
      }).catch((e) => console.error("open failed:", e));
      return;
    }
    if (entry.kind === "intent") {
      // A logged reason — jump to the first file it touched (most useful
      // navigation), or, when the reason recorded no files, pop its
      // split/merge editor by timestamp so the user still lands on it.
      if (entry.path) {
        const path = entry.path;
        const line = entry.line ?? 1;
        editor.open(path).then(() => {
          window.setTimeout(() => {
            window.dispatchEvent(
              new CustomEvent("aura:scroll-to-line", {
                detail: { path, line, column: 1 },
              }),
            );
          }, 120);
        }).catch((e) => console.error("open failed:", e));
      } else {
        window.dispatchEvent(
          new CustomEvent("aura:open-intent-edit", {
            detail: { intentTs: entry.timestamp },
          }),
        );
      }
      return;
    }
    if (entry.kind === "chat") {
      // The conversation opens as a workpane, and a workpane opened while a
      // page is covering the work surface really does open — focused, in the
      // tab strip, entirely invisible.
      leavePages();
      const openConversation = () => editor.openManager(entry.sessionId, entry.hint ?? "Conversation");
      if (entry.repoRoot && entry.repoRoot !== currentRootRef.current) {
        void loadProjectAt(entry.repoRoot)
          .then(openConversation)
          .catch((e) => console.error("conversation workspace switch failed:", e));
      } else {
        openConversation();
      }
      return;
    }
    if (entry.kind === "agent") {
      // `@<id> <prompt>` — dispatch the prompt to that agent. Empty
      // prompt just focuses (or opens) the agent tab.
      const a = discoveredAgents.find((x) => x.id === entry.id);
      const label = a?.label ?? entry.label;
      runAgentPrompt(entry.id, label, entry.prompt, "pty");
      return;
    }
    if (entry.kind === "workspace") {
      // Jump to another registered project — same promise as clicking it in
      // the roster, so it lands on that project's code rather than re-scoping
      // whichever page happened to be covering the work surface.
      goToProject(entry.root);
      return;
    }
    // slash entry — route through the same dispatcher Composer uses so
    // palette and composer share one execution path.
    const cmd = findSlash(entry.id);
    if (cmd) runSlash(cmd, "");
  }

  // Routes a slash command (from palette or composer) to the right
  // sink — UI toggles run inline, MCP-style commands either open a
  // dedicated dialog (snapshot/rewind/log/handover) or fall through to
  // the CLI passthrough rendered in the OutputDialog.
  function runSlash(cmd: ReturnType<typeof findSlash>, extra: string) {
    if (!cmd) return;
    if (cmd.kind === "ui") {
      if (cmd.target === "toggle_terminal") editor.toggleTerminalPanel();
      if (cmd.target === "claude_resume") setResumeOpen(true);
      if (cmd.target === "knowledge") setKnowledgeOpen(true);
      if (cmd.target === "remote") setRemoteOpen(true);
      if (cmd.target === "intent_inspector") goTrace({ kind: "inspector" });
      if (cmd.target === "provenance_replay") goTrace({ kind: "replay" });
      if (cmd.target === "semantic_graph") goTrace({ kind: "graph" });
      if (cmd.target === "plan_builder") editor.openPlanBuilder();
      if (cmd.target === "prove") goTrace({ kind: "prove" });
      if (cmd.target === "ask") {
        // Plain-language project Q&A. Prefill with whatever the user typed
        // after /ask (empty from the palette) so the dialog opens ready.
        setAskPrefill(extra.trim() || undefined);
        setAskOpen(true);
      }
      if (cmd.target === "compare_worktrees") setCompareOpen(true);
      if (cmd.target === "open_prs_sidebar") {
        setRightRailTab("prs");
      }
      if (cmd.target === "open_inbox") {
        setRightRailTab("prs");
      }
      if (cmd.target === "open_pr_by_number" && project) {
        const n = parseInt(extra.trim(), 10);
        if (Number.isFinite(n) && n > 0) {
          editor.openPrDetail(project.root, n, `PR #${n}`);
        } else {
          setRightRailTab("prs");
        }
      }
      if (cmd.target === "claude_clear") {
        // Drop both events + sessionId so the next prompt starts a
        // fresh Claude conversation. Auto-spawn the stream tab if
        // there isn't one yet so the user has a place to send into.
        if (project) {
          const channel = streamChannel("claude", project.root);
          forgetAgentStream(channel);
          forgetPersistedSession(channel);
          runAgentPrompt("claude", "Claude", "", "pty");
        }
      }
      // /clear-composer is a no-op here — the Composer clears its
      // buffer on send.
      return;
    }
    if (cmd.kind === "aura-cli") {
      // Verb plus optional sub-args, plus whatever the user typed
      // after the slash. e.g. `/zones list foo` → ["zones","list","foo"].
      const parts = cmd.target.split(/\s+/).filter(Boolean);
      if (extra.trim()) parts.push(...extra.trim().split(/\s+/));
      runCli(`aura ${cmd.target}`, parts);
      return;
    }
    if (cmd.kind === "agent-pty") {
      // Claude Code-native slash. Auto-spawn a PTY-mode tab for the
      // gated agent (defaulting to claude) so the slash lands inside
      // the actual REPL where it has meaning.
      const targetAgent = cmd.agent ?? "claude";
      const label = titleCaseName(targetAgent);
      const line = extra.trim() ? `${cmd.target} ${extra.trim()}` : cmd.target;
      // Spawn (or focus) the PTY tab, then send the slash line.
      runAgentPrompt(targetAgent, label, line, "pty");
      return;
    }
    if (cmd.kind === "mcp-server") {
      // External MCP server (Atlassian, Linear, …). `target` is
      // "<server>:<tool>". We pass the post-slash text as a freeform
      // `prompt` argument — most MCP tools accept a single string
      // (search query, issue title, etc.); the user can drill into
      // schema-shaped calls via the dedicated dialog later.
      const colon = cmd.target.indexOf(":");
      if (colon <= 0) return;
      const server = cmd.target.slice(0, colon);
      const tool = cmd.target.slice(colon + 1);
      runMcp(server, tool, extra.trim() ? { prompt: extra.trim() } : {});
      return;
    }
    switch (cmd.target) {
      case "aura_snapshot":
        setSnapshotOpen(true);
        return;
      case "aura_rewind":
        goTrace({ kind: "tool", tool: "rewind" });
        return;
      case "aura_log_intent":
        setLogIntentOpen(true);
        return;
      case "aura_handover":
        runHandover();
        return;
      case "aura_status":
        runCli("aura status", ["status"]);
        return;
      case "aura_doctor":
        runCli("aura doctor", ["doctor"]);
        return;
      case "aura_live_impacts":
        runCli("aura live impacts", ["live", "impacts"]);
        return;
      case "aura_pr_review":
        goTrace({ kind: "tool", tool: "review" });
        return;
      case "aura_plan_discover":
        runCli("aura plan", extra ? ["plan", extra] : ["plan"]);
        return;
      case "aura_prove":
        goTrace({ kind: "prove" });
        return;
      case "aura_memory_read":
        goTrace({ kind: "tool", tool: "memory" });
        return;
      default:
        runCli(cmd.name, [cmd.target.replace(/^aura_/, "").replace(/_/g, "-")]);
    }
  }

  // Trace's destinations, as one bag of handlers.
  //
  // These used to be written inline into the sidebar's `traceBody`, which was
  // fine while the rail was the only door into Trace. It isn't any more: the
  // switcher now rides on the surface, above whichever Trace pane is open, so
  // both entrances need the same handlers — including the two that hand a
  // question to the ambient manager and must share ONE busy flag, or a second
  // click from the other entrance quietly buys a second agent turn.
  //
  // The two that ask (Goals, Safety check) guard on `traceAsk || ambientBusy`
  // rather than disabling themselves, so a click while Aura is mid-turn is
  // absorbed instead of queued behind it.
  //
  // Both go through `askAura`, which owns the three things a question needs to
  // get right and neither handler used to: it asks about `placeRoot` (the
  // project Trace's own strip names, not whichever folder is open), and it
  // catches — a dispatch that throws used to leave the row spinning on an
  // unhandled rejection with nothing on screen ever saying so.
  const askAura = (key: "goals" | "review", prompt: string) => {
    if (traceAsk || ambientBusy) return;
    const root = placeRoot || project.root;
    setTraceAsk(key);
    setTraceAskSending(true);
    void sendToAmbientManager(root, prompt)
      .catch(async (err) => {
        setTraceAsk(null);
        await askNotice({
          title: "Aura couldn't take that question",
          body: String(err),
        });
      })
      .finally(() => setTraceAskSending(false));
  };

  const traceActions: TraceActions = {
    onOverview: () => goTrace({ kind: "sessions", view: "overview" }),
    onSessions: () => goTrace({ kind: "sessions", view: "sessions" }),
    onTeamActivity: () => goTrace({ kind: "sessions", view: "team" }),
    onCostUsage: () => goTrace({ kind: "sessions", view: "usage" }),
    onIntentAst: () => goTrace({ kind: "inspector" }),
    onReview: () => askAura("review", safetyCheckPrompt()),
    onChecks: () => window.dispatchEvent(new CustomEvent("aura:open-checks")),
    onImpacts: () => goTrace({ kind: "tool", tool: "impacts" }),
    onProve: () => askAura("goals", proveGoalsPrompt()),
    onRewind: () => goTrace({ kind: "tool", tool: "rewind" }),
    onTimeline: () =>
      window.dispatchEvent(new CustomEvent("aura:open-timeline")),
    onAttest: () => goTrace({ kind: "tool", tool: "attest" }),
    onCodeMap: () => goTrace({ kind: "graph" }),
    onMemory: () => goTrace({ kind: "tool", tool: "memory" }),
    onDoctor: () => goTrace({ kind: "tool", tool: "doctor" }),
    impactsCount,
    busyKey: traceAsk,
  };

  // The one destination currently covering the work area, or null when the
  // user is in their files/agents. These are pages, not modals — they sit in
  // the content region beside a live sidebar, so leaving is a matter of going
  // somewhere else rather than dismissing something. Exactly one renders: the
  // openers close their siblings, and this picks a single winner so a stale
  // flag can never stack two pages on top of each other.
  //
  // Aura is deliberately first and ungated on `project.root` — it reaches
  // across every project, so it opens with no repo loaded at all.
  //
  // A machine is NOT in this chain. It used to be, and being a single winner
  // among mutually-exclusive siblings is precisely why entering one had to null
  // every other surface first. It renders as its own layer over this one
  // instead, so a box can cover the fleet page it was opened from and give it
  // straight back when you leave.
  const activePage = auraSid ? (
    <AuraSurface
      asPage
      sessionId={auraSid}
      onClose={() => setAuraSid(null)}
      onNewThread={startNewAuraThread}
    />
  ) : tracePage && project.root ? (
    <TracePage
      // The shared place scope, not the open folder: Trace's own strip carries
      // a project switcher, and a switcher the surface under it ignores is
      // worse than none. Gated on `project.root` because Trace still needs a
      // repo open at all — `placeRoot` falls back to it.
      repoRoot={placeRoot || project.root}
      dest={tracePage}
      actions={traceActions}
      onDest={setTracePage}
      onClose={() => setTracePage(null)}
    />
  ) : place === "team" && project.root ? (
    // Takes the window bare because it mounts its OWN `PlacePage` — Team is
    // the one place whose rail and page share a `useTeamChat()` instance, so
    // the shell has to be inside the surface rather than around it. The result
    // on screen is the same as Pages and Tasks: the conversation list on the
    // right, at the same width, on the page's ground.
    <TeamSurface repoRoot={placeRoot} mode="full" />
  ) : place === "pages" && project.root ? (
    <PlacePage rail={<PagesSidebarMount repoRoot={placeRoot} />}>
      <PagesSurface repoRoot={placeRoot} />
    </PlacePage>
  ) : place === "tasks" && project.root ? (
    // One destination, four lenses, ONE rail — see tasks/TasksPlace. This
    // branch used to fork on which surface owned the lens and mount the rail
    // for only two of them, because the crew surface stood up a panel of its
    // own on the same edge. It doesn't any more, so the fork is gone with it.
    <TasksPlace
      repoRoot={project.root}
      lens={workLens}
      onLens={chooseWorkLens}
      onClose={() => setPlace(null)}
    />
  ) : wsOpen && project.root ? (
    <WorkspacesSurface
      asPage
      onClose={() => setWsOpen(false)}
      initialProjectId={wsFilter}
      activePath={project.root}
      worktreesByRoot={worktreesByRoot}
      badgeByPath={rosterBadges}
      onAddWorkspace={pickAndOpenFolder}
      onOpen={(p) => {
        if (p !== project.root)
          loadProjectAt(p).catch((e) => console.error("switch failed:", e));
      }}
      projects={(recents.length
        ? recents.filter((r) => !isManagedWorktree(r))
        : [project.root]
      ).map((root) => ({
        id: root,
        name: root.split("/").pop() || root,
        emoji: workspaceCustomization[root]?.emoji,
        letter: tileLetter(root),
        accent: accentForRoot(root),
      }))}
    />
  ) : null;

  // A page owns the window, so the chrome that frames a workpane comes off.
  //
  // The header names ONE repo and offers its branch, its review rail, its
  // terminal; the right rail lists that repo's files and changes. That frame
  // is right around a file you are editing and wrong around every page here,
  // in one of two ways.
  //
  // Aura, Workspaces and Mission Control are fleet-wide — they answer "what is
  // happening across every project" — so the frame is chrome about a different
  // subject, inviting you to read the fleet as if it belonged to the repo
  // named above it. Aura most of all: its conversation is stored unqualified
  // by repo and its tools sweep the whole registry, and it can be up with no
  // project at all, which is why it alone doesn't require `project.root`.
  //
  // Trace is the other way round. It IS about this repo — which is exactly the
  // problem: a header offering the branch and the review rail beside a page
  // whose whole subject is what happened to this repo and whether it holds up
  // is the same question asked twice, in two vocabularies, at two sizes.
  //
  // Nothing is written when the chrome comes off: `reviewOpen` is overridden
  // for the render, never set, so the rail comes back exactly as you left it.
  // The sidebar stays — it is the roster of every project plus the nav row you
  // used to get here, and that is navigation, not chrome.
  const pageOwnsWindow =
    !!auraSid ||
    (!!project.root && (wsOpen || !!tracePage || !!place));


  return (
    // Pointed at the PLACE root, not the open folder. Team's shell asserts that
    // the chat model it renders was built for the root it was handed — a model
    // for project A drawn as project B would file messages into the wrong repo
    // — and the place mount below hands it `placeRoot`. With the provider stuck
    // on the open folder, picking any other project in the Team rail's switcher
    // made those two disagree and the assertion threw: the switcher didn't
    // "not work", it took the whole surface down. One root, one model.
    <TeamChatProvider repoRoot={placeRoot} projectName={placeName}>
      {/* Feed the always-on-top floating HUD. Only the real main window
          publishes — a workspace popout also renders <App>, and two publishers
          would fight over the `hud:state` channel. Every detached window, not
          just the ones pinned to a local root: a popped-out machine renders the
          same <App>. */}
      {!isDetached && <HudPublisher projectRoot={project?.root ?? null} />}
      <Layout
        // PR / Tasks / Notes surfaces swap the sidebar contents for the
        // surface-specific list (Inbox / Tasks list / Pages list) — see
        // the `sidebar={...}` branch below. Visibility honours
        // `sidebarOpen` in every surface; SS.2 auto-collapses on detail-
        // tab-open under 1400px so the detail view gets the breathing
        // room, and the NavRail toggle (⌘B) always wins thereafter.
        sidebarOpen={sidebarOpen}
        reviewOpen={reviewOpen && !pageOwnsWindow}
        // ADE v2 runs the sidebar full-height to y=0 and hands it a header
        // zone (traffic-lights + nav + project switcher + search) so the
        // work-surface header starts right of the sidebar width.
        sidebarHeader={
          <SidebarHeader
              fullscreen={fullscreen}
              onBack={wsGoBack}
              onForward={wsGoForward}
              canBack={canWsBack}
              canForward={canWsForward}
              onToggleSidebar={() => setSidebarOpen((v) => !v)}
              onOpenPalette={() => setPaletteOpen(true)}
              onOpenSettings={() =>
                window.dispatchEvent(new CustomEvent("aura:open-settings"))
              }
            projectLabel={project.name}
          />
        }
        sidebar={
          <AdeSidebar
            activeSection={adeSection}
            // Clicking a destination goes to it. `adeSection` above is
            // derived from the focused pane, so without this the rail could
            // only ever REPORT where you were: clicking Team lit the row and
            // swapped the rail's list while the work surface kept showing
            // whatever was already there. Each of these opens the section's
            // home, and `adeSection` then comes back around agreeing.
            //
            // Build is absent on purpose — Aura / Workspaces / Mission
            // Control are its rows and each carries its own door.
            //
            // `leavePages` first, for the reason it documents: Aura,
            // Workspaces and Mission Control are full pages layered OVER the
            // workpane, so opening a channel underneath one of them lands a
            // tab you cannot see. Asking for somewhere else is leaving here.
            onNavigate={(s) => {
              if (s === "build") return;
              leavePages();
              if (s === "team") goPlace("team");
              else if (s === "plan") goPlace("pages");
              else if (s === "trace") goTrace({ kind: "sessions", view: "overview" });
            }}
            workspaceKey={project.root}
            // Only what Trace actually holds. This used to add
            // `conflictsCount` — merge conflicts in your working tree —
            // so the rail badged Trace with 5 and the section had no row
            // about any of them. Conflicts already have a home, and it is
            // not this one: the review header names them and the Changes
            // tab resolves them.
            traceCount={impactsCount}
            repoRoot={project?.root ?? ""}
            whatsNew={whatsNew?.note}
            onDismissWhatsNew={dismissWhatsNew}
            onWhatsNewCta={takeReleaseCta}
            buildRows={
              <BuildNav
                repoRoot={project.root}
                // The orchestrator's permanent door. `focusOrStartChat`
                // reopens the workspace's existing conversation and only
                // starts a new one when there is none — the row must not
                // spawn a fresh thread every time it is clicked.
                onOpenAura={focusOrStartChat}
                // Each row is a page, so the one you're standing in is the
                // one that's lit — and when you're standing in none of them
                // (a file, a terminal, an agent) none of them is. Workspaces
                // used to be the fallback, so the rail claimed you were on
                // the fleet page for the whole of an ordinary editing
                // session. A manager session still open as a workpane tab
                // (a project chat, a resumed thread) counts as Aura — the
                // user is in Aura either way.
                //
                // Full pages are tested FIRST. A manager session left open as
                // a workpane tab is a tab; Mission Control and Workspaces are
                // pages drawn OVER that tab. Testing `activeManagerId` before
                // them lit "Aura" while Mission Control's board filled the
                // screen — the rail naming a room you had already left, on the
                // strength of a tab nobody could see.
                activeRow={
                  auraSid
                    ? "aura"
                    : place === "tasks"
                      ? "work"
                      : wsOpen
                        ? "workspaces"
                        : editor.activeManagerId
                          ? "aura"
                          : null
                }
                onSelectWorkspaces={() => editor.closeAutomations(project.root)}
                // No `projectId` in the detail — the row heads the whole
                // roster, so its door opens on every project. The per-project
                // count chip inside the roster keeps its scoped deep-link.
                onOpenWorkspaces={() =>
                  window.dispatchEvent(new CustomEvent("aura:open-workspaces"))
                }
                // No lens in the detail: the row means "take me to the
                // work", and the work reopens on the drawing you left.
                onOpenWork={() => goToWork()}
              />
            }
            buildBody={
              // Your projects, in every section and on every page.
              //
              // This used to blank out on Aura, Workspaces and Mission
              // Control, on the reasoning that a page bringing its own left
              // column shouldn't have the roster stacked beside it. The
              // reasoning was right about the collision and wrong about the
              // fix: opening Mission Control made every project you have
              // disappear, so the one list that answers "what am I working
              // on" was missing from exactly the pages that span all of them.
              //
              // The collision is solved on the other axis instead — a page's
              // own panel opens on the RIGHT now, where the Changes and Files
              // rails open (see PlacePage, CrewWorkspace). Left edge: the
              // app. Right edge: this surface. Nothing has to be taken away.
              //
              // Build = workspace roster only, per the mockup. The file
              // tree + git changes live on the RIGHT rail (Files /
              // Changes tabs) — see the reviewPanel below. `ade-sec-fill`
              // makes it span the panel edges like Team/Plan; the `px-1.5`
              // re-adds the canonical 6px gutter so the nav + roster land
              // at the same 14px inset (and inset active pills) as
              // Trace/Tasks/Pages, not flush to the panel edge.
              <div className="ade-build ade-sec-fill px-1.5">
                {/* Aura / Workspaces / Mission Control are `buildRows` above
                    — they live in the sidebar's one nav list, not in a band
                    of their own here. The "Projects" break header + its
                    sort/new/fold-all controls live inside WorkspaceRoster,
                    co-located with the collapse + sort state they drive. */}

                {/* Who is working on what, ABOVE the roster. It went below
                    first, on the reasoning that projects are the subject and
                    people are the addition — and below a roster of eleven
                    projects and their worktrees it was off the bottom of a
                    scrolling column, which is the same as not shipping it.
                    Short volatile list on top, long stable list under it. It
                    folds to a single row while you are the only one here, so
                    the projects it sits above barely move. */}
                <PeopleRailMount repoRoot={project.root} />

                {/* The arrangements you built — two places in one window, and
                    the door back into each. It sits directly above the roster
                    because a club IS a place: the rail lists everywhere the
                    window can stand, and the rows you clubbed are two of them.
                    The pick that makes one runs over the roster's own rows
                    below (see lib/clubGesture), so the gesture and its result
                    are one list apart. */}
                <ClubRailMount
                  onEnter={enterClubById}
                  onLeave={leaveActiveClub}
                />

                <WorkspaceRoster
                  workspaces={(recents.length
                    ? recents.filter((r) => !isManagedWorktree(r))
                    : [project.root]
                  ).map((root) => ({
                    id: root,
                    letter: tileLetter(root),
                    emoji: workspaceCustomization[root]?.emoji,
                    active: !clubState.activeClubId && root === project.root,
                    accent: accentForRoot(root),
                    worktrees: worktreesByRoot[root] ?? [],
                  }))}
                  activePath={project.root}
                  badgeByPath={rosterBadges}
                  onAddProject={pickAndOpenFolder}
                  onOpenAllCopies={(projectId) =>
                    window.dispatchEvent(
                      new CustomEvent("aura:open-workspaces", {
                        detail: { projectId },
                      }),
                    )
                  }
                  onSelectProject={(id) => {
                    if (clubState.activeClubId) {
                      editor.exitClub(id);
                      setActiveClub(null);
                    }
                    goToProject(id);
                  }}
                  onOpenWorktree={(p) => goToProject(p)}
                  onCloseProject={(id) => {
                    // Same as the legacy rail's onCloseWorkspace: drop
                    // the project from recents (non-destructive — the
                    // checkout stays on disk) and fall back to another
                    // open workspace if we just closed the active one.
                    setRecents((prev) => {
                      const next = prev.filter((r) => r !== id);
                      try {
                        localStorage.setItem(
                          "aura.recents",
                          JSON.stringify(next),
                        );
                      } catch {
                        /* ignore quota errors */
                      }
                      return next;
                    });
                    // Closing is the one action that still wipes: drop the
                    // project's LIVE state so re-opening it rebuilds from its
                    // snapshot instead of handing back a session the user
                    // said they were done with. (Switching never wipes — see
                    // editorStore.switchWorkspace.) Done AFTER the fallback
                    // switch, because that switch parks whatever place it is
                    // leaving — including this one.
                    if (id === project.root && recents.length > 1) {
                      const fallback = recents.find((r) => r !== id);
                      if (fallback) {
                        loadProjectAt(fallback)
                          .catch((e) => console.error("switch failed:", e))
                          .finally(() => editorRef.current.closeWorkspace(id));
                      } else {
                        editor.closeWorkspace(id);
                      }
                    } else {
                      editor.closeWorkspace(id);
                    }
                  }}
                  onRemoveWorktree={async (root, path) => {
                    // Destructive — deletes the managed worktree checkout
                    // on disk via `worktree_remove_managed`. Confirm, then
                    // re-fetch the root's worktree list so the row drops.
                    const ok = await askConfirm({
                      title: "Remove this worktree?",
                      body: `${path}\n\nThe checkout is deleted from disk. Commits on its branch that you haven't merged are NOT removed.`,
                      confirmLabel: "Remove",
                      tone: "danger",
                    });
                    if (!ok) return;
                    api
                      .worktreeRemoveManaged(root, path)
                      .then(() => api.gitWorktreeList(root))
                      .then((list) =>
                        setWorktreesByRoot((prev) => ({
                          ...prev,
                          [root]: list,
                        })),
                      )
                      .catch((e) => {
                        console.error("worktree remove failed:", e);
                        void askNotice({
                          title: "Could not remove this worktree",
                          body: String(e),
                        });
                      });
                  }}
                />
              </div>
            }
            /* No team / plan / trace body. The rail under the nav is the
                project roster and only ever that.

                Each of the other three used to hand it a body of its own —
                Team its conversation list, Pages its document list, Trace a
                232px column of ten destinations — so the widest column on
                screen changed its subject every time you changed destination,
                and your projects were reachable from exactly one of the four.
                All three navigate from their own page now: Trace's switcher
                is WorkSurface's TraceTabs, Team opens `mode="full"` with its
                conversation list as its first column, and PagesSurface mounts
                the same `PagesSidebarMount` as its own. A page's navigation
                belongs to the page; the rail belongs to the app. */
          />
        }
        // Only so the shell knows whether the macOS traffic lights need a bare
        // drag strip of their own: a page that paints its own header has no
        // gutter for them, a tab-bearing surface reserves one itself. The work
        // column has no chrome band any more — the pane toggles ride in the tab
        // row (see `chromeTrailing` on WorkSurface below).
        pageOwnsWindow={pageOwnsWindow}
        bottomPane={
          <TerminalPanel
            repoRoot={project.root}
            maximized={terminalMaximized}
            onToggleMaximize={() => setTerminalMaximized((v) => !v)}
            onClosePanel={() => {
              setTerminalMaximized(false);
              editor.setTerminalPanelOpen(false);
            }}
          />
        }
        bottomPaneOpen={terminalOpen}
        bottomPaneMaximized={terminalMaximized}
        reviewHeader={
          <ReviewStateHeader
            repoRoot={project.root}
            conflictsCount={conflictsCount}
            onGoToChanges={() => setRightRailTab("changes")}
          />
        }
        reviewPanel={
          <RightRail
            activeTab={rightRailTab}
            onChangeTab={setRightRailTab}
            filesView={
              <FilesSidebar
                repoRoot={project.root}
                selected={editor.activePath}
                onSelect={(p) =>
                  editor.open(p).catch((e) => console.error("open failed:", e))
                }
                onSelectSplit={(p, direction) =>
                  editor
                    .openFileSplit(p, direction)
                    .catch((e) => console.error("open split failed:", e))
                }
              />
            }
            changesView={
              <GitSidebar
                repoRoot={project.root}
                onOpen={(p, mode) => {
                  if (mode === "diff-new-tab") {
                    editor
                      .openFileSplit(p, "row")
                      .catch((e) => console.error("open split failed:", e));
                    return;
                  }
                  editor
                    .open(p, {
                      defaultView: mode === "edit" ? "edit" : "diff",
                    })
                    .catch((e) => console.error("open failed:", e));
                }}
                onBeforeCommit={guardCommit}
              />
            }
            checksView={
              <ChecksPanel
                repoRoot={project.root}
                conflictsCount={conflictsCount}
                onGoToChanges={() => setRightRailTab("changes")}
              />
            }
            commonsView={
              COMMONS_ENABLED ? (
                <CommonsRailPanel
                  repoRoot={project.root}
                  onExpand={() => editor.openCommons(project.root)}
                />
              ) : undefined
            }
            scribbleView={<ScribblePanel repoRoot={project.root} />}
            browserView={BROWSER_RAIL_ENABLED ? <RailBrowser /> : undefined}
            changesCount={diffStats?.changed_files}
            pluginPanels={pluginPanelDescriptors}
          />
        }
        statusBar={
          <StatusBar
            repoRoot={project.root}
            sidebarOpen={sidebarOpen}
            changedFiles={diffStats?.changed_files ?? null}
            auditUnacked={auditUnacked}
            conflictsOpen={astConflictsOpen}
            onClickDiff={() => {
              // The changes chip is a navigation, not a popup: open the
              // Review changes page (the semantic diff / verdict surface)
              // and poke the Changes panel so it focuses the working set.
              window.dispatchEvent(new CustomEvent("aura:focus-changes"));
              goTrace({ kind: "tool", tool: "review" });
            }}
            onClickAudit={() => {
              // The accountability feed — every AI change on the team, who
              // made it, why, and whether it's sealed. That's Trace's team
              // view; it used to be a filter on the sidebar's History body.
              goTrace({ kind: "sessions", view: "team" });
            }}
            onClickConflicts={() => setConflictsOpen(true)}
            cliVersion={cliVersion}
            onRefreshCliVersion={refreshCliVersion}
            onUpdateCli={updateCli}
            pluginPills={pluginPillEntries.map((p) => ({
              pluginId: p.pluginId,
              id: p.id,
              render: p.render,
            }))}
            onClickPluginPill={(pluginId, pillId) => {
              dispatchPluginPillClick(pluginId, pillId);
              window.dispatchEvent(
                new CustomEvent("aura:plugin-pill-click", {
                  detail: { pluginId, pillId },
                }),
              );
            }}
            trailing={
              // ADE chrome — the footer's trailing edge now carries only the
              // two self-hiding status pills (Capture-off nudge + Strict). The
              // ex-TopBar utility cluster (resource monitor, impact bell,
              // mobile-remote, ⋮ overflow) was pulled out of the footer face:
              // the monitor lives in Project health, impacts have the loud
              // banner + trace row, mobile-remote is on ⌘K, and every overflow
              // item duplicates a Trace sidebar row.
              <StatusPills
                  repoRoot={project.root}
                  onFocusChat={focusOrStartChat}
                  onOpenGit={() => setSourceControlOpen(true)}
                  onOpenSettings={() => setSettingsOpen(true)}
                  onOpenStrict={() => {
                    // Strict is a major feature — deep-link to the
                    // Security & Policy page (its real home), not a
                    // random settings pane.
                    window.dispatchEvent(
                      new CustomEvent("aura:open-settings", {
                        detail: { pane: "policy" },
                      }),
                    );
                    setSettingsOpen(true);
                  }}
                  onOpenCapture={() => {
                    // Deep-link to the Capture pane — one button there
                    // installs the no-MCP git hooks for this repo.
                    window.dispatchEvent(
                      new CustomEvent("aura:open-settings", {
                        detail: { pane: "capture" },
                      }),
                    );
                    setSettingsOpen(true);
                  }}
              />
            }
          />
        }
        body={
          // Flex-col wrapper so the banners take their
          // natural heights and WorkSurface consumes the remaining
          // space cleanly. Without this column, WorkSurface's h-full
          // resolved against the body slot's full height regardless of
          // the banner stack above it, so the bottom of WorkSurface
          // (including PlanTab's Build/Cancel bar) got clipped under
          // the global status bar.
          <div className="flex flex-col h-full min-h-0 overflow-hidden">
            <UpdateBanner />
            {/* Auto-update needs a writable install location. That's false in
                three cases the user can fix by moving Aura to Applications:
                a read-only mounted DMG (`/Volumes/…` — issue #7), a Gatekeeper
                App-Translocation quarantine path, or any other read-only spot.
                Keying on `!writable` (not just `translocated`) covers all three;
                the message is tailored to whichever it is. */}
            {appLocation?.bundle_path &&
              appLocation.writable === false &&
              !translocationBannerDismissed &&
              (() => {
                const onDmg = appLocation.bundle_path.startsWith("/Volumes/");
                return (
                  <div className="px-3 py-2 bg-amber-500/15 border-b border-amber-500/30 text-sm text-amber-200 flex items-center gap-3">
                    <span className="font-medium">
                      {onDmg
                        ? "Aura is running from the disk image. Updates won’t install."
                        : "Auto-update disabled: app is running from a read-only quarantine."}
                    </span>
                    <span className="text-amber-300/80 font-mono text-xs truncate">
                      {appLocation.bundle_path}
                    </span>
                    <div className="flex-1" />
                    <span className="text-amber-200/80">
                      {onDmg
                        ? "Drag Aura into your Applications folder, then open it from there."
                        : "Move Aura.app into ~/Applications to re-enable auto-update."}
                    </span>
                    <button
                      type="button"
                      className="text-xs text-amber-200 hover:text-amber-100 px-1.5 py-0.5 rounded hover:bg-amber-500/20"
                      onClick={() => setTranslocationBannerDismissed(true)}
                    >
                      ×
                    </button>
                  </div>
                );
              })()}
            <Toaster />
            <CrashRecoveryToast />
            <PluginToastHost />
            <HuddleErrorToast />
            <RecordingNotice />
            <TelemetryConsent />
            {mobileWaitlistOpen && (
              <MobileWaitlistDialog
                onClose={() => setMobileWaitlistOpen(false)}
              />
            )}
            <GetStartedTour open={tourOpen} onClose={closeTour} />
            <CliUpdateToast onInstalled={(check) => setCliVersion(check)} />
            <AuraImpactsBanner
              repoRoot={project.root}
              // Same door the topbar's impact inbox uses, so there's one
              // impacts surface rather than one per entrance.
              onOpenImpacts={() => goTrace({ kind: "tool", tool: "impacts" })}
              dismissedIds={dismissedImpactIds}
              onDismiss={(id) =>
                setDismissedImpactIds((prev) => {
                  const next = new Set(prev);
                  next.add(id);
                  return next;
                })
              }
            />
            {/* The strip can now replace an out-of-date `aura` helper itself.
                When it does, the footer chip must stop describing the copy
                that no longer exists — same state, updated from either door. */}
            <AuraTrackingNotice
              repoRoot={project.root}
              onCliUpdated={(check) => setCliVersion(check)}
            />
            <AgentMutationGuard repoRoot={project.root} />
            {/* The work area, and the destinations that cover it.
                Workspaces / Aura / Mission Control are PAGES: they fill this
                region beside a live sidebar instead of floating above the shell
                behind a dim backdrop. They're layered over WorkSurface rather
                than swapped for it so open terminals and agent PTYs stay
                mounted underneath — leaving a page puts you straight back into
                the work you left, mid-stream. (Wizards that genuinely
                interrupt — the PR flow, session/task detail — stay modal.) */}
            <div className="relative flex-1 min-h-0 overflow-hidden">
              {/* Renders nothing — it keeps each open Aura conversation's tab
                  named after what the conversation is about. Mounted here
                  rather than inside a tab strip because there are two strips
                  (the global one, and the per-pane one that replaces it while
                  a split is active) and the naming belongs to neither. */}
              {editor.managerTabs.length > 0 && (
                <ManagerTabTitles tabs={editor.managerTabs} />
              )}
              <WorkSurface
                repoRoot={project.root}
                projectName={project.name}
                strictMode={strictMode}
                traceActions={traceActions}
                // Window chrome rides in the tab row. It used to have a 30px
                // band of its own directly above it, holding these two icons
                // and nothing else across the whole width of the work column
                // — a second header whose only content was already in the
                // same corner as the tab strip's.
                chromeLeading={
                  <SidebarPeek
                    sidebarOpen={sidebarOpen}
                    onToggleSidebar={() => setSidebarOpen((v) => !v)}
                  />
                }
                chromeTrailing={
                  <PaneToggles
                    reviewOpen={reviewOpen}
                    terminalOpen={terminalOpen}
                    onToggleReview={() => setReviewOpen((v) => !v)}
                    onToggleTerminal={() => editor.toggleTerminalPanel()}
                  />
                }
                onOpenRewind={(filePath?: string) =>
                  goTrace({
                    kind: "tool",
                    tool: "rewind",
                    arg: filePath ? { file: filePath } : undefined,
                  })
                }
                onLogIntent={(filePath?: string) => {
                  // Scope "Add a reason" to the file the user clicked in the
                  // insight strip (per-file reasoning, AURA-131) — pre-select
                  // just that path instead of every dirty file. defaultPaths are
                  // repo-relative to match the dialog's git-status entries;
                  // WorkSurface hands us the absolute path. onClose clears the
                  // default, so other openers stay unscoped.
                  const rel =
                    filePath && filePath.startsWith(project.root + "/")
                      ? filePath.slice(project.root.length + 1)
                      : filePath;
                  setLogIntentDefaultPaths(rel ? [rel] : undefined);
                  setLogIntentOpen(true);
                }}
                onSnapshot={() => setSnapshotOpen(true)}
              />
              {activePage && (
                <div className="absolute inset-0 z-20 overflow-hidden bg-bg-content">
                  {activePage}
                </div>
              )}
              {/* The machine you are standing in, over everything above —
                  including whichever page you opened it from, which is exactly
                  what lets leaving hand that page straight back.

                  Only the focused one is mounted. Its shells are not lost by
                  that: a remote tab is a persistent Terminal session keyed by
                  machine + session id, so it survives the unmount and is
                  re-attached on the way back in — `releaseTerminalSession` is
                  called when you close a tab, and nowhere else. What a blurred
                  place keeps is its entry; what a left place gives up is its
                  slot in the set. */}
              {remoteEntry && (
                <div
                  key={remotePlaces.focusedKey ?? "remote"}
                  className="absolute inset-0 z-30 overflow-hidden bg-bg-content"
                >
                  <RemoteWorkspace
                    entry={remoteEntry}
                    onClose={() => {
                      const key = remotePlaces.focusedKey;
                      if (!key) return;
                      setRemotePlaces((cur) => leaveRemotePlace(cur, key));
                    }}
                  />
                </div>
              )}
            </div>
          </div>
        }
        composer={null}
      />
      {/* PR detail — app-level fullscreen surface (covers the squeezed ADE v2
          center when both sidebars are open). Mounted before the dialog stack
          so dialogs / the agent gate stack above it. */}
      {editor.activePrDetail && (
        <PRDetailPane
          onClose={editor.closePrDetail}
          onDetach={() => {
            const s = editor.selectedPr;
            if (s) {
              openPopout({
                kind: "pr",
                root: s.repoRoot,
                prNumber: s.number,
                title: `PR #${s.number}`,
              });
            }
          }}
        />
      )}
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onPick={onPalettePick}
        repoRoot={project.root}
        recentFiles={editor.files.map((f) => ({ path: f.path, name: f.name }))}
        agents={discoveredAgents
          .filter((a) => a.available)
          .map((a) => ({ id: a.id, label: a.label, available: a.available }))}
      />
      <ShortcutsDialog
        open={shortcutsOpen}
        onClose={() => setShortcutsOpen(false)}
      />
      <OpLogDialog
        open={opLogOpen}
        repoRoot={project.root}
        onClose={() => setOpLogOpen(false)}
      />
      <ConflictsDialog
        open={conflictsOpen}
        repoRoot={project.root}
        onClose={() => setConflictsOpen(false)}
      />
      <CompareWorktreesDialog
        open={compareOpen}
        repoRoot={project.root}
        onClose={() => setCompareOpen(false)}
      />
      <LogIntentDialog
        open={logIntentOpen}
        repoRoot={project.root}
        defaultText={logIntentPrefill}
        source={logIntentSource}
        defaultPaths={logIntentDefaultPaths}
        onClose={() => {
          setLogIntentOpen(false);
          setLogIntentPrefill(undefined);
          setLogIntentSource(undefined);
          setLogIntentDefaultPaths(undefined);
        }}
      />
      <IntentSplitMergeDialog
        open={intentEditTs !== null}
        repoRoot={project.root}
        intentTs={intentEditTs}
        onClose={() => setIntentEditTs(null)}
      />
      <IntentVerificationDialog
        open={intentGuard.open}
        verdict={intentGuard.verdict}
        tests={intentGuard.tests}
        busy={intentGuard.busy}
        onClose={() => {
          intentGuard.resolve?.(false);
          setIntentGuard({ open: false, verdict: null, tests: null, busy: null, resolve: null });
        }}
        onRestore={async (symbol) => {
          // Put the one function back and let the gate decide again. If it
          // still objects — a second removal, say — the dialog stays open on
          // the new verdict rather than waving the commit through because
          // something was repaired.
          setIntentGuard((g) => ({ ...g, busy: `Putting ${symbol}() back…` }));
          try {
            const res = await api.restoreDeletedSymbol(project.root, symbol);
            if (res.verdict.passed) {
              intentGuard.resolve?.(true);
              setIntentGuard({ open: false, verdict: null, tests: null, busy: null, resolve: null });
            } else {
              setIntentGuard((g) => ({ ...g, verdict: res.verdict, busy: null }));
            }
          } catch (e) {
            console.error("restore failed:", e);
            setIntentGuard((g) => ({ ...g, busy: null }));
          }
        }}
        onApproveRemoval={async (symbol) => {
          // Widening the contract is a decision, and it is recorded as one.
          // That is the difference between this and skipping the hook.
          setIntentGuard((g) => ({ ...g, busy: "Recording the decision…" }));
          try {
            const verdict = await api.approveSymbolRemoval(project.root, symbol);
            if (verdict.passed) {
              intentGuard.resolve?.(true);
              setIntentGuard({ open: false, verdict: null, tests: null, busy: null, resolve: null });
            } else {
              setIntentGuard((g) => ({ ...g, verdict, busy: null }));
            }
          } catch (e) {
            console.error("amend failed:", e);
            setIntentGuard((g) => ({ ...g, busy: null }));
          }
        }}
      />
      <StrictCommitDialog
        open={strictGuard.open}
        readiness={strictGuard.readiness}
        onClose={() => {
          strictGuard.resolve?.(false);
          setStrictGuard({ open: false, readiness: null, resolve: null });
        }}
        onContinue={() => {
          strictGuard.resolve?.(true);
          setStrictGuard({ open: false, readiness: null, resolve: null });
        }}
        onOpenLogIntent={() => {
          // Abort the commit (user is going to log intent first), then
          // pop the LogIntentDialog with the unpaired files prefilled
          // so they only have to type the *why*.
          strictGuard.resolve?.(false);
          const files = strictGuard.readiness?.files ?? [];
          const prefill = files.length
            ? `Edited ${files.map((f) => f.split("/").pop()).join(", ")}: `
            : "";
          setStrictGuard({ open: false, readiness: null, resolve: null });
          setLogIntentPrefill(prefill);
          setLogIntentOpen(true);
        }}
      />
      <SnapshotDialog
        open={snapshotOpen}
        repoRoot={project.root}
        onClose={() => setSnapshotOpen(false)}
      />
      <PrAuthoringDialogHost />
      <SettingsDialog
        open={settingsOpen}
        repoRoot={project.root}
        openRoots={recents}
        onClose={() => setSettingsOpen(false)}
      />
      {timeMachine && project.root && (
        <TimeMachineWizard
          repoRoot={project.root}
          defaultIdentifier={timeMachine.identifier}
          defaultFile={timeMachine.file}
          onClose={() => setTimeMachine(null)}
        />
      )}
      {timelineOpen && project.root && (
        <TimelineWizard
          repoRoot={project.root}
          onClose={() => setTimelineOpen(false)}
        />
      )}
      {checksOpen && project.root && (
        <ChecksPane
          repoRoot={project.root}
          onClose={() => setChecksOpen(false)}
        />
      )}
      {sourceControlOpen && project.root && (
        <GitView
          repoRoot={project.root}
          onClose={() => setSourceControlOpen(false)}
          onBeforeCommit={guardCommit}
        />
      )}
      {signInOpen && <SignInWizard onClose={() => setSignInOpen(false)} />}
      {agentCustomizeOpen && project.root && (
        <AgentCustomizations
          repoRoot={project.root}
          initialView={agentCustomizeView}
          onClose={() => setAgentCustomizeOpen(false)}
        />
      )}
      {/* Mission Control, Aura and Workspaces used to be mounted here, in the
          modal stack. They're pages now — see the content area above. */}
      {/* Picked a folder that isn't tracked yet — set it up, then open it.
          Cancelling leaves the current project alone rather than dropping the
          user into a shell that can't do anything. */}
      {publishGateDir && (
        <PublishRepoDialog
          dir={publishGateDir}
          onClose={() => setPublishGateDir(null)}
          onPublished={() => {
            const dir = publishGateDir;
            setPublishGateDir(null);
            loadProjectAt(dir).catch((e) =>
              console.error("open after setup failed:", e),
            );
          }}
        />
      )}
      <SearchWorkpane
        open={searchOpen}
        repoRoot={project.root}
        onClose={() => setSearchOpen(false)}
      />
      <ShareCodeDialog repoRoot={project.root} />
      <ChannelNotesPanel repoRoot={project.root} />
      {ONBOARDING_V2 ? <OnboardingFlow /> : <OnboardingDialog />}
      {/* Global host for Aura's destructive-op gate. Catches the bare
          `agent-gate-request` event for every session and overlays a
          single blocking Allow/Deny card. Mounted once, here, so it sits
          above everything and there's exactly one gate surface. */}
      <AgentGateHost />
      {/* A proposed plan opens here as a proper fullscreen wizard overlay
          (Document / Tasks tabs + Build cluster), not a workpane tab.
          Mounted once; renders nothing until openPlanWizard() fires from
          the chat surface. */}
      <PlanWizardHost />
      {/* Audio-only "huddle" overlay. Owns its own open/close state —
          listens for `aura:start-huddle` events dispatched by
          CommsPanel and renders a floating top-right panel while a
          call is live. Mounted once so the call survives right-rail
          collapses and repo swaps. */}
      <CallPanel />
      <ScreenshareFloating />
      {/* Conductor-style "start new work in an isolated copy" composer.
          Mounted once, self-manages open/close; any affordance opens it via
          window CustomEvent("aura:new-workspace", { detail: { repoRoot } }). */}
      <WorkspaceCreateComposer />
      <KnowledgeDialog
        open={knowledgeOpen}
        repoRoot={project.root}
        onClose={() => setKnowledgeOpen(false)}
      />
      <ResumeDialog
        open={resumeOpen}
        channel={streamChannel("claude", project.root)}
        repoRoot={project.root}
        onClose={() => setResumeOpen(false)}
        onResumed={() => {
          // Spawn/focus a PTY tab; the resumed session id is passed
          // through via runAgentPrompt's pty path so claude continues
          // the conversation natively in xterm instead of via the
          // legacy stream-json bubble surface.
          runAgentPrompt("claude", "Claude", "", "pty");
        }}
      />
      <OutputDialog
        open={output.open}
        title={output.title}
        body={output.body}
        loading={output.loading}
        error={output.error}
        onClose={() => setOutput((s) => ({ ...s, open: false }))}
      />
      <AskDialog
        open={askOpen}
        repoRoot={project.root}
        initialQuery={askPrefill}
        onClose={() => {
          setAskOpen(false);
          setAskPrefill(undefined);
        }}
      />
      <RemoteDialog
        open={remoteOpen}
        onClose={() => setRemoteOpen(false)}
      />
      <PairPhoneDialog
        open={pairPhoneOpen}
        onClose={() => setPairPhoneOpen(false)}
      />
      <ManagerLauncher
        open={managerLauncherOpen}
        onClose={() => setManagerLauncherOpen(false)}
        defaultProjectRoot={project.root}
        onLaunched={(sid) => {
          focusAmbientManager(project.root, sid);
        }}
      />
    </TeamChatProvider>
  );
}

function formatAge(secs: number): string {
  // One ladder for the whole app — see lib/relativeTime.
  return relativeAgeFromDelta(secs);
}

function isReviewableGitPath(path: string): boolean {
  return !/[{}*]/.test(path) && !path.endsWith("/");
}

// Managed agent/sibling worktrees live under
// `<repo>/.{claude,gemini,aura}/worktrees/<name>` — they're machine-created
// checkouts (e.g. an orchestrator spawning an agent in its own branch), not
// workspaces the user opened. They belong in the parent workspace's worktree
// list (the roster nests them there), never as their own top-level tile.
// Surfacing one as a standalone workspace is what made a spawned
// `agent-a40050d3` checkout masquerade as a workspace the user never created.
// Filter these everywhere recents/roster/projects are built.
function isManagedWorktree(root: string): boolean {
  return /\/\.(claude|gemini|aura)\/worktrees\//.test(root);
}

export default App;

/** Opening a project. Aura reads the repo, restores the workspace and hydrates
 *  the tab tree before it can draw anything, and on a large repo that is a
 *  second or two of blank window. Says what is happening, with the one loader
 *  the rest of the app uses. */
function BootLoading() {
  return (
    <div className="h-screen w-screen bg-bg-deep flex flex-col items-center justify-center gap-2.5">
      <div className="flex items-center gap-2 text-sm text-text-2">
        <AsciiSpinner />
        Opening your project
      </div>
      <div className="text-xs text-text-4">Reading the repo and restoring your tabs.</div>
    </div>
  );
}

/** Boot failed. This is the whole app — there is no shell to fall back into,
 *  no sidebar, no menu — so the screen has to carry the recovery itself. The
 *  raw error stays, because on this screen it is the only thing that can tell
 *  anyone (including us, in a bug report) what actually went wrong; it just
 *  no longer arrives as the entire message. */
function BootFailed({ detail }: { detail: string }) {
  return (
    <div className="h-screen w-screen bg-bg-deep flex items-center justify-center px-6">
      <div className="w-full max-w-[420px] flex flex-col gap-3">
        <div className="text-base text-text-1">Aura could not open your project</div>
        <div className="text-xs text-text-3 leading-relaxed">
          Nothing has been changed on disk. This usually means the folder moved
          or was renamed since you last had it open.
        </div>
        <div className="rounded-lg border border-line-soft bg-bg-1 px-3 py-2 font-mono text-2xs text-text-4 break-words">
          {detail}
        </div>
        <div className="flex items-center gap-2 pt-0.5">
          <Button size="sm" onClick={() => window.location.reload()}>
            Try again
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={async () => {
              // Boot resolves its root from `aura.lastWorkspace` before
              // anything else, so pointing that at a folder the user can
              // actually reach and reloading is the whole recovery — the
              // normal boot path then runs against it. Dismissing the picker
              // leaves this screen exactly as it was.
              try {
                const { pickPath } = await import("./lib/nativeDialog");
                const picked = await pickPath({ directory: true, multiple: false });
                if (typeof picked !== "string" || !picked) return;
                localStorage.setItem("aura.lastWorkspace", picked);
              } catch (e) {
                console.error("open folder failed:", e);
                return;
              }
              window.location.reload();
            }}
          >
            Open a different folder
          </Button>
        </div>
      </div>
    </div>
  );
}
