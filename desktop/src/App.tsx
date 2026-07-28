// W2 wiring — composes the superset-style 3-column shell out of the
// pieces we just built: NavRail | FileTree sidebar | TopBar over a body
// that defaults to EmptyState (no file open) with a Composer pinned to
// the bottom of the work surface.
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
import { ScreenshareFloating } from "./components/chat/ScreenshareFloating";
import { WorkspaceCreateComposer } from "./components/workspace/WorkspaceCreateComposer";
import { WorkspaceRail, accentForRoot, type WorktreeRef } from "./components/WorkspaceRail";
import { WorkspaceRoster } from "./components/WorkspaceRoster";
import { BuildNav } from "./components/BuildNav";
import { useWorktreeBadges } from "./lib/useWorktreeBadges";
import { useChatNotifier } from "./lib/useChatNotifier";
import { openPopout } from "./lib/popout";
import { onIdle } from "./lib/idle";
import { installInAppFileDropRouter, installOsFileDropRouter } from "./lib/osFileDrop";
import { AdeSidebar, TraceBody, type AdeSection } from "./components/AdeSidebar";
import { useWorkspaceCustomization } from "./lib/workspaceCustomization";
import {
  NavRail,
  type PluginRailTile,
  type SidebarTabId,
} from "./components/NavRail";
import {
  pluginRailTiles,
  pluginRightRailPanels,
  pluginStatusPills,
  usePluginContributes,
} from "./lib/pluginContributesStore";
import { TopBar } from "./components/TopBar";
import { StatusPills } from "./components/topbar/StatusPills";
import { ProjectHeader } from "./components/ProjectHeader";
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
  dispatchPluginTileClick,
} from "./lib/pluginRuntime";
import { PluginToastHost } from "./components/PluginToastHost";
import { HuddleErrorToast } from "./components/HuddleErrorToast";
import { RecordingNotice } from "./components/RecordingNotice";
import { TelemetryConsent } from "./components/TelemetryConsent";
import { WhatsNewModal } from "./components/WhatsNewModal";
import { MobileWaitlistDialog } from "./components/mobile/MobileWaitlistDialog";
import { GetStartedTour } from "./components/tour/GetStartedTour";
import { markTourSeen } from "./lib/tour/tourState";
import {
  markWhatsNewSeen,
  pendingWhatsNew,
  type ReleaseCta,
  type WhatsNewPending,
} from "./lib/releaseNotes";
import { trackFeature } from "./lib/track";
import { autoEnableCapture } from "./lib/autoCapture";
import { WorkSurface } from "./components/WorkSurface";
import { PRDetailPane } from "./components/workpanes/PRDetailPane";
import { PresetsBar } from "./components/PresetsBar";
import { useAgents } from "./lib/agents";
import { TerminalPanel } from "./components/terminal/TerminalPanel";
import { TeamSurface } from "./components/team/TeamSurface";
import { TeamChatProvider } from "./components/team/application/TeamChatContext";
import { SidebarHeader } from "./components/SidebarHeader";
import { AccountMenu } from "./components/account/AccountMenu";
import { humanizeWorkspaceName, isWorktreeRoot } from "./lib/workspaceLabel";
import { CallPanel } from "./components/chat/CallPanel";
import {
  RightRail,
  type RightRailTab,
  type PluginRightRailPanelDescriptor,
} from "./components/rightrail/RightRail";
import { AuraRailPanel } from "./components/rightrail/AuraRailPanel";
import { ReviewStateHeader } from "./components/rightrail/ReviewStateHeader";
import { ChecksPanel } from "./components/rightrail/ChecksPanel";
import { ScribblePanel } from "./components/rightrail/scribble/ScribblePanel";
import { type ActiveAgentSession } from "./components/rightrail/createPrRouting";
import { EditViewPanel } from "./components/rightrail/EditViewPanel";
import { TasksSidebarPanel } from "./components/rightrail/TasksSidebarPanel";
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
import { CrewSurface } from "./components/commons/crew/CrewSurface";
import { WorkspacesSurface } from "./components/workspaces/WorkspacesSurface";
import { PublishRepoDialog } from "./components/workpanes/workspaces/PublishRepoDialog";
import { SearchWorkpane } from "./components/SearchWorkpane";
import { ShareCodeDialog } from "./components/ShareCodeDialog";
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
import { checkStrictModeReadiness } from "./lib/strictModeGate";
import {
  FilesSidebar,
  GitSidebar,
  HistorySidebar,
  type HistoryEvent,
} from "./components/sidebars";
import { InboxSidebar } from "./components/workpanes/InboxPane";
import { CommonsRailPanel } from "./components/rightrail/CommonsRailPanel";
import { TasksSidebar } from "./components/workpanes/TasksSidebar";
import { PagesSidebarMount } from "./components/pages/PagesSidebar";
import { useEditorStore, armWorkspaceSnapshots, readPersistedAgents, readPersistedManagers, pendingFilePaths, pendingFilePathsForClub, openFileImperative, treeLeafNodes, openBrowserTab, workspaceUnreadCount, activeWorkSurface } from "./lib/editorStore";
import { sectionForRef } from "./lib/paneSection";
import {
  getClubState,
  subscribeClub,
  clubWith,
  removeFromClub,
  dissolveClub,
  setClubActive,
} from "./lib/workspaceClubStore";
import {
  focusAmbientManager,
  FOCUS_MANAGER_EVENT,
  sendToAmbientManager,
} from "./lib/focusManager";
import { safetyCheckPrompt, proveGoalsPrompt } from "./lib/worktreeActions";
import { sendAmbientManagerTurn } from "./lib/managerTurn";
import { HudPublisher } from "./lib/hudPublisher";
import { onHudSelectProject, onHudSend } from "./lib/hud";
import { AURA_MANAGER_ENABLED, COMMONS_ENABLED, ONBOARDING_V2 } from "./lib/featureFlags";
import { useAppActions, type AppActionId } from "./lib/keymap";
import { findSlash } from "./lib/slashCommands";
import {
  api,
  type DiffStats,
  type ImpactAlert,
  type IntentVerdict,
  type StrictModeInfo,
  type UsageSummary,
  type ZoneRule,
} from "./lib/api";
import { fetchPrList } from "./lib/prsCache";
import { useApplyThemeClass, useAdeV2 } from "./lib/themeStore";
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
import { UnattributedChangesBanner } from "./components/UnattributedChangesBanner";
import { AuraTrackingNotice } from "./components/AuraTrackingNotice";
import { CrashRecoveryToast } from "./components/CrashRecoveryToast";
import { CliUpdateToast } from "./components/CliUpdateToast";
import { Toaster } from "./components/Toaster";
import { ImpactInbox } from "./components/ImpactInbox";
import { UpdateBanner } from "./components/UpdateBanner";
import { useDocumentVisibility } from "./lib/useDocumentVisibility";

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


type AppProps = {
  /** Set in a detached "workspace" popout window — the App boots pinned to
   *  THIS repo root instead of the persisted `aura.lastWorkspace`, and never
   *  writes `aura.lastWorkspace` itself, so a second window onto another
   *  project doesn't move the main window's last-workspace pointer. Undefined
   *  in the main window. */
  bootRootOverride?: string;
};

function App({ bootRootOverride }: AppProps = {}) {
  // True while this is a detached whole-workspace window (popout=workspace).
  // Held in a ref so the []-dep boot effect can read it without re-running.
  const bootRootOverrideRef = useRef<string | undefined>(bootRootOverride);
  bootRootOverrideRef.current = bootRootOverride;
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
  const sidebarPrevRef = useRef<boolean | null>(null);
  const reviewPrevRef = useRef<boolean | null>(null);
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
    // ADE — the file tree + git changes home on the right rail, so the
    // "files"/"changes" tabs only exist (and only restore) when the
    // redesign flag is on; ADE also defaults to Files instead of Aura.
    const ade = (() => {
      try {
        return localStorage.getItem("aura.ade.v2") === "1";
      } catch {
        return false;
      }
    })();
    const raw = localStorage.getItem("aura.rightRail.tab");
    if (ade) {
      // ADE rail = Files · Changes · Checks (+ Commons + plugin panels). The
      // legacy aura/chat/story/tasks tabs are hidden (re-homed); Trust +
      // Review folded into Trace. Checks + PRs are now one surface (the PR
      // list lives at the bottom of Checks), so a persisted "prs" restores
      // into Checks. Never restore into a hidden tab — fall back to Files.
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
    }
    if (raw === "chat" || raw === "story" || raw === "tasks") return raw;
    if (raw && raw.startsWith("plugin:")) return raw as RightRailTab;
    // Native Aura Manager gated off → never default into (or restore) the
    // hidden "aura" tab; land on Chat (Team) instead.
    if (!AURA_MANAGER_ENABLED) return "chat";
    return "aura";
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

  // Chat-first sweep — when any caller wants a Manager session in focus
  // (post-launch, plan handoff, dashboard click), they dispatch
  // aura:focus-manager. We flip the right rail to "aura"; AuraRailPanel
  // re-reads the ambient sid from localStorage.
  useEffect(() => {
    function onFocus(e: Event) {
      // ADE re-homes the manager out of the right rail (which no longer
      // has an "aura" tab) into a center pane. Open/focus the requested
      // session as a workpane tab — post-launch / dashboard / plan-handoff
      // focus calls land inline instead of popping a modal. Read the flag
      // live to avoid a stale closure.
      const ade = (() => {
        try {
          return localStorage.getItem("aura.ade.v2") === "1";
        } catch {
          return false;
        }
      })();
      if (ade) {
        const detail = (e as CustomEvent<{ repoRoot: string; sessionId: string }>)
          .detail;
        if (detail?.sessionId) {
          editorRef.current.openManager(detail.sessionId, "Chat");
        } else {
          // No session yet — e.g. the empty-state "Start a chat" card fires
          // focusAmbientManager(root, ""). Spin up a fresh blank chat inline
          // instead of silently dropping the click.
          newSessionActionRef.current();
        }
        return;
      }
      setRightRailTab("aura");
    }
    window.addEventListener(FOCUS_MANAGER_EVENT, onFocus as EventListener);
    return () =>
      window.removeEventListener(FOCUS_MANAGER_EVENT, onFocus as EventListener);
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
  // Crew — the full-screen home for the autonomous work loop (Build rail).
  const [crewOpen, setCrewOpen] = useState(false);
  // The full-screen Workspaces view — the "cool view" for the whole fleet of
  // parallel copies, so the Build sidebar stays a curated few. `wsFilter`
  // scopes it to one project when opened from that project's disclosure.
  const [wsOpen, setWsOpen] = useState(false);
  const [wsFilter, setWsFilter] = useState<string | null>(null);
  // Which section the agent-customize overlay lands on. A bare open (account
  // menu / palette) uses "overview"; a deep-link row in the Build rail passes
  // `{ pane }` so Skills / Instructions / Connections open in one click.
  const [agentCustomizeView, setAgentCustomizeView] =
    useState<CustomizeViewId>("overview");
  // ADE surface redesign (W1) master flag. When on, the three left
  // columns (workspace rail + icon NavRail + sidebar) collapse into one
  // AdeSidebar panel with a Build/Team/Plan/Trace footer switcher; the
  // old surface stays the default until ramp.
  const adeV2 = useAdeV2();
  // Full-height ADE sidebar owns the traffic-light corner; the header drops
  // its own left inset in fullscreen (lights vanish) via this probe.
  const fullscreen = useIsFullscreen();
  // In-rail browser: the far-edge globe tab + RailBrowser. Restored by request.
  const BROWSER_RAIL_ENABLED = true;
  // If the rail is parked on the (now absent) browser tab, fall back so the
  // rail body isn't blank.
  useEffect(() => {
    if (!BROWSER_RAIL_ENABLED && rightRailTab === "browser") {
      setRightRailTab(adeV2 ? "files" : "aura");
    }
  }, [rightRailTab, adeV2, BROWSER_RAIL_ENABLED]);
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
  // `aura:open-crew` — the full-screen home for the autonomous work loop: the
  // ready/working/blocked/done lanes over the `.aura/a2a/` dependency graph,
  // with Sync-from-board and Run affordances. Opened from the Build rail.
  useEffect(() => {
    function onEvent() {
      setCrewOpen(true);
    }
    window.addEventListener("aura:open-crew", onEvent);
    return () => window.removeEventListener("aura:open-crew", onEvent);
  }, []);
  // `aura:open-workspaces` — the full-screen Workspaces view (time list +
  // status board over every parallel copy). Fired by the roster's "…more
  // parallel copies" disclosure (carrying a projectId to scope the view) and
  // by a plain "View all" affordance (no detail = every open project).
  useEffect(() => {
    function onEvent(e: Event) {
      const projectId = (e as CustomEvent<{ projectId?: string }>).detail
        ?.projectId;
      setWsFilter(projectId ?? null);
      setWsOpen(true);
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
      if (e.shiftKey && e.key.toLowerCase() === "n") {
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
      editor.openTraceTool("rewind", detail ?? undefined);
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
        editor.openTraceTool(tool, detail?.args ?? undefined);
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
  // SessionInfoCard's recent-intents footer dispatches this when the
  // user clicks a row — switch to the history sidebar so they land on
  // the full timeline without prop-drilling sidebar state through 4
  // layers.
  useEffect(() => {
    function open() {
      setHistoryView("list");
      setActiveSidebarTab("history");
      setSidebarOpen(true);
    }
    window.addEventListener("aura:open-history", open);
    return () => window.removeEventListener("aura:open-history", open);
  }, []);
  // Source Control panel's branch-graph button → History tab, Graph view.
  useEffect(() => {
    function open() {
      setHistoryView("graph");
      setHistoryFilter("all");
      setActiveSidebarTab("history");
      setSidebarOpen(true);
    }
    window.addEventListener("aura:open-branch-graph", open);
    return () => window.removeEventListener("aura:open-branch-graph", open);
  }, []);
  const [askOpen, setAskOpen] = useState(false);
  const [askPrefill, setAskPrefill] = useState<string | undefined>(undefined);
  const [activeSidebarTab, setActiveSidebarTab] = useState<SidebarTabId>("files");
  const [diffStats, setDiffStats] = useState<DiffStats>({
    changed_files: 0,
    added: 0,
    removed: 0,
  });
  const [impactsCount, setImpactsCount] = useState(0);
  const [conflictsCount, setConflictsCount] = useState(0);
  // jj-style durable AST conflicts in `.aura/conflicts.jsonl`. Distinct
  // from `conflictsCount` above which scans sentinel + git markers.
  const [astConflictsOpen, setAstConflictsOpen] = useState(0);
  // Full impact list for A1 banner + A5 critical-dot. Polled in the
  // existing tick() at 4s — disk read of one JSONL, negligible cost.
  const [impacts, setImpacts] = useState<ImpactAlert[]>([]);
  // Banner row dismissals are session-scoped — restart re-shows them
  // until the underlying alert flips to resolved.
  const [dismissedImpactIds, setDismissedImpactIds] = useState<Set<string>>(
    () => new Set(),
  );
  // Active zone rules — file tabs evaluate ownership per row (A3 chip).
  // Polled by the 4s tick().
  const [zones, setZones] = useState<ZoneRule[]>([]);
  // Strict-mode posture from ~/.aura/credentials.json. Long-cadence
  // poll (120s) — the field rarely changes. Drives the StatusBar +
  // SessionInfoCard pill, and the commit-time confirmation guard.
  const [strictMode, setStrictMode] = useState<StrictModeInfo["mode"]>("off");
  // Task #229 — installed `aura` CLI version vs. the version the shell
  // was built against. One-shot at boot + manual refresh via the chip
  // popover; no polling. `null` while the first check is in flight.
  const [cliVersion, setCliVersion] = useState<{
    installed: string | null;
    expected: string;
    path: string | null;
    status: "ok" | "outdated" | "missing" | "unknown";
    raw: string | null;
  } | null>(null);
  // What's-new after an update: a one-time modal for major releases, a small
  // dismissible sidebar card for minor ones (see lib/releaseNotes). Computed
  // once on boot from the running app version vs the last version we showed.
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
            surface: pending.surface,
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
  // History sidebar honors this on mount + when bumped — used by the
  // StatusBar audit chip to jump straight into the audit feed.
  const [historyFilter, setHistoryFilter] = useState<
    "all" | "intent" | "snapshot" | "commit" | "audit" | undefined
  >(undefined);
  // Which History view to land on. "graph" only when the Source Control
  // panel's branch-graph button deep-links here; every timeline deep-link
  // resets to "list" so the tab isn't stuck in graph mode.
  const [historyView, setHistoryView] = useState<"list" | "graph">("list");
  const [zoom, setZoom] = useState<number>(() => {
    const raw = localStorage.getItem(ZOOM_KEY);
    const n = raw ? parseFloat(raw) : NaN;
    return Number.isFinite(n) ? clampZoom(n) : 1;
  });
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
    if (adeV2 && editor.activeInbox) {
      editor.closeInbox();
      setRightRailTab("prs");
    }
  }, [adeV2, editor.activeInbox, editor]);

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
  // In ADE the default "+"/⌘N starts a blank chat-only Manager session
  // and opens it as a center workpane tab in the active workspace — no
  // popup. The heavyweight task-DAG launcher (ManagerLauncher) is the
  // legacy-shell path and an explicit "orchestrate" action, not the
  // everyday new-chat. Project root comes from a ref and the ADE flag
  // from localStorage so these stay correct as stable []-dep callbacks.
  const adeFlagLive = useCallback(() => {
    try {
      return localStorage.getItem("aura.ade.v2") === "1";
    } catch {
      return false;
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
    const root = currentRootRef.current;
    if (!root) return;
    api
      .managerChatStart(root, "")
      .then((sid) => {
        editorRef.current.openManager(sid, "New chat");
        try {
          localStorage.setItem(`aura.ambient.${root}`, sid);
        } catch {
          /* localStorage quota — non-fatal */
        }
      })
      .catch((e) => console.error("[manager] new chat failed:", e));
  }, []);
  // "Focus chat" — reopen the workspace's current ambient session as a
  // tab if there is one, else start a fresh chat. Used by the status-pill
  // chat affordance so it doesn't spawn a new thread on every click.
  const focusOrStartChat = useCallback(() => {
    if (!AURA_MANAGER_ENABLED) {
      editorRef.current.setActiveDashboard();
      return;
    }
    const root = currentRootRef.current;
    if (!root) return;
    let sid: string | null = null;
    try {
      sid = localStorage.getItem(`aura.ambient.${root}`);
    } catch {
      /* ignore */
    }
    if (sid) {
      editorRef.current.openManager(sid, "Chat");
      return;
    }
    startInlineChat();
  }, [startInlineChat]);
  // The "new session" action behind the + button, ⌘N, and aura:new-session.
  // ADE → inline chat; legacy shell → the orchestration launcher modal.
  const newSessionAction = useCallback(() => {
    // Native chat gated off → no inline chat, no launcher modal; just reveal
    // the calm empty surface so + / ⌘N land on the action list.
    if (!AURA_MANAGER_ENABLED) {
      editorRef.current.setActiveDashboard();
      return;
    }
    if (adeFlagLive()) startInlineChat();
    else setManagerLauncherOpen(true);
  }, [adeFlagLive, startInlineChat]);
  newSessionActionRef.current = newSessionAction;

  // Cmd+T (or "aura:open-tasks") opens the Tasks board. Cmd+Shift+T
  // also works for users who learned the original binding. Standup
  // stays on Cmd+Shift+U — leaving the un-shifted Cmd+U slot free for
  // the platform's "view source" instinct. With a repo open the board
  // lands as a first-class workpane tab (#266); without one we fall
  // back to the legacy modal.
  useEffect(() => {
    function openTasks() {
      const root = projectRootRef.current;
      if (root) editor.openTasks(root);
    }
    function openStandup() {
      const root = projectRootRef.current;
      if (root) editor.openStandup(root);
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
      editor.openScreenshare(id);
    }
    // RR.3 — Cmd+Shift+N (or `aura:open-notes`) opens the Pages
    // workpane tab. No-op without a repo open — Pages needs a project
    // to read team notes from.
    function openPages() {
      const root = projectRootRef.current;
      if (root) editor.openPages(root);
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
      } else if (k === "n" && e.shiftKey) {
        e.preventDefault();
        openPages();
      }
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
  }, [editor]);

  // Plugin rail-tile entries (W1.4) — derived from the shared
  // contributes snapshot. Click routes through the bridge runtime to
  // the owning plugin's sandboxes (`aura.ui.tile-click` event); the
  // window CustomEvent stays as a DevTools-visible debugging trace.
  const pluginRailTileEntries: PluginRailTile[] = pluginRailTiles(
    pluginContribs.rows,
  ).map((t) => ({
    pluginId: t.pluginId,
    tileId: t.id,
    label: t.label,
    glyph: t.icon ?? undefined,
  }));
  const onSelectPluginTile = useCallback((t: PluginRailTile) => {
    dispatchPluginTileClick(t.pluginId, t.tileId);
    window.dispatchEvent(
      new CustomEvent("aura:plugin-tile-click", {
        detail: { pluginId: t.pluginId, tileId: t.tileId },
      }),
    );
  }, []);
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
  // Sidebar tab selector — used by the second rail (vertical NavRail).
  // `tasks` + `pages` are not sidebar bodies; they open their own
  // workpane tabs (RR.3 promoted pages off the legacy full-screen
  // overlay). We don't flip `activeSidebarTab` in those cases so when
  // the user closes the surface they land back on the previous body.
  const selectSidebarTab = useCallback(
    (t: SidebarTabId) => {
      const wasPr = editor.activeInbox || editor.activePrDetail;
      if (t === "prs") {
        setActiveSidebarTab("prs");
        editor.openInbox();
        return;
      }
      if (t === "tasks") {
        const root = projectRootRef.current;
        if (root) editor.openTasks(root);
        return;
      }
      if (t === "pages") {
        const root = projectRootRef.current;
        if (root) editor.openPages(root);
        return;
      }
      if (wasPr) {
        if (editor.activeInbox) editor.closeInbox();
        if (editor.activePrTabId != null) editor.closePrDetail();
      }
      setActiveSidebarTab(t);
    },
    [editor, setActiveSidebarTab],
  );

  // Deep-links carried in auto-DMs + page mentions (see the matching comment
  // up by the `aura:open-crew` listener).
  useEffect(() => {
    const onOpenTask = (e: Event) => {
      const id = (e as CustomEvent<{ id?: string }>).detail?.id;
      const root = projectRootRef.current;
      if (id && root) editor.openTaskDetail(id, root);
    };
    const onOpenDm = () => {
      // Surface the Team activity pane; useTeamChat focuses the 1:1 by handle.
      editor.openSessions("team");
    };
    const onOpenPage = (e: Event) => {
      const d = (
        e as CustomEvent<{ scope?: string; bucket?: string; id?: string }>
      ).detail;
      const root = projectRootRef.current;
      if (!d?.id || !d.scope || !root) return;
      editor.openPages(root);
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
  }, [editor]);

  // Stage 8H — auto-collapse the left sidebar + right comms whenever
  // any PR surface is open (Inbox or single-PR detail), restoring the
  // prior values when the user navigates away from PR. This gives the
  // diff + floating threads the full Graphite-style surface, and the
  // Inbox a wide enough triage list, both of which match the
  // user-requested behaviour.
  const inPrSurface = editor.activeInbox || editor.activePrDetail;
  // OO.6 — when the active workpane tab is the Tasks board, the
  // sidebar takes over the same way PR Inbox does: hide Files/Git/
  // History, mount the wide `<TasksSidebar>` rail so the board gets
  // the breathing room the in-board 220px aside denied it. Walk the
  // split layout and check every leaf's active tab — any "tasks" hit
  // flips us into Tasks surface.
  const inTasksSurface = useMemo(() => {
    const layout = editor.splitLayout;
    if (!layout) return false;
    for (const leaf of treeLeafNodes(layout)) {
      const active = leaf.tabs[leaf.activeIndex];
      if (active && (active.kind === "tasks" || active.kind === "task")) {
        return true;
      }
    }
    return false;
  }, [editor.splitLayout]);
  // RR.3 — same pattern as inTasksSurface. Lights the Pages rail tile
  // whenever any leaf's active tab is the Pages workpane.
  const inPagesSurface = useMemo(() => {
    const layout = editor.splitLayout;
    if (!layout) return false;
    for (const leaf of treeLeafNodes(layout)) {
      const active = leaf.tabs[leaf.activeIndex];
      if (active && active.kind === "pages") return true;
    }
    return false;
  }, [editor.splitLayout]);
  // Unified Notes/Pages surface flag — true whenever the user is on
  // the Pages workpane. Same takeover pattern as PR/Tasks: when set,
  // the app-level sidebar swaps to PagesSidebarMount so the user sees
  // ONE rail instead of the duplicate (in-workpane + app-level) we
  // used to ship.
  const inNotesSurface = inPagesSurface;
  // Stage 8N — NavRail surface flips between "code" and "pr". Drives
  // which tile set the rail renders (Files/Git/… vs Inbox/Reviews/…).
  const navSurface: "code" | "pr" = inPrSurface ? "pr" : "code";
  // Stage 10C — when the active agent changes (claude / codex / gemini /
  // kimi), flip the right rail to Story once. Story is where the
  // multi-agent file timeline + intent attribution lives, so it's the
  // most useful default while an agent is editing. Tracked per-session
  // so a manual flip back to Chat sticks until the next agent switch.
  const lastAgentRailRef = useRef<string | null>(null);
  useEffect(() => {
    // ADE re-homes Story into the Trace section and its right rail has no
    // "story" tab. Forcing one here blanked the rail the instant an agent
    // (Claude Code / Codex / …) became active — leave the user's chosen
    // ADE tab (Files / Changes / Trust / Review) untouched.
    if (adeV2) return;
    const id = editor.activeAgentId;
    if (!id) return;
    if (lastAgentRailRef.current === id) return;
    lastAgentRailRef.current = id;
    setRightRailTab("story");
  }, [editor.activeAgentId, adeV2]);
  // Chat-first sweep — rail collapsed to Files/Git/PRs/History; the
  // surface flip (code ↔ pr) just nudges the highlight to PRs when the
  // user is in PR mode and Files otherwise.
  //
  // Bug-fix (#279 BB.3): when the active workpane tab flips from a PR
  // surface to a non-PR tab (file / agent / terminal / tasks /…) the
  // store's setActive* now clears activePrTabId, so navSurface drops
  // back to "code". We track the previous value so we can ONLY restore
  // the sidebar on the pr→code transition — never on the steady-state
  // "code" tick, because callers like the "open_prs_sidebar" command
  // legitimately set the sidebar to "prs" while navSurface is still
  // "code" (they want the list, not a workpane).
  const navSurfacePrevRef = useRef<"code" | "pr">(navSurface);
  useEffect(() => {
    const valid = new Set<SidebarTabId>([
      "files",
      "git",
      "prs",
      "tasks",
      "pages",
      "history",
    ]);
    const wasPr = navSurfacePrevRef.current === "pr";
    navSurfacePrevRef.current = navSurface;
    if (!valid.has(activeSidebarTab)) {
      setActiveSidebarTab(navSurface === "pr" ? "prs" : "files");
    } else if (navSurface === "pr" && activeSidebarTab !== "prs") {
      setActiveSidebarTab("prs");
    } else if (
      navSurface === "code" &&
      wasPr &&
      activeSidebarTab === "prs"
    ) {
      setActiveSidebarTab("files");
    }
  }, [navSurface, activeSidebarTab]);
  // Stage 10B — used to auto-collapse sidebar + right rail on PR-mode
  // entry and force-restore on exit. Caused phantom re-opens: the
  // restoration would pop a closed rail back open whenever the user
  // toggled out of PR. Now PR-mode just respects the user's current
  // layout — Layout.tsx still has a responsive width guard that hides
  // the panes when the window is too narrow to fit them.
  void sidebarPrevRef;
  void reviewPrevRef;
  // SS.2 — auto-collapse the sidebar whenever the user opens an
  // individual detail tab (single task, single PR, single page).
  // Detail tabs already have their own context (right rail, action
  // bar, side aside) so the list-style sidebar mostly steals space.
  // Manual reopen sticks: once the user opens the sidebar back while
  // on a detail surface, we set an override ref and stop auto-
  // collapsing until they leave detail surface entirely. The ref is
  // reset by the inDetailSurface effect below.
  const sidebarOverrideRef = useRef(false);
  // Last *settled* value of inDetailSurface — lets the effects below
  // tell a genuine list→detail entry (collapse) apart from a manual
  // open while already steady in a detail surface (override). Updated
  // by a trailing effect so both transition effects read the same
  // pre-transition snapshot.
  const prevInDetailRef = useRef(false);
  // True whenever the active workpane on any pane is a single-record
  // detail surface — single task, single PR, or a Pages workpane
  // (whose list mode is now redundant with the app-level
  // PagesSidebarMount, so we treat it as detail too).
  const inDetailSurface = useMemo(() => {
    // ADE never auto-collapses the sidebar on a detail tab: the
    // AdeSidebar IS the contextual surface, and its section auto-follow
    // already swaps to the Plan/Pages (or Plan/Tasks) rail when a Page /
    // task tab opens. Collapsing would hide exactly the rail the user
    // wants up. This flag only drives the legacy three-column shell's
    // collapse effects, so short-circuiting it here is the whole fix.
    if (adeV2) return false;
    if (editor.activePrDetail) return true;
    const layout = editor.splitLayout;
    if (!layout) return false;
    for (const leaf of treeLeafNodes(layout)) {
      const active = leaf.tabs[leaf.activeIndex];
      if (!active) continue;
      if (active.kind === "task") return true;
      if (active.kind === "pages") return true;
    }
    return false;
  }, [editor.splitLayout, editor.activePrDetail, adeV2]);
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
  ]);
  // The live agent session the right-side "Create PR" routes into for this
  // repo: the active agent tab when it belongs here, else the most-recent
  // agent tab for this root. Null when no agent is running here — Create PR
  // then hands the work to the ambient Aura session instead.
  const activeAgentSession = useMemo<ActiveAgentSession | null>(() => {
    if (!project) return null;
    const norm = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);
    const root = norm(project.root);
    const forRepo = editor.agentTabs.filter((t) => norm(t.repoRoot) === root);
    if (forRepo.length === 0) return null;
    const active = forRepo.find((t) => t.sessionId === editor.activeAgentId);
    const t = active ?? forRepo[forRepo.length - 1];
    return { sessionId: t.sessionId, agentId: t.agentId, label: t.agentLabel };
  }, [editor.agentTabs, editor.activeAgentId, project]);
  // Overlay-style detail (the Plane peek) keeps the active tab on the
  // list, so it can't move inDetailSurface — it announces itself via
  // these events instead. Workpane-tab detail surfaces (single task /
  // page in their own tab) flip inDetailSurface and are handled by the
  // reactive effect below.
  useEffect(() => {
    // ADE keeps the AdeSidebar up on detail tabs (see inDetailSurface) —
    // skip the event-driven collapse too so an openTaskDetail drill-in
    // doesn't hide the Plan rail the section auto-follow just surfaced.
    if (adeV2) return;
    function onDetailOpened() {
      if (sidebarOverrideRef.current) return;
      setSidebarOpen(false);
    }
    function onDetailClosed() {
      if (sidebarOverrideRef.current) return;
      setSidebarOpen(true);
    }
    window.addEventListener("aura:detail-tab-opened", onDetailOpened);
    window.addEventListener("aura:detail-tab-closed", onDetailClosed);
    return () => {
      window.removeEventListener("aura:detail-tab-opened", onDetailOpened);
      window.removeEventListener("aura:detail-tab-closed", onDetailClosed);
    };
  }, [adeV2]);
  // Workpane-tab detail surfaces: collapse the list-style sidebar on
  // entry so the single task / page gets the full width, and restore it
  // (clearing any override) once the user navigates back to a list /
  // board / file. Only acts on the actual list↔detail transition so a
  // steady detail surface doesn't fight the user's manual toggles.
  useEffect(() => {
    const was = prevInDetailRef.current;
    if (inDetailSurface === was) return;
    if (inDetailSurface) {
      if (!sidebarOverrideRef.current) setSidebarOpen(false);
    } else {
      sidebarOverrideRef.current = false;
      setSidebarOpen(true);
    }
  }, [inDetailSurface]);
  // A manual open while ALREADY steady in a detail surface is a strong
  // "keep the rail here" signal (⌘B, NavRail tile, ProjectBar toggle).
  // Gated on prevInDetailRef so the entry tick — where sidebarOpen is
  // just leftover-true from the list view — isn't mistaken for it.
  useEffect(() => {
    if (sidebarOpen && inDetailSurface && prevInDetailRef.current) {
      sidebarOverrideRef.current = true;
    }
  }, [sidebarOpen, inDetailSurface]);
  // Trailing: commit the settled detail flag AFTER the two transition
  // effects above have read the pre-transition value.
  useEffect(() => {
    prevInDetailRef.current = inDetailSurface;
  }, [inDetailSurface]);
  // Persist the rail's open/closed state so it comes back exactly the way
  // the user left it after an app restart, rather than defaulting to open.
  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_OPEN_KEY, sidebarOpen ? "1" : "0");
    } catch {
      /* localStorage quota — non-fatal */
    }
  }, [sidebarOpen]);
  // Cold boot into a deliberately-closed rail: mark it as a user override so
  // the detail-surface auto-open effects above don't spring it back open on
  // startup. Mount-only — seeds the boot intent, not runtime toggles.
  useEffect(() => {
    if (!sidebarOpen) sidebarOverrideRef.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Managed-agent review lives in the Source Control sidebar. Agent tabs,
  // status chips, and review actions dispatch this instead of opening a
  // duplicate right-rail Changes surface.
  useEffect(() => {
    function open(e: Event) {
      const detail = (e as CustomEvent<{ filePath?: string }>).detail;
      setSidebarOpen(true);
      setActiveSidebarTab("git");
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
      // ADE has no "story" rail tab — the intent/edit timeline lives in
      // the Trace section (Intent↔AST inspector is its browse home). Route
      // there instead of blanking the rail on a hidden tab. Legacy mode
      // keeps the story rail tab.
      if (adeV2) {
        editor.openInspector();
      } else {
        setReviewOpen(true);
        setRightRailTab("story");
      }
    }
    window.addEventListener("aura:open-story", open);
    window.addEventListener("aura:open-edit-view", open);
    return () => {
      window.removeEventListener("aura:open-story", open);
      window.removeEventListener("aura:open-edit-view", open);
    };
  }, [adeV2, editor]);
  // Provenance lock badge in agent turns dispatches `aura:open-replay`
  // so any assistant message can drop the user into the Replay pane
  // without prop-drilling editor state through 4 layers of agent UI.
  useEffect(() => {
    function open() {
      editor.openReplay();
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
            agentMonogram: detail.agentId.charAt(0).toUpperCase(),
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

  // Club state — opt-in cross-workspace pinning. The store lives in
  // `workspaceClubStore`; we mirror it into a render trigger so the
  // rail tile re-paints when membership changes. Empty `members` = no
  // club exists.
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
  useEffect(() => {
    const activeRoot = project?.root ?? "";
    const roots = recents.length ? recents : activeRoot ? [activeRoot] : [];
    // Only fetch roots we haven't listed yet.
    const missing = roots.filter((root) => worktreesByRoot[root] === undefined);
    if (missing.length === 0) return;
    let cancelled = false;
    // Defer to idle + fan out in parallel. The old serial `for…await` fired one
    // `git worktree list` subprocess after another (up to 8 on launch, each
    // re-running this effect through its own setState) — a chain of blocking
    // IPC round-trips competing with first paint. This pre-warms the sibling /
    // right-click popover data off the launch-critical path and collapses N
    // serial calls into one parallel batch merged in a single state update.
    // Same data, same per-root fallback (`[]`); only WHEN/HOW changes.
    const cancelIdle = onIdle(() => {
      void Promise.all(
        missing.map((root): Promise<readonly [string, WorktreeRef[]]> =>
          api
            .gitWorktreeList(root)
            .then((list) => [root, list] as readonly [string, WorktreeRef[]])
            .catch(() => [root, []] as readonly [string, WorktreeRef[]]),
        ),
      ).then((pairs) => {
        if (cancelled) return;
        setWorktreesByRoot((prev) => {
          const next = { ...prev };
          for (const [root, list] of pairs) {
            if (next[root] === undefined) next[root] = list;
          }
          return next;
        });
      });
    });
    return () => {
      cancelled = true;
      cancelIdle();
    };
  }, [recents, project?.root, worktreesByRoot]);

  // ADE roster badges — per-worktree diff + PR pills. Only assembled when
  // the v2 surface is on; the legacy shell passes no groups so the hook
  // makes no git/gh calls. Each group falls back to a synthetic root row
  // (matching WorkspaceRoster) so a plain repo still gets its own diff.
  const rosterBadgeGroups = useMemo(() => {
    if (!adeV2) return [];
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
  }, [adeV2, recents, project?.root, worktreesByRoot]);
  const rosterBadges = useWorktreeBadges(rosterBadgeGroups);

  // Always-on chat notifications: fires an OS banner for every inbound
  // team-chat message (per-repo rooms + the cross-repo #aura channel),
  // even when the Team surface isn't mounted. The mention-only bridge
  // below now just flashes the title; this hook owns the OS notification.
  useChatNotifier(project?.root ?? null);

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
        const title = `commit ${ev.entry.sha} — ${ev.entry.subject}`;
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
        const title = `intent — ${ev.entry.agent || "agent"}`;
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
      const title = `snapshot ${ev.entry.id} — ${ev.entry.file}`;
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
            const sid = await api.managerChatStart(root, prompt);
            focusAmbientManager(root, sid);
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
            agentMonogram: agentLabel.charAt(0).toUpperCase(),
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
          const handle = await api.agentPtyOpen(
            agentId,
            root,
            80,
            24,
            undefined,
            true,
            undefined,
            ptyPermissionMode === "default" ? undefined : ptyPermissionMode,
          );
          editor.openAgent({
            sessionId: handle.id,
            agentId,
            agentLabel,
            agentMonogram: agentLabel.charAt(0).toUpperCase(),
            repoRoot: root,
            mode: "pty",
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
          title: `${agentLabel} — failed to start`,
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
          ?.then(() => {
            // Now standing IN the worktree (switchWorkspace hydrated its empty
            // snapshot). Open the launched agent(s) ACTIVELY here so the user
            // lands directly in the running chat — with the query they typed
            // already seeding — instead of a blank workspace. Placement was
            // deferred at launch time on purpose: doing it before the switch
            // would file the tab under the OUTGOING workspace's snapshot.
            for (const tab of detail?.tabs ?? []) {
              editorRef.current.openAgent({ ...tab, repoRoot: wt });
            }
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
        | { session?: { session_id: string; first_prompt?: string; last_prompt?: string } }
        | undefined;
      const s = detail?.session;
      if (!s) return;
      void (async () => {
        try {
          const pm = getPermissionMode(streamChannel("claude", project!.root));
          const handle = await api.agentPtyOpen(
            "claude",
            project!.root,
            96,
            32,
            s.session_id,
            true,
            undefined,
            pm === "default" ? undefined : pm,
          );
          const labelText = (s.last_prompt || s.first_prompt || "Claude").trim();
          const label = labelText.length > 24 ? labelText.slice(0, 24) + "…" : labelText || "Claude";
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
            window.alert(
              "Claude Code isn't installed on this machine, so this chat can't be opened there yet.\n\n" +
                "Install the Claude Code CLI (the `claude` command), then try again — your conversation has been saved and is ready to resume.",
            );
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
          window.alert(
            `Couldn't open this chat in Claude Code:\n\n${String(err)}`,
          );
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
            window.alert(
              `${out.label} isn't installed on this machine, so this chat can't be opened there yet.\n\n` +
                `Install ${out.label}'s command-line tool, then try again — your conversation has been saved and is ready to continue.`,
            );
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
            agentMonogram: baseLabel.charAt(0).toUpperCase() || "A",
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
          window.alert(`Couldn't open this chat in that agent:\n\n${String(err)}`);
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
              agentMonogram: label.charAt(0).toUpperCase(),
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
          agentMonogram: label.charAt(0).toUpperCase(),
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
    // Capture the surface the user is on (Pages/Tasks) BEFORE the switch wipes
    // the layout, so we can keep them there in the new project instead of
    // dumping them back to Build. switchWorkspace itself carries this for the
    // instant paint; we re-assert it below AFTER restored files settle, since
    // re-opening those files steals focus and would otherwise clobber it.
    const carrySurface = activeWorkSurface(editor.splitLayout);
    setProject({
      root,
      name,
      branch: branch || "—",
      lastModified: ageSecs >= 0 ? formatAge(ageSecs) : "no git history",
    });
    projectRootRef.current = root;
    // Per-workspace tab snapshots: serialize prev's full tab state,
    // wipe live state, hydrate next's snapshot. Replaces the legacy
    // `closeAll` + ad-hoc persistedAgents restore — which mixed tabs
    // from multiple workspaces together because closeAll deliberately
    // kept non-file tabs alive across switches (Stage 9B).
    editor.switchWorkspace(previousRoot, root);

    // Restore file tabs from the new workspace's snapshot. The
    // snapshot stores paths only; openFile owns the disk read so a
    // changed file on disk shows its latest content.
    const fileQueue = pendingFilePaths(root);
    const fileOpens = fileQueue.map((path) =>
      // Fire-and-forget; the editor handles tabs that fail to load by
      // showing an error tab. We don't block the workspace switch on
      // disk I/O across N files.
      editor.open(path).catch((e) => {
        console.warn("[workspace] failed to reopen file:", path, e);
      }),
    );
    // Each restored file steals focus as its buffer loads, so re-assert the
    // carried Pages/Tasks surface once they've all settled — but only if the
    // user is still on this project (they may have switched again mid-load).
    if (carrySurface) {
      void Promise.allSettled(fileOpens).then(() => {
        if (projectRootRef.current !== root) return;
        if (carrySurface === "pages") editor.openPages(root);
        else editor.openTasks(root);
      });
    }
    // Backwards-compat: if the user has no snapshot yet but does have
    // legacy `aura.openAgents.<root>` entries from before P1, surface
    // them so the transition isn't lossy.
    if (editor.agentTabs.length === 0) {
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
          const sessions = await api.managerList(root);
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
    // this: it's a second window onto a (usually different) project, and
    // moving the shared last-workspace pointer would yank the MAIN window
    // there on its next restart.
    if (!bootRootOverrideRef.current) {
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

  // Resolve a root into a tile letter — the canonical project name shown
  // on the workspace rail. Two roots can collide on first letter, but
  // hovering shows the full path so it's not actually ambiguous.
  const tileLetter = useCallback((root: string) => {
    const name = root.split("/").filter(Boolean).pop() ?? "·";
    return name.charAt(0).toUpperCase() || "·";
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
        case "project_timeline":
          window.dispatchEvent(new CustomEvent("aura:open-timeline"));
          return;
        case "workspaces":
          // Unscoped on purpose — a keyboard/palette summon has no project in
          // mind, so it opens on the whole fleet.
          window.dispatchEvent(new CustomEvent("aura:open-workspaces"));
          return;
        case "tasks_board": {
          const root = projectRootRef.current;
          if (root) editor.openTasks(root);
          return;
        }
        case "notes": {
          const root = projectRootRef.current;
          if (root) editor.openPages(root);
          return;
        }
        case "open_prs":
          // The PR triage Inbox. In ADE it lives in the right rail's PRs
          // tab (one home); legacy mode opens the center InboxPane.
          if (adeV2) setRightRailTab("prs");
          else editor.openInbox();
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
          editor.openTraceTool("doctor");
          return;
        case "aura_impacts":
          runCli("aura live impacts", ["live", "impacts"]);
          return;
        case "aura_pr_review":
          editor.openTraceTool("review");
          return;
        case "aura_snapshot":
          setSnapshotOpen(true);
          return;
        case "aura_rewind":
          editor.openTraceTool("rewind");
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
          editor.openProve();
          return;
        case "new_file":
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
        const [stats, impacts, conflicts, astConflicts, usageSum, intentCount, auditCount, zones] =
          await Promise.all([
            api.gitDiffStats(project!.root, sinceBase).catch(() => null),
            api.auraReadImpacts(project!.root).catch(() => []),
            api.auraListConflicts(project!.root).catch(() => []),
            api.auraConflictsList(project!.root).catch(() => []),
            api.auraUsageSummary(project!.root).catch(() => null),
            api.auraCountIntentsToday(project!.root).catch(() => 0),
            api.auraCountAuditUnacked(project!.root).catch(() => 0),
            api.zoneList(project!.root).catch(() => []),
          ]);
        if (cancelled) return;
        if (stats) setDiffStats(stats);
        setImpactsCount(impacts.length);
        setImpacts(impacts);
        setConflictsCount(conflicts.length);
        setAstConflictsOpen(astConflicts.filter((c) => c.resolved_at === null).length);
        if (usageSum) setUsage(usageSum);
        setIntentsToday(intentCount);
        setAuditUnacked(auditCount);
        setZones(zones);
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
        const live = await api.managerList(project.root);
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

  if (bootError) {
    return (
      <div className="h-screen w-screen bg-bg-deep text-red flex items-center justify-center font-mono text-xs">
        boot error: {bootError}
      </div>
    );
  }
  if (!project) {
    return (
      <div className="h-screen w-screen bg-bg-deep text-text-3 flex items-center justify-center text-xs">
        loading project…
      </div>
    );
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
      // Jump to another registered project. The current root is filtered out
      // of the lane, so this is always a real switch.
      if (entry.root !== currentRootRef.current) {
        void loadProjectAt(entry.root).catch((e) =>
          console.error("workspace switch failed:", e),
        );
      }
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
      if (cmd.target === "intent_inspector") editor.openInspector();
      if (cmd.target === "provenance_replay") editor.openReplay();
      if (cmd.target === "semantic_graph") editor.openGraph();
      if (cmd.target === "plan_builder") editor.openPlanBuilder();
      if (cmd.target === "prove") editor.openProve();
      if (cmd.target === "ask") {
        // Plain-language project Q&A. Prefill with whatever the user typed
        // after /ask (empty from the palette) so the dialog opens ready.
        setAskPrefill(extra.trim() || undefined);
        setAskOpen(true);
      }
      if (cmd.target === "compare_worktrees") setCompareOpen(true);
      if (cmd.target === "open_prs_sidebar") {
        setActiveSidebarTab("prs");
        setSidebarOpen(true);
      }
      if (cmd.target === "open_inbox") {
        if (adeV2) setRightRailTab("prs");
        else editor.openInbox();
      }
      if (cmd.target === "open_pr_by_number" && project) {
        const n = parseInt(extra.trim(), 10);
        if (Number.isFinite(n) && n > 0) {
          editor.openPrDetail(project.root, n, `PR #${n}`);
        } else {
          setActiveSidebarTab("prs");
          setSidebarOpen(true);
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
      const label =
        targetAgent.charAt(0).toUpperCase() + targetAgent.slice(1);
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
        editor.openTraceTool("rewind");
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
        editor.openTraceTool("review");
        return;
      case "aura_plan_discover":
        runCli("aura plan", extra ? ["plan", extra] : ["plan"]);
        return;
      case "aura_prove":
        editor.openProve();
        return;
      case "aura_memory_read":
        editor.openTraceTool("memory");
        return;
      default:
        runCli(cmd.name, [cmd.target.replace(/^aura_/, "").replace(/_/g, "-")]);
    }
  }

  return (
    <TeamChatProvider repoRoot={project.root} projectName={project.name}>
      {/* Feed the always-on-top floating HUD. Only the real main window
          publishes — a workspace popout also renders <App> (with
          bootRootOverride set), and two publishers would fight over the
          `hud:state` channel. */}
      {!bootRootOverride && (
        <HudPublisher projectRoot={project?.root ?? null} />
      )}
      <Layout
        // PR / Tasks / Notes surfaces swap the sidebar contents for the
        // surface-specific list (Inbox / Tasks list / Pages list) — see
        // the `sidebar={...}` branch below. Visibility honours
        // `sidebarOpen` in every surface; SS.2 auto-collapses on detail-
        // tab-open under 1400px so the detail view gets the breathing
        // room, and the NavRail toggle (⌘B) always wins thereafter.
        sidebarOpen={sidebarOpen}
        reviewOpen={reviewOpen}
        // ADE v2 runs the sidebar full-height to y=0 and hands it a header
        // zone (traffic-lights + nav + project switcher + search) so the
        // work-surface header starts right of the sidebar width.
        fullHeightSidebar={adeV2}
        sidebarHeader={
          adeV2 ? (
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
              account={
                <AccountMenu
                  userInitial="M"
                  square
                  onOpenProfile={() =>
                    window.dispatchEvent(
                      new CustomEvent("aura:open-settings", {
                        detail: { pane: "identity" },
                      }),
                    )
                  }
                />
              }
              projectLabel={project.name}
            />
          ) : undefined
        }
        rail={
          // ADE v2 folds the icon NavRail into the AdeSidebar footer
          // switcher — omit the slot so Layout hides the column.
          adeV2 ? undefined : (
          <NavRail
            activeTab={
              inPrSurface
                ? "prs"
                : inTasksSurface
                  ? "tasks"
                  : inPagesSurface
                    ? "pages"
                    : activeSidebarTab
            }
            onSelectTab={selectSidebarTab}
            sidebarOpen={sidebarOpen}
            onToggleSidebar={() => setSidebarOpen((v) => !v)}
            badges={{
              history: impacts.some(
                (i) => !i.resolved && i.severity === "critical",
              )
                ? { kind: "dot", color: "var(--color-red)" }
                : impactsCount + conflictsCount > 0
                  ? { kind: "count", n: impactsCount + conflictsCount }
                  : { kind: "none" },
              files:
                diffStats.changed_files > 0
                  ? { kind: "dot", color: "var(--color-amber)" }
                  : { kind: "none" },
              git:
                diffStats.changed_files > 0
                  ? { kind: "count", n: diffStats.changed_files }
                  : { kind: "none" },
            }}
            pluginTiles={pluginRailTileEntries}
            onSelectPluginTile={onSelectPluginTile}
          />
          )
        }
        workspaceRail={
          // ADE v2 folds the workspace roster into the Build section.
          adeV2 ? undefined : (
          <WorkspaceRail
            workspaces={(recents.length
              ? recents.filter((r) => !isManagedWorktree(r))
              : [project.root]
            ).map((root) => ({
              id: root,
              letter: tileLetter(root),
              emoji: workspaceCustomization[root]?.emoji,
              // When the club is the active surface, no concrete tile
              // gets the active highlight — the clubbed tile does.
              active: !clubState.active && root === project.root,
              accent: accentForRoot(root),
              worktrees: worktreesByRoot[root] ?? [],
              unread:
                root === project.root
                  ? editor.agentTabs.filter((tab) => tab.repoRoot === root && tab.attention).length
                  : workspaceUnreadCount(root),
            }))}
            userInitial="M"
            club={
              clubState.members.length >= 2
                ? {
                    members: clubState.members,
                    active: clubState.active,
                    onActivate: () => {
                      // Persist the outgoing concrete workspace, then
                      // hydrate the club slot. The active project.root
                      // stays at its last value — it represents the
                      // "primary" cwd for shell commands while in club.
                      const prev = clubState.active
                        ? null
                        : projectRootRef.current;
                      editor.enterClub(prev, clubState.members);
                      setClubActive(true);
                      // Replay club's file paths via openFile so disk
                      // is the source of truth, matching switchWorkspace.
                      const paths = pendingFilePathsForClub(
                        clubState.members,
                      );
                      for (const p of paths) {
                        void editor.open(p).catch((e) => {
                          console.warn("[club] reopen file failed:", p, e);
                        });
                      }
                    },
                    onLeaveMember: (root) => {
                      removeFromClub(root);
                      // If leaving while active and the club is now
                      // gone (<2 members remain), bounce back to a real
                      // workspace tile so the user isn't stranded.
                      const next = getClubState();
                      if (clubState.active && next.members.length < 2) {
                        editor.exitClub(project.root);
                        setClubActive(false);
                      }
                    },
                    onDissolve: () => {
                      if (clubState.active) {
                        editor.exitClub(project.root);
                      }
                      dissolveClub();
                    },
                  }
                : undefined
            }
            onDropTabOnWorkspace={(srcRoot, dstRoot) => {
              // The tab strip's drag broadcasts the source workspace
              // root in `application/x-aura-tab-source-root`. Dropping
              // onto another workspace's tile pulls both into a club.
              clubWith(srcRoot, dstRoot);
            }}
            onSelect={(id) => {
              // Selecting a concrete tile while clubbed exits the club
              // and routes through the normal workspace switch (which
              // persists the club slot so re-entry is sticky).
              if (clubState.active) {
                editor.exitClub(id);
                setClubActive(false);
              }
              if (id !== project.root) loadProjectAt(id).catch((e) => console.error("switch failed:", e));
            }}
            onAddWorkspace={pickAndOpenFolder}
            onOpenSettings={() => dispatchAction("settings")}
            onOpenWorktree={(p) => {
              if (p !== project.root) loadProjectAt(p).catch((e) => console.error("switch failed:", e));
            }}
            onCloseWorkspace={(id) => {
              setRecents((prev) => {
                const next = prev.filter((r) => r !== id);
                try {
                  localStorage.setItem("aura.recents", JSON.stringify(next));
                } catch {
                  /* ignore quota errors */
                }
                return next;
              });
              if (id === project.root && recents.length > 1) {
                const fallback = recents.find((r) => r !== id);
                if (fallback) {
                  loadProjectAt(fallback).catch((e) => console.error("switch failed:", e));
                }
              }
            }}
          />
          )
        }
        sidebar={
          adeV2 ? (
            <AdeSidebar
              activeSection={adeSection}
              workspaceKey={project.root}
              traceCount={impactsCount + conflictsCount}
              whatsNew={
                whatsNew?.surface === "card" ? whatsNew.note : undefined
              }
              onDismissWhatsNew={dismissWhatsNew}
              onWhatsNewCta={takeReleaseCta}
              buildBody={
                // Build = workspace roster only, per the mockup. The file
                // tree + git changes live on the RIGHT rail (Files /
                // Changes tabs) — see the reviewPanel below. `ade-sec-fill`
                // makes it span the panel edges like Team/Plan; the `px-1.5`
                // re-adds the canonical 6px gutter so the nav + roster land
                // at the same 14px inset (and inset active pills) as
                // Trace/Tasks/Pages, not flush to the panel edge.
                <div className="ade-build ade-sec-fill px-1.5">
                  <BuildNav
                    repoRoot={project.root}
                    onSelectWorkspaces={() => editor.closeAutomations(project.root)}
                    onAddWorkspace={pickAndOpenFolder}
                    // No `projectId` in the detail — the row heads the whole
                    // roster, so its door opens on every project. The per-project
                    // count chip inside the roster keeps its scoped deep-link.
                    onOpenWorkspaces={() =>
                      window.dispatchEvent(new CustomEvent("aura:open-workspaces"))
                    }
                    onOpenCrew={() =>
                      window.dispatchEvent(new CustomEvent("aura:open-crew"))
                    }
                  />
                  {/* The "Projects" break header + its sort/new/fold-all
                      controls now live inside WorkspaceRoster, co-located with
                      the collapse + sort state it drives. */}
                  <WorkspaceRoster
                    workspaces={(recents.length
                      ? recents.filter((r) => !isManagedWorktree(r))
                      : [project.root]
                    ).map((root) => ({
                      id: root,
                      letter: tileLetter(root),
                      emoji: workspaceCustomization[root]?.emoji,
                      active: !clubState.active && root === project.root,
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
                      if (clubState.active) {
                        editor.exitClub(id);
                        setClubActive(false);
                      }
                      if (id !== project.root)
                        loadProjectAt(id).catch((e) =>
                          console.error("switch failed:", e),
                        );
                    }}
                    onOpenWorktree={(p) => {
                      if (p !== project.root)
                        loadProjectAt(p).catch((e) =>
                          console.error("switch failed:", e),
                        );
                    }}
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
                      if (id === project.root && recents.length > 1) {
                        const fallback = recents.find((r) => r !== id);
                        if (fallback)
                          loadProjectAt(fallback).catch((e) =>
                            console.error("switch failed:", e),
                          );
                      }
                    }}
                    onRemoveWorktree={(root, path) => {
                      // Destructive — deletes the managed worktree checkout
                      // on disk via `worktree_remove_managed`. Confirm, then
                      // re-fetch the root's worktree list so the row drops.
                      const ok = window.confirm(
                        `Remove this worktree?\n\n${path}\n\nThe checkout is deleted from disk. Unmerged commits on its branch are NOT removed.`,
                      );
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
                          window.alert(`Could not remove worktree:\n${e}`);
                        });
                    }}
                  />
                </div>
              }
              teamBody={
                // Team navigation stays docked here while the selected
                // conversation opens as a detail surface in the workpane.
                <div className="ade-sec-fill">
                  <TeamSurface
                    repoRoot={project.root}
                    projectName={project.name}
                    mode="navigator"
                    onExpand={() => editor.openChannels(project.root)}
                  />
                </div>
              }
              planBody={
                // Pages is its own top-level section now — Tasks moved to
                // Team (a collaborative board belongs beside the chat). Bare
                // mount, no onClose → no stray close button; PagesSidebarMount
                // opens pages via its own aura:pages:* events.
                <div className="ade-sec-fill">
                  <PagesSidebarMount repoRoot={project.root} />
                </div>
              }
              traceBody={
                // Trace = the semantic / provenance spine. Pull Requests
                // are NOT here — they re-homed to the right rail's PRs tab
                // so they live in one place. Everything else (Overview,
                // Sessions, Review, Intent↔AST, Goals, Rewind, …) stays.
                // Full-bleed (ade-sec-fill) so its rows share the same 8px
                // inset as every other section.
                <div className="ade-sec-fill">
                <TraceBody
                  activeKey={
                    checksOpen
                      ? "checks"
                      : editor.traceTool
                      ? editor.traceTool
                      : editor.activeProve
                        ? "goals"
                        : editor.activeInspector
                          ? "intent"
                          : editor.activeSessions
                            ? editor.traceView === "sessions"
                              ? "sessions"
                              : editor.traceView === "team"
                                ? "team"
                                : editor.traceView === "usage"
                                  ? "usage"
                                  : "overview"
                            : null
                  }
                  onOverview={() => editor.openSessions("overview")}
                  onSessions={() => editor.openSessions("sessions")}
                  onTeamActivity={() => editor.openSessions("team")}
                  onCostUsage={() => editor.openSessions("usage")}
                  onIntentAst={() => editor.openInspector()}
                  onReview={() =>
                    void sendToAmbientManager(project.root, safetyCheckPrompt())
                  }
                  onChecks={() =>
                    window.dispatchEvent(new CustomEvent("aura:open-checks"))
                  }
                  onImpacts={() => editor.openTraceTool("impacts")}
                  onProve={() =>
                    void sendToAmbientManager(project.root, proveGoalsPrompt())
                  }
                  onRewind={() => editor.openTraceTool("rewind")}
                  onTimeline={() =>
                    window.dispatchEvent(new CustomEvent("aura:open-timeline"))
                  }
                  onAttest={() => editor.openTraceTool("attest")}
                  onCodeMap={() => editor.openGraph()}
                  onMemory={() => editor.openTraceTool("memory")}
                  onDoctor={() => editor.openTraceTool("doctor")}
                  impactsCount={impactsCount}
                />
                </div>
              }
            />
          ) : (
          <>
            {inPrSurface ? (
              // PR mode — sidebar body is the Inbox filter rail. The
              // vertical NavRail (second rail) stays visible so the
              // user can swap back to Files / Git / History at any time
              // (clicking those exits PR mode via selectSidebarTab).
              <div className="flex-1 min-h-0">
                <InboxSidebar
                  repoRoot={project.root}
                  onClose={() => {
                    if (editor.activeInbox) editor.closeInbox();
                    if (editor.activePrTabId != null) editor.closePrDetail();
                    setActiveSidebarTab("files");
                  }}
                />
              </div>
            ) : inTasksSurface ? (
              // Tasks mode — same takeover pattern as the PR Inbox. The
              // wide app-level rail replaces Files/Git/History so the
              // board surface gets the breathing room Plane.so has.
              <div className="flex-1 min-h-0">
                <TasksSidebar
                  repoRoot={project.root}
                  onClose={() => {
                    editor.closeTasks(project.root);
                    setActiveSidebarTab("files");
                  }}
                />
              </div>
            ) : inNotesSurface ? (
              // Pages mode — same takeover. The internal PagesSidebar
              // inside NotesWorkpane was removed (Fix 1); navigation now
              // lives here. PagesSidebarMount loads its own summaries
              // and stays in lock-step with NotesWorkpane via the
              // `aura:pages:*` window events.
              <div className="flex-1 min-h-0">
                <PagesSidebarMount
                  repoRoot={project.root}
                  onClose={() => {
                    if (inPagesSurface) editor.closePages(project.root);
                    setActiveSidebarTab("files");
                  }}
                />
              </div>
            ) : (
              <>
                <ProjectHeader
                  name={project.name}
                  path={project.root}
                  branch={project.branch}
                />
                <div className="flex-1 min-h-0">
                  {activeSidebarTab === "files" && (
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
                  )}
                  {activeSidebarTab === "git" && (
                    <GitSidebar
                      repoRoot={project.root}
                      onOpen={(p, mode) => {
                        // v0.2.7 Phase 5 — modifier-key routing.
                        // diff (plain click) and edit (⌘ click) reuse
                        // the same workpane; diff-new-tab (⇧ click)
                        // splits a fresh pane so the user can compare
                        // two files side-by-side.
                        if (mode === "diff-new-tab") {
                          editor
                            .openFileSplit(p, "row")
                            .catch((e) =>
                              console.error("open split failed:", e),
                            );
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
                  )}
                  {activeSidebarTab === "history" && (
                    <HistorySidebar
                      repoRoot={project.root}
                      onOpen={openHistoryEvent}
                      initialFilter={historyFilter}
                      initialView={historyView}
                    />
                  )}
                </div>
                {/* v0.2.23 — VoiceDockPanel + UserIdentityBar moved into
                    CommsPanel's LEFT RAIL aside (right rail / chat sidebar),
                    matching the column users joined the call from. */}
              </>
            )}
          </>
          )
        }
        topBar={
          <TopBar
            adeChrome={adeV2}
            hideAccountCluster={adeV2}
            userInitial="M"
            onOpenProfile={() => {
              setSettingsOpen(true);
              window.dispatchEvent(
                new CustomEvent("aura:open-settings", {
                  detail: { pane: "identity" },
                }),
              );
            }}
            activeRoot={project.root}
            activeName={humanizeWorkspaceName(project.root, project.name)}
            activeEmoji={workspaceCustomization[project.root]?.emoji}
            workspaces={
              adeV2
                ? (recents.includes(project.root)
                    ? recents
                    : [project.root, ...recents]
                  ).map((root) => ({
                    root,
                    name: humanizeWorkspaceName(
                      root,
                      root === project.root ? project.name : undefined,
                    ),
                    emoji: workspaceCustomization[root]?.emoji,
                  }))
                : undefined
            }
            worktreesByRoot={worktreesByRoot}
            onSwitchProject={(root) => {
              if (root !== project.root)
                loadProjectAt(root).catch((e) =>
                  console.error("switch failed:", e),
                );
            }}
            onOpenWorktree={(path) => {
              if (path !== project.root)
                loadProjectAt(path).catch((e) =>
                  console.error("open worktree failed:", e),
                );
            }}
            onAddWorkspace={pickAndOpenFolder}
            projectLabel={project.name}
            reviewOpen={reviewOpen}
            terminalOpen={terminalOpen}
            onOpenPalette={() => setPaletteOpen(true)}
            onToggleReview={() => setReviewOpen((v) => !v)}
            onToggleTerminal={() => editor.toggleTerminalPanel()}
            onOpenInspector={() => editor.openInspector()}
            onOpenReplay={() => editor.openReplay()}
            onOpenGraph={() => editor.openGraph()}
            onOpenMemory={() => editor.openTraceTool("memory")}
            onOpenDoctor={() => editor.openTraceTool("doctor")}
            onOpenRemote={() => setRemoteOpen(true)}
            repoRoot={project.root}
            onOpenGit={() => {
              setSidebarOpen(true);
              setActiveSidebarTab("git");
            }}
            onOpenSettings={() => setSettingsOpen(true)}
            onFocusChat={() => {
              // ADE re-homes the manager into a center pane; focus the
              // workspace's ambient chat (or start one) as a tab instead
              // of flipping to a hidden "aura" rail tab.
              if (adeV2) focusOrStartChat();
              else setRightRailTab("aura");
            }}
            sidebarOpen={sidebarOpen}
            onToggleSidebar={() => setSidebarOpen((v) => !v)}
            onNewSession={newSessionAction}
            inboxSlot={
              <ImpactInbox
                repoRoot={project.root}
                onOpenFile={(p) =>
                  editor.open(`${project.root}/${p}`, { defaultView: "diff" })
                }
                onOpenAll={() => editor.openTraceTool("impacts")}
              />
            }
          />
        }
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
          adeV2 ? (
            <ReviewStateHeader
              repoRoot={project.root}
              conflictsCount={conflictsCount}
              activeAgentSession={activeAgentSession}
              onGoToChanges={() => setRightRailTab("changes")}
            />
          ) : undefined
        }
        reviewPanel={
          <RightRail
            activeTab={rightRailTab}
            onChangeTab={setRightRailTab}
            adeMode={adeV2}
            filesView={
              adeV2 ? (
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
              ) : undefined
            }
            changesView={
              adeV2 ? (
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
              ) : undefined
            }
            checksView={
              adeV2 ? (
                <ChecksPanel
                  repoRoot={project.root}
                  conflictsCount={conflictsCount}
                  onGoToChanges={() => setRightRailTab("changes")}
                />
              ) : undefined
            }
            commonsView={
              adeV2 && COMMONS_ENABLED ? (
                <CommonsRailPanel
                  repoRoot={project.root}
                  onExpand={() => editor.openCommons(project.root)}
                />
              ) : undefined
            }
            scribbleView={adeV2 ? <ScribblePanel repoRoot={project.root} /> : undefined}
            browserView={adeV2 && BROWSER_RAIL_ENABLED ? <RailBrowser /> : undefined}
            changesCount={diffStats.changed_files}
            auraView={<AuraRailPanel repoRoot={project.root} />}
            chatView={
              <TeamSurface repoRoot={project.root} projectName={project.name} />
            }
            storyView={<EditViewPanel repoRoot={project.root} />}
            tasksView={<TasksSidebarPanel repoRoot={project.root} />}
            pluginPanels={pluginPanelDescriptors}
          />
        }
        statusBar={
          <StatusBar
            repoRoot={project.root}
            sidebarOpen={sidebarOpen}
            changedFiles={diffStats.changed_files}
            auditUnacked={auditUnacked}
            conflictsOpen={astConflictsOpen}
            onClickDiff={() => {
              // The changes chip is a navigation, not a popup: open the
              // Review changes page (the semantic diff / verdict surface)
              // and poke the Changes panel so it focuses the working set.
              window.dispatchEvent(new CustomEvent("aura:focus-changes"));
              editor.openTraceTool("review");
            }}
            onClickAudit={() => {
              // Audit chip is gone in the chat-first sweep; route to the
              // History tab with the full feed visible.
              setHistoryFilter("all");
              setActiveSidebarTab("history");
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
              adeV2 ? (
                <StatusPills
                  repoRoot={project.root}
                  onFocusChat={focusOrStartChat}
                  onOpenGit={() => {
                    setSidebarOpen(true);
                    setActiveSidebarTab("git");
                  }}
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
              ) : undefined
            }
          />
        }
        body={
          // Flex-col wrapper so the banners + PresetsBar take their
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
                  <div className="px-3 py-2 bg-amber-500/15 border-b border-amber-500/30 text-[12px] text-amber-200 flex items-center gap-3">
                    <span className="font-medium">
                      {onDmg
                        ? "Aura is running from the disk image — updates won’t install."
                        : "Auto-update disabled: app is running from a read-only quarantine."}
                    </span>
                    <span className="text-amber-300/80 font-mono text-[11px] truncate">
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
                      className="text-[11px] text-amber-200 hover:text-amber-100 px-1.5 py-0.5 rounded hover:bg-amber-500/20"
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
            {whatsNew?.surface === "modal" ? (
              <WhatsNewModal
                note={whatsNew.note}
                onDismiss={dismissWhatsNew}
                onCta={takeReleaseCta}
              />
            ) : null}
            {mobileWaitlistOpen && (
              <MobileWaitlistDialog
                onClose={() => setMobileWaitlistOpen(false)}
              />
            )}
            <GetStartedTour
              open={tourOpen && whatsNew?.surface !== "modal"}
              onClose={closeTour}
            />
            <CliUpdateToast onInstalled={(check) => setCliVersion(check)} />
            <AuraImpactsBanner
              repoRoot={project.root}
              onOpenImpacts={() => {
                setHistoryFilter("all");
                setActiveSidebarTab("history");
              }}
              dismissedIds={dismissedImpactIds}
              onDismiss={(id) =>
                setDismissedImpactIds((prev) => {
                  const next = new Set(prev);
                  next.add(id);
                  return next;
                })
              }
            />
            <AuraTrackingNotice repoRoot={project.root} />
            <UnattributedChangesBanner repoRoot={project.root} />
            <PresetsBar
              onLaunchAgent={(id, label) =>
                runAgentPrompt(id, label, "", "pty")
              }
            />
            <div className="flex-1 min-h-0 overflow-hidden">
              <WorkSurface
                repoRoot={project.root}
                projectName={project.name}
                zones={zones}
                strictMode={strictMode}
                onLaunchAgent={(id, label) =>
                  runAgentPrompt(id, label, "", "pty")
                }
                onOpenRewind={(filePath?: string) =>
                  editor.openTraceTool("rewind", filePath ? { file: filePath } : undefined)
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
      {crewOpen && project.root && (
        <CrewSurface
          repoRoot={project.root}
          onClose={() => setCrewOpen(false)}
        />
      )}
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
      {wsOpen && project.root && (
        <WorkspacesSurface
          onClose={() => setWsOpen(false)}
          initialProjectId={wsFilter}
          activePath={project.root}
          worktreesByRoot={worktreesByRoot}
          badgeByPath={rosterBadges}
          onAddWorkspace={pickAndOpenFolder}
          onOpen={(p) => {
            if (p !== project.root)
              loadProjectAt(p).catch((e) =>
                console.error("switch failed:", e),
              );
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
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
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
