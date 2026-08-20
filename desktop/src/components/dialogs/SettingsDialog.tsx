// Aura settings — single dialog, sidebar-grouped panes. Layout
// repurposed from superset.sh's settings shell (two-column: grouped
// sidebar nav + content pane + per-section search). Replaces the
// "edit ~/.aura/credentials.json by hand" + "set env vars in your
// shell" mental model. Reachable via gear icon (workspace rail bottom)
// and ⌘, keybind.
//
// Small panes stay here as plain functions, sharing the SettingsView
// state hoisted up top so save-and-reload-on-pane-switch works without
// extra plumbing. A pane that grows past roughly a screenful of its own
// logic moves out to `components/settings/` — Brain, MCP Servers,
// Agents, Local Models, Plugins, Team, Integrations and the repo /
// worktree pane are all there. The line is the pane's own weight, not
// its subject: this file used to carry an eight-thousand-line version
// of the argument that they were each too small to bother.
//
// The panes intentionally don't surface fields the CLI exposes but the
// shell can't safely manipulate over IPC — strict-mode passcode-set,
// cloud rotation, sigstore key import all stay in `aura config` /
// `aura keys`. The dialog gestures users toward those CLI flows when
// they pick a locked surface.
//
// Keyboard model: ⌘, opens; Esc closes. Each pane self-saves on
// change — no global "Save" button — so the user closes when they're
// satisfied.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Beaker,
  ArrowLeft,
  BookOpen,
  Boxes,
  Brain,
  Bug,
  Check,
  ChevronDown,
  Cloud,
  Cpu,
  ExternalLink,
  Eye,
  FileCode2,
  FolderGit2,
  Gauge,
  Key,
  LayoutDashboard,
  LifeBuoy,
  MessageCircle,
  Paintbrush,
  Palette,
  Plug,
  Puzzle,
  Search,
  ShieldCheck,
  Smartphone,
  Sparkles,
  Terminal,
  Trash2,
  Upload,
  Users,
  X,
} from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { beginWindowDrag } from "../../lib/windowDrag";
import { AsciiSpinner } from "../ui/ascii-spinner";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select } from "../ui/select";
import { Kbd } from "../ui/kbd";
import { useIsFullscreen } from "../../lib/useIsFullscreen";
import {
  api,
  type AgentProfile,
  type CaptureStatus,
  type GitProfile,
  type SettingsView,
  type TerminalProfile,
  type TelemetryView,
  type TelemetryConsent,
  type WorkspaceBinding,
} from "../../lib/api";
import { setCaptureOptOut } from "../../lib/autoCapture";
import { SHORTCUT_GROUPS, comboKeys } from "../../lib/shortcuts";
import {
  setSidebarGlass,
  sidebarGlassAvailable,
  sidebarGlassEnabled,
} from "../../lib/sidebarGlass";
import {
  completionSoundEnabled,
  setCompletionSoundEnabled,
  playCompletionChime,
} from "../../lib/completionChime";
import { isChimeMuted, setChimeMuted, playChime } from "../../lib/chime";
import { InstalledModesPane } from "../marketplace/InstalledModesPane";
import { AuraWatchPanel } from "./AuraWatchSettingsDialog";
import { IntegrationsTab } from "../settings/IntegrationsTab";
import { McpServersTab } from "../settings/McpServersTab";
import { AgentsTab } from "../settings/AgentsTab";
import { BrainTab } from "../settings/BrainTab";
import { LocalModelsTab } from "../settings/LocalModelsTab";
import { PluginsTab } from "../settings/PluginsTab";
import { TeamTab } from "../settings/TeamTab";
import { MobileWaitlistTab } from "../mobile/MobileWaitlistTab";
import { CloudRunnerPanel } from "../commons/crew/CloudRunnerPanel";
import { IdentityPanel } from "../identity/IdentityPanel";
import { RepoWorktreeSettingsPane } from "../settings/RepoWorktreeSettingsPane";
import { WorkspaceLandingRow } from "../settings/WorkspaceLandingRow";
import {
  setThemePreference,
  isDarkOnlyVariant,
  setThemeVariant,
  useThemePreference,
  useThemeVariant,
  type ThemePreference,
  type ThemeVariant,
} from "../../lib/themeStore";
import {
  applyPresetTheme,
  importThemeFromText,
  removeTheme,
  setActiveTheme,
  setApplyChrome,
  useActiveVsCodeTheme,
  useApplyChrome,
  useVsCodeThemes,
} from "../../lib/vscodeThemesStore";
import { THEME_PRESETS } from "../../lib/vscodeThemePresets";
import type { ConvertedTheme } from "../../lib/vscodeTheme";
import {
  useExtensionThemes,
  useInstalledExtensions,
} from "../../lib/vscodeExt/vsixStore";
import { ensureExtensionThemesLoaded } from "../../lib/vscodeExt/applyContributes";
import {
  defaultTerminalFontSize,
  setEditorPref,
  setFlag,
  setFontSize,
  setHudPref,
  setScrollback,
  setTerminalBool,
  setTerminalFontSize,
  useEditorPrefs,
  useFlagPrefs,
  useFontSize,
  useHudPrefs,
  useTerminalPrefs,
} from "../../lib/settingsStore";
import type { HudPresentationMode } from "../../lib/hud";
import {
  readFollowUpBehavior,
  writeFollowUpBehavior,
  type FollowUpBehavior,
} from "../../lib/followUpBehavior";
import {
  KeyValueTable,
  PaneHeader,
  PaneIntro,
  Row,
  Section,
  SegControl,
  StatusPill,
  Stepper,
  Toggle,
} from "../settings/kit";
import { onExternalAnchorClick } from "../../lib/openExternal";
import { compactNumber } from "../../lib/compactNumber";
import { shortPath } from "../../lib/paths";
import { askConfirm, askNotice } from "../ui/ask";

type PaneKey =
  | "appearance"
  | "themes"
  | "hud"
  | "capture"
  | "behavior"
  | "brain"
  | "modes"
  | "aurawatch"
  | "agents"
  | "local-models"
  | "terminal"
  | "copies"
  | "keys"
  | "plugins"
  | "mcp"
  | "integrations"
  | "cloud"
  | "mobile"
  | "policy"
  | "profiles"
  | "identity"
  | "team"
  | "telemetry"
  | "experimental"
  | "help";

type SettingsDialogProps = {
  open: boolean;
  repoRoot: string;
  /** Every open/recent workspace root, so the Identity pane can let the
   *  user confirm "this is me" in each git project at once. Falls back to
   *  just `repoRoot` when absent. */
  openRoots?: string[];
  onClose: () => void;
};

type PackDescriptor = {
  id: string;
  label: string;
  description: string;
  rule_count: number;
  category: string;
  /** Whether every rule in this pack is already in the repo's
   *  `production.aura.json` — answered by `aura policy list --json`, which
   *  reads the file. The pane used to keep this in a Set it seeded empty, so
   *  a fully-covered repo showed seven `install` buttons. */
  installed: boolean;
};

type PaneItem = {
  id: PaneKey;
  label: string;
  icon: React.ReactNode;
  /** Free-form keywords used by the sidebar search. */
  keywords: string[];
};

type PaneGroup = {
  label: string;
  items: PaneItem[];
};

const PANE_GROUPS: PaneGroup[] = [
  {
    label: "You",
    items: [
      { id: "appearance", label: "Appearance", icon: <Palette className="h-4 w-4" />, keywords: ["theme", "dark", "light", "font", "size", "accent", "look"] },
      { id: "themes", label: "Editor themes", icon: <Paintbrush className="h-4 w-4" />, keywords: ["vscode", "vs code", "theme", "import", "color", "syntax", "tokencolors", "monaco", "extension"] },
      { id: "hud", label: "Floating HUD", icon: <LayoutDashboard className="h-4 w-4" />, keywords: ["hud", "overlay", "floating", "capsule", "sidebar", "minimal", "fab", "always on top", "shortcut", "shape", "opacity", "glance"] },
      { id: "identity", label: "Identity", icon: <Users className="h-4 w-4" />, keywords: ["identity", "alias", "handle", "team", "git", "email", "chat", "override", "per-repo", "mention", "name"] },
      { id: "profiles", label: "Accounts & profiles", icon: <Key className="h-4 w-4" />, keywords: ["profile", "identity", "git", "account", "isolated", "claude", "login", "sign in"] },
    ],
  },
  {
    label: "Building",
    items: [
      { id: "behavior", label: "Editor behavior", icon: <Sparkles className="h-4 w-4" />, keywords: ["vim", "minimap", "sticky", "indent", "editor", "keybindings", "sound", "chat", "follow-up", "followup", "steer", "queue", "interrupt", "redirect", "composer"] },
      { id: "brain", label: "Brain & models", icon: <Brain className="h-4 w-4" />, keywords: ["brain", "model", "provider", "anthropic", "openai", "gemini", "claude", "byok", "api key", "subscription", "aura pro"] },
      { id: "modes", label: "Modes", icon: <Sparkles className="h-4 w-4" />, keywords: ["modes", "mode", "marketplace", "architect", "code", "debug", "persona", "specialist", "system prompt"] },
      { id: "agents", label: "Coding agents", icon: <Cpu className="h-4 w-4" />, keywords: ["claude", "gemini", "codex", "cursor", "kimi", "providers", "agent", "cli"] },
      { id: "local-models", label: "Local & custom models", icon: <Cpu className="h-4 w-4" />, keywords: ["ollama", "huggingface", "hf", "together", "groq", "openrouter", "vllm", "local", "llama", "qwen", "openai-compat", "chat", "completions"] },
      { id: "terminal", label: "Terminal", icon: <Terminal className="h-4 w-4" />, keywords: ["shell", "pty", "bell", "cursor", "scrollback", "profile"] },
      { id: "copies", label: "Copies & agents", icon: <Boxes className="h-4 w-4" />, keywords: ["copy", "copies", "worktree", "agent", "setup", "run", "archive", "script", "branch", "base", "env", "files", "workspace", "isolated"] },
    ],
  },
  {
    label: "Capture & safety",
    items: [
      { id: "capture", label: "Record changes", icon: <ShieldCheck className="h-4 w-4" />, keywords: ["capture", "enable", "disable", "hooks", "git hook", "no mcp", "checkpoint", "semantic", "drop-in", "record", "merge"] },
      { id: "aurawatch", label: "Change reasons", icon: <Eye className="h-4 w-4" />, keywords: ["change reasons", "reason", "why", "aurawatch", "nudge", "remind", "watch", "autonomous", "auto-fill", "intent", "backend", "ollama"] },
      { id: "policy", label: "Security & policy", icon: <ShieldCheck className="h-4 w-4" />, keywords: ["strict", "passcode", "lock", "policy", "templates", "telemetry", "worktree", "embeddings", "dev mode"] },
    ],
  },
  {
    label: "Connections",
    items: [
      { id: "integrations", label: "Integrations", icon: <Plug className="h-4 w-4" />, keywords: ["jira", "linear", "atlassian", "sync", "tasks", "issues", "oauth", "tracker"] },
      { id: "cloud", label: "Cloud machine", icon: <Cloud className="h-4 w-4" />, keywords: ["cloud", "always-on", "always on", "machine", "runner", "connect", "remote", "vm", "box", "send", "offload", "background"] },
      { id: "mobile", label: "Aura on your phone", icon: <Smartphone className="h-4 w-4" />, keywords: ["mobile", "phone", "iphone", "ios", "android", "app", "waitlist", "invite", "testflight", "beta", "notify"] },
      { id: "mcp", label: "MCP servers", icon: <Plug className="h-4 w-4" />, keywords: ["mcp", "atlassian", "linear", "github", "sentry", "model context protocol", "tools"] },
      { id: "plugins", label: "Plugins", icon: <Puzzle className="h-4 w-4" />, keywords: ["plugin", "skill", "mcp", "marketplace", "extension"] },
      { id: "keys", label: "API keys", icon: <Key className="h-4 w-4" />, keywords: ["anthropic", "openai", "gemini", "mercury", "secret", "key"] },
    ],
  },
  // Team and "advanced" were one group, which the scope filter then split
  // across two tabs: Organization got the heading "Team & advanced" over the
  // single Team row, and Personal got the same heading over three rows with
  // no team among them. A group label is the name of what is under it, so it
  // has to be a group the tabs don't cut in half.
  {
    label: "Team",
    items: [
      { id: "team", label: "Team", icon: <Users className="h-4 w-4" />, keywords: ["team", "members", "admin", "standup", "activity", "tokens", "usage", "billing", "report", "rollup", "channels"] },
    ],
  },
  {
    label: "About Aura",
    items: [
      { id: "experimental", label: "Experimental", icon: <Beaker className="h-4 w-4" />, keywords: ["flags", "preview", "lab"] },
      { id: "telemetry", label: "Usage data", icon: <Gauge className="h-4 w-4" />, keywords: ["usage", "anonymous", "metrics", "telemetry"] },
      { id: "help", label: "Help & support", icon: <LifeBuoy className="h-4 w-4" />, keywords: ["help", "support", "shortcuts", "keyboard", "docs", "documentation", "github", "issue", "bug", "report", "about", "version", "community", "discord"] },
    ],
  },
];

/** Panes that act on the open repository rather than the user's global
 *  `~/.aura/settings.toml`. The header's Personal / Organization / Repository
 *  tabs scope the sidebar to one of the three — every pane stays reachable,
 *  just under the tab that matches what it configures. Change this set to
 *  re-file a pane. */
const REPO_SCOPED_PANES: ReadonlySet<PaneKey> = new Set<PaneKey>([
  "capture",
  "aurawatch",
  "policy",
  "integrations",
  "cloud",
  "mcp",
  "copies",
]);

/** Panes that configure the cloud organization / team you belong to
 *  (members, usage, billing, channels) rather than your personal setup or a
 *  single repository. Filed under the Organization tab. */
const ORG_SCOPED_PANES: ReadonlySet<PaneKey> = new Set<PaneKey>(["team"]);

type SettingsScope = "user" | "org" | "repo";

function paneScope(id: PaneKey): SettingsScope {
  if (ORG_SCOPED_PANES.has(id)) return "org";
  return REPO_SCOPED_PANES.has(id) ? "repo" : "user";
}

function scopeLabel(s: SettingsScope): string {
  return s === "user" ? "Personal" : s === "org" ? "Organization" : "Repository";
}

function flattenPanes(): PaneItem[] {
  return PANE_GROUPS.flatMap((g) => g.items);
}

/** A pane's name, from the one place that holds it: the rail row that
 *  navigates there. Panes used to declare their own title, and seven of them
 *  declared a different one from the row you clicked to reach them. */
function paneLabel(id: PaneKey): string {
  return flattenPanes().find((it) => it.id === id)?.label ?? "Settings";
}

function defaultPane(): PaneKey {
  return flattenPanes()[0]?.id ?? "appearance";
}

// Window-drag from the settings header — same model as TopBar: the
// `data-tauri-drag-region` attribute handles most targets, this JS
// fallback covers the ones Tauri 2's injector misses. Clickable children
// (the close button) keep their own clicks via the closest() guard.
function handleHeaderDrag(e: React.MouseEvent) {
  if (e.button !== 0) return;
  const target = e.target as HTMLElement;
  if (target.closest("button, input, a, [role=button]")) return;
  if (e.detail === 2) {
    getCurrentWindow().toggleMaximize().catch(() => {});
    return;
  }
  beginWindowDrag();
}

/** Dedicated full-screen Settings page (formerly a modal Dialog).
 *  Mounts in place of the work surface when `open` is true. Layout
 *  copies the Superset-style two-pane shell: 240-px left sidebar with
 *  grouped section links + persistent search, content pane on the right
 *  with each section's controls. `onClose` returns the user to the
 *  previous surface. */
export function SettingsDialog({
  open,
  repoRoot,
  openRoots,
  onClose,
}: SettingsDialogProps) {
  const [pane, setPane] = useState<PaneKey>(defaultPane);
  // Every distinct git project the user has open/recent, current repo
  // first — the Identity pane needs them all so "this is me" can be
  // confirmed per repo. De-duped; falls back to just the current repo.
  const identityRoots = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const r of [repoRoot, ...(openRoots ?? [])]) {
      if (r && !seen.has(r)) {
        seen.add(r);
        out.push(r);
      }
    }
    return out;
  }, [repoRoot, openRoots]);
  const [query, setQuery] = useState("");
  // User vs. Repo scope. The header tabs flip this; it filters the sidebar
  // to the panes that write the user's global `~/.aura/settings.toml`
  // (You / Building / your keys & plugins) versus the ones that configure
  // *this project* (capture hooks, policy, MCP, integrations, team). Repo
  // scope only means something with a repo open — falls back to User.
  const [scope, setScope] = useState<SettingsScope>("user");
  // Repo scope acts on one project. Defaults to the current repo; the header
  // picker lets you point the Repo panes at any other open project.
  const [repoPick, setRepoPick] = useState<string | null>(null);
  const activeRepoRoot =
    repoPick && identityRoots.includes(repoPick) ? repoPick : repoRoot;
  // Split-button flyout: choose which settings.toml to reveal.
  const [tomlMenu, setTomlMenu] = useState(false);
  const [view, setView] = useState<SettingsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fullscreen = useIsFullscreen();
  const searchRef = useRef<HTMLInputElement>(null);

  // No repo open → the Repo tab has nothing to configure; pin to User.
  useEffect(() => {
    if (!repoRoot && scope === "repo") setScope("user");
  }, [repoRoot, scope]);

  // "Open settings.toml" — reveal the file backing a scope in Finder
  // (the user's global one, or a repo's). Defaults to the active scope.
  // Falls back to the .aura folder if the file hasn't been written yet.
  const openSettingsToml = useCallback(
    async (which: SettingsScope = scope) => {
      try {
        const base =
          which === "repo" && activeRepoRoot
            ? activeRepoRoot
            : await api.homeDir();
        const auraDir = `${base}/.aura`;
        try {
          await api.fsRevealInFinder(`${auraDir}/settings.toml`);
        } catch {
          await api.fsRevealInFinder(auraDir);
        }
      } catch (e) {
        setError(String(e));
      }
    },
    [scope, activeRepoRoot],
  );

  // Let callers deep-link to a pane: `aura:open-settings` may carry a
  // `{ pane }` detail (e.g. the topbar avatar opens Settings → Identity).
  // App's own listener flips `open`; this one just steers the pane.
  useEffect(() => {
    function onOpen(e: Event) {
      const detail = (e as CustomEvent).detail as { pane?: PaneKey } | undefined;
      if (detail?.pane) {
        // Switch to the tab that owns the target pane, else the scope
        // filter would immediately bounce the deep-link elsewhere.
        setScope(paneScope(detail.pane));
        setPane(detail.pane);
      }
    }
    window.addEventListener("aura:open-settings", onOpen as EventListener);
    return () =>
      window.removeEventListener("aura:open-settings", onOpen as EventListener);
  }, []);

  const reload = async () => {
    try {
      setView(await api.settingsLoad());
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  };

  useEffect(() => {
    if (!open) return;
    reload();
  }, [open]);

  // Filter sidebar groups by the active scope, then the search query.
  // Scope keeps User panes and Repo panes on separate tabs; query matches
  // label + keyword bag so "vim" surfaces Behavior even though the visible
  // label doesn't contain it. Empty groups drop out.
  // Browsing is scoped to the open tab; *searching* is not.
  //
  // The tabs file each pane under the thing it configures, which is right for
  // browsing. But applying that filter to a search turns a question into a
  // lie: type "cloud" from Personal and the answer was "No settings match" —
  // when the Cloud machine pane exists, one tab over. A search that can only
  // see a third of the settings is worse than no search, because the empty
  // state reads as "this doesn't exist" rather than "not here".
  //
  // So a query searches every scope, and a hit outside the current tab is
  // labelled with the tab it lives under. Clicking it goes there.
  const filteredGroups = useMemo(() => {
    const q = query.trim().toLowerCase();
    return PANE_GROUPS.map((g) => ({
      ...g,
      items: g.items.filter((it) => {
        if (!q) return paneScope(it.id) === scope;
        return (
          it.label.toLowerCase().includes(q) ||
          it.keywords.some((k) => k.includes(q))
        );
      }),
    })).filter((g) => g.items.length > 0);
  }, [query, scope]);

  // When scope or search hides the active pane, jump to the first visible
  // match so the content area never goes blank.
  useEffect(() => {
    const visible = filteredGroups.flatMap((g) => g.items.map((it) => it.id));
    if (visible.length === 0) return;
    if (!visible.includes(pane)) setPane(visible[0]!);
  }, [filteredGroups, pane]);

  // Esc returns to the previous surface; ⌘K (⌃K) jumps to the search box.
  // Matches the dialog era's keyboard model so muscle memory is preserved.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-40 flex flex-col"
      style={{ background: "var(--color-bg-content)" }}
    >
      {/* Top bar — no title (the tabs + nav carry context, per the
          full-screen wizard doctrine). Traffic-light inset on the left
          (collapses in fullscreen), a Back affordance, the Personal /
          Organization / Repository scope tabs, and a shortcut to the raw
          settings.toml. Search lives at the top of the sidebar. */}
      <header
        data-tauri-drag-region
        onMouseDown={handleHeaderDrag}
        className="flex-shrink-0 flex items-center gap-4 border-b"
        style={{
          height: 48,
          paddingLeft: fullscreen ? 16 : 78,
          paddingRight: 12,
          background: "var(--color-bg-1)",
          borderColor: "var(--color-line-soft)",
        }}
      >
        <button
          type="button"
          onClick={onClose}
          className="flex items-center gap-1.5 text-sm text-text-3 hover:text-text-1 transition-colors"
          title="Back (Esc)"
        >
          <ArrowLeft size={14} />
          <span>Back</span>
        </button>

        {/* Personal / Organization / Repository scope — underline tabs sitting
            on the header rule. The Repository scope's project picker lives in
            the sidebar (a repo list), not here, so the header stays a clean
            three-tab strip. */}
        <nav className="flex items-stretch gap-1 h-full">
          {(["user", "org", "repo"] as SettingsScope[]).map((s) => {
            const active = scope === s;
            const disabled = s === "repo" && !repoRoot;
            return (
              <button
                key={s}
                type="button"
                disabled={disabled}
                onClick={() => setScope(s)}
                title={disabled ? "Open a project to configure it" : undefined}
                className={`relative flex items-center px-1.5 text-sm transition-colors ${
                  disabled
                    ? "text-text-5 cursor-default"
                    : active
                      ? "text-text-1 font-medium"
                      : "text-text-3 hover:text-text-1"
                }`}
              >
                {scopeLabel(s)}
                {active && (
                  <span className="absolute inset-x-0 -bottom-px h-[2px] rounded-full bg-accent" />
                )}
              </button>
            );
          })}
        </nav>

        {/* Open settings.toml — split button (Medusa button-group): the label
            reveals the active scope's file, the caret picks which one. */}
        <div className="ml-auto relative">
          <div
            className="inline-flex items-center overflow-hidden rounded-md border"
            style={{
              borderColor: "var(--color-line-soft)",
              background: "var(--color-bg-2)",
            }}
          >
            <button
              type="button"
              onClick={() => openSettingsToml()}
              className="inline-flex items-center gap-1.5 h-7 pl-2.5 pr-2 text-sm text-text-2 hover:bg-white/[0.06] hover:text-text-1 transition-colors"
              style={{ borderColor: "var(--color-line-soft)" }}
              title={`Reveal ${scope === "repo" ? "this project's" : "your"} settings.toml in Finder`}
            >
              <FileCode2 size={13} />
              <span>
                Open{" "}
                <span className="font-mono text-xs">
                  {scope === "repo" ? "settings.local.toml" : "settings.toml"}
                </span>
              </span>
            </button>
            <button
              type="button"
              onClick={() => setTomlMenu((v) => !v)}
              className="flex h-7 w-6 items-center justify-center text-text-3 hover:bg-white/[0.06] hover:text-text-1 transition-colors"
              style={{ borderLeft: "1px solid var(--color-line-soft)" }}
              aria-label="Choose settings file"
              aria-haspopup="menu"
              aria-expanded={tomlMenu}
            >
              <ChevronDown size={13} />
            </button>
          </div>
          {tomlMenu && (
            <>
              <div
                className="fixed inset-0 z-40"
                onClick={() => setTomlMenu(false)}
              />
              <div
                className="absolute right-0 z-50 mt-1.5 min-w-[220px] rounded-md border py-1 shadow-lg"
                style={{
                  background: "var(--color-bg-1)",
                  borderColor: "var(--color-line-soft)",
                }}
                role="menu"
              >
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    openSettingsToml("user");
                    setTomlMenu(false);
                  }}
                  className="flex h-7 w-full items-center gap-2 px-3 text-left text-sm text-text-2 hover:bg-state-hover hover:text-text-1 transition-colors"
                >
                  <FileCode2 size={13} className="text-text-4" />
                  <span>
                    Your <span className="font-mono text-xs">settings.toml</span>
                  </span>
                </button>
                {repoRoot && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      openSettingsToml("repo");
                      setTomlMenu(false);
                    }}
                    className="flex h-7 w-full items-center gap-2 px-3 text-left text-sm text-text-2 hover:bg-state-hover hover:text-text-1 transition-colors"
                  >
                    <FolderGit2 size={13} className="text-text-4" />
                    <span>
                      This project&rsquo;s{" "}
                      <span className="font-mono text-xs">settings.toml</span>
                    </span>
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </header>
      <div className="flex flex-1 min-h-0">
        {/* Sidebar — search on top, then grouped nav. The active row wore
            two marks for one meaning: a neutral fill AND an accent-tinted
            glyph. A neutral fill means "which part of the app" elsewhere in
            the product; "which item you are on" is the accent tint the rail
            rows, the Pages tree and the conversation tabs all use. One mark,
            and it is that one. Group labels are sentence case at 11px, on
            `.ade-sec-h`'s measurements. */}
        <aside
          className="w-[280px] shrink-0 flex flex-col border-r"
          style={{
            background: "var(--color-bg-1)",
            borderColor: "var(--color-line-soft)",
          }}
        >
          <div className="px-3 pt-3 pb-2">
            <div className="relative">
              <Search
                className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-4 pointer-events-none z-10"
                size={13}
              />
              <Input
                ref={searchRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search…"
                className="h-7 pl-7 pr-7 text-sm"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery("")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-text-4 hover:text-text-1"
                  title="Clear"
                >
                  <X size={12} />
                </button>
              )}
            </div>
          </div>
          <div className="flex-1 overflow-y-auto px-2.5 pb-3">
            {/* Repository picker — lives in the sidebar (Conductor-parity: the
                repos you can configure are listed here, not tucked in a header
                dropdown). Repository scope only; the highlighted row is the
                project the Repository panes act on. One project → a one-row
                list that names what you're editing. */}
            {scope === "repo" && activeRepoRoot && identityRoots.length > 0 && (
              <div className="mt-1 mb-1">
                <div className="text-[11px] font-medium text-text-4 px-2 pt-2 pb-1.5">
                  Repositories
                </div>
                <nav className="flex flex-col gap-1">
                  {identityRoots.map((r) => {
                    const active = r === activeRepoRoot;
                    const name = r.split("/").filter(Boolean).pop() || r;
                    return (
                      <button
                        key={r}
                        type="button"
                        onClick={() => setRepoPick(r)}
                        title={r}
                        className={`group flex items-center gap-2.5 px-2.5 h-9 text-sm rounded-md text-left transition-colors ${
                          active
                            ? "row-selected font-medium"
                            : "text-text-3 hover:text-text-1 hover:bg-state-hover"
                        }`}
                      >
                        <span
                          className={`flex-shrink-0 transition-colors [&_svg]:h-[15px] [&_svg]:w-[15px] ${
                            active ? "text-accent" : "text-text-4 group-hover:text-text-2"
                          }`}
                        >
                          <FolderGit2 />
                        </span>
                        <span className="flex-1 truncate">{name}</span>
                      </button>
                    );
                  })}
                </nav>
              </div>
            )}
            {filteredGroups.length === 0 ? (
              <div className="text-sm text-text-4 px-2 py-4">
                No settings match “{query}”.
              </div>
            ) : (
              filteredGroups.map((group, gi) => (
                <div key={group.label} className={gi > 0 ? "mt-4" : "mt-1"}>
                  {/* A heading whose only child repeats it says nothing —
                      "Team" over one row called Team. Scope and search both
                      thin groups down to one item, so this is decided per
                      render, not per group. */}
                  {!(group.items.length === 1 && group.items[0]!.label === group.label) && (
                    <div className="text-[11px] font-medium text-text-4 px-2 pt-2 pb-1.5">
                      {group.label}
                    </div>
                  )}
                  <nav className="flex flex-col gap-1">
                    {group.items.map((it) => {
                      const active = pane === it.id;
                      // Only ever set while searching, because that is the only
                      // time a row from another tab can appear in this list.
                      const itsScope = paneScope(it.id);
                      const elsewhere = itsScope !== scope;
                      return (
                        <button
                          key={it.id}
                          type="button"
                          onClick={() => {
                            // Follow the result to its own tab, otherwise the
                            // pane opens while the header still says Personal.
                            if (elsewhere) setScope(itsScope);
                            setPane(it.id);
                          }}
                          className={`group flex items-center gap-2.5 px-2.5 h-9 text-sm rounded-md text-left transition-colors ${
                            active
                              ? "row-selected font-medium"
                              : "text-text-3 hover:text-text-1 hover:bg-state-hover"
                          }`}
                        >
                          <span
                            className={`flex-shrink-0 transition-colors [&_svg]:h-[15px] [&_svg]:w-[15px] ${
                              active ? "text-accent" : "text-text-4 group-hover:text-text-2"
                            }`}
                          >
                            {it.icon}
                          </span>
                          <span className="flex-1 truncate">{it.label}</span>
                          {elsewhere && (
                            <span className="flex-shrink-0 text-[11px] text-text-4">
                              {scopeLabel(itsScope)}
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </nav>
                </div>
              ))
            )}
          </div>
        </aside>

        {/* Content pane — scrolls independently, padding tuned for full-
            page rather than dialog density.

            The pane is anchored by a real heading again. It was made
            screen-reader-only on the reasoning that the lit rail row two
            inches left already says where you are — true, but the rail is
            chrome, and a column of settings with nothing at the top of it
            starts mid-sentence. What that change actually fixed was seven
            panes each declaring their OWN title and disagreeing with the row
            you clicked. So the heading is back, and it is `paneLabel(pane)`:
            the rail's own string, read from the rail's own table. One name
            for one destination — visible now, and still impossible to
            disagree with. Panes must not print their own.

            When the pane opens with a `PaneIntro`, the heading tightens to
            sit above it as one title-and-subtitle block. */}
        <div className="flex-1 min-w-0 overflow-y-auto">
          {error && (
            <div className="text-sm text-red m-4" role="alert">
              {error}
            </div>
          )}
          <div className="max-w-[722px] px-11 pb-16 pt-9">
            <PaneHeader title={paneLabel(pane)} />
            {pane === "appearance" && <AppearanceTab />}
            {pane === "themes" && <EditorThemesTab />}
            {pane === "hud" && <HudTab />}
            {pane === "capture" && <CaptureTab repoRoot={activeRepoRoot} />}
            {pane === "behavior" && <BehaviorTab />}
            {pane === "brain" && <BrainTab />}
            {pane === "modes" && <InstalledModesPane />}
            {pane === "aurawatch" && <AuraWatchPanel repoRoot={activeRepoRoot} />}
            {pane === "keys" && view && (
              <KeysTab view={view} onChanged={reload} />
            )}
            {pane === "policy" && view && (
              <PolicyTab view={view} repoRoot={activeRepoRoot} onChanged={reload} />
            )}
            {pane === "agents" && <AgentsTab />}
            {pane === "local-models" && <LocalModelsTab />}
            {pane === "terminal" && <TerminalTab />}
            {pane === "copies" && (
              <>
                {/* Which tool a new copy opens into is a fact about the person,
                    not the repo — so it sits above the project gate and can be
                    set with nothing open. The scripts below it genuinely are
                    per-project and stay behind it. */}
                <WorkspaceLandingRow />
                {activeRepoRoot ? (
                  <RepoWorktreeSettingsPane repoRoot={activeRepoRoot} />
                ) : (
                  <div className="py-6 text-sm text-text-3">
                    Open a project to configure its setup scripts.
                  </div>
                )}
              </>
            )}
            {pane === "plugins" && <PluginsTab />}
            {pane === "mcp" && <McpServersTab repoRoot={activeRepoRoot} />}
            {pane === "integrations" && <IntegrationsTab repoRoot={activeRepoRoot} />}
            {pane === "mobile" && <MobileWaitlistTab />}
            {pane === "cloud" && <CloudRunnerPanel repoRoot={activeRepoRoot} />}
            {pane === "profiles" && <ProfilesTab repoRoot={repoRoot} />}
            {pane === "identity" && <IdentityTab repoRoots={identityRoots} />}
            {pane === "team" &&
              (activeRepoRoot ? (
                <TeamTab repoRoot={activeRepoRoot} />
              ) : (
                <div className="py-6 text-sm text-text-3">
                  Open a project to see its team.
                </div>
              ))}
            {pane === "telemetry" && <TelemetryTab />}
            {pane === "experimental" && <ExperimentalTab />}
            {pane === "help" && <HelpTab onClose={onClose} />}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Appearance ────────────────────────────────────────────────────────

function AppearanceTab() {
  const theme = useThemePreference();
  const variant = useThemeVariant();
  const fontSize = useFontSize();
  // Some packs ship dark-only palettes — picking light/system would be a
  // silent no-op (useResolvedTheme pins them to dark), so disable the
  // color-scheme picker and say why instead of letting it lie. Asked of
  // themeStore rather than restated here: this list was hand-copied and had
  // drifted to include Amber, which ships a real light palette — so light
  // mode was unreachable on the one pack everybody is on.
  const schemeDisabled = isDarkOnlyVariant(variant);
  return (
    <>
      <PaneIntro text="Customize how Aura looks on your device." />
      <Section title="Theme">
        <Row
          label="Style"
          description="The palette the whole app is painted from — window chrome, sidebar, chat and terminal all follow it."
        >
          <SegControl<ThemeVariant>
            value={variant}
            options={[
              // No "Default" row: it named the pre-redesign palette, and
              // readVariant has resolved it to Amber for as long as there has
              // been one shell — so picking it did nothing.
              { value: "amber", label: "Amber" },
              { value: "emerald", label: "Aura emerald" },
              { value: "modal", label: "Modal" },
            ]}
            onChange={setThemeVariant}
          />
        </Row>
        <Row
          label="Color scheme"
          description="Light or dark. System follows the one macOS is in, and switches with it."
          hint={schemeDisabled ? "This style ships dark-only." : undefined}
        >
          <SegControl<ThemePreference>
            value={schemeDisabled ? "dark" : theme}
            disabled={schemeDisabled}
            options={[
              { value: "dark", label: "Dark" },
              { value: "light", label: "Light" },
              { value: "system", label: "System" },
            ]}
            onChange={(next) => {
              if (schemeDisabled) return;
              setThemePreference(next);
            }}
          />
        </Row>
      </Section>
      <Section title="Editor font">
        <Row
          label="Font size"
          description="Type size in the code editor and in diffs. Terminals have their own, on the Terminal page."
        >
          <Stepper
            value={fontSize}
            onChange={(n) => setFontSize(n)}
            min={11}
            max={16}
            suffix="px"
          />
        </Row>
      </Section>
    </>
  );
}

// ── Floating HUD (⌘⇧A) ────────────────────────────────────────────────
//
// The HUD's shape is a personal preference: the bottom-center Capsule, a
// right-edge Sidebar that lives as a FAB, or a chromeless Minimal ("nerd")
// overlay. Mode + opacity persist in `~/.aura/settings.toml` via `setHudPref`
// and apply LIVE (no relaunch) — the setter pushes to the native window AND
// broadcasts `hud:settings` so a summoned HUD restyles itself instantly.
function HudTab() {
  const hud = useHudPrefs();
  // Opacity is stored as a 0.2–1.0 fraction but tuned as a friendlier percent.
  const opacityPct = Math.round(hud.opacity * 100);
  // Everything past Availability shapes a window that, with the HUD off,
  // cannot appear — the enable row says so itself: "⌘⇧A and the menu-bar
  // icon do nothing and the HUD stays hidden". The Show HUD button was
  // already gated on this; the pet, the presentation and the sizes were not,
  // so the pane sat there taking settings for something that wasn't there.
  const off = !hud.enabled;
  return (
    <>
      <PaneIntro text="The always-on-top glance summoned with ⌘⇧A. Changes apply live." />
      <Section title="Availability">
        <Toggle
          label="Enable the floating HUD"
          hint="When off, ⌘⇧A and the menu-bar icon do nothing and the HUD stays hidden. This sticks across restarts."
          value={hud.enabled}
          onChange={(v) => setHudPref("enabled", v)}
        />
        <Toggle
          label="Desk pet"
          hint="A little companion perches on the HUD and reacts to what your agents are doing. Reading while they think, working while they edit, a hop when a task finishes."
          value={hud.pet}
          onChange={(v) => setHudPref("pet", v)}
          disabled={off}
        />
        {off && (
          <div className="pb-4 text-xs text-text-4">
            The HUD is off, so the rest of this page has nothing to change
            yet. Turn it on to shape it.
          </div>
        )}
      </Section>
      <Section title="Shape">
        <Row
          label="Presentation"
          description="Capsule sits bottom-center · Sidebar docks right as a panel · Minimal drops the glass."
        >
          <SegControl<HudPresentationMode>
            value={hud.mode as HudPresentationMode}
            options={[
              { value: "capsule", label: "Capsule" },
              { value: "sidebar", label: "Sidebar" },
              { value: "minimal", label: "Minimal" },
            ]}
            onChange={(next) => setHudPref("mode", next)}
            disabled={off}
          />
        </Row>
        <Row
          label="Opacity"
          description="How much of the screen behind shows through. Below about half the HUD reads as a ghost."
        >
          <Stepper
            value={opacityPct}
            onChange={(pct) => setHudPref("opacity", pct / 100)}
            min={20}
            max={100}
            step={5}
            suffix="%"
            disabled={off}
          />
        </Row>
      </Section>
      {hud.mode === "sidebar" && (
        <Section title="Sidebar size">
          <Row
            label="Width"
            description="Panel width when the sidebar is open."
          >
            <Stepper
              value={Math.round(hud.sidebar_width)}
              onChange={(px) => setHudPref("sidebar_width", px)}
              min={240}
              max={480}
              step={10}
              suffix="px"
              disabled={off}
            />
          </Row>
          <Row
            label="Height"
            description="How far down the screen edge the panel runs."
          >
            <Stepper
              value={Math.round(hud.sidebar_height)}
              onChange={(px) => setHudPref("sidebar_height", px)}
              min={320}
              max={900}
              step={20}
              suffix="px"
              disabled={off}
            />
          </Row>
        </Section>
      )}
      <Section title="Preview">
        <Row
          label="Show the HUD"
          description="Summon it to see the current shape (also ⌘⇧A anytime)."
        >
          <Button
            size="sm"
            variant="secondary"
            disabled={!hud.enabled}
            onClick={() => void api.hudShow()}
          >
            Show HUD
          </Button>
        </Row>
      </Section>
    </>
  );
}

// ── Editor Themes (VS Code theme import) ──────────────────────────────
//
// The first concrete slice of the "plugins like a VS Code extension system"
// track: import a VS Code color theme (`*-color-theme.json`) and apply it to
// the Monaco file editor — optionally reskinning the whole app chrome from its
// palette. Parsing + conversion live in `lib/vscodeTheme.ts`; persistence +
// Monaco registration in `lib/vscodeThemesStore.ts`. This pane is just the face.

/** A few representative colors from a converted theme, for the preview chips.
 *  Monaco rule foregrounds are stored without a leading `#`; re-add it.
 *  Accepts any `ConvertedTheme` (presets) or `StoredVsTheme` (imports). */
/** Where "Find themes on the VS Code Marketplace" goes. Pre-filtered to the
 *  Themes category and sorted by installs, because the thing this pane can
 *  actually consume is a color theme's JSON, not any extension. */
const MARKETPLACE_THEMES_URL =
  "https://marketplace.visualstudio.com/search?target=VSCode&category=Themes&sortBy=Installs";

function themeSwatches(t: ConvertedTheme): string[] {
  const colors = t.monaco.colors ?? {};
  const ruleColor = (token: string): string | undefined => {
    const r = t.monaco.rules.find((x) => x.token === token && x.foreground);
    return r?.foreground ? `#${r.foreground}` : undefined;
  };
  const accent = t.cssVars["--color-accent"] ?? "#888888";
  return [
    colors["editor.background"] ?? "#000000",
    colors["editor.foreground"] ?? "#ffffff",
    ruleColor("keyword") ?? ruleColor("storage") ?? accent,
    ruleColor("string") ?? colors["editor.foreground"] ?? "#ffffff",
    ruleColor("comment") ?? "#888888",
  ];
}

function ThemeSwatchRow({ colors }: { colors: string[] }) {
  return (
    <span className="inline-flex items-center rounded overflow-hidden border border-line-soft shrink-0">
      {colors.map((c, i) => (
        <span
          key={i}
          className="h-4 w-4"
          style={{ background: c }}
          title={c}
        />
      ))}
    </span>
  );
}

function EditorThemesTab() {
  const themes = useVsCodeThemes();
  const active = useActiveVsCodeTheme();
  const applyChrome = useApplyChrome();
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [showPaste, setShowPaste] = useState(false);
  const [paste, setPaste] = useState("");

  // Themes contributed by installed extensions. The registry is normally filled
  // when a code editor mounts; load it here too so the picker is complete even
  // if the user opens Settings before opening a file, and refresh it whenever
  // the installed set changes (install/remove/toggle from the Extensions wizard).
  const installedExts = useInstalledExtensions();
  const extThemes = useExtensionThemes();
  useEffect(() => {
    void ensureExtensionThemesLoaded();
  }, [installedExts]);

  function doImport(text: string) {
    setError(null);
    setNote(null);
    const trimmed = text.trim();
    if (!trimmed) {
      setError("Nothing to import. Pick a file or paste theme JSON.");
      return;
    }
    try {
      const imported = importThemeFromText(trimmed, Date.now());
      setActiveTheme(imported.id);
      setNote(`Imported and activated “${imported.name}”.`);
      setPaste("");
      setShowPaste(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-picking the same file
    if (!file) return;
    try {
      doImport(await file.text());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <>
      <PaneIntro text="Import a VS Code color theme and apply it to the code editor." />

      <Section title="Import a theme">
        <div className="flex items-center gap-2 py-1">
          <label className="cursor-pointer">
            <input
              type="file"
              accept=".json,.jsonc,application/json"
              className="hidden"
              onChange={onFile}
            />
            <span className="inline-flex items-center gap-1.5 rounded-md border border-line bg-bg-1 px-3 py-1.5 text-sm text-text-1 hover:bg-state-hover transition-colors">
              <Upload className="h-3.5 w-3.5" />
              Import theme file…
            </span>
          </label>
          <button
            type="button"
            className="text-sm text-text-3 hover:text-text-1 transition-colors"
            onClick={() => setShowPaste((v) => !v)}
          >
            {showPaste ? "Hide paste" : "or paste JSON"}
          </button>
        </div>

        {showPaste && (
          <div className="mt-2 flex flex-col gap-2">
            <textarea
              value={paste}
              onChange={(e) => setPaste(e.target.value)}
              spellCheck={false}
              placeholder='Paste the contents of a *-color-theme.json here…'
              className="w-full h-40 bg-bg-0 border border-line rounded-md px-3 py-2 text-sm font-mono text-text-1 resize-y"
            />
            <div>
              <Button onClick={() => doImport(paste)}>Import pasted theme</Button>
            </div>
          </div>
        )}

        {note && (
          <div className="text-sm text-text-2 mt-2 flex items-center gap-1.5">
            <Check className="h-3.5 w-3.5 text-accent-green" />
            {note}
          </div>
        )}
        {error && (
          <div className="text-sm text-red mt-2" role="alert">
            {error}
          </div>
        )}
        <div className="text-xs text-text-4 mt-2 leading-relaxed">
          Find themes on the{" "}
          {/* This was a `<span className="text-text-2">` — brighter than the
              sentence around it, so it read as the link it wasn't, and
              clicking it did nothing. Anything that leaves the app has to go
              through `openExternal`; a bare `target="_blank"` is a no-op in
              the webview. */}
          <a
            href={MARKETPLACE_THEMES_URL}
            onClick={onExternalAnchorClick}
            className="text-text-2 underline decoration-line hover:decoration-text-2 underline-offset-2"
          >
            VS Code Marketplace
          </a>{" "}
          or any extension's <code className="text-text-2">themes/*.json</code>.
          Syntax colors and editor chrome are mapped onto the editor; this
          matches the common token scopes, not every grammar-specific rule.
        </div>
      </Section>

      <Section title="Built-in presets">
        <div className="text-xs text-text-4 mb-2 leading-relaxed">
          Popular published palettes, ready to apply. No download needed. Each
          is run through the same converter as an imported file, and applying
          one adds it to your themes below.
        </div>
        <div className="grid grid-cols-2 gap-2">
          {THEME_PRESETS.map((p) => {
            const isActive = active?.name === p.name;
            return (
              <button
                key={p.name}
                type="button"
                onClick={() => {
                  setError(null);
                  setNote(null);
                  applyPresetTheme(p, Date.now());
                  setNote(`Applied “${p.name}”.`);
                }}
                className={`flex items-center gap-2.5 py-2 px-2.5 rounded-md border text-left transition-colors ${
                  isActive
                    ? "border-accent bg-accent/5"
                    : "border-line hover:bg-state-hover"
                }`}
              >
                <ThemeSwatchRow colors={themeSwatches(p)} />
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-text-1 truncate">{p.name}</div>
                  <div className="text-xs text-text-4">
                    {p.isDark ? "Dark" : "Light"}
                  </div>
                </div>
                {isActive && (
                  <Check className="h-3.5 w-3.5 text-accent shrink-0" />
                )}
              </button>
            );
          })}
        </div>
      </Section>

      {extThemes.length > 0 && (
        <Section title="From your extensions">
          <div className="text-xs text-text-4 mb-2 leading-relaxed">
            Color themes from the extensions you’ve installed. Pick one to apply
            it. It joins your themes below.
          </div>
          <div className="grid grid-cols-2 gap-2">
            {extThemes.map((t) => {
              const isActive = active?.name === t.converted.name;
              return (
                <button
                  key={t.themeName}
                  type="button"
                  onClick={() => {
                    setError(null);
                    setNote(null);
                    applyPresetTheme(t.converted, Date.now());
                    setNote(`Applied “${t.converted.name}”.`);
                  }}
                  className={`flex items-center gap-2.5 py-2 px-2.5 rounded-md border text-left transition-colors ${
                    isActive
                      ? "border-accent bg-accent/5"
                      : "border-line hover:bg-state-hover"
                  }`}
                >
                  <ThemeSwatchRow colors={themeSwatches(t.converted)} />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-text-1 truncate">
                      {t.converted.name}
                    </div>
                    <div className="text-xs text-text-4 truncate">
                      {t.extName} · {t.isDark ? "Dark" : "Light"}
                    </div>
                  </div>
                  {isActive && (
                    <Check className="h-3.5 w-3.5 text-accent shrink-0" />
                  )}
                </button>
              );
            })}
          </div>
        </Section>
      )}

      {/* Titled "Active theme" until it was read on screen: the heading sat
          over eight rows, seven of them carrying an Activate button and a
          delete. It is the library — one row of it happens to be active. */}
      <Section title="Your themes">
        <ThemeChoiceRow
          name="Aura default"
          detail="GitHub-matched dark / light"
          swatches={["#0d1117", "#f0f6fc", "#ff7b72", "#a5d6ff", "#8b949e"]}
          active={active === null}
          onActivate={() => setActiveTheme(null)}
        />
        {themes.map((t) => (
          <ThemeChoiceRow
            key={t.id}
            name={t.name}
            detail={t.isDark ? "Dark" : "Light"}
            swatches={themeSwatches(t)}
            active={active?.id === t.id}
            onActivate={() => setActiveTheme(t.id)}
            onRemove={() => removeTheme(t.id)}
          />
        ))}
        {themes.length === 0 && (
          <div className="text-sm text-text-4 py-2">
            No imported themes yet. Import one above to get started.
          </div>
        )}
      </Section>

      <Section title="Scope">
        <Toggle
          label="Also reskin the whole app"
          hint="Apply the active theme's palette to Aura's chrome, not just the code editor. Turn off to keep the editor themed but the app on its own colors."
          value={applyChrome}
          onChange={setApplyChrome}
        />
        {applyChrome && active === null && (
          <div className="text-xs text-text-4 mt-1">
            No imported theme is active, so this has no effect yet.
          </div>
        )}
      </Section>

      <Section title="VS Code compatibility">
        <div className="text-sm text-text-3 leading-relaxed">
          Color themes are the first slice of broader VS Code interop. Planned
          next: LSP-backed language features (hover, completion) and a growing{" "}
          <code className="text-text-2">vscode</code>-API subset so a portion of
          simple extensions run. Running an unmodified{" "}
          <code className="text-text-2">.vsix</code> is an explicit non-goal. 
          Aura's own capability-sandboxed mini-apps are the path for richer
          surfaces.
        </div>
      </Section>
    </>
  );
}

function ThemeChoiceRow({
  name,
  detail,
  swatches,
  active,
  onActivate,
  onRemove,
}: {
  name: string;
  detail: string;
  swatches: string[];
  active: boolean;
  onActivate: () => void;
  onRemove?: () => void;
}) {
  return (
    <div
      className={`flex items-center gap-3 py-2 px-2.5 rounded-md border transition-colors ${
        active
          ? "border-accent bg-accent/5"
          : "border-transparent hover:bg-state-hover"
      }`}
    >
      <ThemeSwatchRow colors={swatches} />
      <div className="flex-1 min-w-0">
        <div className="text-sm text-text-1 truncate">{name}</div>
        <div className="text-xs text-text-4">{detail}</div>
      </div>
      {active ? (
        <span className="inline-flex items-center gap-1 text-xs text-accent shrink-0">
          <Check className="h-3.5 w-3.5" />
          Active
        </span>
      ) : (
        <Button variant="subtle" onClick={onActivate}>
          Activate
        </Button>
      )}
      {onRemove && (
        <button
          type="button"
          aria-label={`Remove ${name}`}
          className="shrink-0 text-text-4 hover:text-red transition-colors p-1"
          onClick={onRemove}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

// ── Behavior ──────────────────────────────────────────────────────────

// ── Capture (no-MCP drop-in) ──────────────────────────────────────────
//
// Passive semantic capture is on for a workspace exactly when Aura's git
// hooks are installed in it — distinct from the global ~/.aura blockstore
// that `auraStatus` reports. This pane is the desktop face of the
// frictionless `aura enable` story (the VS Code extension has the same gate,
// the CLI has the bare command): it shows whether THIS repo is capturing and
// flips it with one click, no MCP server and no wizard. Enable/disable run
// `aura enable` / `aura disable` through the CLI passthrough so the hook
// install logic lives in one place; we re-probe `captureStatus` afterward.
// `aura merge-driver --status --json` output, parsed verbatim. Lives here
// (not api.ts) because the row reuses the generic auraCli passthrough — no
// dedicated IPC command exists or is needed.
type MergeDriverStatus = {
  installed: boolean;
  driver_line: string | null;
  attributes_patterns: string[];
  aura_on_path: boolean;
};

function CaptureTab({ repoRoot }: { repoRoot: string }) {
  const [status, setStatus] = useState<CaptureStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  // Semantic merge driver row — same shape as the capture row above it:
  // probe over the CLI passthrough, flip with one click, re-probe after.
  const [merge, setMerge] = useState<MergeDriverStatus | null>(null);
  const [mergeUnavailable, setMergeUnavailable] = useState<string | null>(
    null,
  );
  // What the CLI actually said when the probe failed. The row used to
  // throw this away and assert "aura CLI is too old" for every non-zero
  // exit — a guess, printed as a fact, next to a disabled button. If the
  // real reason was something else entirely (no repo, a broken install,
  // a permissions error) nothing on screen could tell you.
  const [mergeProbeDetail, setMergeProbeDetail] = useState<string | null>(null);
  // Set when the installed CLI genuinely predates this feature, which is
  // the one case the app can fix by itself.
  const [mergeCliOutdated, setMergeCliOutdated] = useState(false);
  const [mergeBusy, setMergeBusy] = useState(false);
  const [mergeError, setMergeError] = useState<string | null>(null);
  const [updatingCli, setUpdatingCli] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setStatus(await api.captureStatus(repoRoot));
    } catch (e) {
      setError(String(e));
    }
  }, [repoRoot]);

  const refreshMerge = useCallback(async () => {
    try {
      const res = await api.auraCli(repoRoot, [
        "merge-driver",
        "--status",
        "--json",
      ]);
      if (res.status === 0) {
        setMerge(JSON.parse(res.stdout) as MergeDriverStatus);
        setMergeUnavailable(null);
        setMergeProbeDetail(null);
        setMergeCliOutdated(false);
        return;
      }
      setMerge(null);
      // A non-zero exit was being read as one thing — "too old" — because
      // that is the likeliest cause, not because anything checked. Ask the
      // question that has an answer: what version is actually installed?
      const detail = (res.stderr || res.stdout || "").trim();
      setMergeProbeDetail(detail || `aura merge-driver exited ${res.status}`);
      let outdated = false;
      try {
        outdated = (await api.auraCliVersionCheck()).status === "outdated";
      } catch {
        // The version probe is a nicety. If it fails too, the row still
        // shows the real stderr below — which is the part that matters.
      }
      setMergeCliOutdated(outdated);
      setMergeUnavailable(
        outdated
          ? "The aura command on this computer is too old for smart merge"
          : "Couldn't read the smart-merge setting",
      );
    } catch (e) {
      // Spawn failure: no `aura` on PATH at all.
      setMerge(null);
      setMergeCliOutdated(false);
      setMergeProbeDetail(e instanceof Error ? e.message : String(e));
      setMergeUnavailable("aura CLI not found");
    }
  }, [repoRoot]);

  // The one repair the app can perform itself: drop the CLI this release
  // ships with over the stale one on PATH. `interactive` authorizes the
  // macOS admin prompt when the install dir is root-owned — this is an
  // explicit click, so that is exactly right.
  async function updateCli() {
    setUpdatingCli(true);
    setMergeError(null);
    try {
      await api.auraCliInstallBundled(true);
    } catch (e) {
      setMergeError(e instanceof Error ? e.message : String(e));
    } finally {
      await refreshMerge();
      setUpdatingCli(false);
    }
  }

  useEffect(() => {
    void refresh();
    void refreshMerge();
  }, [refresh, refreshMerge]);

  async function setMergeInstalled(next: boolean) {
    setMergeBusy(true);
    setMergeError(null);
    try {
      const res = await api.auraCli(repoRoot, [
        "merge-driver",
        next ? "--install" : "--uninstall",
      ]);
      if (res.status !== 0) {
        setMergeError((res.stderr || res.stdout || "command failed").trim());
      }
    } catch (e) {
      setMergeError(String(e));
    } finally {
      await refreshMerge();
      setMergeBusy(false);
    }
  }

  async function toggle(next: boolean) {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const res = next
        ? await api.captureEnable(repoRoot)
        : await api.captureDisable(repoRoot);
      if (res.status !== 0) {
        setError((res.stderr || res.stdout || "command failed").trim());
      } else {
        // Remember an explicit choice so the auto-on path (autoCapture.ts)
        // never re-enables a repo the user deliberately turned off — and a
        // manual re-enable clears that marker.
        setCaptureOptOut(repoRoot, !next);
        const summary = (res.stdout || "").trim();
        setNote(
          summary.length > 0
            ? summary.split("\n").slice(-2).join(" ").slice(0, 200)
            : next
              ? "Capture enabled."
              : "Capture disabled.",
        );
      }
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  const on = status?.enabled ?? false;
  const isGit = status?.is_git ?? false;

  return (
    <>
      <PaneIntro text="Quietly record what changed and why in this project. No extra setup." />

      {status && !isGit && (
        <div className="text-sm text-text-3 rounded-md border border-line-soft bg-bg-2 px-3 py-2.5">
          This folder isn't a Git repository, so there's nothing to capture
          into yet. Initialize Git first, then enable capture here.
        </div>
      )}

      {isGit && (
        <Section title="This workspace">
          <div className="flex items-center gap-3 py-1.5">
            <span
              className="inline-block h-2 w-2 rounded-full shrink-0"
              style={{
                background: on
                  ? "var(--color-accent-green)"
                  : "var(--color-text-4)",
              }}
            />
            <div className="flex-1">
              <div className="text-sm text-text-1">
                {on ? "Capturing" : "Not capturing"}
              </div>
              <div className="text-xs text-text-3 leading-relaxed">
                {on
                  ? "Every time you save (commit), Aura records what changed, why, and which AI made it. Right inside your project's history."
                  : "Turn on to record what changed and why on every save. It runs quietly alongside any existing Git hooks (Husky, Lefthook) without disturbing them."}
              </div>
            </div>
            <Button
              variant={on ? "subtle" : "default"}
              disabled={busy}
              onClick={() => toggle(!on)}
            >
              {busy ? (
                <AsciiSpinner className="text-sm leading-none" />
              ) : on ? (
                "Disable"
              ) : (
                "Enable capture"
              )}
            </Button>
          </div>

          {status?.hooks_dir && (
            <div className="text-xs text-text-4 mt-1 font-mono break-all">
              hooks: {status.hooks_dir}
            </div>
          )}
          {note && <div className="text-xs text-text-3 mt-2">{note}</div>}
          {error && (
            <div className="text-xs text-red mt-2" role="alert">
              {error}
            </div>
          )}
        </Section>
      )}

      {isGit && (
        <Section title="Smart merge">
          <div className="flex items-center gap-3 py-1.5">
            <span
              className="inline-block h-2 w-2 rounded-full shrink-0"
              style={{
                background: merge?.installed
                  ? "var(--color-accent-green)"
                  : "var(--color-text-4)",
              }}
            />
            <div className="flex-1">
              <div className="text-sm text-text-1">
                {mergeUnavailable ??
                  (merge?.installed
                    ? "Smart merge is on"
                    : "Smart merge is off")}
              </div>
              <div className="text-xs text-text-3 leading-relaxed">
                When two AIs edit different functions in the same file, Aura
                merges them cleanly. No conflicts to untangle by hand.
              </div>
            </div>
            {/* A row that says "update it" and hands you a dead button is
                worse than no button. When the CLI is the problem, the
                control becomes the fix; when the reason is something else,
                the way forward is to look again after changing whatever
                the message below names. */}
            {mergeCliOutdated ? (
              <Button disabled={updatingCli} onClick={() => void updateCli()}>
                {updatingCli ? (
                  <AsciiSpinner className="text-sm leading-none" />
                ) : (
                  "Update aura"
                )}
              </Button>
            ) : mergeUnavailable !== null ? (
              <Button
                variant="subtle"
                disabled={mergeBusy}
                onClick={() => void refreshMerge()}
              >
                Try again
              </Button>
            ) : (
              <Button
                variant={merge?.installed ? "subtle" : "default"}
                disabled={mergeBusy}
                onClick={() => setMergeInstalled(!(merge?.installed ?? false))}
              >
                {mergeBusy ? (
                  <AsciiSpinner className="text-sm leading-none" />
                ) : merge?.installed ? (
                  "Uninstall"
                ) : (
                  "Install"
                )}
              </Button>
            )}
          </div>

          {mergeProbeDetail && (
            <div className="mt-1.5 max-h-20 overflow-auto rounded border border-line-soft bg-bg-1 px-2 py-1 font-mono text-[11px] leading-snug text-text-4">
              {mergeProbeDetail}
            </div>
          )}

          {merge?.installed && !merge.aura_on_path && (
            <div className="text-xs text-text-3 mt-1">
              The driver is configured but `aura` isn't on PATH. Git falls
              back to its own merge until that's fixed.
            </div>
          )}
          {merge?.installed && merge.attributes_patterns.length > 0 && (
            <div className="text-xs text-text-4 mt-1 font-mono break-all">
              {merge.attributes_patterns.join("   ")}
            </div>
          )}
          {mergeError && (
            <div className="text-xs text-red mt-2" role="alert">
              {mergeError}
            </div>
          )}
        </Section>
      )}

      <Section title="What this does">
        <ul className="text-sm text-text-3 leading-relaxed list-disc pl-4 space-y-1">
          <li>
            Installs Aura's Git hooks (pre-commit, commit-msg, post-commit,
            post-merge, pre-push). Safe to run more than once, and they leave
            any existing hooks in place.
          </li>
          <li>
            Records what changed and why straight into Git. Nothing leaves your
            machine. No cloud, no extra server.
          </li>
          <li>
            Works with whatever coding agent you run, or none at all. Turning
            it off removes the hooks; the history already recorded in Git stays
            put.
          </li>
        </ul>
        <div className="text-xs text-text-4 mt-2 leading-relaxed">
          Want the full interactive setup — API keys, baseline scan, MCP
          wiring? Run <code className="text-text-2">aura init</code> in this
          repo from a terminal.
        </div>
      </Section>
    </>
  );
}

function BehaviorTab() {
  const editor = useEditorPrefs();
  // Completion sound is backed by completionChime's own pref helpers (the
  // stored value is "on"/"off", distinct from settingsStore's prefs), so
  // the chime and this toggle always read the same flag.
  const [chime, setChime] = useState(completionSoundEnabled());
  // Message & huddle sounds share one mute flag (chime.ts), which also gates
  // the OS notification's system sound so "off" is silent on every path.
  const [msgSound, setMsgSound] = useState(!isChimeMuted());
  // Follow-up behavior lives in its own localStorage pref (composer UX, not a
  // durable TOML setting) — read once here and write through the helper, which
  // also live-notifies any open composer.
  const [followUp, setFollowUp] = useState<FollowUpBehavior>(readFollowUpBehavior);
  return (
    <>
      <PaneIntro text="How the editor and chat behave." />
      <Section title="Editor">
        <Toggle
          label="Vim keybindings"
          hint="Edit with Vim key motions. Takes effect on the next file you open."
          value={editor.vim}
          onChange={(v) => setEditorPref("vim", v)}
        />
        <Toggle
          label="Minimap"
          hint="A zoomed-out map of the file on the right edge. Always off for very large files."
          value={editor.minimap}
          onChange={(v) => setEditorPref("minimap", v)}
        />
        <Toggle
          label="Sticky scroll"
          hint="Keep the current section's header pinned at the top as you scroll past it."
          value={editor.sticky_scroll}
          onChange={(v) => setEditorPref("sticky_scroll", v)}
        />
        <Toggle
          label="Indent guides"
          hint="Faint vertical lines marking indentation depth."
          value={editor.indent_guides}
          onChange={(v) => setEditorPref("indent_guides", v)}
        />
      </Section>
      <Section title="Chat">
        <Row
          label="Follow-up behavior"
          description={
            followUp === "steer"
              ? "Sending while the agent is working interrupts it and redirects the turn with your new message. It keeps everything it's done so far."
              : "Sending while the agent is working queues your message and it runs when the current turn finishes."
          }
          hint="Tip: ⌘↵ always steers, whichever option is set here."
        >
          <SegControl<FollowUpBehavior>
            value={followUp}
            options={[
              { value: "queue", label: "Queue" },
              { value: "steer", label: "Steer" },
            ]}
            onChange={(v) => {
              setFollowUp(v);
              writeFollowUpBehavior(v);
            }}
          />
        </Row>
      </Section>
      <Section title="Notifications">
        <Toggle
          label="Completion sound"
          hint="Play a short chime when an agent finishes. Off mutes it everywhere."
          value={chime}
          onChange={(v) => {
            setCompletionSoundEnabled(v);
            setChime(v);
            if (v) playCompletionChime();
          }}
        />
        <Toggle
          label="Message & huddle sounds"
          hint="Play a soft chime for new team messages and huddles. The in-app tone while Aura is focused, the OS notification sound when it isn't. Off mutes both."
          value={msgSound}
          onChange={(v) => {
            setChimeMuted(!v);
            setMsgSound(v);
            if (v) playChime("message");
          }}
        />
      </Section>
    </>
  );
}

// ── Terminal ──────────────────────────────────────────────────────────

function TerminalTab() {
  const terminal = useTerminalPrefs();
  // Profiles + the persisted default live backend-side
  // (`cmd_terminal_profiles`, auto-seeded from `/etc/shells` + `$SHELL`),
  // not in the localStorage settings store — so this loads them directly
  // and writes the choice through the same command the `+` menu uses.
  const [profiles, setProfiles] = useState<TerminalProfile[]>([]);
  const [defaultProfileId, setDefaultProfileId] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    Promise.all([api.terminalProfileList(), api.terminalProfileDefault()])
      .then(([list, def]) => {
        if (!alive) return;
        setProfiles(list);
        setDefaultProfileId(def ?? list[0]?.id ?? null);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  function selectDefault(id: string) {
    setDefaultProfileId(id);
    api.terminalProfileSetDefault(id).catch(() => {});
  }
  return (
    <>
      <PaneIntro text="How terminal tabs behave. Changes apply to new tabs." />
      {/* This said "Profile" / "Default profile" over a list of shells, and
          the description under it already gave the game away by saying
          "shell". The `+` menu that opens these has always called them
          Shells and "Choose the Default Shell" — one list, two names, and
          the losing name collides with three other things in this same
          dialog: Accounts & profiles means a git identity and an agent HOME,
          the launcher's Profile picker means that one too. `TerminalProfile`
          stays the type's name; on screen it is a shell. */}
      <Section title="Shell">
        <Row
          label="Default shell"
          description="The shell every new terminal tab opens with."
        >
          {profiles.length > 0 ? (
            <Select
              value={defaultProfileId ?? ""}
              onChange={selectDefault}
              options={profiles.map((p) => ({ value: p.id, label: p.name }))}
              aria-label="Default shell"
              className="w-auto min-w-[160px]"
            />
          ) : (
            <span className="text-text-4 text-sm">No shells found</span>
          )}
        </Row>
      </Section>
      <Section title="Visual">
        {/* Appearance's font-size row says "the terminal keeps its own
            size", which was true and useless: the size was compiled in —
            12 on mac, 14 elsewhere — with nowhere to change it. Every other
            terminal ships this control; a pane that offers a bell and a
            cursor blink but not the type size is picking the wrong two. */}
        <Row
          label="Text size"
          description="Type size in terminal panes, including the ones agents run in."
        >
          <Stepper
            value={terminal.font_size ?? defaultTerminalFontSize()}
            onChange={(n) => setTerminalFontSize(n)}
            min={9}
            max={20}
            suffix="px"
          />
        </Row>
        <Toggle
          label="Cursor blink"
          hint="Blink the cursor in terminal panes."
          value={terminal.cursor_blink}
          onChange={(v) => setTerminalBool("cursor_blink", v)}
        />
        <Toggle
          label="Bell"
          hint="Play the system bell when a program asks for it."
          value={terminal.bell}
          onChange={(v) => setTerminalBool("bell", v)}
        />
      </Section>
      <Section title="History">
        <Row
          label="Scrollback lines"
          description="How far back a terminal remembers. More history costs more memory per open tab."
        >
          <Select
            value={String(terminal.scrollback)}
            onChange={(v) => setScrollback(Number(v))}
            options={[1000, 5000, 10000, 50000].map((n) => ({
              value: String(n),
              label: compactNumber(n),
            }))}
            aria-label="Scrollback lines"
            className="w-auto min-w-[120px]"
          />
        </Row>
      </Section>
    </>
  );
}

// ── Experimental ──────────────────────────────────────────────────────

function ExperimentalTab() {
  const flags = useFlagPrefs();
  const [glass, setGlass] = useState(sidebarGlassEnabled);
  return (
    <>
      <PaneIntro text="Preview features. May change or be removed without notice." />
      {sidebarGlassAvailable() ? (
        <Section title="Appearance">
          <Toggle
            label="Glass sidebar"
            hint="Let your desktop softly blur through the sidebar. Turn off for a plain solid background. (macOS)"
            value={glass}
            onChange={(v) => {
              setGlass(v);
              setSidebarGlass(v);
            }}
          />
        </Section>
      ) : null}
      <Section title="Aura Studio">
        <Toggle
          label="Review Changes"
          hint="Check whether a commit changed what was requested. Stage 5F WIP."
          value={flags.intent_inspector}
          onChange={(v) => setFlag("intent_inspector", v)}
        />
        <Toggle
          label="Proof trail"
          hint="See proof every change is genuine and untampered. Stage 5G WIP."
          value={flags.provenance_replay}
          onChange={(v) => setFlag("provenance_replay", v)}
        />
      </Section>
      <Section title="Manager">
        <Toggle
          label="Parallel copy per task"
          hint="Each AI works in its own isolated copy of the project, so their edits never collide. Stage 6 Track C WIP."
          value={flags.manager_worktrees}
          onChange={(v) => setFlag("manager_worktrees", v)}
        />
        <Toggle
          label="Show token savings"
          hint="Show a small estimate of the tokens Aura saved on each reply by using its code map and Q&A instead of reading whole files. It's an estimate, not an exact count."
          value={flags.show_token_savings}
          onChange={(v) => setFlag("show_token_savings", v)}
        />
        <Toggle
          label="Show token usage per message"
          hint="Under each reply, show the input and output tokens that message actually used, straight from the model. Off by default."
          value={flags.show_message_tokens}
          onChange={(v) => setFlag("show_message_tokens", v)}
        />
      </Section>
    </>
  );
}

// ── Keys ──────────────────────────────────────────────────────────────

function KeysTab({
  view,
  onChanged,
}: {
  view: SettingsView;
  onChanged: () => void;
}) {
  return (
    <Section title="Provider API keys">
      <p className="text-sm text-text-3 mb-2">
        Stored in <code>~/.aura/credentials.json</code> (mode 0600). Cleared
        keys also clear the env-var fallback from <code>aura</code>'s point
        of view.
      </p>
      <KeyRow
        provider="anthropic"
        label="Anthropic"
        last4={view.anthropic_key_last4}
        active={view.ai_provider === "anthropic"}
        onChanged={onChanged}
      />
      <KeyRow
        provider="openai"
        label="OpenAI"
        last4={view.openai_key_last4}
        active={view.ai_provider === "openai"}
        onChanged={onChanged}
      />
      <KeyRow
        provider="gemini"
        label="Gemini"
        last4={view.gemini_key_last4}
        active={view.ai_provider === "gemini"}
        onChanged={onChanged}
      />
      <KeyRow
        provider="mercury"
        label="Mercury"
        last4={view.mercury_key_last4}
        active={view.ai_provider === "mercury"}
        onChanged={onChanged}
      />
    </Section>
  );
}

function KeyRow({
  provider,
  label,
  last4,
  active,
  onChanged,
}: {
  provider: string;
  label: string;
  last4: string | null;
  active: boolean;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await api.settingsSetProviderKey(provider, value);
      setValue("");
      setEditing(false);
      onChanged();
    } finally {
      setBusy(false);
    }
  };
  const clear = async () => {
    setBusy(true);
    try {
      await api.settingsSetProviderKey(provider, "");
      onChanged();
    } finally {
      setBusy(false);
    }
  };
  const setActive = async () => {
    setBusy(true);
    try {
      await api.settingsSetActiveProvider(provider);
      onChanged();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex items-center gap-2 py-1.5 border-b border-line-soft">
      <div className="w-24 text-sm text-text-2">{label}</div>
      <div className="flex-1 min-w-0">
        {editing ? (
          <div className="flex items-center gap-1.5">
            <Input
              type="password"
              autoFocus
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="paste key…"
              onKeyDown={(e) => {
                if (e.key === "Enter" && value.trim()) save();
                if (e.key === "Escape") {
                  setEditing(false);
                  setValue("");
                }
              }}
              className="flex-1 font-mono"
            />
            <button
              type="button"
              onClick={save}
              disabled={!value.trim() || busy}
              className="text-sm px-2 py-1 rounded bg-accent-green text-bg-deep disabled:opacity-40"
            >
              save
            </button>
            <button
              type="button"
              onClick={() => {
                setEditing(false);
                setValue("");
              }}
              className="text-sm px-2 py-1 rounded text-text-3 hover:text-text-1"
            >
              cancel
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2 text-sm">
            <span className="font-mono text-text-3">
              {last4 ? `••••${last4}` : "—"}
            </span>
            {active && (
              <span className="text-2xs text-accent-green border border-accent-green/40 rounded px-1.5 py-0.5">
                active
              </span>
            )}
          </div>
        )}
      </div>
      {!editing && (
        <div className="flex items-center gap-1">
          {!active && last4 && (
            <Button
              variant="ghost"
              size="xs"
              onClick={setActive}
              disabled={busy}
              title="Set as active provider"
            >
              activate
            </Button>
          )}
          <Button
            variant="ghost"
            size="xs"
            onClick={() => setEditing(true)}
            disabled={busy}
          >
            {last4 ? "replace" : "set"}
          </Button>
          {last4 && (
            <Button
              variant="ghost"
              size="xs"
              onClick={clear}
              disabled={busy}
              className="text-red hover:text-red"
              title="Remove this key"
            >
              clear
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

// ── Policy ────────────────────────────────────────────────────────────

function PolicyTab({
  view,
  repoRoot,
  onChanged,
}: {
  view: SettingsView;
  repoRoot: string;
  onChanged: () => void;
}) {
  const strict = view.strict_gatekeeper_mode;
  const locked = view.strict_mode_locked;
  const disable = async () => {
    if (locked) return;
    if (
      !(await askConfirm({
        title: "Turn strict mode off?",
        body: "The pre-commit guard stops blocking risky changes. An agent could then delete code without accounting for it.",
        confirmLabel: "Turn it off",
        tone: "danger",
      }))
    ) {
      return;
    }
    try {
      await api.settingsDisableStrictUnlocked();
      onChanged();
    } catch (e) {
      await askNotice({ title: "Couldn't change strict mode", body: String(e) });
    }
  };
  // The one direction this pane couldn't go. Turning the guard off was a
  // click; turning it on was `aura config set strict-mode true` in a
  // terminal — which also refuses outside an interactive TTY and demands a
  // passcode, so the sentence's "(with a passcode, recommended)" was not
  // optional either. Easy to remove the protection, hard to add it, on the
  // setting the whole product is about. No confirm: switching a guard on is
  // never the dangerous direction, and it's one click back.
  const enable = async () => {
    try {
      await api.settingsEnableStrictUnlocked();
      onChanged();
    } catch (e) {
      await askNotice({ title: "Couldn't change strict mode", body: String(e) });
    }
  };
  return (
    <>
      <Section title="Strict mode">
        <Row
          label={
            <>
              Status{" "}
              {/* Colour tracks how protected the repo is, not how loud the
                  state sounds. On-and-locked is the safest this can be, so it
                  is green; it used to be red, which is the colour everything
                  else in the app uses for failure and read as an alarm about
                  the one setting that means nothing can get past the guard.
                  On-but-unlocked is amber — the protection is real but a
                  machine can still switch it off. Off is the actual risk. */}
              <StatusPill
                tone={strict ? (locked ? "green" : "amber") : "red"}
                text={locked ? "on · locked" : strict ? "on" : "off"}
              />
            </>
          }
          // What strict mode is doing right now, said in the row it belongs to
          // rather than in a loose paragraph hung underneath the section. Out
          // there it sat outside the divided list, so it read as a footnote
          // about the section instead of the description of this setting, and
          // it took the row's own bottom hairline with it.
          description={
            <>
              {locked ? (
                <>
                  Strict mode is passcode-locked. Only a human at a real
                  terminal can turn it off. Run{" "}
                  <code className="text-text-2">aura config reset-passcode</code>{" "}
                  from a real terminal.
                </>
              ) : strict ? (
                <>
                  Strict mode is on. Before every commit, Aura checks the AI
                  didn't quietly delete working code or do something different
                  from what it said, and stops the commit if it did. Anything on
                  this machine can still switch it back off — to lock it behind
                  a passcode, run{" "}
                  <code className="text-text-2">
                    aura config set strict-mode true
                  </code>{" "}
                  from a real terminal.
                </>
              ) : (
                <>
                  Strict mode is off. Turn it on and Aura stops any commit where
                  the AI deleted working code without accounting for it, or did
                  something different from what it promised. To also lock it, so
                  nothing on this machine — an agent included — can switch it
                  back off, run{" "}
                  <code className="text-text-2">
                    aura config set strict-mode true
                  </code>{" "}
                  from a real terminal and set a passcode.
                </>
              )}
            </>
          }
        >
          <div className="flex items-center gap-1.5">
            {!strict && !locked && (
              <Button variant="accentSoft" size="xs" onClick={enable}>
                Turn on
              </Button>
            )}
            {strict && !locked && (
              <Button
                variant="ghost"
                size="xs"
                onClick={disable}
                className="text-red hover:text-red"
              >
                disable
              </Button>
            )}
          </div>
        </Row>
      </Section>
      {/* There used to be a second telemetry switch here — "Anonymous
          telemetry", hinted "Per-command usage counts." It was the SAME
          boolean as Telemetry → Usage analytics: `settings_set_telemetry`
          and `telemetry_set_consent` both write `telemetry_enabled` into
          ~/.aura/credentials.json. Two rows, two names, two descriptions,
          one value — and neither read the other, so flipping this one left
          the other still reading ON until its own fetch reran. On a privacy
          control that is the worst possible failure: you turn it off, you
          see something that looks like it's still on, and you can't tell
          which is true. telemetry.rs already knew, in a comment: "the
          Settings → Privacy toggle, which wrote `telemetry_enabled` alone".
          It self-healed the consent marker and left the second switch.

          One switch now, in the Telemetry tab, beside the crash-report
          switch it shares a decision with and above the counts view that
          shows what's been recorded. */}
      {/* Both of these described themselves in terms of the machinery rather
          than the consequence, and both descriptions were wrong about the
          consequence — see each hint. Checked against the code that reads the
          flags: aura-cli/src/embeddings.rs and, for dev mode,
          security.rs + main.rs (secret guard, taste gate) + ci.rs. */}
      <Section title="Advanced">
        <Toggle
          label="Keep search on this machine"
          /* Was: "Force 100% offline embeddings (slower; requires sovereign
             embedding daemon)." Both parenthetical claims were false. The
             local path is `embed_local` — a trigram feature hash running
             in-process, so there is no daemon to require, and it is not
             slower than an HTTPS round trip with an 8-second timeout. It
             tells you a privacy control costs speed and needs infrastructure
             you don't have, which are two reasons not to turn on the private
             option. What it actually trades is precision. */
          hint="To search by meaning, Aura sends your text to OpenAI or Gemini to read. Turn this on and it never leaves this machine. Aura matches with its own built-in method instead, which is less precise but sends nothing anywhere."
          value={view.use_local_embeddings}
          onChange={async (v) => {
            await api.settingsSetLocalEmbeddings(v);
            onChanged();
          }}
        />
        <Toggle
          label="Dev mode"
          /* Was: "Bypass heavy infrastructure for local development. Off in
             production." There is no production — this is an app on your
             desk — and "heavy infrastructure" is three specific guards, one
             of which is the thing that stops you committing an API key.
             A switch that turns off a secret guard has to say so. The name
             stays "Dev mode" because that's what the CLI calls it, and one
             more name for one thing is what the last two commits were for. */
          hint="Trades Aura's checks for speed on a machine only you use. Aura stops blocking commits that look like they contain a secret, skips the house-style check, and sets up one local key instead of the full recovery-key set."
          value={view.dev_mode}
          onChange={async (v) => {
            await api.settingsSetDevMode(v);
            onChanged();
          }}
        />
      </Section>
      <WorktreesSection view={view} onChanged={onChanged} />
      <TemplatesSection repoRoot={repoRoot} />
    </>
  );
}

// Worktree base-path override. Default is ~/.aura/worktrees; teams with
// external SSDs or repository-adjacent layouts can point Aura elsewhere
// so per-task worktrees land in a project-organised location.
function WorktreesSection({
  view,
  onChanged,
}: {
  view: SettingsView;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const current = view.worktree_base_path;
  async function pick() {
    setBusy(true);
    try {
      const { pickPath } = await import("../../lib/nativeDialog");
      const picked = await pickPath({
        directory: true,
        multiple: false,
        title: "Choose parallel-copy base folder",
        defaultPath: current ?? undefined,
      });
      if (typeof picked === "string" && picked.length > 0) {
        await api.settingsSetWorktreeBase(picked);
        onChanged();
      }
    } finally {
      setBusy(false);
    }
  }
  async function reset() {
    setBusy(true);
    try {
      await api.settingsSetWorktreeBase("");
      onChanged();
    } finally {
      setBusy(false);
    }
  }
  return (
    <Section title="Parallel copies">
      <Row
        label="Base folder"
        description="Where Aura keeps your parallel copies. Each task gets its own folder here, so agents can work side by side without stepping on each other. Pick any folder you can write to — Aura creates it the first time it’s needed."
      >
        <div className="flex items-center gap-1.5">
          <code
            className="text-sm text-text-2 truncate max-w-[260px]"
            title={current ?? "~/.aura/worktrees"}
          >
            {current ?? "~/.aura/worktrees (default)"}
          </code>
          <Button variant="ghost" size="xs" onClick={pick} disabled={busy}>
            choose…
          </Button>
          {current && (
            <Button variant="ghost" size="xs" onClick={reset} disabled={busy}>
              reset
            </Button>
          )}
        </div>
      </Row>
    </Section>
  );
}

// Pre-built rule packs from `aura policy list --json`. Mirrors Graphite
// Diamond's template library (OWASP / Airbnb / Google / PEP) but layered on
// top of Aura's structured invariant rules instead of prose. Install button
// shells `aura policy add <id>` which merges into production.aura.json.
function TemplatesSection({ repoRoot }: { repoRoot: string }) {
  const [packs, setPacks] = useState<PackDescriptor[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // Which packs this repo already has is read off `production.aura.json` by
  // the CLI, not remembered here — a Set seeded empty made every pack look
  // uninstalled on open, however many were already merged.
  const load = useCallback(async () => {
    try {
      const res = await api.auraCli(repoRoot, ["policy", "list", "--json"]);
      const out = res.stdout.trim();
      if (!out) {
        setError(res.stderr.trim() || `exit ${res.status}`);
        // Otherwise the spinner runs under the error message forever.
        setPacks([]);
        return;
      }
      setPacks(JSON.parse(out) as PackDescriptor[]);
    } catch (e) {
      setError(String(e));
      setPacks([]);
    }
  }, [repoRoot]);

  useEffect(() => {
    void load();
  }, [load]);

  const install = async (pack: PackDescriptor) => {
    setBusy(pack.id);
    setError(null);
    setToast(null);
    try {
      const res = await api.auraCli(repoRoot, ["policy", "add", pack.id]);
      if (res.status !== 0) {
        setError(res.stderr.trim() || `exit ${res.status}`);
      } else {
        setToast(`${pack.label} merged into production.aura.json`);
        setTimeout(() => setToast(null), 3000);
        // Re-read rather than assume: `policy add` can no-op on an unknown
        // id, and the file is the authority on what this repo enforces.
        await load();
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Section title="Rule template library">
      <p className="text-sm text-text-3 mb-2 leading-relaxed">
        Pre-built invariant packs. Install merges into{" "}
        <code className="text-text-2">production.aura.json</code> at the repo
        root. Layered packs additively. Install several to compose.
      </p>
      {error && <div role="alert" className="text-sm text-red mb-2">{error}</div>}
      {toast && <div className="text-sm text-accent-green mb-2">✓ {toast}</div>}
      {packs === null ? (
        <div className="flex items-center gap-1.5 text-sm text-text-4 py-2" role="status">
          <AsciiSpinner className="text-sm leading-none" />
          Loading rule packs…
        </div>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {packs.map((p) => (
            <li
              key={p.id}
              className="flex items-start gap-2 px-2.5 py-2 rounded border border-line-soft bg-bg-1"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-0.5">
                  <span className="text-sm text-text-1 font-medium">
                    {p.label}
                  </span>
                  <span className="text-2xs px-1.5 py-0.5 rounded bg-bg-2 text-text-3">
                    {p.category}
                  </span>
                  <span className="text-2xs text-text-4">
                    {p.rule_count} rules
                  </span>
                </div>
                <div className="text-xs text-text-3 leading-relaxed">
                  {p.description}
                </div>
              </div>
              {p.installed ? (
                // Not a button. Installing a pack that's already in full is a
                // no-op now that the merge dedupes, so offering "re-install"
                // was offering nothing — and it was offered because the pane
                // had no idea the pack was there.
                <span className="text-xs text-accent-green shrink-0 py-0.5">
                  ✓ installed
                </span>
              ) : (
                <Button
                  variant="ghost"
                  size="xs"
                  disabled={busy === p.id}
                  onClick={() => install(p)}
                  title={`aura policy add ${p.id}`}
                >
                  {busy === p.id ? "installing…" : "install"}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

// ── Telemetry ─────────────────────────────────────────────────────────

function TelemetryTab() {
  const [view, setView] = useState<TelemetryView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = async () => {
    try {
      setView(await api.settingsTelemetryShow());
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  };
  useEffect(() => {
    reload();
  }, []);
  return (
    <>
      <TelemetrySharingSection />
      <TelemetryLocalCounts view={view} error={error} reload={reload} />
    </>
  );
}

// The cloud-sharing consent (PostHog EU). Two independent switches mirroring
// the first-run prompt; persisted in credentials.json via telemetry.rs, which
// gates every event on them. Saving here also marks consent "decided" so the
// launch prompt won't reappear.
function TelemetrySharingSection() {
  const [consent, setConsent] = useState<TelemetryConsent | null>(null);
  useEffect(() => {
    api
      .telemetryConsentGet()
      .then(setConsent)
      .catch(() => setConsent(null));
  }, []);
  const apply = async (product: boolean, crash: boolean) => {
    const next = await api.telemetrySetConsent(product, crash);
    setConsent(next);
  };
  return (
    <Section title="Share with Aura">
      <p className="text-sm text-text-3 mb-2">
        Anonymous only, never your code, files, what you type, or your name. We
        use it to see which features help and to fix crashes. Change it anytime.
      </p>
      <Toggle
        label="Crash reports"
        hint="Tells us when Aura breaks so we can fix it. The most useful to leave on."
        value={consent?.crash ?? true}
        onChange={(v) => apply(consent?.product ?? true, v)}
      />
      {/* This one switch is the whole of it. It gates the desktop's PostHog
          events AND the `aura` command-line tool's own ping — `track_event`
          in aura-cli/src/main.rs reads the same `telemetry_enabled` out of
          the same credentials.json — so the hint has to name both, or
          turning it off looks narrower than it is. */}
      <Toggle
        label="Usage analytics"
        hint="Counts of which features get opened, and which commands the aura command-line tool runs. Counts only, never your code, file paths, or anything you type. Sent with a fixed anonymous ID, not your name."
        value={consent?.product ?? true}
        onChange={(v) => apply(v, consent?.crash ?? true)}
      />
    </Section>
  );
}

function TelemetryLocalCounts({
  view,
  error,
  reload,
}: {
  view: TelemetryView | null;
  error: string | null;
  reload: () => void;
}) {
  const total = useMemo(() => {
    if (!view) return 0;
    return Object.values(view.counts).reduce((a, b) => a + b, 0);
  }, [view]);
  const sorted = useMemo(() => {
    if (!view) return [];
    return Object.entries(view.counts).sort((a, b) => b[1] - a[1]);
  }, [view]);
  return (
    <Section title="Anonymous usage">
      {error && <div role="alert" className="text-sm text-red mb-2">{error}</div>}
      {view ? (
        view.enabled ? (
          <>
            <Row label="Status">
              <StatusPill tone="muted" text={`${total} events`} />
            </Row>
            {view.last_updated && (
              <Row label="Last updated">
                <span className="text-sm text-text-3">
                  {new Date(view.last_updated * 1000).toLocaleString()}
                </span>
              </Row>
            )}
            {sorted.length > 0 ? (
              <ul className="text-sm font-mono mt-2 max-h-64 overflow-auto">
                {sorted.map(([k, v]) => (
                  <li
                    key={k}
                    className="flex items-center justify-between py-0.5 border-b border-line-soft"
                  >
                    <span className="text-text-2">{k}</span>
                    <span className="text-text-3 tabular-nums">{v}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-text-4 mt-2">
                No events recorded yet.
              </p>
            )}
            <div className="flex justify-end mt-3">
              <Button
                variant="ghost"
                size="xs"
                onClick={async () => {
                  if (
                    !(await askConfirm({
                      title: "Clear local telemetry counters?",
                      body: "The counts Aura keeps on this machine go back to zero.",
                      confirmLabel: "Clear",
                      tone: "danger",
                    }))
                  )
                    return;
                  await api.settingsTelemetryClear();
                  reload();
                }}
                className="text-red hover:text-red"
              >
                clear counters
              </Button>
            </div>
          </>
        ) : (
          <p className="text-sm text-text-3">
            Telemetry is disabled. Toggle it on under <em>Policy &rarr; Telemetry</em>.
          </p>
        )
      ) : (
        <div className="flex items-center gap-1.5 text-sm text-text-4" role="status">
          <AsciiSpinner className="text-sm leading-none" />
          Loading what Aura has sent…
        </div>
      )}
    </Section>
  );
}

// ── Help & Support ─────────────────────────────────────────────────────
//
// One calm place for the things people hunt for when they're stuck:
// the keyboard map, the docs/repo/issue links, and which build they're
// running. The shortcut rows come from the shared `lib/shortcuts` map —
// the same source the ⌘/ cheat-sheet reads — so the two never drift.

const HELP_LINKS: Array<{
  label: string;
  hint: string;
  url: string;
  icon: React.ReactNode;
}> = [
  {
    label: "Documentation",
    hint: "Guides, concepts, and the semantic-engine reference",
    url: "https://auravcs.com/learn/",
    icon: <BookOpen className="h-4 w-4" aria-hidden />,
  },
  {
    label: "Source on GitHub",
    hint: "github.com/Naridon-Inc/aura. Fully open source",
    url: "https://github.com/Naridon-Inc/aura",
    icon: <ExternalLink className="h-4 w-4" aria-hidden />,
  },
  {
    label: "Report an issue",
    hint: "File a bug or request a feature",
    url: "https://github.com/Naridon-Inc/aura/issues/new",
    icon: <Bug className="h-4 w-4" aria-hidden />,
  },
  {
    label: "Discussions",
    hint: "Ask questions and share workflows with the community",
    url: "https://github.com/Naridon-Inc/aura/discussions",
    icon: <MessageCircle className="h-4 w-4" aria-hidden />,
  },
];

async function openHelpUrl(url: string) {
  try {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } catch (e) {
    console.warn("openUrl failed:", e);
  }
}

// A shortcut combo split into key caps, each our shared `Kbd` so every hint in
// the app reads identically.
//
// The split is `comboKeys`, beside the shortcut map. It used to be `[...combo]`
// right here — one cap per code point, which is fine for an alphabet of single
// letters and wrong the moment a combo names a whole key: "⌘⇧Enter" came out as
// seven boxes spelling ⌘ ⇧ E n t e r. There were three copies of that split in
// the tree; this was one of them.
function KbdCombo({ combo }: { combo: string }) {
  return (
    <span className="inline-flex items-center gap-0.5">
      {comboKeys(combo).map((cap, i) => (
        <Kbd key={i}>{cap}</Kbd>
      ))}
    </span>
  );
}

function HelpTab({ onClose }: { onClose: () => void }) {
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const { getVersion } = await import("@tauri-apps/api/app");
        const v = await getVersion();
        if (alive) setVersion(v);
      } catch {
        // dev/browser fallback — leave version unknown rather than guess
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div>
      <Section title="Getting started">
        <button
          type="button"
          onClick={() => {
            onClose();
            window.dispatchEvent(new Event("aura:start-tour"));
          }}
          className="group flex w-full items-center gap-3 rounded-md px-2 py-2 text-left hover:bg-state-hover transition-colors"
        >
          <span className="shrink-0 text-accent">
            <Sparkles className="h-4 w-4" aria-hidden />
          </span>
          <span className="flex-1 min-w-0">
            <span className="block text-base text-text-1">
              Take the tour
            </span>
            <span className="block text-xs text-text-4 truncate">
              A 60-second walkthrough of what Aura does and where things live.
            </span>
          </span>
        </button>
      </Section>

      <Section title="Keyboard shortcuts">
        {/* Grouped, and the groups carry their scope. This was one flat list
            of every binding in the app, which read fine while every binding
            was global. It isn't any more: `Enter` opens a task on a focused
            card and builds a plan on a plan card, and printed side by side
            with no heading they look like a contradiction. So the same
            shape the ⌘/ sheet uses — heading, scope note, rows. */}
        <div className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2">
          {SHORTCUT_GROUPS.map((group) => (
            <section key={group.title} className="flex flex-col">
              <h4 className="section-label pb-1">{group.title}</h4>
              {group.note ? (
                <p className="-mt-0.5 pb-1 text-xs text-text-4">{group.note}</p>
              ) : null}
              {group.items.map((s) => (
                // Keyed by label: two groups bind Enter, two bind Esc.
                <div
                  key={s.label}
                  className="flex items-center justify-between gap-3 border-b border-line-soft/40 py-1.5 last:border-b-0"
                >
                  <span className="text-sm text-text-2">{s.label}</span>
                  <KbdCombo combo={s.keys} />
                </div>
              ))}
            </section>
          ))}
        </div>
        <p className="mt-2 text-xs text-text-4">
          Press <KbdCombo combo="⌘K" /> any time to search every command, file,
          and agent action.
        </p>
      </Section>

      <Section title="Resources">
        <div className="flex flex-col gap-1">
          {HELP_LINKS.map((l) => (
            <button
              key={l.label}
              type="button"
              onClick={() => void openHelpUrl(l.url)}
              className="group flex items-center gap-3 rounded-md px-2 py-2 text-left hover:bg-state-hover transition-colors"
            >
              <span className="shrink-0 text-text-3 group-hover:text-accent">
                {l.icon}
              </span>
              <span className="flex-1 min-w-0">
                <span className="block text-base text-text-1">
                  {l.label}
                </span>
                <span className="block text-xs text-text-4 truncate">
                  {l.hint}
                </span>
              </span>
              <ExternalLink
                className="h-3.5 w-3.5 shrink-0 text-text-4 opacity-0 group-hover:opacity-100 transition-opacity"
                aria-hidden
              />
            </button>
          ))}
        </div>
      </Section>

      {/* Facts, not settings. These were two setting rows — a hundred pixels
          of air each to carry one version number and three words — which said
          "there is something here to change" about the only part of this pane
          you can't. A key/value table states them in the space they're worth
          and keeps the row rhythm meaning what it means everywhere else. */}
      <Section title="About">
        <KeyValueTable
          rows={[
            {
              key: "version",
              label: "Version",
              value: version ? `v${version}` : "—",
              mono: true,
            },
            { key: "surfaces", label: "Runs on", value: "CLI · Desktop · Cloud" },
            { key: "licence", label: "Licence", value: "Open source, under the Naridon umbrella" },
          ]}
        />
        <p className="mt-3 max-w-[520px] text-[13px] leading-relaxed text-text-4">
          Aura watches every change the way a careful teammate would. It sees
          what each edit means, checks it still matches what you asked for, and
          lets you bring back a single piece if something breaks.
        </p>
      </Section>
    </div>
  );
}

// ── Profiles ─────────────────────────────────────────────────────────────
//
// Two stacks share this pane:
//   • Agent profiles  — named ~/.aura/agent-profiles/<name>/ dirs swapped
//     in as HOME for the child PTY. Lets the user run multiple Claude
//     accounts side-by-side.
//   • Git profiles    — named {user_name,user_email,signing_key?} bound
//     to the current workspace. PTY spawn injects GIT_AUTHOR_* /
//     GIT_COMMITTER_* env so the agent's commits carry the right
//     identity without touching .git/config.
//
// The binding is workspace-scoped (per-repo file wins, then global
// path-map fallback) — set here so it persists across reopens.

function ProfilesTab({ repoRoot }: { repoRoot: string }) {
  const [agentProfiles, setAgentProfiles] = useState<AgentProfile[]>([]);
  const [gitProfiles, setGitProfiles] = useState<GitProfile[]>([]);
  const [binding, setBinding] = useState<WorkspaceBinding>({});
  const [bindingScope, setBindingScope] = useState<"repo" | "global">("repo");
  const [newAgentName, setNewAgentName] = useState("");
  const [editingGit, setEditingGit] = useState<GitProfile | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const [aps, gps, b] = await Promise.all([
        api.agentProfileList(),
        api.gitProfileList(),
        repoRoot ? api.workspaceProfileGet(repoRoot) : Promise.resolve({} as WorkspaceBinding),
      ]);
      setAgentProfiles(aps);
      setGitProfiles(gps);
      setBinding(b ?? {});
      if (b?.source === "global") setBindingScope("global");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [repoRoot]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function createAgentProfile() {
    const name = newAgentName.trim();
    if (!name || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.agentProfileCreate(name);
      setNewAgentName("");
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function deleteAgentProfile(name: string) {
    if (
      !(await askConfirm({
        title: `Delete profile "${name}"?`,
        body: `This removes ~/.aura/agent-profiles/${name}/. Every agent sign-in kept inside it (Claude tokens, Gemini config, and the rest) goes with it. You'll have to sign those agents in again.`,
        confirmLabel: "Delete profile",
        tone: "danger",
      }))
    )
      return;
    setBusy(true);
    try {
      await api.agentProfileDelete(name);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function saveGitProfile(p: GitProfile) {
    setBusy(true);
    setError(null);
    try {
      await api.gitProfileUpsert(p);
      setEditingGit(null);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function deleteGitProfile(id: string) {
    if (
      !(await askConfirm({
        title: `Delete git profile "${id}"?`,
        body: "The name and email it commits under are forgotten. This can't be undone.",
        confirmLabel: "Delete profile",
        tone: "danger",
      }))
    )
      return;
    setBusy(true);
    try {
      await api.gitProfileDelete(id);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function saveBinding(next: WorkspaceBinding) {
    if (!repoRoot) return;
    setBusy(true);
    setError(null);
    try {
      const resolved = await api.workspaceProfileSet(repoRoot, next, bindingScope);
      setBinding(resolved ?? {});
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PaneIntro text="Isolated agent logins and per-workspace git identities." />
      {error && (
        <div className="text-red text-xs px-3 py-2 bg-red/10 rounded border border-red/30">
          {error}
        </div>
      )}

      <Section
        title={
          repoRoot
            ? `This workspace · ${shortPath(repoRoot)}`
            : "This workspace"
        }
      >
        {repoRoot && (
          <div className="flex flex-col gap-3">
            <LabeledRow label="Git identity">
              <Select
                value={binding.git_profile_id ?? "__none__"}
                onChange={(v) =>
                  void saveBinding({
                    ...binding,
                    git_profile_id: v === "__none__" ? null : v,
                  })
                }
                options={[
                  {
                    value: "__none__",
                    // Was "(none. Use system default)" — "system default"
                    // is the name of the mechanism, not of the thing that
                    // ends up on your commits.
                    label: "This computer's git identity",
                  },
                  ...gitProfiles.map((p) => ({
                    value: p.id,
                    label: `${p.label} · ${p.user_email}`,
                  })),
                ]}
                aria-label="Git identity"
                className="min-w-[200px]"
              />
            </LabeledRow>
            <LabeledRow label="Default agent profile">
              <Select
                value={binding.agent_profile_name ?? "__none__"}
                onChange={(v) =>
                  void saveBinding({
                    ...binding,
                    agent_profile_name: v === "__none__" ? null : v,
                  })
                }
                options={[
                  {
                    value: "__none__",
                    // "(none. Inherit system HOME)" describes an environment
                    // variable. What it means to the reader is that agents
                    // sign in as they already are.
                    label: "Your normal agent logins",
                  },
                  ...agentProfiles.map((p) => ({
                    value: p.name,
                    label: p.label ?? p.name,
                  })),
                ]}
                aria-label="Default agent profile"
                className="min-w-[200px]"
              />
            </LabeledRow>
            <LabeledRow label="Where to save">
              {/* The choice is real and worth making — one answer travels to
                  your teammates in the repo, the other never leaves this
                  machine. It was written as "Repo file (.aura/profile.json)"
                  vs "Global path map", which names the two files and says
                  nothing about the consequence. And both radios drew in the
                  OS blue because they were bare inputs; every other choice
                  control in the app is brand green. */}
              <div className="flex items-center gap-3 text-sm">
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="radio"
                    name="bindscope"
                    className="accent-accent"
                    checked={bindingScope === "repo"}
                    onChange={() => setBindingScope("repo")}
                  />
                  With the project
                </label>
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="radio"
                    name="bindscope"
                    className="accent-accent"
                    checked={bindingScope === "global"}
                    onChange={() => setBindingScope("global")}
                  />
                  Only on this computer
                </label>
              </div>
            </LabeledRow>
            {/* "(loaded from repo)" sat inline with the radios, so the word
                naming a file competed with the two choices. It belongs under
                them, and it should say what saving there means. */}
            <p className="text-[13px] text-text-4 leading-relaxed">
              {binding.source === "repo"
                ? "Saved with the project, so it travels to anyone who clones it."
                : binding.source === "global"
                  ? "Saved on this computer only. Your teammates keep their own."
                  : "Nothing saved for this project yet."}
            </p>
          </div>
        )}
      </Section>

      <Section title="Agent profiles">
        <div className="flex flex-col gap-1.5">
          {agentProfiles.length === 0 && (
            <div className="text-sm text-text-4">No profiles yet.</div>
          )}
          {agentProfiles.map((p) => (
            <div
              key={p.name}
              className="flex items-center gap-2 px-2.5 py-1.5 rounded border border-line-soft bg-bg-2"
            >
              <span className="font-medium text-base text-text-1">
                {p.label ?? p.name}
              </span>
              <span className="text-xs text-text-4 font-mono">
                ~/.aura/agent-profiles/{p.name}
              </span>
              <button
                type="button"
                onClick={() => void deleteAgentProfile(p.name)}
                disabled={busy}
                className="ml-auto h-6 px-2 rounded text-xs text-red hover:bg-red/10 transition-colors"
              >
                Delete
              </button>
            </div>
          ))}
        </div>
        <div className="flex items-center gap-2 mt-3">
          <Input
            value={newAgentName}
            onChange={(e) => setNewAgentName(e.target.value)}
            // A placeholder is the one chance to say what belongs here.
            // "new-profile-name" restates the field's own name and its
            // hyphens read as a format requirement.
            placeholder="work, personal, a client's name…"
            onKeyDown={(e) => {
              if (e.key === "Enter") void createAgentProfile();
            }}
            className="max-w-[240px]"
          />
          <Button
            onClick={() => void createAgentProfile()}
            disabled={!newAgentName.trim() || busy}
            size="sm"
          >
            + Create profile
          </Button>
        </div>
      </Section>

      <Section title="Git identities">
        <div className="flex flex-col gap-1.5">
          {gitProfiles.length === 0 && (
            <div className="text-sm text-text-4">No git profiles yet.</div>
          )}
          {gitProfiles.map((p) => (
            <div
              key={p.id}
              className="flex items-center gap-2 px-2.5 py-1.5 rounded border border-line-soft bg-bg-2"
            >
              <div className="flex flex-col">
                <span className="font-medium text-base text-text-1">
                  {p.label}
                </span>
                <span className="text-xs text-text-4">
                  {p.user_name} &lt;{p.user_email}&gt;
                  {p.signing_key && (
                    <span className="ml-2 font-mono">key: {p.signing_key}</span>
                  )}
                </span>
              </div>
              <div className="ml-auto flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => setEditingGit(p)}
                  className="h-6 px-2 rounded text-xs text-text-2 hover:bg-state-hover"
                >
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() => void deleteGitProfile(p.id)}
                  disabled={busy}
                  className="h-6 px-2 rounded text-xs text-red hover:bg-red/10"
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
        <div className="mt-3">
          <Button
            onClick={() =>
              setEditingGit({
                id: "",
                label: "",
                user_name: "",
                user_email: "",
                signing_key: null,
              })
            }
            size="sm"
          >
            + Add git identity
          </Button>
        </div>
        {editingGit && (
          <GitProfileEditor
            initial={editingGit}
            existingIds={new Set(gitProfiles.map((p) => p.id))}
            onCancel={() => setEditingGit(null)}
            onSave={(p) => void saveGitProfile(p)}
            busy={busy}
          />
        )}
      </Section>
    </>
  );
}
// ── Identity tab (II.9) ───────────────────────────────────────────────
//
// Surfaces the per-repo identity override map + the alias-augmented
// roster for the current repo. Two concerns intentionally co-located so
// a user fixing "messages don't appear under @mck" doesn't have to
// bounce between two panes:
//   1. Per-repo override map — list every repo on this device that has
//      a stored override, with a "Set as default for this repo" button
//      pinned to `repoRoot`.
//   2. Roster identities — every claimed team member in the current
//      repo's manifest, plus their `also_emails`. Admins (or the
//      handle's owner) can add / remove aliases inline; non-admins see
//      the list read-only with a tooltip explaining the gate.
//
// The current implementation keeps both surfaces flat — no nested
// dialogs — because the typical interaction is "I have one or two
// repos with an override, and I want to verify the alias on my own
// handle". Anything heavier would be over-engineered for the volume.

function IdentityTab({ repoRoots }: { repoRoots: string[] }) {
  // "This is me" — the multi-repo, confusion-aware identity surface.
  // Each open git project gets one calm row; the user confirms who they
  // are per repo (a different git email per project is common). Never a
  // silent merge, always one click. Replaces the old single-repo form.
  return (
    <>
      <PaneIntro text="Each project can use a different git email. Confirm who you are in each." />
      <IdentityPanel repoRoots={repoRoots} />
    </>
  );
}

function LabeledRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-3">
      <span className="text-sm text-text-2 min-w-[140px]">{label}</span>
      {children}
    </div>
  );
}

function GitProfileEditor({
  initial,
  existingIds,
  onCancel,
  onSave,
  busy,
}: {
  initial: GitProfile;
  existingIds: Set<string>;
  onCancel: () => void;
  onSave: (p: GitProfile) => void;
  busy: boolean;
}) {
  const [draft, setDraft] = useState<GitProfile>(initial);
  const isNew = !existingIds.has(initial.id);
  const idCollision =
    isNew && draft.id.trim().length > 0 && existingIds.has(draft.id.trim());

  return (
    <div
      className="mt-3 p-3 rounded border border-line-soft bg-bg-1 flex flex-col gap-2"
      onKeyDown={(e) => {
        if (e.key === "Escape") onCancel();
      }}
    >
      <LabeledRow label="Profile id">
        <Input
          value={draft.id}
          onChange={(e) =>
            setDraft({ ...draft, id: e.target.value.replace(/\s+/g, "-") })
          }
          placeholder="work, personal, client-acme"
          disabled={!isNew}
          className="max-w-[260px]"
        />
        {idCollision && (
          <span className="text-red text-xs ml-2">
            id already in use
          </span>
        )}
      </LabeledRow>
      <LabeledRow label="Label">
        <Input
          value={draft.label}
          onChange={(e) => setDraft({ ...draft, label: e.target.value })}
          placeholder="Work. TouchStage"
          className="max-w-[320px]"
        />
      </LabeledRow>
      <LabeledRow label="user.name">
        <Input
          value={draft.user_name}
          onChange={(e) => setDraft({ ...draft, user_name: e.target.value })}
          className="max-w-[320px]"
        />
      </LabeledRow>
      <LabeledRow label="user.email">
        <Input
          value={draft.user_email}
          onChange={(e) => setDraft({ ...draft, user_email: e.target.value })}
          className="max-w-[320px]"
        />
      </LabeledRow>
      <LabeledRow label="Signing key (optional)">
        <Input
          value={draft.signing_key ?? ""}
          onChange={(e) =>
            setDraft({ ...draft, signing_key: e.target.value || null })
          }
          placeholder="GPG key id or SSH pubkey path"
          className="max-w-[320px]"
        />
      </LabeledRow>
      <div className="flex items-center gap-2 mt-1">
        <Button
          onClick={() => onSave(draft)}
          disabled={
            busy ||
            !draft.id.trim() ||
            !draft.user_name.trim() ||
            !draft.user_email.trim() ||
            idCollision
          }
          size="sm"
        >
          Save
        </Button>
        <Button onClick={onCancel} variant="ghost" size="sm">
          Cancel
        </Button>
      </div>
    </div>
  );
}
