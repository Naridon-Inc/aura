// Aura settings — single dialog, sidebar-grouped panes. Layout
// repurposed from superset.sh's settings shell (two-column: grouped
// sidebar nav + content pane + per-section search). Replaces the
// "edit ~/.aura/credentials.json by hand" + "set env vars in your
// shell" mental model. Reachable via gear icon (workspace rail bottom)
// and ⌘, keybind.
//
// Each pane is small enough that splitting into separate files would
// add more import noise than it saves; they're plain functions in this
// file, sharing the SettingsView state hoisted up here so save-and-
// reload-on-pane-switch flows work without extra plumbing.
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
  BookOpen,
  Boxes,
  Brain,
  Bug,
  Check,
  Cpu,
  ExternalLink,
  Eye,
  EyeOff,
  Gauge,
  Key,
  Keyboard,
  LayoutDashboard,
  LifeBuoy,
  Loader2,
  MessageCircle,
  Paintbrush,
  Palette,
  Plug,
  Puzzle,
  Search,
  ShieldCheck,
  Sparkles,
  Terminal,
  Trash2,
  Upload,
  Users,
  X,
} from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { Field as FormField } from "../ui/field";
import { Kbd } from "../ui/kbd";
import { FullscreenOverlay } from "../FullscreenOverlay";
import { ChromeBtn } from "../TopBar";
import { useIsFullscreen } from "../../lib/useIsFullscreen";
import {
  api,
  type AgentDescriptor,
  type AgentProfile,
  type AgentsTomlEntry,
  type AuraProQuota,
  type AuraProSignInState,
  type BillingUsageByMember,
  type BrainDescriptor,
  type CaptureStatus,
  type DiscoveredMcp,
  type GitProfile,
  type McpServerEntry,
  type McpServerToolList,
  type OpenAiCompatProfile,
  type OpenAiCompatTestResult,
  type PluginRow,
  type PluginSecretRow,
  type SettingsView,
  type TerminalProfile,
  type TeamManifest,
  type TeamMember,
  type TeamIdentity,
  type ChannelMeta,
  type TelemetryView,
  type TelemetryConsent,
  type WorkspaceBinding,
} from "../../lib/api";
import { refreshPluginContributes } from "../../lib/pluginContributesStore";
import { refreshMcpTools } from "../../lib/mcpToolsStore";
import { setCaptureOptOut } from "../../lib/autoCapture";
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
import { InstalledModesPane } from "../marketplace/InstalledModesPane";
import { AuraWatchPanel } from "./AuraWatchSettingsDialog";
import { IntegrationsTab } from "../settings/IntegrationsTab";
import { IdentityPanel } from "../identity/IdentityPanel";
import { RepoWorktreeSettingsPane } from "../settings/RepoWorktreeSettingsPane";
import { StandupView } from "../standup/StandupView";
import {
  setThemePreference,
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
  setEditorPref,
  setFlag,
  setFontSize,
  setHudPref,
  setScrollback,
  setTerminalBool,
  useEditorPrefs,
  useFlagPrefs,
  useFontSize,
  useHudPrefs,
  useTerminalPrefs,
} from "../../lib/settingsStore";
import type { HudPresentationMode } from "../../lib/hud";
import {
  Card,
  Field,
  PaneHeader,
  Row,
  Section,
  SegControl,
  StatusPill,
  Stepper,
  Toggle,
} from "../settings/kit";

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
      { id: "behavior", label: "Editor behavior", icon: <Sparkles className="h-4 w-4" />, keywords: ["vim", "minimap", "sticky", "indent", "editor", "keybindings", "sound"] },
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
      { id: "mcp", label: "MCP servers", icon: <Plug className="h-4 w-4" />, keywords: ["mcp", "atlassian", "linear", "github", "sentry", "model context protocol", "tools"] },
      { id: "plugins", label: "Plugins", icon: <Puzzle className="h-4 w-4" />, keywords: ["plugin", "skill", "mcp", "marketplace", "extension"] },
      { id: "keys", label: "API keys", icon: <Key className="h-4 w-4" />, keywords: ["anthropic", "openai", "gemini", "mercury", "secret", "key"] },
    ],
  },
  {
    label: "Team & advanced",
    items: [
      { id: "team", label: "Team", icon: <Users className="h-4 w-4" />, keywords: ["team", "members", "admin", "standup", "activity", "tokens", "usage", "billing", "report", "rollup", "channels"] },
      { id: "experimental", label: "Experimental", icon: <Beaker className="h-4 w-4" />, keywords: ["flags", "preview", "lab"] },
      { id: "telemetry", label: "Usage data", icon: <Gauge className="h-4 w-4" />, keywords: ["usage", "anonymous", "metrics", "telemetry"] },
      { id: "help", label: "Help & support", icon: <LifeBuoy className="h-4 w-4" />, keywords: ["help", "support", "shortcuts", "keyboard", "docs", "documentation", "github", "issue", "bug", "report", "about", "version", "community", "discord"] },
    ],
  },
];

function flattenPanes(): PaneItem[] {
  return PANE_GROUPS.flatMap((g) => g.items);
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
  getCurrentWindow().startDragging().catch(() => {});
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
  const [view, setView] = useState<SettingsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fullscreen = useIsFullscreen();
  const searchRef = useRef<HTMLInputElement>(null);

  // Let callers deep-link to a pane: `aura:open-settings` may carry a
  // `{ pane }` detail (e.g. the topbar avatar opens Settings → Identity).
  // App's own listener flips `open`; this one just steers the pane.
  useEffect(() => {
    function onOpen(e: Event) {
      const detail = (e as CustomEvent).detail as { pane?: PaneKey } | undefined;
      if (detail?.pane) setPane(detail.pane);
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

  // Filter sidebar groups against the search query. Match against label
  // + keyword bag so "vim" surfaces Behavior even though the visible
  // label doesn't contain it.
  const filteredGroups = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return PANE_GROUPS;
    return PANE_GROUPS.map((g) => ({
      ...g,
      items: g.items.filter(
        (it) =>
          it.label.toLowerCase().includes(q) ||
          it.keywords.some((k) => k.includes(q)),
      ),
    })).filter((g) => g.items.length > 0);
  }, [query]);

  // When a search hides the active pane, jump to the first visible
  // match so the content area never goes blank.
  useEffect(() => {
    if (!query.trim()) return;
    const visible = filteredGroups.flatMap((g) => g.items.map((it) => it.id));
    if (visible.length === 0) return;
    if (!visible.includes(pane)) setPane(visible[0]!);
  }, [filteredGroups, pane, query]);

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

  // Active group + pane drive the breadcrumb in the top bar.
  const activeGroup = PANE_GROUPS.find((g) =>
    g.items.some((it) => it.id === pane),
  );
  const activeItem = activeGroup?.items.find((it) => it.id === pane);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-40 flex flex-col"
      style={{ background: "var(--color-bg-content)" }}
    >
      {/* Top bar — no title (the breadcrumb + nav carry context, per the
          full-screen wizard doctrine). Traffic-light inset on the left
          (collapses in fullscreen), a search box with a ⌘K affordance,
          a drag region so the window still moves, and a close button. */}
      <header
        data-tauri-drag-region
        onMouseDown={handleHeaderDrag}
        className="flex-shrink-0 flex items-center gap-3 border-b text-text-3"
        style={{
          height: 52,
          paddingLeft: fullscreen ? 16 : 78,
          paddingRight: 12,
          background: "var(--color-bg-1)",
          borderColor: "var(--color-line-soft)",
        }}
      >
        <span className="text-[12.5px] text-text-4 whitespace-nowrap">
          Settings
          {activeGroup && (
            <>
              {" · "}
              <span className="text-text-2 font-medium">
                {activeGroup.label}
              </span>
            </>
          )}
          {activeItem && (
            <>
              {" · "}
              <span className="text-text-2 font-medium">
                {activeItem.label}
              </span>
            </>
          )}
        </span>
        <div className="relative ml-2 flex-1 max-w-[420px]">
          <Search
            className="absolute left-3 top-1/2 -translate-y-1/2 text-text-4 z-10 pointer-events-none"
            size={13}
          />
          <Input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search settings…"
            className="h-8 pl-8 pr-12 text-[12.5px]"
          />
          {query ? (
            <button
              type="button"
              onClick={() => setQuery("")}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-text-4 hover:text-text-1"
              title="Clear"
            >
              <X size={12} />
            </button>
          ) : (
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[10.5px] text-text-5 border border-line rounded px-1.5 py-px pointer-events-none">
              ⌘K
            </span>
          )}
        </div>
        <div className="ml-auto flex items-center">
          <ChromeBtn title="Close (Esc)" onClick={onClose}>
            <X size={15} />
          </ChromeBtn>
        </div>
      </header>
      <div className="flex flex-1 min-h-0">
        {/* Sidebar — grouped nav with an accent left-rail on the active item. */}
        <aside
          className="w-[248px] shrink-0 flex flex-col border-r"
          style={{
            background: "var(--color-bg-1)",
            borderColor: "var(--color-line-soft)",
          }}
        >
          <div className="flex-1 overflow-y-auto px-2.5 py-3.5">
            {filteredGroups.length === 0 ? (
              <div className="text-[11.5px] text-text-4 px-3 py-4">
                No settings match “{query}”.
              </div>
            ) : (
              filteredGroups.map((group, gi) => (
                <div key={group.label} className={gi > 0 ? "mt-4" : ""}>
                  <div className="text-[10px] font-bold text-text-5 uppercase tracking-[0.11em] px-2.5 mb-1.5">
                    {group.label}
                  </div>
                  <nav className="flex flex-col gap-0.5">
                    {group.items.map((it) => {
                      const active = pane === it.id;
                      return (
                        <button
                          key={it.id}
                          type="button"
                          onClick={() => setPane(it.id)}
                          className={`relative flex items-center gap-2.5 px-2.5 h-8 text-[13px] rounded-lg text-left transition-colors ${
                            active
                              ? "bg-accent/10 text-text-1 font-medium"
                              : "text-text-3 hover:text-text-1 hover:bg-bg-2/60"
                          }`}
                        >
                          {active && (
                            <span className="absolute -left-2.5 top-1.5 bottom-1.5 w-[3px] rounded-full bg-accent" />
                          )}
                          <span className="flex-shrink-0 [&_svg]:h-[15px] [&_svg]:w-[15px]">
                            {it.icon}
                          </span>
                          <span className="flex-1 truncate">{it.label}</span>
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
            page rather than dialog density. */}
        <div className="flex-1 min-w-0 overflow-y-auto">
          {error && (
            <div className="text-[11.5px] text-red m-4" role="alert">
              {error}
            </div>
          )}
          <div className="max-w-[680px] mx-auto px-8 py-7">
            {pane === "appearance" && <AppearanceTab />}
            {pane === "themes" && <EditorThemesTab />}
            {pane === "hud" && <HudTab />}
            {pane === "capture" && <CaptureTab repoRoot={repoRoot} />}
            {pane === "behavior" && <BehaviorTab />}
            {pane === "brain" && <BrainTab />}
            {pane === "modes" && <InstalledModesPane />}
            {pane === "aurawatch" && <AuraWatchPanel repoRoot={repoRoot} />}
            {pane === "keys" && view && (
              <KeysTab view={view} onChanged={reload} />
            )}
            {pane === "policy" && view && (
              <PolicyTab view={view} repoRoot={repoRoot} onChanged={reload} />
            )}
            {pane === "agents" && <AgentsTab />}
            {pane === "local-models" && <LocalModelsTab />}
            {pane === "terminal" && <TerminalTab />}
            {pane === "copies" &&
              (repoRoot ? (
                <RepoWorktreeSettingsPane repoRoot={repoRoot} />
              ) : (
                <div className="py-6 text-[12px] text-text-3">
                  Open a project to configure its copies.
                </div>
              ))}
            {pane === "plugins" && <PluginsTab />}
            {pane === "mcp" && <McpServersTab repoRoot={repoRoot} />}
            {pane === "integrations" && <IntegrationsTab repoRoot={repoRoot} />}
            {pane === "profiles" && <ProfilesTab repoRoot={repoRoot} />}
            {pane === "identity" && <IdentityTab repoRoots={identityRoots} />}
            {pane === "team" && <TeamTab repoRoot={repoRoot} />}
            {pane === "telemetry" && <TelemetryTab />}
            {pane === "experimental" && <ExperimentalTab />}
            {pane === "help" && <HelpTab />}
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
  // Modal and ember ship dark-only palettes — picking light/system would
  // be a silent no-op (useResolvedTheme pins them to dark), so disable the
  // color-scheme picker and say why instead of letting it lie.
  const schemeDisabled =
    variant === "modal" || variant === "ember" || variant === "conductor";
  return (
    <>
      <PaneHeader
        title="Appearance"
        subtitle="Customize how Aura looks on your device."
      />
      <Section title="Theme">
        <Row label="Style">
          <SegControl<ThemeVariant>
            value={variant}
            options={[
              { value: "default", label: "Default" },
              { value: "modal", label: "Modal" },
              { value: "conductor", label: "Conductor" },
            ]}
            onChange={setThemeVariant}
          />
        </Row>
        <Row
          label={
            <span className="flex flex-col">
              Color scheme
              {schemeDisabled && (
                <span className="text-[10.5px] text-text-4">
                  This style ships dark-only.
                </span>
              )}
            </span>
          }
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
        <Row label="Font size">
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
  return (
    <>
      <PaneHeader
        title="Floating HUD"
        subtitle="The always-on-top glance summoned with ⌘⇧A. Changes apply live."
      />
      <Section title="Availability">
        <Toggle
          label="Enable the floating HUD"
          hint="When off, ⌘⇧A and the menu-bar icon do nothing and the HUD stays hidden. This sticks across restarts."
          value={hud.enabled}
          onChange={(v) => setHudPref("enabled", v)}
        />
      </Section>
      <Section title="Shape">
        <Row
          label={
            <span className="flex flex-col">
              Presentation
              <span className="text-[10.5px] text-text-4">
                Capsule sits bottom-center · Sidebar docks right as a panel ·
                Minimal drops the glass.
              </span>
            </span>
          }
        >
          <SegControl<HudPresentationMode>
            value={hud.mode as HudPresentationMode}
            options={[
              { value: "capsule", label: "Capsule" },
              { value: "sidebar", label: "Sidebar" },
              { value: "minimal", label: "Minimal" },
            ]}
            onChange={(next) => setHudPref("mode", next)}
          />
        </Row>
        <Row label="Opacity">
          <Stepper
            value={opacityPct}
            onChange={(pct) => setHudPref("opacity", pct / 100)}
            min={20}
            max={100}
            step={5}
            suffix="%"
          />
        </Row>
      </Section>
      {hud.mode === "sidebar" && (
        <Section title="Sidebar size">
          <Row
            label={
              <span className="flex flex-col">
                Width
                <span className="text-[10.5px] text-text-4">
                  Panel width when the sidebar is open.
                </span>
              </span>
            }
          >
            <Stepper
              value={Math.round(hud.sidebar_width)}
              onChange={(px) => setHudPref("sidebar_width", px)}
              min={240}
              max={480}
              step={10}
              suffix="px"
            />
          </Row>
          <Row label="Height">
            <Stepper
              value={Math.round(hud.sidebar_height)}
              onChange={(px) => setHudPref("sidebar_height", px)}
              min={320}
              max={900}
              step={20}
              suffix="px"
            />
          </Row>
        </Section>
      )}
      <Section title="Preview">
        <Row
          label={
            <span className="flex flex-col">
              Show the HUD
              <span className="text-[10.5px] text-text-4">
                Summon it to see the current shape (also ⌘⇧A anytime).
              </span>
            </span>
          }
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
      setError("Nothing to import — pick a file or paste theme JSON.");
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
      <PaneHeader
        title="Editor Themes"
        subtitle="Import a VS Code color theme and apply it to the code editor."
      />

      <Section title="Import a theme">
        <div className="flex items-center gap-2 py-1">
          <label className="cursor-pointer">
            <input
              type="file"
              accept=".json,.jsonc,application/json"
              className="hidden"
              onChange={onFile}
            />
            <span className="inline-flex items-center gap-1.5 rounded-md border border-line bg-bg-1 px-3 py-1.5 text-[12px] text-text-1 hover:bg-bg-2 transition-colors">
              <Upload className="h-3.5 w-3.5" />
              Import theme file…
            </span>
          </label>
          <button
            type="button"
            className="text-[11.5px] text-text-3 hover:text-text-1 transition-colors"
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
              className="w-full h-40 bg-bg-0 border border-line rounded-md px-3 py-2 text-[11.5px] font-mono text-text-1 resize-y"
            />
            <div>
              <Button onClick={() => doImport(paste)}>Import pasted theme</Button>
            </div>
          </div>
        )}

        {note && (
          <div className="text-[11.5px] text-text-2 mt-2 flex items-center gap-1.5">
            <Check className="h-3.5 w-3.5 text-accent-green" />
            {note}
          </div>
        )}
        {error && (
          <div className="text-[11.5px] text-red mt-2" role="alert">
            {error}
          </div>
        )}
        <div className="text-[10.5px] text-text-4 mt-2 leading-relaxed">
          Find themes on the{" "}
          <span className="text-text-2">VS Code Marketplace</span> or any
          extension's <code className="text-text-2">themes/*.json</code>. Syntax
          colors and editor chrome are mapped onto the editor; this matches the
          common token scopes, not every grammar-specific rule.
        </div>
      </Section>

      <Section title="Built-in presets">
        <div className="text-[10.5px] text-text-4 mb-2 leading-relaxed">
          Popular published palettes, ready to apply — no download needed. Each
          is run through the same converter as an imported file.
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
                    : "border-line hover:bg-bg-1"
                }`}
              >
                <ThemeSwatchRow colors={themeSwatches(p)} />
                <div className="flex-1 min-w-0">
                  <div className="text-[12px] text-text-1 truncate">{p.name}</div>
                  <div className="text-[10.5px] text-text-4">
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
          <div className="text-[10.5px] text-text-4 mb-2 leading-relaxed">
            Color themes from the extensions you’ve installed. Pick one to apply
            it — it joins your themes below.
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
                      : "border-line hover:bg-bg-1"
                  }`}
                >
                  <ThemeSwatchRow colors={themeSwatches(t.converted)} />
                  <div className="flex-1 min-w-0">
                    <div className="text-[12px] text-text-1 truncate">
                      {t.converted.name}
                    </div>
                    <div className="text-[10.5px] text-text-4 truncate">
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

      <Section title="Active theme">
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
          <div className="text-[11.5px] text-text-4 py-2">
            No imported themes yet. Import one above to get started.
          </div>
        )}
      </Section>

      <Section title="Scope">
        <Toggle
          label="Also reskin the whole app"
          hint="Apply the active theme's palette to Aura's chrome — not just the code editor. Turn off to keep the editor themed but the app on its own colors."
          value={applyChrome}
          onChange={setApplyChrome}
        />
        {applyChrome && active === null && (
          <div className="text-[10.5px] text-text-4 mt-1">
            No imported theme is active, so this has no effect yet.
          </div>
        )}
      </Section>

      <Section title="VS Code compatibility">
        <div className="text-[11.5px] text-text-3 leading-relaxed">
          Color themes are the first slice of broader VS Code interop. Planned
          next: LSP-backed language features (hover, completion) and a growing{" "}
          <code className="text-text-2">vscode</code>-API subset so a portion of
          simple extensions run. Running an unmodified{" "}
          <code className="text-text-2">.vsix</code> is an explicit non-goal —
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
          : "border-transparent hover:bg-bg-1"
      }`}
    >
      <ThemeSwatchRow colors={swatches} />
      <div className="flex-1 min-w-0">
        <div className="text-[12px] text-text-1 truncate">{name}</div>
        <div className="text-[10.5px] text-text-4">{detail}</div>
      </div>
      {active ? (
        <span className="inline-flex items-center gap-1 text-[11px] text-accent shrink-0">
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
  const [mergeBusy, setMergeBusy] = useState(false);
  const [mergeError, setMergeError] = useState<string | null>(null);

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
      } else {
        // Installed CLI predates --status (clap usage error) — stay calm,
        // just say the row needs a newer CLI rather than erroring out.
        setMerge(null);
        setMergeUnavailable("aura CLI is too old — update it to manage merges here");
      }
    } catch {
      // Spawn failure: no `aura` on PATH at all.
      setMerge(null);
      setMergeUnavailable("aura CLI not found");
    }
  }, [repoRoot]);

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
      <PaneHeader
        title="Capture"
        subtitle="Quietly record what changed and why in this project — no extra setup."
      />

      {status && !isGit && (
        <div className="text-[12px] text-text-3 rounded-md border border-line-soft bg-bg-2 px-3 py-2.5">
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
              <div className="text-[12px] text-text-1">
                {on ? "Capturing" : "Not capturing"}
              </div>
              <div className="text-[11px] text-text-3 leading-relaxed">
                {on
                  ? "Every time you save (commit), Aura records what changed, why, and which AI made it — right inside your project's history."
                  : "Turn on to record what changed and why on every save. It runs quietly alongside any existing Git hooks (Husky, Lefthook) without disturbing them."}
              </div>
            </div>
            <Button
              variant={on ? "subtle" : "default"}
              disabled={busy}
              onClick={() => toggle(!on)}
            >
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : on ? (
                "Disable"
              ) : (
                "Enable capture"
              )}
            </Button>
          </div>

          {status?.hooks_dir && (
            <div className="text-[10.5px] text-text-4 mt-1 font-mono break-all">
              hooks: {status.hooks_dir}
            </div>
          )}
          {note && <div className="text-[11px] text-text-3 mt-2">{note}</div>}
          {error && (
            <div className="text-[11px] text-red mt-2" role="alert">
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
              <div className="text-[12px] text-text-1">
                {mergeUnavailable ??
                  (merge?.installed
                    ? "Smart merge is on"
                    : "Smart merge is off")}
              </div>
              <div className="text-[11px] text-text-3 leading-relaxed">
                When two AIs edit different functions in the same file, Aura
                merges them cleanly — no conflicts to untangle by hand.
              </div>
            </div>
            <Button
              variant={merge?.installed ? "subtle" : "default"}
              disabled={mergeBusy || mergeUnavailable !== null}
              onClick={() => setMergeInstalled(!(merge?.installed ?? false))}
            >
              {mergeBusy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : merge?.installed ? (
                "Uninstall"
              ) : (
                "Install"
              )}
            </Button>
          </div>

          {merge?.installed && !merge.aura_on_path && (
            <div className="text-[11px] text-text-3 mt-1">
              The driver is configured but `aura` isn't on PATH — git falls
              back to its own merge until that's fixed.
            </div>
          )}
          {merge?.installed && merge.attributes_patterns.length > 0 && (
            <div className="text-[10.5px] text-text-4 mt-1 font-mono break-all">
              {merge.attributes_patterns.join("   ")}
            </div>
          )}
          {mergeError && (
            <div className="text-[11px] text-red mt-2" role="alert">
              {mergeError}
            </div>
          )}
        </Section>
      )}

      <Section title="What this does">
        <ul className="text-[11.5px] text-text-3 leading-relaxed list-disc pl-4 space-y-1">
          <li>
            Installs Aura's Git hooks (pre-commit, commit-msg, post-commit,
            post-merge, pre-push) — safe to run more than once, and they leave
            any existing hooks in place.
          </li>
          <li>
            Records what changed and why straight into Git. Nothing leaves your
            machine — no cloud, no extra server.
          </li>
          <li>
            Works with whatever coding agent you run — or none at all. Turning
            it off removes the hooks; the history already recorded in Git stays
            put.
          </li>
        </ul>
        <div className="text-[11px] text-text-4 mt-2 leading-relaxed">
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
  return (
    <>
      <PaneHeader
        title="Behavior"
        subtitle="How the code editor behaves."
      />
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
      </Section>
    </>
  );
}

// ── Brain ─────────────────────────────────────────────────────────────
//
// The Brain picker — replaces the old "set ANTHROPIC_API_KEY in env"
// flow. Each Brain impl compiled into the build appears here with a
// radio selector + an API-key field (when required). Keys land in the
// OS keychain via `brain_keychain_set` — they never round-trip to the
// frontend after the first save.

function BrainTab() {
  const [descriptors, setDescriptors] = useState<BrainDescriptor[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [keyDrafts, setKeyDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const [ds, settings] = await Promise.all([
        api.brainListDescriptors(),
        api.brainGetSettings(),
      ]);
      setDescriptors(ds);
      setActive(settings.active_provider_id ?? null);
    } catch (e) {
      setErr(String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function pick(providerId: string) {
    setBusy(providerId);
    setMsg(null);
    setErr(null);
    try {
      await api.brainSetActive(providerId);
      setActive(providerId);
      setMsg(`Active brain: ${providerId}`);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(null);
    }
  }

  async function saveKey(providerId: string) {
    const draft = keyDrafts[providerId];
    if (!draft) return;
    setBusy(providerId);
    setMsg(null);
    setErr(null);
    try {
      await api.brainKeychainSet(providerId, draft);
      setKeyDrafts((d) => ({ ...d, [providerId]: "" }));
      setMsg(`Saved API key for ${providerId}`);
      await load();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(null);
    }
  }

  async function forgetKey(providerId: string) {
    if (!confirm(`Forget the stored API key for ${providerId}?`)) return;
    setBusy(providerId);
    setMsg(null);
    setErr(null);
    try {
      await api.brainKeychainDelete(providerId);
      setMsg(`Forgot API key for ${providerId}`);
      await load();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <PaneHeader
        title="Brain"
        subtitle="Pick the chat backend that powers the Manager. Subscribe to Aura Pro for zero-setup, or bring your own key for Anthropic / OpenAI / Gemini / any OpenAI-compatible endpoint. CLI wrappers reuse the login you already have for Claude Code / Gemini CLI / opencode / cursor."
      />
      <Section title="Available brains">
        {err && (
          <div className="text-[11.5px] text-red mb-2" role="alert">
            {err}
          </div>
        )}
        {msg && (
          <div className="text-[11.5px] text-text-3 mb-2">{msg}</div>
        )}
        {descriptors.length === 0 ? (
          <div className="text-[11.5px] text-text-4 italic">
            No brains compiled into this build. Rebuild with at least one
            of: <code>brain_anthropic_native</code>,{" "}
            <code>brain_cli_wrapper</code>, <code>brain_openai_native</code>,
            {" "}<code>brain_gemini_native</code>,{" "}
            <code>brain_openai_compat</code>.
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {descriptors.map((d) => {
              const isActive = active === d.provider_id;
              const draft = keyDrafts[d.provider_id] ?? "";
              const isAuraPro = d.provider_id === "aura_pro";
              return (
                <div
                  key={d.provider_id}
                  className={`rounded-md border p-3 ${
                    isActive
                      ? "border-accent/60 bg-bg-2/60"
                      : "border-line-soft bg-bg-1/40"
                  }`}
                >
                  <label className="flex items-start gap-3 cursor-pointer">
                    <input
                      type="radio"
                      name="brain-active"
                      checked={isActive}
                      onChange={() => void pick(d.provider_id)}
                      disabled={busy === d.provider_id}
                      className="mt-0.5"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-baseline gap-2">
                        <div className="text-[12.5px] font-medium text-text-1">
                          {d.display_name}
                        </div>
                        <code className="text-[10.5px] text-text-4">
                          {d.provider_id}
                        </code>
                        {d.requires_api_key && d.has_api_key && (
                          <span className="text-[10.5px] text-green">
                            ✓ key set
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] text-text-3 mt-0.5">
                        {d.blurb}
                      </div>
                      {isAuraPro && <AuraProRow />}
                      {d.requires_api_key && (
                        <div className="mt-2 flex items-center gap-2">
                          <Input
                            type="password"
                            placeholder={
                              d.has_api_key
                                ? "Replace stored API key…"
                                : "API key"
                            }
                            value={draft}
                            onChange={(e) =>
                              setKeyDrafts((s) => ({
                                ...s,
                                [d.provider_id]: e.target.value,
                              }))
                            }
                            className="h-7 text-[11px] flex-1"
                          />
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={!draft || busy === d.provider_id}
                            onClick={() => void saveKey(d.provider_id)}
                          >
                            Save
                          </Button>
                          {d.has_api_key && (
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={busy === d.provider_id}
                              onClick={() => void forgetKey(d.provider_id)}
                              title="Remove from OS keychain"
                            >
                              <Trash2 size={12} />
                            </Button>
                          )}
                        </div>
                      )}
                    </div>
                  </label>
                </div>
              );
            })}
          </div>
        )}
      </Section>
    </>
  );
}

// ── Aura Pro row ──────────────────────────────────────────────────────
//
// v0.2.31 task #352. Special-case panel rendered inside the Brain tab
// when the descriptor is `aura_pro`. Unlike the BYOK rows, this brain
// has no API-key field — it reuses the cloud token OnboardingDialog
// already stashed. We show:
//
//   - "Signed in as <email>" or a "Sign in to Aura" button that fires
//     the existing `aura:open-onboarding` window event the onboarding
//     dialog already listens for.
//   - "1,234,567 / 2,000,000 tokens used this period" (or "∞" for the
//     unlimited tier), pulled from the cloud `/v1/brain/quota` endpoint
//     via the `aura_pro_quota` tauri command. Refresh button alongside
//     so the user can see the bucket move after a long session.

function AuraProRow() {
  const [signIn, setSignIn] = useState<AuraProSignInState | null>(null);
  const [quota, setQuota] = useState<AuraProQuota | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const state = await api.auraProIsSignedIn();
      setSignIn(state);
      if (state.signed_in) {
        // Quota is only meaningful when signed in. Tolerate failure —
        // a 5xx from the cloud shouldn't blank out the sign-in label.
        try {
          const q = await api.auraProQuota();
          setQuota(q);
        } catch (e) {
          setQuota(null);
          setErr(`quota: ${String(e)}`);
        }
      } else {
        setQuota(null);
      }
    } catch (e) {
      setErr(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    // Refresh on dialog reopen elsewhere — when the user signs in via
    // the OnboardingDialog from another surface, the dialog dispatches
    // `aura:onboarding-refresh` on completion. Cheap to listen.
    const onRefresh = () => void refresh();
    window.addEventListener("aura:onboarding-refresh", onRefresh);
    return () =>
      window.removeEventListener("aura:onboarding-refresh", onRefresh);
  }, [refresh]);

  function openSignIn() {
    window.dispatchEvent(new CustomEvent("aura:open-onboarding"));
  }

  if (loading && !signIn) {
    return (
      <div className="mt-2 text-[11px] text-text-4 italic">Checking sign-in…</div>
    );
  }

  if (!signIn?.signed_in) {
    return (
      <div className="mt-2 flex items-center gap-2">
        <span className="text-[11px] text-text-3">Not signed in.</span>
        <Button size="sm" variant="secondary" onClick={openSignIn}>
          Sign in to Aura
        </Button>
        {err && (
          <span className="text-[10.5px] text-red ml-1" title={err}>
            (error)
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="mt-2 flex flex-col gap-1">
      <div className="flex items-center gap-2 text-[11px]">
        <span className="text-text-3">Signed in as</span>
        <span className="text-text-1 font-medium">
          {signIn.user ?? "(unknown user)"}
        </span>
        {signIn.cloud_origin && (
          <code className="text-[10.5px] text-text-4">
            {signIn.cloud_origin}
          </code>
        )}
      </div>
      <div className="flex items-center gap-2 text-[11px]">
        <span className="text-text-3">Usage:</span>
        {quota ? (
          <span className="text-text-1">
            {formatTokens(quota.tokens_used_current_period)} /{" "}
            {quota.monthly_token_limit == null
              ? "∞"
              : formatTokens(quota.monthly_token_limit)}{" "}
            tokens this period
            <span className="text-text-4 ml-2">tier: {quota.tier}</span>
            {!quota.active && (
              <span className="text-red ml-2">subscription inactive</span>
            )}
          </span>
        ) : (
          <span className="text-text-4 italic">
            {err ? "unavailable" : "loading…"}
          </span>
        )}
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void refresh()}
          disabled={loading}
          title="Refresh sign-in + quota"
        >
          Refresh
        </Button>
      </div>
      {err && quota && (
        <div className="text-[10.5px] text-text-4">{err}</div>
      )}
    </div>
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
      <PaneHeader
        title="Terminal"
        subtitle="How terminal tabs behave. Changes apply to new tabs."
      />
      <Section title="Profile">
        <Row label="Default profile">
          {profiles.length > 0 ? (
            <Select
              value={defaultProfileId ?? ""}
              onChange={selectDefault}
              options={profiles.map((p) => ({ value: p.id, label: p.name }))}
              aria-label="Default profile"
              className="w-auto min-w-[160px]"
            />
          ) : (
            <span className="text-text-4 text-[12px]">No profiles found</span>
          )}
        </Row>
      </Section>
      <Section title="Visual">
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
        <Row label="Scrollback lines">
          <Select
            value={String(terminal.scrollback)}
            onChange={(v) => setScrollback(Number(v))}
            options={[1000, 5000, 10000, 50000].map((n) => ({
              value: String(n),
              label: n.toLocaleString(),
            }))}
            aria-label="Scrollback lines"
            className="w-auto min-w-[120px]"
          />
        </Row>
      </Section>
    </>
  );
}

// ── Plugins ───────────────────────────────────────────────────────────
//
// Reads `~/.aura/plugins/<scope>/<name>/aura.{plugin,skill,mcp}.json`
// via the Tauri `plugin_*` commands (cmd_plugin.rs). Three grouped
// lists: native plugins, skills, MCP servers. Each row toggles
// enabled state; the on-disk `.state.json` is the source of truth, so
// `aura plugin enable/disable` from the CLI and a click here converge.

function PluginsTab() {
  const [rows, setRows] = useState<PluginRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const list = await api.pluginList();
      setRows(list);
      setError(null);
      // Keep slash-command + rail-tile catalog in lockstep with the
      // enabled set the user is staring at.
      void refreshPluginContributes();
    } catch (e) {
      setError(String(e));
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const rescan = async () => {
    try {
      const report = await api.pluginRescan();
      await refresh();
      if (report.rejected.length > 0) {
        setError(
          `${report.rejected.length} manifest(s) rejected — check ~/.aura/plugins`,
        );
      }
    } catch (e) {
      setError(String(e));
    }
  };

  const setEnabled = async (
    kind: PluginRow["kind"],
    id: string,
    next: boolean,
  ) => {
    try {
      if (next) {
        await api.pluginEnable(kind, id);
      } else {
        await api.pluginDisable(kind, id);
      }
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  };

  const groups = useMemo(() => {
    const list = rows ?? [];
    return {
      plugin: list.filter((r) => r.kind === "plugin"),
      skill: list.filter((r) => r.kind === "skill"),
      mcp: list.filter((r) => r.kind === "mcp"),
    };
  }, [rows]);

  // Secrets are bundle-scoped, but a bundle can ship several manifests
  // (plugin + mcp). Render the secrets editor on exactly ONE row per
  // bundle — the native plugin row when present (it carries the
  // declared titles), else whichever row got there first.
  const secretsOwners = useMemo(() => {
    const byBundle = new Map<string, PluginRow>();
    for (const r of rows ?? []) {
      if (!r.bundle) continue;
      const cur = byBundle.get(r.bundle);
      if (!cur || (cur.kind !== "plugin" && r.kind === "plugin")) {
        byBundle.set(r.bundle, r);
      }
    }
    return new Set([...byBundle.values()].map((r) => `${r.kind}/${r.id}`));
  }, [rows]);

  return (
    <>
      <PaneHeader
        title="Plugins"
        subtitle="Plugins, skills, and MCP servers under ~/.aura/plugins. The shell rescans on disk changes; enable state persists to .state.json."
      />
      {error && (
        <div className="text-[12px] text-red mb-3" role="alert">
          {error}
        </div>
      )}
      <div className="flex items-center justify-between mb-3">
        <div className="text-[12px] text-text-3">
          {rows === null
            ? "Loading…"
            : `${rows.length} installed (${groups.plugin.length} plugin · ${groups.skill.length} skill · ${groups.mcp.length} mcp)`}
        </div>
        <Button size="sm" variant="ghost" onClick={rescan}>
          Rescan
        </Button>
      </div>
      {rows !== null && rows.length === 0 ? (
        <div className="text-[12px] text-text-4 px-3 py-6 text-center border border-dashed border-line-soft rounded">
          No plugins installed. Drop a manifest under
          {" "}
          <code className="text-text-3">
            ~/.aura/plugins/&lt;scope&gt;/&lt;name&gt;/
          </code>
          {" "}and click Rescan.
        </div>
      ) : (
        <>
          <PluginGroup
            title="Plugins"
            entries={groups.plugin}
            onToggle={setEnabled}
            secretsOwners={secretsOwners}
          />
          <PluginGroup
            title="Skills"
            entries={groups.skill}
            onToggle={setEnabled}
            secretsOwners={secretsOwners}
          />
          <PluginGroup
            title="MCP Servers"
            entries={groups.mcp}
            onToggle={setEnabled}
            secretsOwners={secretsOwners}
          />
        </>
      )}
    </>
  );
}

function PluginGroup({
  title,
  entries,
  onToggle,
  secretsOwners,
}: {
  title: string;
  entries: PluginRow[];
  onToggle: (kind: PluginRow["kind"], id: string, next: boolean) => void;
  secretsOwners: Set<string>;
}) {
  if (entries.length === 0) return null;
  return (
    <Section title={title}>
      <div className="flex flex-col gap-1">
        {entries.map((row) => (
          <div
            key={`${row.kind}/${row.id}`}
            className="flex items-start justify-between gap-3 py-2 border-b border-line-soft last:border-b-0"
          >
            <div className="flex-1 min-w-0">
              <div className="flex items-baseline gap-2">
                <span className="text-[12.5px] text-text-1 font-medium truncate">
                  {row.id}
                </span>
                <span className="text-[11px] text-text-4">v{row.version}</span>
                <span className="text-[10px] text-text-4 px-1.5 py-0.5 rounded bg-bg-1">
                  {row.capabilities_count} cap
                  {row.capabilities_count === 1 ? "" : "s"}
                </span>
                <SignatureBadge row={row} />
              </div>
              {row.description && (
                <div className="text-[11.5px] text-text-3 mt-0.5 line-clamp-2">
                  {row.description}
                </div>
              )}
              <div className="text-[10.5px] text-text-4 mt-0.5 truncate">
                {row.install_dir}
              </div>
              {row.bundle &&
                secretsOwners.has(`${row.kind}/${row.id}`) && (
                  <PluginSecretsEditor bundle={row.bundle} />
                )}
            </div>
            <Toggle
              label=""
              value={row.enabled}
              onChange={(next) => onToggle(row.kind, row.id, next)}
            />
          </div>
        ))}
      </div>
    </Section>
  );
}

// Signature verdict chip (P3). Verified = green check + publisher
// (status color, per palette rules); unknown key = neutral
// "unverified publisher" with the key id on hover; unsigned = dim
// text. Tampered bundles never reach this list — the registry
// rejects them at scan time.
function SignatureBadge({ row }: { row: PluginRow }) {
  if (row.signature === "verified") {
    return (
      <span
        className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 whitespace-nowrap"
        title={`Signed by ${row.signed_by ?? "unknown"} — bundle contents verified`}
      >
        ✓ {row.signed_by}
      </span>
    );
  }
  if (row.signature === "unknown_key") {
    return (
      <span
        className="text-[10px] px-1.5 py-0.5 rounded bg-bg-1 text-text-4 whitespace-nowrap"
        title={
          row.signed_by
            ? `Signed with key ${row.signed_by}, which is not in this machine's trust store`
            : "Signed with a key that is not in this machine's trust store"
        }
      >
        unverified publisher
      </span>
    );
  }
  return (
    <span
      className="text-[10px] text-text-4/70 whitespace-nowrap"
      title="This bundle carries no publisher signature"
    >
      unsigned
    </span>
  );
}

// Bundle-scoped secrets editor (P2 secrets broker). Values are write-
// only from here: they go straight into the OS keychain and only ever
// resurface inside the MCP child's environment at spawn. The status
// call reports existence, never values.
function PluginSecretsEditor({ bundle }: { bundle: string }) {
  const [rows, setRows] = useState<PluginSecretRow[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const refresh = async () => {
    try {
      setRows(await api.pluginSecretsStatus(bundle));
      setErr(null);
    } catch (e) {
      // Unknown bundle / scan race — hide rather than alarm.
      console.warn(`[plugins] secrets status failed for ${bundle}:`, e);
      setRows([]);
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bundle]);

  if (!rows || rows.length === 0) return null;

  const save = async (key: string) => {
    const value = (drafts[key] ?? "").trim();
    if (!value) return;
    setBusy(key);
    try {
      await api.pluginSecretSet(bundle, key, value);
      setDrafts((d) => ({ ...d, [key]: "" }));
      setErr(null);
      await refresh();
      // Servers that failed their probe with "secret not set" can now
      // spawn — refresh the cached tool catalog.
      void refreshMcpTools();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(null);
    }
  };

  const clear = async (key: string) => {
    setBusy(key);
    try {
      await api.pluginSecretClear(bundle, key);
      setErr(null);
      await refresh();
      void refreshMcpTools();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mt-2 rounded border border-line-soft bg-bg-1/40 px-2.5 py-2">
      <div className="text-[10.5px] uppercase tracking-wide text-text-4 mb-1.5">
        Secrets
      </div>
      {err && (
        <div className="text-[11px] text-red mb-1.5" role="alert">
          {err}
        </div>
      )}
      <div className="flex flex-col gap-1.5">
        {rows.map((s) => (
          <div key={s.key} className="flex items-center gap-2">
            <span
              className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${
                s.set ? "bg-accent-green" : "bg-text-4/40"
              }`}
              title={s.set ? "Stored in OS keychain" : "Not set"}
            />
            <span
              className="text-[11.5px] text-text-2 w-[160px] truncate shrink-0"
              title={s.key}
            >
              {s.title ?? s.key}
            </span>
            <Input
              type="password"
              autoComplete="off"
              value={drafts[s.key] ?? ""}
              onChange={(e) =>
                setDrafts((d) => ({ ...d, [s.key]: e.target.value }))
              }
              onKeyDown={(e) => {
                if (e.key === "Enter") void save(s.key);
              }}
              placeholder={s.set ? "••••••••  (replace)" : "paste value"}
              className="flex-1 min-w-0"
            />
            <Button
              size="sm"
              variant="ghost"
              disabled={busy === s.key || !(drafts[s.key] ?? "").trim()}
              onClick={() => void save(s.key)}
            >
              Set
            </Button>
            {s.set && (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy === s.key}
                onClick={() => void clear(s.key)}
              >
                Clear
              </Button>
            )}
            {s.url && (
              <button
                type="button"
                title={`Open token page: ${s.url}`}
                className="p-1 text-text-4 hover:text-text-1"
                onClick={() => {
                  void (async () => {
                    const { openUrl } = await import(
                      "@tauri-apps/plugin-opener"
                    );
                    await openUrl(s.url as string);
                  })();
                }}
              >
                <ExternalLink size={12} />
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── MCP Servers ───────────────────────────────────────────────────────
//
// Post-W4 pivot surface: rather than continue building the bespoke
// worker-bridge plugin SDK, we let MCP servers BE the plugin system.
// Configs live at `~/.aura/mcp/<name>.json`; this pane is the only UI
// that mutates them. The Composer pulls the merged tool catalog from
// `useMcpTools()` so add/remove here flows straight into the slash
// palette + @-mention picker.

type McpTemplate = {
  id: string;
  label: string;
  description: string;
  command: string;
  args: string[];
  envKeys: string[];
  /** Per-key hint shown next to the field in the auth modal. */
  envHints?: Record<string, string>;
  /** Per-key sensitivity flag — true means render as password input. */
  envSecret?: Record<string, boolean>;
  /** Provider's token-issue page. The auth modal renders this as an
   *  "Open token page" button that uses the system browser, so users
   *  don't have to hunt for the right Settings panel. */
  tokenPageUrl?: string;
  /** Remote MCP endpoint. When set, Aura uses its native Streamable
   *  HTTP transport + OAuth 2.1 PKCE flow rather than spawning a
   *  stdio child. Mutually informative with `command`/`args` (a
   *  template can be remote-only with empty command, or hybrid). */
  serverUrl?: string;
};

const MCP_TEMPLATES: McpTemplate[] = [
  {
    id: "atlassian-remote",
    label: "Atlassian (remote · native OAuth)",
    description:
      "Atlassian's hosted remote MCP — Aura authenticates via native OAuth 2.1 and calls it over Streamable HTTP.",
    command: "",
    args: [],
    envKeys: [],
    serverUrl: "https://mcp.atlassian.com/v1/sse",
  },
  {
    id: "atlassian",
    label: "Atlassian (Jira + Confluence)",
    description:
      "Atlassian's official MCP server. Needs ATLASSIAN_API_TOKEN + ATLASSIAN_EMAIL + ATLASSIAN_DOMAIN.",
    command: "npx",
    args: ["-y", "@atlassian/mcp-server"],
    envKeys: ["ATLASSIAN_API_TOKEN", "ATLASSIAN_EMAIL", "ATLASSIAN_DOMAIN"],
    envHints: {
      ATLASSIAN_API_TOKEN: "Create at id.atlassian.com → Security → API tokens",
      ATLASSIAN_EMAIL: "Your Atlassian account email",
      ATLASSIAN_DOMAIN: "e.g. yourco.atlassian.net (no https://)",
    },
    envSecret: { ATLASSIAN_API_TOKEN: true },
    tokenPageUrl:
      "https://id.atlassian.com/manage-profile/security/api-tokens",
  },
  {
    id: "linear",
    label: "Linear",
    description:
      "Linear's MCP bridge. Needs a personal API key with read/write scopes (LINEAR_API_KEY).",
    command: "npx",
    args: ["-y", "@linear/mcp-server"],
    envKeys: ["LINEAR_API_KEY"],
    envHints: {
      LINEAR_API_KEY: "Create at linear.app/settings/api",
    },
    envSecret: { LINEAR_API_KEY: true },
    tokenPageUrl: "https://linear.app/settings/api",
  },
  {
    id: "github",
    label: "GitHub",
    description:
      "GitHub's MCP server. Needs a fine-grained personal access token (GITHUB_PERSONAL_ACCESS_TOKEN).",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    envKeys: ["GITHUB_PERSONAL_ACCESS_TOKEN"],
    envHints: {
      GITHUB_PERSONAL_ACCESS_TOKEN:
        "Use a fine-grained PAT with repo + issues scopes",
    },
    envSecret: { GITHUB_PERSONAL_ACCESS_TOKEN: true },
    tokenPageUrl: "https://github.com/settings/tokens?type=beta",
  },
  {
    id: "sentry",
    label: "Sentry",
    description:
      "Sentry issue + event search. Needs SENTRY_AUTH_TOKEN and the org slug.",
    command: "npx",
    args: ["-y", "@sentry/mcp-server"],
    envKeys: ["SENTRY_AUTH_TOKEN", "SENTRY_ORG"],
    envHints: {
      SENTRY_AUTH_TOKEN: "Create at sentry.io → Settings → Auth Tokens",
      SENTRY_ORG: "Your org slug (visible in any Sentry URL)",
    },
    envSecret: { SENTRY_AUTH_TOKEN: true },
    tokenPageUrl: "https://sentry.io/settings/account/api/auth-tokens/",
  },
];

// Best-effort match from a configured server back to its template. Used
// by the AuthSetupModal to know which env keys to prompt for. We match
// on `id === name` first (the import flow keeps the template slug as
// the server name); fall back to scanning args for the npm package
// hint so renamed-but-otherwise-identical configs still snap into the
// right template.
function matchTemplate(
  name: string,
  args: string[] | undefined,
): McpTemplate | null {
  const byName = MCP_TEMPLATES.find((t) => t.id === name.toLowerCase());
  if (byName) return byName;
  const argBlob = (args ?? []).join(" ").toLowerCase();
  for (const t of MCP_TEMPLATES) {
    const pkgArg = t.args[t.args.length - 1] ?? "";
    if (pkgArg && argBlob.includes(pkgArg.toLowerCase())) return t;
  }
  return null;
}

type AddFormState = {
  name: string;
  command: string;
  args: string;
  envText: string;
  description: string;
  /** Remote MCP endpoint. When non-empty the backend wires the native
   *  Streamable HTTP transport and OAuth 2.1 PKCE flow; the stdio
   *  command/args become optional (empty = pure-remote). */
  serverUrl: string;
};

const EMPTY_FORM: AddFormState = {
  name: "",
  command: "",
  args: "",
  envText: "",
  description: "",
  serverUrl: "",
};

// Identity key for a discovered row. Used as the picker checkbox key so
// the same server surfaced from multiple agents (Claude+Cursor+Windsurf
// pointed at the same binary) collapses to one row, but configs that
// diverge stay distinct.
function discoveredKey(d: DiscoveredMcp): string {
  return `${d.name}::${d.command}::${d.args.join(" ")}`;
}

function McpServersTab({ repoRoot }: { repoRoot: string }) {
  const [rows, setRows] = useState<McpServerEntry[] | null>(null);
  const [tools, setTools] = useState<McpServerToolList[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState<AddFormState>(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  // QQ.2 — Discover-from-agents picker state. Lives next to the rest
  // of the tab so an open discover panel doesn't survive a tab switch.
  const [discoverOpen, setDiscoverOpen] = useState(false);
  const [discovered, setDiscovered] = useState<DiscoveredMcp[] | null>(null);
  const [discoverError, setDiscoverError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [discovering, setDiscovering] = useState(false);
  // Wave A — name of the server whose auth modal is currently open
  // (null when closed). Only one modal at a time.
  const [authTarget, setAuthTarget] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const list = await api.mcpServersList();
      setRows(list);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  // Best-effort tool-catalog read. Failures don't block the list —
  // we surface them inline on the row so the user can fix the config.
  const refreshTools = useCallback(async () => {
    try {
      const t = await api.mcpToolsList();
      setTools(t);
    } catch (e) {
      console.warn("mcpToolsList failed:", e);
    }
  }, []);

  useEffect(() => {
    void refresh();
    void refreshTools();
  }, [refresh, refreshTools]);

  const runDiscover = useCallback(async () => {
    setDiscoverError(null);
    setDiscovering(true);
    setDiscoverOpen(true);
    try {
      const found = await api.mcpServersDiscoverAgents(repoRoot);
      setDiscovered(found);
      setPicked(
        new Set(
          found.filter((d) => !d.already_imported).map((d) => discoveredKey(d)),
        ),
      );
    } catch (e) {
      setDiscoverError(String(e));
      setDiscovered([]);
    } finally {
      setDiscovering(false);
    }
  }, [repoRoot]);

  const runImport = useCallback(async () => {
    if (!discovered) return;
    const chosen = discovered.filter(
      (d) => !d.already_imported && picked.has(discoveredKey(d)),
    );
    if (chosen.length === 0) return;
    setBusy(true);
    try {
      await api.mcpServersImportDiscovered(chosen);
      setDiscovered(null);
      setDiscoverOpen(false);
      setPicked(new Set());
      await refresh();
      void refreshTools();
      void refreshMcpTools();
    } catch (e) {
      setDiscoverError(String(e));
    } finally {
      setBusy(false);
    }
  }, [discovered, picked, refresh, refreshTools]);

  const toolsByServer = useMemo(() => {
    const m = new Map<string, McpServerToolList>();
    for (const t of tools ?? []) m.set(t.server, t);
    return m;
  }, [tools]);

  const onToggle = async (name: string, enabled: boolean) => {
    setBusy(true);
    try {
      await api.mcpServersToggle(name, enabled);
      await refresh();
      void refreshMcpTools();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const onRemove = async (name: string) => {
    if (!window.confirm(`Remove MCP server "${name}"?`)) return;
    setBusy(true);
    try {
      await api.mcpServersRemove(name);
      await refresh();
      void refreshMcpTools();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const applyTemplate = (t: McpTemplate) => {
    const env = t.envKeys.map((k) => `${k}=`).join("\n");
    setForm({
      name: t.id,
      command: t.command,
      args: t.args.join(" "),
      envText: env,
      description: t.label,
      serverUrl: t.serverUrl ?? "",
    });
    setAdding(true);
  };

  const submitAdd = async () => {
    setBusy(true);
    try {
      const env = parseEnvBlock(form.envText);
      const newName = form.name.trim();
      const serverUrl = form.serverUrl.trim();
      await api.mcpServersAdd({
        name: newName,
        command: form.command.trim(),
        args: form.args.trim() ? form.args.trim().split(/\s+/) : [],
        env,
        description: form.description.trim() || null,
        serverUrl: serverUrl || undefined,
      });
      setForm(EMPTY_FORM);
      setAdding(false);
      await refresh();
      void refreshMcpTools();
      void refreshTools();
      // When the new server is a remote/native-OAuth one, jump straight
      // into the auth modal — otherwise the user would have to find the
      // row and click Auth, which is exactly the friction we just fixed.
      if (serverUrl) {
        setAuthTarget(newName);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PaneHeader
        title="MCP Servers"
        subtitle="External Model Context Protocol servers Aura spawns on demand for slash commands and @-mentions. Configs live in ~/.aura/mcp/."
      />
      {error && (
        <div className="text-[12px] text-red mb-3" role="alert">
          {error}
        </div>
      )}

      <div className="flex items-center justify-between mb-3 gap-3">
        <div className="text-[12px] text-text-3">
          {rows === null
            ? "Loading…"
            : `${rows.length} configured · ${rows.filter((r) => r.enabled).length} enabled`}
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              void refresh();
              void refreshTools();
              void refreshMcpTools();
            }}
            disabled={busy}
          >
            Refresh
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void runDiscover()}
            disabled={busy || discovering}
            title="Scan agent configs (Claude Code, Cursor, Windsurf, Cline, Zed, opencode, Gemini CLI, …) for MCP servers you already have authenticated"
          >
            {discovering ? "Scanning…" : "Import from agents"}
          </Button>
          {!adding && (
            <Button size="sm" onClick={() => setAdding(true)} disabled={busy}>
              Add server
            </Button>
          )}
        </div>
      </div>

      {discoverOpen && (
        <Section title="Discovered from your agents">
          {discoverError && (
            <div className="text-[12px] text-red mb-2" role="alert">
              {discoverError}
            </div>
          )}
          {discovered === null && discovering && (
            <div className="text-[12px] text-text-3">
              Scanning agent configs…
            </div>
          )}
          {discovered !== null && discovered.length === 0 && !discovering && (
            <div className="text-[12px] text-text-4 px-3 py-4 text-center border border-dashed border-line-soft rounded">
              Nothing new found. Aura scans Claude Code, Claude Desktop,
              Cursor, Windsurf, Cline, Roo Cline, Zed, opencode, Gemini CLI,
              Codex, and repo-local <code>.mcp.json</code>. Configure a server
              in any of those and re-run.
            </div>
          )}
          {discovered !== null && discovered.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-[11px] text-text-3 px-1">
                <div>
                  {discovered.length} server
                  {discovered.length === 1 ? "" : "s"} found ·{" "}
                  {discovered.filter((d) => !d.already_imported).length}{" "}
                  importable
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    className="text-[11px] text-text-3 hover:text-text-1"
                    onClick={() =>
                      setPicked(
                        new Set(
                          discovered
                            .filter((d) => !d.already_imported)
                            .map((d) => discoveredKey(d)),
                        ),
                      )
                    }
                  >
                    Select all
                  </button>
                  <button
                    type="button"
                    className="text-[11px] text-text-3 hover:text-text-1"
                    onClick={() => setPicked(new Set())}
                  >
                    Clear
                  </button>
                </div>
              </div>
              <div className="max-h-[280px] overflow-y-auto rounded border border-line-soft divide-y divide-line-soft">
                {discovered.map((d) => {
                  const k = discoveredKey(d);
                  const checked = picked.has(k);
                  const disabled = d.already_imported;
                  return (
                    <label
                      key={`${k}::${d.source}`}
                      className={`flex items-start gap-2.5 px-2.5 py-2 ${disabled ? "opacity-50" : "cursor-pointer hover:bg-bg-1/40"}`}
                    >
                      <input
                        type="checkbox"
                        className="mt-0.5"
                        checked={checked}
                        disabled={disabled}
                        onChange={() => {
                          setPicked((prev) => {
                            const next = new Set(prev);
                            if (next.has(k)) next.delete(k);
                            else next.add(k);
                            return next;
                          });
                        }}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <div className="text-[12.5px] font-medium text-text-1 truncate">
                            {d.name}
                          </div>
                          <span className="text-[10px] uppercase tracking-wider text-text-4 px-1.5 py-0.5 rounded bg-bg-1 border border-line-soft">
                            {d.source}
                          </span>
                          {disabled && (
                            <span className="text-[10px] text-emerald-500 px-1.5 py-0.5 rounded border border-emerald-500/40">
                              already imported
                            </span>
                          )}
                        </div>
                        <div className="text-[10.5px] text-text-4 font-mono truncate mt-0.5">
                          {d.command} {d.args.join(" ")}
                        </div>
                        {Object.keys(d.env).length > 0 && (
                          <div className="text-[10px] text-text-4 mt-0.5">
                            {Object.keys(d.env).length} env var
                            {Object.keys(d.env).length === 1 ? "" : "s"}{" "}
                            inherited
                          </div>
                        )}
                      </div>
                    </label>
                  );
                })}
              </div>
              <div className="flex items-center justify-end gap-2 pt-1">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setDiscoverOpen(false);
                    setDiscovered(null);
                    setPicked(new Set());
                    setDiscoverError(null);
                  }}
                  disabled={busy}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  onClick={() => void runImport()}
                  disabled={busy || picked.size === 0}
                >
                  Import {picked.size > 0 ? `(${picked.size})` : ""}
                </Button>
              </div>
            </div>
          )}
        </Section>
      )}

      {rows !== null && rows.length === 0 && !adding && (
        <div className="text-[12px] text-text-4 px-3 py-6 text-center border border-dashed border-line-soft rounded">
          No MCP servers configured yet. Pick a template below to get started.
        </div>
      )}

      <Section title="Pre-configured templates">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {MCP_TEMPLATES.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => applyTemplate(t)}
              className="text-left p-2.5 rounded border border-line-soft hover:border-text-4 transition-colors bg-bg-1/40"
            >
              <div className="text-[12.5px] font-medium text-text-1">
                {t.label}
              </div>
              <div className="text-[11px] text-text-3 mt-1 line-clamp-2">
                {t.description}
              </div>
              <div className="text-[10.5px] text-text-4 mt-1 font-mono truncate">
                {t.command} {t.args.join(" ")}
              </div>
            </button>
          ))}
        </div>
      </Section>

      {adding && (
        <Section title="Add server">
          <div className="space-y-2.5">
            <Field
              label="Name"
              hint="Becomes the file name under ~/.aura/mcp/. Letters, digits, dashes."
            >
              <Input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="atlassian"
                className="h-8 text-[12px]"
              />
            </Field>
            <Field
              label="Remote URL"
              hint="Optional. For hosted MCP servers — Aura uses its native Streamable HTTP transport and OAuth 2.1 PKCE flow. Leave blank for stdio-only servers."
            >
              <Input
                value={form.serverUrl}
                onChange={(e) =>
                  setForm({ ...form, serverUrl: e.target.value })
                }
                placeholder="https://mcp.atlassian.com/v1/sse"
                className="h-8 text-[12px]"
              />
            </Field>
            <Field label="Command" hint="Executable Aura spawns. Usually 'npx'. Leave blank for pure-remote servers.">
              <Input
                value={form.command}
                onChange={(e) => setForm({ ...form, command: e.target.value })}
                placeholder="npx"
                className="h-8 text-[12px]"
              />
            </Field>
            <Field label="Arguments" hint="Space-separated argv passed after the command.">
              <Input
                value={form.args}
                onChange={(e) => setForm({ ...form, args: e.target.value })}
                placeholder="-y @atlassian/mcp-server"
                className="h-8 text-[12px]"
              />
            </Field>
            <Field
              label="Environment"
              hint="One KEY=VALUE per line. Leave blank to inherit the shell environment only."
            >
              <textarea
                value={form.envText}
                onChange={(e) => setForm({ ...form, envText: e.target.value })}
                rows={4}
                spellCheck={false}
                placeholder={"ATLASSIAN_API_TOKEN=\nATLASSIAN_EMAIL="}
                className="w-full bg-bg-1 border border-line rounded px-2 py-1.5 text-[11.5px] font-mono text-text-1 outline-none focus:border-text-4 resize-y"
              />
            </Field>
            <Field label="Description" hint="Optional note shown next to the row.">
              <Input
                value={form.description}
                onChange={(e) =>
                  setForm({ ...form, description: e.target.value })
                }
                placeholder="Atlassian Jira + Confluence"
                className="h-8 text-[12px]"
              />
            </Field>
            <div className="flex items-center justify-end gap-2 pt-1">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setAdding(false);
                  setForm(EMPTY_FORM);
                }}
                disabled={busy}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={() => void submitAdd()}
                disabled={
                  busy ||
                  !form.name.trim() ||
                  (!form.command.trim() && !form.serverUrl.trim())
                }
              >
                Save
              </Button>
            </div>
          </div>
        </Section>
      )}

      {rows && rows.length > 0 && (
        <Section title="Configured servers">
          <div className="flex flex-col gap-1">
            {rows.map((row) => {
              const tl = toolsByServer.get(row.name);
              return (
                <McpServerRow
                  key={row.name}
                  row={row}
                  toolList={tl}
                  onToggle={(next) => void onToggle(row.name, next)}
                  onRemove={() => void onRemove(row.name)}
                  onAuth={() => setAuthTarget(row.name)}
                  disabled={busy}
                />
              );
            })}
          </div>
        </Section>
      )}
      {authTarget &&
        (() => {
          const target = rows?.find((r) => r.name === authTarget);
          if (!target) return null;
          return (
            <AuthSetupModal
              server={target}
              onClose={() => setAuthTarget(null)}
              onSaved={async () => {
                setAuthTarget(null);
                await refresh();
                void refreshTools();
                void refreshMcpTools();
              }}
            />
          );
        })()}
    </>
  );
}

function McpServerRow({
  row,
  toolList,
  onToggle,
  onRemove,
  onAuth,
  disabled,
}: {
  row: McpServerEntry;
  toolList: McpServerToolList | undefined;
  onToggle: (next: boolean) => void;
  onRemove: () => void;
  onAuth: () => void;
  disabled: boolean;
}) {
  const probeOk = toolList?.ok ?? null;
  const probeErr = toolList?.ok === false ? toolList.error : null;
  const probeCount = toolList?.tools.length ?? null;
  const statusLabel = !row.enabled
    ? "disabled"
    : probeOk === true
      ? `${probeCount ?? 0} tools`
      : probeOk === false
        ? "error"
        : "unknown";
  const statusColor = !row.enabled
    ? "text-text-4"
    : probeOk === true
      ? "text-accent-green"
      : probeOk === false
        ? "text-red"
        : "text-text-3";

  // Inline native-OAuth CTAs. We only surface these when we KNOW the
  // user can act — `server_url` set means the backend will run native
  // OAuth on click; otherwise the generic Auth button stays the only
  // entry point. "Authenticate now" for first-time auth, escalating to
  // amber "Re-authenticate" once the tools probe spits a 401/expired
  // signal so the row reads as actionable, not just broken.
  const hasRemote = Boolean(row.server_url);
  const needsAuth = hasRemote && !row.has_oauth_token;
  const errBlob = `${row.status ?? ""} ${probeErr ?? ""}`.toLowerCase();
  const tokensRejected =
    hasRemote &&
    row.has_oauth_token &&
    (errBlob.includes("401") ||
      errBlob.includes("unauthor") ||
      errBlob.includes("expired"));
  return (
    <div className="flex items-start justify-between gap-3 py-2 border-b border-line-soft last:border-b-0">
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="text-[12.5px] text-text-1 font-medium truncate">
            {row.name}
          </span>
          <span className={`text-[10.5px] ${statusColor}`}>{statusLabel}</span>
          {row.plugin_id && (
            <span
              className="text-[10.5px] px-[3px] py-[1.5px] rounded bg-bg-1 text-text-3 border border-line-soft"
              title="Bundled by a plugin — env + secrets are managed in the Plugins pane"
            >
              plugin
            </span>
          )}
          {row.server_url && (
            <span
              className="text-[10.5px] px-[3px] py-[1.5px] rounded bg-sky-500/15 text-sky-200 border border-sky-500/30"
              title={`Remote transport — uses HTTP/SSE to ${row.server_url}`}
            >
              remote
            </span>
          )}
          {row.has_oauth_token && (
            <span
              className="text-[10.5px] px-[3px] py-[1.5px] rounded bg-emerald-500/15 text-emerald-200 border border-emerald-500/30"
              title="OAuth tokens stored in OS keychain"
            >
              authenticated
            </span>
          )}
        </div>
        <div className="text-[10.5px] text-text-4 mt-0.5 truncate font-mono">
          {row.command} {row.args.join(" ")}
        </div>
        {row.description && (
          <div className="text-[11.5px] text-text-3 mt-0.5 line-clamp-2">
            {row.description}
          </div>
        )}
        {probeErr && (
          <div
            className="text-[10.5px] text-red mt-1 break-words"
            title={probeErr}
          >
            {probeErr}
          </div>
        )}
      </div>
      <div className="flex items-center gap-1">
        {(() => {
          // ONE auth button per row — label + tone derived from state.
          // Mirrors Claude Code's /mcp drill-in where a server flagged
          // "needs authentication" gets a single Authenticate CTA.
          // Plugin-bundled servers authenticate via the secrets broker
          // in the Plugins pane — no env-edit modal here.
          if (row.plugin_id) {
            return null;
          }
          if (needsAuth) {
            return (
              <button
                type="button"
                onClick={onAuth}
                disabled={disabled}
                title="A browser window will open for authentication"
                className="px-2 py-0.5 rounded text-[10.5px] font-medium border transition-colors text-sky-200 border-sky-500/40 hover:bg-sky-500/10 disabled:opacity-40"
              >
                Authenticate
              </button>
            );
          }
          if (tokensRejected) {
            return (
              <button
                type="button"
                onClick={onAuth}
                disabled={disabled}
                title="Tokens rejected — refresh required"
                className="px-2 py-0.5 rounded text-[10.5px] font-medium border transition-colors text-amber-200 border-amber-500/40 hover:bg-amber-500/10 disabled:opacity-40"
              >
                Re-authenticate
              </button>
            );
          }
          if (probeOk === false || (!hasRemote && !row.has_oauth_token)) {
            return (
              <button
                type="button"
                onClick={onAuth}
                disabled={disabled}
                title="Set up auth — env or browser flow"
                className={`px-2 py-0.5 rounded text-[10.5px] font-medium border transition-colors ${
                  probeOk === false
                    ? "text-amber-300 border-amber-500/40 hover:bg-amber-500/10"
                    : "text-text-3 border-line-soft hover:text-text-1 hover:border-text-4"
                } disabled:opacity-40`}
              >
                Auth
              </button>
            );
          }
          return null;
        })()}
        <Toggle label="" value={row.enabled} onChange={onToggle} />
        {!row.plugin_id && (
          <button
            type="button"
            onClick={onRemove}
            disabled={disabled}
            title="Remove server"
            className="p-1 text-text-4 hover:text-red disabled:opacity-40"
          >
            <Trash2 size={13} />
          </button>
        )}
      </div>
    </div>
  );
}

// Wave A — Auth setup modal. For known providers (atlassian, linear,
// github, sentry) it shows per-key labels + hints + a deep link to the
// provider's token page. For unknown servers it falls back to a free-
// form KEY=value textarea so power users aren't blocked.
//
// Wave B (OAuth via mcp-remote): when the configured command points at
// `mcp-remote` or contains an `https://` arg, this modal also renders
// an "Authenticate in browser" path that spawns the proxy interactively
// and watches for the auth URL.
function AuthSetupModal({
  server,
  onClose,
  onSaved,
}: {
  server: McpServerEntry;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const template = useMemo(
    () => matchTemplate(server.name, server.args),
    [server.name, server.args],
  );
  // For known templates we render one field per envKey. We never seed
  // the input with the existing secret value (security — and stops
  // accidental leakage if the user takes a screenshot of this dialog);
  // an empty submission leaves prior values intact (handled backend-
  // side via the merge semantics).
  const [values, setValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const k of template?.envKeys ?? []) init[k] = "";
    // Pre-fill non-secret fields (email, domain, org) from existing
    // config — these aren't sensitive and saving the user a re-type is
    // worth the small leakage risk. Secrets stay blank.
    for (const k of template?.envKeys ?? []) {
      if (template?.envSecret?.[k]) continue;
      if (server.env[k]) init[k] = server.env[k];
    }
    return init;
  });
  const [reveal, setReveal] = useState<Record<string, boolean>>({});
  const [freeform, setFreeform] = useState<string>(() => {
    // Show existing env in the freeform editor for unknown templates.
    if (template) return "";
    return Object.entries(server.env)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n");
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remote = useMemo(() => detectRemote(server), [server]);

  // Wave B — OAuth-via-mcp-remote flow state. Lives alongside the
  // env-paste state so a remote-OAuth server can ALSO have env vars
  // (the proxy itself reads no env, but custom transports might).
  const [authBusy, setAuthBusy] = useState(false);
  const [authLog, setAuthLog] = useState<string[]>([]);
  const [authResult, setAuthResult] = useState<{
    ok: boolean;
    text: string;
  } | null>(null);

  // Native OAuth 2.1 + PKCE state. Shares the per-server
  // `mcp:auth_log:<name>` topic with the mcp-remote piggyback so a
  // single log view shows whichever flow the user kicked off.
  const [nativeBusy, setNativeBusy] = useState(false);
  const [nativeResult, setNativeResult] = useState<{
    ok: boolean;
    text: string;
  } | null>(null);

  const runBrowserAuth = useCallback(async () => {
    setAuthBusy(true);
    setAuthLog([]);
    setAuthResult(null);
    setError(null);
    // Subscribe to per-server log + url topics. We unsubscribe in the
    // finally block so a second auth attempt doesn't double-fire.
    const { listen } = await import("@tauri-apps/api/event");
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    let urlOpened = false;
    const unlistenLog = await listen<string>(
      `mcp:auth_log:${server.name}`,
      (e) => {
        setAuthLog((prev) => {
          const next = [...prev, e.payload];
          // Cap to last 200 lines so a runaway proxy doesn't blow the
          // React tree.
          return next.length > 200 ? next.slice(-200) : next;
        });
      },
    );
    const unlistenUrl = await listen<string>(
      `mcp:auth_url:${server.name}`,
      (e) => {
        if (urlOpened) return;
        urlOpened = true;
        void openUrl(e.payload).catch((err) => {
          console.warn("openUrl failed:", err);
        });
      },
    );
    try {
      const res = await api.mcpServersAuthRun(server.name);
      if (res.timed_out) {
        setAuthResult({
          ok: false,
          text: "Timed out after 5 minutes. If you completed the browser flow, the token may still be cached — try Save & retry. Otherwise re-run Authenticate.",
        });
      } else if (res.exit_code === 0) {
        setAuthResult({
          ok: true,
          text: "Auth succeeded. Token cached — close this dialog and the server will probe green.",
        });
      } else {
        setAuthResult({
          ok: false,
          text: `Proxy exited with code ${res.exit_code ?? "unknown"}. Check the log for details.`,
        });
      }
    } catch (e) {
      setError(String(e));
    } finally {
      unlistenLog();
      unlistenUrl();
      setAuthBusy(false);
    }
  }, [server.name]);

  const runNativeOAuth = useCallback(async () => {
    setNativeBusy(true);
    setAuthLog([]);
    setNativeResult(null);
    setError(null);
    const { listen } = await import("@tauri-apps/api/event");
    // The backend opens the browser itself via tauri-plugin-opener,
    // but we still subscribe to `mcp:auth_url` so the log shows the
    // URL inline as a fallback for users who don't see the browser
    // pop (corporate "always-on-top app" / browser sandbox edge case).
    const unlistenLog = await listen<string>(
      `mcp:auth_log:${server.name}`,
      (e) => {
        setAuthLog((prev) => {
          const next = [...prev, e.payload];
          return next.length > 200 ? next.slice(-200) : next;
        });
      },
    );
    const unlistenUrl = await listen<string>(
      `mcp:auth_url:${server.name}`,
      (e) => {
        setAuthLog((prev) => {
          const next = [...prev, `[link] ${e.payload}`];
          return next.length > 200 ? next.slice(-200) : next;
        });
      },
    );
    try {
      await api.mcpServersOauthStart(server.name);
      setNativeResult({
        ok: true,
        text: "Tokens stored. Aura now holds the OAuth credentials for this server.",
      });
      await onSaved();
    } catch (e) {
      setNativeResult({ ok: false, text: String(e) });
    } finally {
      unlistenLog();
      unlistenUrl();
      setNativeBusy(false);
    }
  }, [server.name, onSaved]);

  const clearOAuthTokens = useCallback(async () => {
    setError(null);
    try {
      await api.mcpServersOauthClear(server.name);
      await onSaved();
    } catch (e) {
      setError(String(e));
    }
  }, [server.name, onSaved]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const env: Record<string, string> = template
        ? { ...values }
        : parseEnvBlock(freeform);
      // Drop empty strings — backend treats them as "clear this key",
      // which would wipe pre-existing values the user didn't intend to
      // touch. Only submit fields the user actually typed into.
      for (const k of Object.keys(env)) {
        if (env[k] === "") delete env[k];
      }
      if (Object.keys(env).length === 0 && template) {
        setError("Paste at least one value, or close the dialog");
        setBusy(false);
        return;
      }
      await api.mcpServersUpdateEnv(server.name, env);
      await onSaved();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  const openTokenPage = async () => {
    if (!template?.tokenPageUrl) return;
    try {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(template.tokenPageUrl);
    } catch (e) {
      console.warn("openUrl failed:", e);
      window.open(template.tokenPageUrl, "_blank", "noopener");
    }
  };

  return (
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="bg-bg-content border border-line-soft rounded-lg shadow-sm w-full max-w-lg max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3 px-4 py-3 border-b border-line-soft">
          <div className="min-w-0">
            <div className="text-text-1 text-[14px] font-semibold">
              {server.name}
            </div>
            {server.server_url ? (
              <div className="text-text-4 text-[11.5px] mt-0.5 truncate font-mono">
                {server.server_url}
              </div>
            ) : (
              <div className="text-text-4 text-[11.5px] mt-0.5 truncate font-mono">
                {server.command} {server.args.join(" ")}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded text-text-4 hover:text-text-1 hover:bg-bg-2"
            aria-label="Close"
          >
            <X className="w-4 h-4" strokeWidth={1.75} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-3">
          {(() => {
            // Pick ONE flow. Mirror Claude Code's UX: native OAuth is the
            // primary path when we have a remote URL; mcp-remote
            // piggyback covers servers whose discovered config wraps a
            // URL we haven't promoted to `server_url` yet; env paste is
            // only for stdio templates that take an API token.
            const useNative = !!server.server_url;
            const useBrowserPiggyback =
              !useNative && remote.kind !== "none";
            const remoteFlow = useNative || useBrowserPiggyback;
            if (!remoteFlow) return null;
            const busy = useNative ? nativeBusy : authBusy;
            const result = useNative ? nativeResult : authResult;
            const onAuth = useNative ? runNativeOAuth : runBrowserAuth;
            const label = busy
              ? `Authenticating with ${server.name}…`
              : server.has_oauth_token
                ? "Re-authenticate"
                : "Authenticate";
            return (
              <div className="space-y-3">
                <button
                  type="button"
                  onClick={() => void onAuth()}
                  disabled={busy}
                  className="w-full inline-flex items-center justify-center gap-2 px-3 py-2 rounded-md text-[13px] font-medium bg-accent-violet text-white hover:bg-accent-violet/90 disabled:opacity-60"
                >
                  {busy ? (
                    <Loader2
                      className="w-4 h-4 animate-spin"
                      aria-hidden
                    />
                  ) : (
                    <ExternalLink className="w-4 h-4" aria-hidden />
                  )}
                  {label}
                </button>
                <div className="text-text-3 text-[12px] leading-relaxed">
                  {busy ? (
                    <>
                      A browser window will open for authentication.
                      <br />
                      Return here after authenticating in your browser.
                    </>
                  ) : (
                    <>
                      Clicking Authenticate opens a browser window. Approve
                      the request and Aura will store the tokens in your
                      OS keychain.
                    </>
                  )}
                </div>
                {server.has_oauth_token && !busy && (
                  <button
                    type="button"
                    onClick={() => void clearOAuthTokens()}
                    className="inline-flex items-center gap-1.5 text-[11.5px] text-text-4 hover:text-rose-300"
                    title="Delete stored tokens from the OS keychain"
                  >
                    Disconnect
                  </button>
                )}
                {authLog.length > 0 && busy && (
                  <div className="font-mono text-[10.5px] text-text-4 bg-bg-1/40 border border-line-soft rounded max-h-28 overflow-y-auto p-2 leading-relaxed">
                    {authLog.slice(-30).map((line, i) => (
                      <div key={i} className="break-all">
                        {line}
                      </div>
                    ))}
                  </div>
                )}
                {result && (
                  <div
                    className={
                      result.ok
                        ? "text-emerald-300 text-[11.5px]"
                        : "text-amber-300 text-[11.5px]"
                    }
                  >
                    {result.text}
                  </div>
                )}
              </div>
            );
          })()}

          {template && template.envKeys.length > 0 && !server.server_url ? (
            <>
              <div className="text-text-3 text-[11.5px] leading-relaxed">
                {template.description}
              </div>
              {template.tokenPageUrl && (
                <button
                  type="button"
                  onClick={() => void openTokenPage()}
                  className="inline-flex items-center gap-1.5 text-[11.5px] text-accent-violet hover:underline"
                >
                  <ExternalLink className="w-3.5 h-3.5" aria-hidden />
                  Open token page
                </button>
              )}
              {template.envKeys.map((k) => {
                const isSecret = !!template.envSecret?.[k];
                const isRevealed = !!reveal[k];
                const hasExisting = !!server.env[k];
                return (
                  <Field
                    key={k}
                    label={k}
                    hint={template.envHints?.[k]}
                  >
                    <div className="relative">
                      <Input
                        type={
                          isSecret && !isRevealed ? "password" : "text"
                        }
                        value={values[k] ?? ""}
                        onChange={(e) =>
                          setValues((prev) => ({
                            ...prev,
                            [k]: e.target.value,
                          }))
                        }
                        placeholder={
                          isSecret && hasExisting
                            ? "(saved — leave blank to keep)"
                            : ""
                        }
                        className="pr-8"
                      />
                      {isSecret && (
                        <button
                          type="button"
                          onClick={() =>
                            setReveal((prev) => ({
                              ...prev,
                              [k]: !prev[k],
                            }))
                          }
                          className="absolute right-1 top-1/2 -translate-y-1/2 p-1.5 text-text-4 hover:text-text-1"
                          title={isRevealed ? "Hide" : "Reveal"}
                        >
                          {isRevealed ? (
                            <EyeOff className="w-3.5 h-3.5" aria-hidden />
                          ) : (
                            <Eye className="w-3.5 h-3.5" aria-hidden />
                          )}
                        </button>
                      )}
                    </div>
                  </Field>
                );
              })}
            </>
          ) : !server.server_url && remote.kind === "none" ? (
            <>
              <div className="text-text-3 text-[11.5px] leading-relaxed">
                This server isn't a known template. Paste any env vars it
                needs as <code>KEY=value</code>, one per line.
              </div>
              <Field
                label="Environment"
                hint="One KEY=value per line. Values are stored as-is at ~/.aura/mcp/<name>.json."
              >
                <textarea
                  value={freeform}
                  onChange={(e) => setFreeform(e.target.value)}
                  rows={6}
                  className="w-full bg-bg-1 border border-line-soft rounded px-2 py-1.5 text-[12px] text-text-1 font-mono"
                  placeholder="ATLASSIAN_API_TOKEN=…"
                />
              </Field>
            </>
          ) : null}

          {error && (
            <div className="text-rose-300 text-[11.5px]" role="alert">
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-line-soft">
          <Button
            size="sm"
            variant="ghost"
            onClick={onClose}
            disabled={busy}
          >
            {server.server_url || remote.kind !== "none" ? "Close" : "Cancel"}
          </Button>
          {!(server.server_url || remote.kind !== "none") &&
            template &&
            template.envKeys.length > 0 && (
              <Button
                size="sm"
                onClick={() => void submit()}
                disabled={busy}
              >
                {busy && (
                  <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" aria-hidden />
                )}
                Save & retry
              </Button>
            )}
          {!(server.server_url || remote.kind !== "none") &&
            !template && (
              <Button
                size="sm"
                onClick={() => void submit()}
                disabled={busy}
              >
                {busy && (
                  <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" aria-hidden />
                )}
                Save & retry
              </Button>
            )}
        </div>
      </div>
    </div>
  );
}

// Wave B helper — classifies an MCP server as a remote-OAuth flavour
// based on command shape. `mcp-remote` is the canonical npm proxy
// shipped by Anthropic for browser-OAuth-gated remote MCPs (Atlassian
// remote, Notion remote, etc); plain `https://` first-arg matches the
// MCP-spec native remote transport. `none` means stdio with env vars
// only — the env-paste path is the right one.
function detectRemote(
  server: McpServerEntry,
): { kind: "none" | "mcp-remote" | "remote-url"; url?: string } {
  const allArgs = server.args.join(" ").toLowerCase();
  if (allArgs.includes("mcp-remote")) {
    const httpsArg = server.args.find((a) => a.startsWith("https://"));
    return { kind: "mcp-remote", url: httpsArg };
  }
  const remoteArg = server.args.find((a) => a.startsWith("https://"));
  if (remoteArg) return { kind: "remote-url", url: remoteArg };
  return { kind: "none" };
}

/** Parse "KEY=value" lines from the textarea into a string-string map.
 *  Blank lines + lines without `=` are skipped; values keep their literal
 *  text (no shell expansion). */
function parseEnvBlock(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1);
    if (key) out[key] = value;
  }
  return out;
}

// ── Team ──────────────────────────────────────────────────────────────
//
// Admin pane: roster (Members), per-member daily intent rollup
// (Activity), and per-member token spend (Usage). Members tab loads
// from `team_load`; Activity embeds StandupView; Usage hits the cloud
// `/api/v1/billing/usage/by_member` endpoint (admin sees all, member
// sees self only — enforced server-side).

type TeamSubTab = "members" | "channels" | "activity" | "usage";

function TeamTab({ repoRoot }: { repoRoot: string }) {
  const [sub, setSub] = useState<TeamSubTab>("members");
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 border-b border-line-soft pb-2">
        <SubTabButton
          active={sub === "members"}
          onClick={() => setSub("members")}
          label="Members"
        />
        <SubTabButton
          active={sub === "channels"}
          onClick={() => setSub("channels")}
          label="Channels"
        />
        <SubTabButton
          active={sub === "activity"}
          onClick={() => setSub("activity")}
          label="Activity"
        />
        <SubTabButton
          active={sub === "usage"}
          onClick={() => setSub("usage")}
          label="Usage"
        />
      </div>
      {sub === "members" && <TeamMembersPane repoRoot={repoRoot} />}
      {sub === "channels" && <TeamChannelsPane repoRoot={repoRoot} />}
      {sub === "activity" && <TeamActivityPane repoRoot={repoRoot} />}
      {sub === "usage" && <TeamUsagePane repoRoot={repoRoot} />}
    </div>
  );
}

function SubTabButton({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`text-[12px] px-2 py-1 rounded transition-colors ${
        active
          ? "bg-bg-2 text-text-1 font-medium"
          : "text-text-3 hover:text-text-1 hover:bg-bg-2/60"
      }`}
    >
      {label}
    </button>
  );
}

// Team roles admin panel. Built on Aura's own git-derived roster: the
// `admin` flag in team.json is advisory (git gives everyone equal write
// access), so this gates the in-app affordances rather than git itself.
// A vacant admin seat can be *claimed* by any member; an existing admin
// can *promote* others or *transfer* the role and step down. Harder,
// cloud-enforced "super controls" are a later opt-in (Aura-account login)
// — this is the honour-system default any team can use as-is.
function TeamMembersPane({ repoRoot }: { repoRoot: string }) {
  const [members, setMembers] = useState<TeamMember[] | null>(null);
  const [identity, setIdentity] = useState<TeamIdentity | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [actionErr, setActionErr] = useState<string | null>(null);
  // Email currently mid-mutation — disables that row's buttons.
  const [busyEmail, setBusyEmail] = useState<string | null>(null);

  const load = useCallback(async () => {
    setErr(null);
    const [t, id] = await Promise.all([
      api.teamLoad(repoRoot),
      api.teamIdentity(repoRoot).catch(() => null),
    ]);
    setMembers(t?.members ?? []);
    setIdentity(id);
  }, [repoRoot]);

  useEffect(() => {
    let cancelled = false;
    setMembers(null);
    setIdentity(null);
    setActionErr(null);
    load().catch((e) => {
      if (!cancelled) setErr(String(e));
    });
    return () => {
      cancelled = true;
    };
  }, [repoRoot, load]);

  const run = useCallback(
    async (email: string, fn: () => Promise<TeamManifest>) => {
      setBusyEmail(email);
      setActionErr(null);
      try {
        const m = await fn();
        setMembers(m?.members ?? []);
        // Admin status of the local user may have changed (e.g. transfer
        // step-down) — refresh identity so the controls regate.
        const id = await api.teamIdentity(repoRoot).catch(() => null);
        setIdentity(id);
      } catch (e) {
        setActionErr(humanizeErr(e));
      } finally {
        setBusyEmail(null);
      }
    },
    [repoRoot],
  );

  if (err) return <div className="text-[11.5px] text-red">{err}</div>;
  if (!members) return <div className="text-[11.5px] text-text-3">Loading…</div>;
  if (members.length === 0) {
    return (
      <div className="text-[11.5px] text-text-3">
        No team members yet. Run a few commits in this repo and they'll
        appear here automatically (auto-derived from git log).
      </div>
    );
  }

  const iAmAdmin = identity?.admin ?? false;
  const myEmail = (identity?.email ?? "").toLowerCase();
  const hasAdmin = members.some((m) => m.admin);
  const adminCount = members.filter((m) => m.admin).length;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2 mb-0.5">
        <div className="text-[10.5px] uppercase tracking-wider text-text-4">
          {members.length} member{members.length === 1 ? "" : "s"}
          {hasAdmin && (
            <span className="text-text-5">
              {" · "}
              {adminCount} admin{adminCount === 1 ? "" : "s"}
            </span>
          )}
        </div>
        {!hasAdmin && (
          <button
            type="button"
            disabled={busyEmail !== null}
            onClick={() => run(myEmail || "self", () => api.teamClaim(repoRoot))}
            className="text-[11px] font-medium px-2 py-1 rounded transition-colors text-bg-deep disabled:opacity-50"
            style={{ background: "var(--color-accent)" }}
            title="No admin yet — claim the admin seat for this team"
          >
            Claim admin
          </button>
        )}
      </div>

      {!hasAdmin && (
        <div className="text-[10.5px] text-text-4 leading-snug px-0.5 pb-1">
          This team has no admin yet. Any member can claim it; the admin can
          later transfer the role or promote others.
        </div>
      )}
      {actionErr && (
        <div
          className="text-[10.5px] rounded px-2 py-1 leading-snug"
          style={{
            color: "var(--color-red)",
            background: "color-mix(in srgb, var(--color-red) 12%, transparent)",
            border: "1px solid color-mix(in srgb, var(--color-red) 30%, transparent)",
          }}
        >
          {actionErr}
        </div>
      )}

      {members.map((m) => {
        const isMe = m.email.toLowerCase() === myEmail;
        const rowBusy = busyEmail === m.email;
        return (
          <div
            key={m.email}
            className="flex items-center gap-3 px-2 py-1.5 rounded hover:bg-bg-2/60"
          >
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-[12px] text-text-1 font-medium truncate">
                  {m.name || m.handle}
                </span>
                {m.admin && (
                  <span
                    className="text-[9.5px] uppercase tracking-wider px-1.5 py-0.5 rounded"
                    style={{
                      color: "var(--color-amber)",
                      background:
                        "color-mix(in srgb, var(--color-amber) 14%, transparent)",
                      border:
                        "1px solid color-mix(in srgb, var(--color-amber) 30%, transparent)",
                    }}
                  >
                    admin
                  </span>
                )}
                {isMe && (
                  <span className="text-[9.5px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-bg-3 text-text-3">
                    you
                  </span>
                )}
                {m.status_emoji && (
                  <span className="text-[12px]">{m.status_emoji}</span>
                )}
              </div>
              <div className="text-[10.5px] text-text-4 truncate">
                {m.email}
                {m.activity_text ? ` · ${m.activity_text}` : ""}
              </div>
            </div>

            {iAmAdmin && !isMe ? (
              <div className="flex items-center gap-1 flex-shrink-0">
                {m.admin ? (
                  <RoleBtn
                    label="Remove admin"
                    busy={rowBusy}
                    onClick={() =>
                      run(m.email, () =>
                        api.teamSetAdmin(repoRoot, m.email, false),
                      )
                    }
                  />
                ) : (
                  <>
                    <RoleBtn
                      label="Make admin"
                      busy={rowBusy}
                      onClick={() =>
                        run(m.email, () =>
                          api.teamSetAdmin(repoRoot, m.email, true),
                        )
                      }
                    />
                    <RoleBtn
                      label="Transfer"
                      busy={rowBusy}
                      accent
                      title="Make this member admin and step down to member"
                      onClick={() => {
                        if (
                          window.confirm(
                            `Transfer admin to ${m.name || m.handle}? You'll step down to a regular member.`,
                          )
                        ) {
                          run(m.email, () =>
                            api.teamTransferAdmin(repoRoot, m.email),
                          );
                        }
                      }}
                    />
                  </>
                )}
              </div>
            ) : (
              <>
                <div className="text-[10.5px] text-text-4 tabular-nums">
                  {m.commits} commit{m.commits === 1 ? "" : "s"}
                </div>
                <div className="text-[10.5px] text-text-4 tabular-nums w-16 text-right">
                  {relAge(m.last_seen)}
                </div>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

function RoleBtn({
  label,
  busy,
  accent,
  title,
  onClick,
}: {
  label: string;
  busy: boolean;
  accent?: boolean;
  title?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={busy}
      onClick={onClick}
      title={title}
      className={`text-[10.5px] px-1.5 py-0.5 rounded border transition-colors disabled:opacity-50 ${
        accent
          ? "border-line-soft text-text-2 hover:text-text-1 hover:border-line"
          : "border-line-soft text-text-3 hover:text-text-1 hover:bg-bg-2"
      }`}
      style={
        accent
          ? { color: "var(--color-accent)", borderColor: "color-mix(in srgb, var(--color-accent) 35%, transparent)" }
          : undefined
      }
    >
      {busy ? "…" : label}
    </button>
  );
}

// Strip Rust's "Err(...)" wrapper noise so the panel surfaces just the
// human-readable reason a role change was refused.
function humanizeErr(e: unknown): string {
  const s = String((e as { message?: string })?.message ?? e ?? "").trim();
  return s.replace(/^Error:\s*/i, "") || "Something went wrong";
}

// Channels admin panel. Channels are advisory-private: the `visibility`
// flag governs what the rail surfaces, not cryptographic access (anyone
// with the clone can read the JSONL). Team admins (and per-channel
// admins) can create open/private channels, manage membership, set a
// topic, and delete non-core channels. Built-in channels are protected.
const CORE_CHANNEL_SLUGS = ["general", "agents", "sentinel", "pull-requests"];

function TeamChannelsPane({ repoRoot }: { repoRoot: string }) {
  const [manifest, setManifest] = useState<TeamManifest | null>(null);
  const [identity, setIdentity] = useState<TeamIdentity | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [actionErr, setActionErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [newVisibility, setNewVisibility] = useState<"open" | "private">("open");
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async () => {
    setErr(null);
    const [t, id] = await Promise.all([
      api.teamLoad(repoRoot),
      api.teamIdentity(repoRoot).catch(() => null),
    ]);
    setManifest(t);
    setIdentity(id);
  }, [repoRoot]);

  useEffect(() => {
    let cancelled = false;
    setManifest(null);
    setIdentity(null);
    setActionErr(null);
    load().catch((e) => {
      if (!cancelled) setErr(String(e));
    });
    return () => {
      cancelled = true;
    };
  }, [repoRoot, load]);

  const run = useCallback(
    async (key: string, fn: () => Promise<TeamManifest>) => {
      setBusy(key);
      setActionErr(null);
      try {
        const m = await fn();
        setManifest(m);
        const id = await api.teamIdentity(repoRoot).catch(() => null);
        setIdentity(id);
      } catch (e) {
        setActionErr(humanizeErr(e));
      } finally {
        setBusy(null);
      }
    },
    [repoRoot],
  );

  if (err) return <div className="text-[11.5px] text-red">{err}</div>;
  if (!manifest)
    return <div className="text-[11.5px] text-text-3">Loading…</div>;

  const iAmAdmin = identity?.admin ?? false;
  const myEmail = (identity?.email ?? "").toLowerCase();
  const members = manifest.members ?? [];
  const metaBySlug = new Map<string, ChannelMeta>(
    (manifest.channel_meta ?? []).map((c) => [c.slug, c]),
  );
  // Stable ordering: core channels first (in canonical order), then the
  // rest alphabetically — mirrors how the chat rail groups them.
  const channels = [...(manifest.channels ?? [])].sort((a, b) => {
    const ai = CORE_CHANNEL_SLUGS.indexOf(a);
    const bi = CORE_CHANNEL_SLUGS.indexOf(b);
    if (ai !== -1 || bi !== -1) {
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    }
    return a.localeCompare(b);
  });

  const canAdminChannel = (slug: string) =>
    iAmAdmin ||
    (metaBySlug.get(slug)?.admins ?? []).some(
      (a) => a.toLowerCase() === myEmail,
    );

  const createChannel = () => {
    const name = newName.trim();
    if (!name) return;
    run("__create__", () =>
      api.teamChannelCreate(
        repoRoot,
        name,
        newVisibility === "private"
          ? { visibility: "private", members: [] }
          : undefined,
      ),
    ).then(() => {
      setNewName("");
      if (newVisibility === "private") {
        setExpanded(slugify(name));
      }
      setNewVisibility("open");
    });
  };

  return (
    <div className="space-y-2">
      <div className="text-[10.5px] uppercase tracking-wider text-text-4">
        {channels.length} channel{channels.length === 1 ? "" : "s"}
      </div>

      {/* Create row */}
      <div className="flex items-center gap-1.5">
        <span className="text-text-4 text-[13px] pl-0.5">#</span>
        <Input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") createChannel();
          }}
          placeholder="new-channel"
          className="flex-1 min-w-0"
        />
        <Select
          value={newVisibility}
          onChange={(v) => setNewVisibility(v as "open" | "private")}
          options={[
            { value: "open", label: "Open" },
            { value: "private", label: "Private" },
          ]}
          aria-label="Channel visibility"
          className="w-auto min-w-[110px]"
        />
        <button
          type="button"
          disabled={busy === "__create__" || !newName.trim()}
          onClick={createChannel}
          className="text-[11.5px] font-medium px-2 py-1 rounded text-bg-deep disabled:opacity-40"
          style={{ background: "var(--color-accent)" }}
        >
          {busy === "__create__" ? "…" : "Create"}
        </button>
      </div>

      {actionErr && (
        <div
          className="text-[10.5px] rounded px-2 py-1 leading-snug"
          style={{
            color: "var(--color-red)",
            background: "color-mix(in srgb, var(--color-red) 12%, transparent)",
            border:
              "1px solid color-mix(in srgb, var(--color-red) 30%, transparent)",
          }}
        >
          {actionErr}
        </div>
      )}

      <div className="space-y-0.5">
        {channels.map((slug) => {
          const meta = metaBySlug.get(slug);
          const isPrivate = (meta?.visibility ?? "open") === "private";
          const isCore = CORE_CHANNEL_SLUGS.includes(slug);
          const admin = canAdminChannel(slug);
          const rowBusy = busy === slug;
          const memberCount = meta?.members?.length ?? 0;
          const isOpen = expanded === slug;
          return (
            <div
              key={slug}
              className="rounded border border-transparent hover:border-line-soft hover:bg-bg-2/40 transition-colors"
            >
              <div className="flex items-center gap-2 px-2 py-1.5">
                <span className="text-text-4 flex-shrink-0">
                  {isPrivate ? <LockGlyph /> : <span className="text-[13px]">#</span>}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[12px] text-text-1 font-medium truncate">
                      {slug}
                    </span>
                    {isCore && (
                      <span className="text-[9px] uppercase tracking-wider px-1 py-0.5 rounded bg-bg-3 text-text-4">
                        built-in
                      </span>
                    )}
                    {isPrivate && (
                      <span className="text-[10px] text-text-4">
                        {memberCount} member{memberCount === 1 ? "" : "s"}
                      </span>
                    )}
                  </div>
                  {meta?.topic && (
                    <div className="text-[10.5px] text-text-4 truncate italic">
                      {meta.topic}
                    </div>
                  )}
                </div>

                {admin && (
                  <div className="flex items-center gap-1 flex-shrink-0">
                    <RoleBtn
                      label={isPrivate ? "Make open" : "Make private"}
                      busy={rowBusy}
                      onClick={() =>
                        run(slug, () =>
                          api.teamChannelUpdate(repoRoot, slug, {
                            visibility: isPrivate ? "open" : "private",
                          }),
                        )
                      }
                    />
                    <RoleBtn
                      label="Topic"
                      busy={rowBusy}
                      onClick={() => {
                        const t = window.prompt(
                          `Topic for #${slug}`,
                          meta?.topic ?? "",
                        );
                        if (t !== null) {
                          run(slug, () =>
                            api.teamChannelUpdate(repoRoot, slug, { topic: t }),
                          );
                        }
                      }}
                    />
                    {isPrivate && (
                      <RoleBtn
                        label={isOpen ? "Done" : "Members"}
                        busy={false}
                        onClick={() => setExpanded(isOpen ? null : slug)}
                      />
                    )}
                    {!isCore && (
                      <RoleBtn
                        label="Delete"
                        busy={rowBusy}
                        onClick={() => {
                          if (
                            window.confirm(`Delete #${slug}? This can't be undone.`)
                          ) {
                            run(slug, () => api.teamChannelDelete(repoRoot, slug));
                          }
                        }}
                      />
                    )}
                  </div>
                )}
              </div>

              {isOpen && isPrivate && admin && (
                <div className="px-2 pb-2 pt-0.5 ml-6 space-y-0.5 border-t border-line-soft mt-0.5">
                  <div className="text-[10px] uppercase tracking-wider text-text-5 pt-1.5 pb-0.5">
                    Who's in #{slug}
                  </div>
                  {members.map((m) => {
                    const inChannel = (meta?.members ?? []).some(
                      (e) => e.toLowerCase() === m.email.toLowerCase(),
                    );
                    const isChAdmin = (meta?.admins ?? []).some(
                      (e) => e.toLowerCase() === m.email.toLowerCase(),
                    );
                    return (
                      <div key={m.email} className="flex items-center gap-1">
                        <button
                          type="button"
                          disabled={rowBusy}
                          onClick={() =>
                            run(slug, () =>
                              inChannel
                                ? api.teamChannelMemberRemove(repoRoot, slug, m.email)
                                : api.teamChannelMemberAdd(repoRoot, slug, m.email),
                            )
                          }
                          className="flex-1 min-w-0 flex items-center gap-2 px-1.5 py-1 rounded text-left hover:bg-bg-2 transition-colors disabled:opacity-50"
                        >
                          <span
                            className="w-3.5 h-3.5 rounded-sm border flex items-center justify-center flex-shrink-0"
                            style={{
                              borderColor: inChannel
                                ? "var(--color-accent)"
                                : "var(--color-line)",
                              background: inChannel
                                ? "var(--color-accent)"
                                : "transparent",
                            }}
                          >
                            {inChannel && (
                              <svg width="9" height="9" viewBox="0 0 16 16" fill="none">
                                <path
                                  d="M3.5 8.5l3 3 6-7"
                                  stroke="var(--color-bg-deep)"
                                  strokeWidth="2"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                />
                              </svg>
                            )}
                          </span>
                          <span className="text-[11.5px] text-text-2 truncate">
                            {m.name || m.handle}
                          </span>
                          <span className="text-[10px] text-text-5 truncate">
                            {m.email}
                          </span>
                        </button>
                        <button
                          type="button"
                          disabled={rowBusy || !inChannel}
                          title={
                            isChAdmin
                              ? "Channel admin — click to demote"
                              : inChannel
                                ? "Make channel admin"
                                : "Add as member first"
                          }
                          onClick={() =>
                            run(slug, () =>
                              api.teamChannelAdminSet(
                                repoRoot,
                                slug,
                                m.email,
                                !isChAdmin,
                              ),
                            )
                          }
                          className="flex-shrink-0 w-6 h-6 rounded flex items-center justify-center hover:bg-bg-2 disabled:opacity-30 transition-colors"
                          style={{
                            color: isChAdmin
                              ? "var(--color-amber)"
                              : "var(--color-text-5)",
                          }}
                        >
                          <StarGlyph filled={isChAdmin} />
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {!iAmAdmin && (
        <div className="text-[10.5px] text-text-4 leading-snug pt-1">
          You can create channels. Managing visibility, membership, topics
          and deletion needs team-admin (or channel-admin) rights.
        </div>
      )}
    </div>
  );
}

function LockGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
      <rect
        x="3.5"
        y="7"
        width="9"
        height="6.5"
        rx="1.2"
        stroke="currentColor"
        strokeWidth="1.3"
      />
      <path
        d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}

// Star marking a channel-level admin — filled when active, outline when
// the member is just a regular channel member.
function StarGlyph({ filled }: { filled: boolean }) {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinejoin="round"
    >
      <path d="M8 1.8l1.8 3.9 4.2.5-3.1 2.9.8 4.2L8 11.9 4.3 14l.8-4.2L2 6.9l4.2-.5z" />
    </svg>
  );
}

// Local slugify mirroring the Rust `slugify_channel` for optimistic UI
// (auto-expanding the just-created private channel's member manager).
function slugify(name: string): string {
  return name
    .trim()
    .replace(/^#+/, "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-");
}

function TeamActivityPane({ repoRoot }: { repoRoot: string }) {
  return <StandupView repoRoot={repoRoot} />;
}

function TeamUsagePane({ repoRoot: _repoRoot }: { repoRoot: string }) {
  const [data, setData] = useState<BillingUsageByMember | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    api
      .cloudBillingUsageByMember()
      .then((r) => {
        if (alive) setData(r);
      })
      .catch((e) => {
        if (alive) setError(String(e?.message ?? e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  if (loading) {
    return (
      <div className="text-[11.5px] text-text-3 px-1 py-2">
        Loading token usage…
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-2 text-[11.5px] text-text-3 leading-relaxed">
        <div className="text-[12px] text-text-1 font-medium">Token spend</div>
        <div className="rounded border border-yellow-700/40 bg-yellow-900/15 px-2 py-1.5 text-yellow-200">
          Couldn't load token usage:{" "}
          <span className="font-mono break-all">{error}</span>
        </div>
        <p className="text-[10.5px] text-text-4">
          Sign in to the cloud (Onboarding → Cloud) to see per-member
          spend. Until then, <span className="font-mono">aura usage</span>{" "}
          in the terminal shows per-machine totals.
        </p>
      </div>
    );
  }

  const members = data?.members ?? [];
  const scope = data?.scope ?? "self";
  const month = data?.month ?? "—";
  const total = data?.total_cost_usd ?? 0;

  return (
    <div className="space-y-3 text-[11.5px] text-text-3 leading-relaxed">
      <div className="flex items-baseline justify-between gap-2">
        <div className="text-[12px] text-text-1 font-medium">
          Token spend · {month}
        </div>
        <div className="text-[10.5px] text-text-4">
          {scope === "org" ? "All members" : "Your usage"} · total{" "}
          <span className="font-mono">${total.toFixed(2)}</span>
        </div>
      </div>

      {members.length === 0 ? (
        <div className="rounded border border-bg-3 bg-bg-1/50 px-2 py-2 text-text-4">
          No LLM activity recorded for{" "}
          <span className="font-mono">{month}</span> yet. As soon as an
          agent in this org calls a model through the Aura proxy, its
          tokens land here.
        </div>
      ) : (
        <div className="rounded border border-bg-3 overflow-hidden">
          <div className="grid grid-cols-[1fr_80px_80px_70px] gap-2 px-2 py-1.5 text-[10.5px] text-text-4 bg-bg-1/60 border-b border-bg-3">
            <span>Member</span>
            <span className="text-right">In</span>
            <span className="text-right">Out</span>
            <span className="text-right">USD</span>
          </div>
          {members.map((m) => (
            <div
              key={m.developer_id}
              className="grid grid-cols-[1fr_80px_80px_70px] gap-2 px-2 py-1.5 border-b border-bg-3 last:border-b-0 hover:bg-bg-2/40"
            >
              <div className="min-w-0">
                <div className="text-text-1 truncate">
                  {m.display_name || m.github_login}
                </div>
                {m.display_name && (
                  <div className="text-[10px] text-text-4 truncate">
                    @{m.github_login}
                  </div>
                )}
              </div>
              <span className="text-right font-mono tabular-nums">
                {formatTokens(m.tokens_in)}
              </span>
              <span className="text-right font-mono tabular-nums">
                {formatTokens(m.tokens_out)}
              </span>
              <span className="text-right font-mono tabular-nums">
                ${m.cost_usd.toFixed(2)}
              </span>
            </div>
          ))}
        </div>
      )}

      <p className="text-[10.5px] text-text-4">
        Captured per-call from the cloud LLM proxy. Members who run
        their own keys outside the proxy don't show up here.
      </p>
    </div>
  );
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function relAge(unixSecs: number): string {
  if (!unixSecs) return "—";
  const ageS = Math.max(0, Math.floor(Date.now() / 1000 - unixSecs));
  if (ageS < 60) return `${ageS}s ago`;
  if (ageS < 3600) return `${Math.floor(ageS / 60)}m ago`;
  if (ageS < 86400) return `${Math.floor(ageS / 3600)}h ago`;
  return `${Math.floor(ageS / 86400)}d ago`;
}

// ── Experimental ──────────────────────────────────────────────────────

function ExperimentalTab() {
  const flags = useFlagPrefs();
  const [glass, setGlass] = useState(sidebarGlassEnabled);
  return (
    <>
      <PaneHeader
        title="Experimental"
        subtitle="Preview features. May change or be removed without notice."
      />
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
      <p className="text-[11.5px] text-text-3 mb-2">
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
      <div className="w-24 text-[12px] text-text-2">{label}</div>
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
              className="text-[11.5px] px-2 py-1 rounded bg-accent-green text-bg-deep disabled:opacity-40"
            >
              save
            </button>
            <button
              type="button"
              onClick={() => {
                setEditing(false);
                setValue("");
              }}
              className="text-[11.5px] px-2 py-1 rounded text-text-3 hover:text-text-1"
            >
              cancel
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2 text-[12px]">
            <span className="font-mono text-text-3">
              {last4 ? `••••${last4}` : "—"}
            </span>
            {active && (
              <span className="text-[10px] text-accent-green border border-accent-green/40 rounded px-1.5 py-0.5">
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
    if (!window.confirm("Disable strict mode? Pre-commit guard will stop blocking risky AST changes.")) {
      return;
    }
    try {
      await api.settingsDisableStrictUnlocked();
      onChanged();
    } catch (e) {
      alert(String(e));
    }
  };
  return (
    <>
      <Section title="Strict mode">
        <Row
          label={
            <>
              Status{" "}
              <StatusPill
                tone={strict ? (locked ? "red" : "amber") : "muted"}
                text={locked ? "on · locked" : strict ? "on" : "off"}
              />
            </>
          }
        >
          <div className="flex items-center gap-1.5">
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
        <p className="text-[11.5px] text-text-3 mt-1.5 leading-relaxed">
          {locked
            ? "Strict mode is passcode-locked — only a human at a real terminal can turn it off. Run "
            : strict
              ? "Strict mode is on. Before every commit, Aura checks the AI didn't quietly delete working code or do something different from what it said — and stops the commit if it did. "
              : "Strict mode is off. Turn it on (with a passcode, recommended) so Aura stops any commit where the AI deletes working code or strays from what it promised: run "}
          {!locked && (
            <code className="text-text-2">aura config set strict-mode true</code>
          )}
          {locked && (
            <code className="text-text-2">aura config reset-passcode</code>
          )}
          {locked && " from a real terminal."}
        </p>
      </Section>
      <Section title="Telemetry">
        <Toggle
          label="Anonymous telemetry"
          hint="Per-command usage counts. No content, paths, or identities are sent."
          value={view.telemetry_enabled}
          onChange={async (v) => {
            await api.settingsSetTelemetry(v);
            onChanged();
          }}
        />
      </Section>
      <Section title="Engine flags">
        <Toggle
          label="Local embeddings"
          hint="Force 100% offline embeddings (slower; requires sovereign embedding daemon)."
          value={view.use_local_embeddings}
          onChange={async (v) => {
            await api.settingsSetLocalEmbeddings(v);
            onChanged();
          }}
        />
        <Toggle
          label="Dev mode"
          hint="Bypass heavy infrastructure for local development. Off in production."
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
      <Row label="Base folder">
        <div className="flex items-center gap-1.5">
          <code
            className="text-[11.5px] text-text-2 truncate max-w-[260px]"
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
      <p className="text-[11.5px] text-text-3 mt-1.5 leading-relaxed">
        Where Aura keeps your parallel copies. Each task gets its own folder
        here, so agents can work side by side without stepping on each other.
        Pick any folder you can write to — Aura creates it the first time it&rsquo;s
        needed.
      </p>
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
  const [installed, setInstalled] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    const load = async () => {
      try {
        const res = await api.auraCli(repoRoot, ["policy", "list", "--json"]);
        const out = res.stdout.trim();
        if (!out) {
          setError(res.stderr.trim() || `exit ${res.status}`);
          return;
        }
        const parsed = JSON.parse(out) as PackDescriptor[];
        setPacks(parsed);
      } catch (e) {
        setError(String(e));
      }
    };
    load();
  }, [repoRoot]);

  const install = async (pack: PackDescriptor) => {
    setBusy(pack.id);
    setError(null);
    setToast(null);
    try {
      const res = await api.auraCli(repoRoot, ["policy", "add", pack.id]);
      if (res.status !== 0) {
        setError(res.stderr.trim() || `exit ${res.status}`);
      } else {
        setInstalled((prev) => new Set(prev).add(pack.id));
        setToast(`${pack.label} merged into production.aura.json`);
        setTimeout(() => setToast(null), 3000);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Section title="Rule template library">
      <p className="text-[11.5px] text-text-3 mb-2 leading-relaxed">
        Pre-built invariant packs. Install merges into{" "}
        <code className="text-text-2">production.aura.json</code> at the repo
        root. Layered packs additively — install several to compose.
      </p>
      {error && <div className="text-[11.5px] text-red mb-2">{error}</div>}
      {toast && <div className="text-[11.5px] text-accent-green mb-2">✓ {toast}</div>}
      {packs === null ? (
        <div className="text-[11.5px] text-text-4 py-2">loading packs…</div>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {packs.map((p) => (
            <li
              key={p.id}
              className="flex items-start gap-2 px-2.5 py-2 rounded border border-line-soft bg-bg-1"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-0.5">
                  <span className="text-[12px] text-text-1 font-medium">
                    {p.label}
                  </span>
                  <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-bg-2 text-text-3">
                    {p.category}
                  </span>
                  <span className="text-[10px] text-text-4">
                    {p.rule_count} rules
                  </span>
                </div>
                <div className="text-[11px] text-text-3 leading-relaxed">
                  {p.description}
                </div>
              </div>
              <Button
                variant="ghost"
                size="xs"
                disabled={busy === p.id}
                onClick={() => install(p)}
                title={`aura policy add ${p.id}`}
              >
                {busy === p.id
                  ? "installing…"
                  : installed.has(p.id)
                    ? "re-install"
                    : "install"}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

// ── Agents ────────────────────────────────────────────────────────────

function AgentsTab() {
  const [registry, setRegistry] = useState<AgentDescriptor[]>([]);
  const [tomlEntries, setTomlEntries] = useState<AgentsTomlEntry[]>([]);
  const [editing, setEditing] = useState<AgentsTomlEntry | null>(null);
  const [busy, setBusy] = useState(false);
  const reload = async () => {
    setBusy(true);
    try {
      const [reg, toml] = await Promise.all([
        api.agentsList(),
        api.settingsAgentsTomlList(),
      ]);
      setRegistry(reg);
      setTomlEntries(toml);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    reload();
  }, []);

  const reloadProviders = async () => {
    setBusy(true);
    try {
      const reg = await api.agentsReload();
      setRegistry(reg);
    } finally {
      setBusy(false);
    }
  };

  // Distinguish compiled-in vs TOML-declared so the user knows which
  // they can edit. TOML ids show up in `tomlEntries`; everything else
  // is compiled in (claude / gemini / codex / cursor / kimi).
  const tomlIds = useMemo(() => new Set(tomlEntries.map((e) => e.id)), [
    tomlEntries,
  ]);

  return (
    <>
      <PaneHeader
        title="Coding agents"
        subtitle="The command-line coding agents Aura can drive. Compiled-in providers plus any overrides you declare in ~/.aura/agents.toml."
      />
      <div className="mb-3.5 flex items-center gap-1.5">
        <Button
          variant="ghost"
          size="xs"
          onClick={() =>
            window.dispatchEvent(new CustomEvent("aura:open-onboarding"))
          }
        >
          Replay onboarding
        </Button>
        <Button
          variant="ghost"
          size="xs"
          onClick={reloadProviders}
          disabled={busy}
        >
          Reload
        </Button>
        <div className="flex-1" />
        <Button
          variant="default"
          size="xs"
          onClick={() => setEditing(blankEntry())}
        >
          + Add provider
        </Button>
      </div>
      <Card>
        {registry.map((p) => (
          <AgentRow
            key={p.id}
            descriptor={p}
            isTomlDeclared={tomlIds.has(p.id)}
            tomlEntry={tomlEntries.find((e) => e.id === p.id)}
            onEdit={(e) => setEditing(e)}
            onRemove={async () => {
              if (!window.confirm(`Remove TOML override for ${p.id}?`)) return;
              await api.settingsAgentsTomlRemove(p.id);
              await reload();
              await reloadProviders();
            }}
          />
        ))}
        {tomlEntries
          .filter((e) => !registry.some((r) => r.id === e.id))
          .map((e) => (
            <div
              key={e.id}
              className="py-3 text-[11.5px] text-amber"
            >
              {e.id} — declared in TOML but not loaded; click Reload above.
            </div>
          ))}
      </Card>
      {editing && (
        <AgentEditor
          entry={editing}
          onCancel={() => setEditing(null)}
          onSave={async (entry) => {
            await api.settingsAgentsTomlUpsert(entry);
            setEditing(null);
            await reload();
            await reloadProviders();
          }}
        />
      )}
    </>
  );
}

function AgentRow({
  descriptor,
  isTomlDeclared,
  tomlEntry,
  onEdit,
  onRemove,
}: {
  descriptor: AgentDescriptor;
  isTomlDeclared: boolean;
  tomlEntry: AgentsTomlEntry | undefined;
  onEdit: (entry: AgentsTomlEntry) => void;
  onRemove: () => void;
}) {
  const caps = [
    descriptor.capabilities.stream && "stream",
    descriptor.capabilities.pty && "pty",
    descriptor.capabilities.resume && "resume",
  ].filter(Boolean);
  return (
    <div className="flex items-center gap-2.5 py-3">
      <span
        className={`grid h-5 w-5 shrink-0 place-items-center rounded-full text-[11px] ${
          descriptor.available
            ? "bg-accent-green/12 text-accent-green"
            : "bg-bg-2 text-text-4"
        }`}
        title={descriptor.available ? "Available on this machine" : "Not found on PATH"}
      >
        {descriptor.available ? "✓" : "✕"}
      </span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-[12.5px] text-text-1">{descriptor.label}</span>
          <span className="text-[10.5px] text-text-4 font-mono">
            {descriptor.id}
          </span>
          {isTomlDeclared && (
            <span className="text-[9.5px] text-accent border border-accent/40 rounded px-1 py-0.5 uppercase tracking-wider">
              toml
            </span>
          )}
        </div>
        <div className="mt-0.5 text-[10.5px] text-text-4 font-mono truncate">
          {descriptor.bin}
          {descriptor.version && ` · ${descriptor.version}`}
          {caps.length > 0 && ` · ${caps.join(" · ")}`}
        </div>
      </div>
      {isTomlDeclared && tomlEntry && (
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="xs"
            onClick={() => onEdit(tomlEntry)}
          >
            Edit
          </Button>
          <Button
            variant="ghost"
            size="xs"
            onClick={onRemove}
            className="text-red hover:text-red"
          >
            Remove
          </Button>
        </div>
      )}
    </div>
  );
}

function AgentEditor({
  entry,
  onCancel,
  onSave,
}: {
  entry: AgentsTomlEntry;
  onCancel: () => void;
  onSave: (entry: AgentsTomlEntry) => void;
}) {
  const [draft, setDraft] = useState<AgentsTomlEntry>(entry);
  const [argsText, setArgsText] = useState(
    (draft.args ?? []).join(" "),
  );
  const isNew = !entry.id;
  const apply = () => {
    onSave({
      ...draft,
      args: tokenize(argsText),
      supports_stream: !!draft.supports_stream,
      supports_pty: !!draft.supports_pty,
      supports_resume: !!draft.supports_resume,
    });
  };
  const saveDisabled = !draft.id.trim() || !draft.bin.trim();
  return (
    <FullscreenOverlay
      onClose={onCancel}
      contentClassName="overflow-y-auto"
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant="accentSoft"
            size="sm"
            onClick={apply}
            disabled={saveDisabled}
          >
            {isNew ? "Add agent" : "Save changes"}
          </Button>
        </>
      }
    >
      <div className="flex w-full flex-col items-center px-6 py-12 sm:py-16">
        <div className="flex w-full max-w-[640px] flex-col gap-8">
          <div>
            <h1 className="text-[18px] font-medium leading-7 text-text-1">
              {isNew ? "New coding agent" : `Edit ${entry.label || entry.id}`}
            </h1>
            <p className="mt-1.5 text-[13px] leading-relaxed text-text-3">
              Declare a command-line coding agent Aura can drive. Saved to{" "}
              <code className="font-mono text-text-2">~/.aura/agents.toml</code>{" "}
              — Aura launches it exactly like the built-in providers.
            </p>
          </div>

          <div className="flex flex-col gap-6">
            <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
              <FormField
                label="ID"
                htmlFor="ae-id"
                description="Stable, lowercase. Examples: kimi, devstral."
              >
                <Input
                  id="ae-id"
                  value={draft.id}
                  onChange={(e) => setDraft({ ...draft, id: e.target.value })}
                  disabled={!isNew}
                  placeholder="kimi"
                  className="font-mono"
                />
              </FormField>
              <FormField
                label="Label"
                htmlFor="ae-label"
                description="The friendly name shown in the agent picker."
              >
                <Input
                  id="ae-label"
                  value={draft.label}
                  onChange={(e) => setDraft({ ...draft, label: e.target.value })}
                  placeholder="Kimi"
                />
              </FormField>
            </div>

            <FormField
              label="Binary"
              htmlFor="ae-bin"
              description="Path or PATH-resolvable name — e.g. /opt/kimi or just kimi."
            >
              <Input
                id="ae-bin"
                value={draft.bin}
                onChange={(e) => setDraft({ ...draft, bin: e.target.value })}
                placeholder="kimi"
                className="font-mono"
              />
            </FormField>

            <FormField
              label="Args"
              htmlFor="ae-args"
              description="Tokens, space-separated. Use {prompt} for the message and optional {resume} for a session id."
            >
              <Input
                id="ae-args"
                value={argsText}
                onChange={(e) => setArgsText(e.target.value)}
                placeholder="chat --prompt {prompt}"
                className="font-mono"
              />
            </FormField>

            <FormField
              label="Capabilities"
              description="What this agent's CLI supports — Aura adapts how it drives the process."
            >
              <div className="divide-y divide-line-soft rounded-lg bg-bg-content px-3.5 shadow-[var(--shadow-field)]">
                <Toggle
                  label="Streaming output"
                  hint="The CLI streams tokens as it generates, instead of one final block."
                  value={!!draft.supports_stream}
                  onChange={(v) => setDraft({ ...draft, supports_stream: v })}
                />
                <Toggle
                  label="Interactive terminal (PTY)"
                  hint="Runs as a full TUI inside a pseudo-terminal."
                  value={!!draft.supports_pty}
                  onChange={(v) => setDraft({ ...draft, supports_pty: v })}
                />
                <Toggle
                  label="Resume sessions"
                  hint="Can pick up a previous session by id."
                  value={!!draft.supports_resume}
                  onChange={(v) => setDraft({ ...draft, supports_resume: v })}
                />
              </div>
            </FormField>
          </div>
        </div>
      </div>
    </FullscreenOverlay>
  );
}

function blankEntry(): AgentsTomlEntry {
  return {
    id: "",
    label: "",
    bin: "",
    args: [],
    supports_stream: false,
    supports_pty: true,
    supports_resume: false,
  };
}

function tokenize(s: string): string[] {
  return s
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

// ── Local & Custom Models ─────────────────────────────────────────────
//
// Profile editor + connection tester for the `openai-compat` agent
// kind. Anything that speaks OpenAI's `/v1/chat/completions` (Ollama,
// HuggingFace TGI, Together, Groq, OpenRouter, vLLM, …) plugs in here.
// Profiles persist to `~/.aura/agents/openai-compat.json` via
// `cmd_openai_compat.rs`; the agent picker in EmptyPanePicker reads the
// same list so launching one of these is exactly like launching Claude.

type OpenAiCompatPreset = {
  id: string;
  label: string;
  base_url: string;
  default_model: string;
  needs_key: boolean;
  hint: string;
};

const OPENAI_COMPAT_PRESETS: OpenAiCompatPreset[] = [
  {
    id: "ollama",
    label: "Ollama (localhost)",
    base_url: "http://localhost:11434/v1",
    default_model: "llama3.2",
    needs_key: false,
    hint: "Local — runs models on your machine. No API key required.",
  },
  {
    id: "huggingface",
    label: "HuggingFace Inference",
    base_url: "https://api-inference.huggingface.co/v1",
    default_model: "meta-llama/Llama-3.3-70B-Instruct",
    needs_key: true,
    hint: "Hosted — paste an HF Inference API token as the API key.",
  },
  {
    id: "together",
    label: "Together.ai",
    base_url: "https://api.together.xyz/v1",
    default_model: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    needs_key: true,
    hint: "Hosted — sign up at together.ai and paste your key.",
  },
  {
    id: "groq",
    label: "Groq",
    base_url: "https://api.groq.com/openai/v1",
    default_model: "llama-3.3-70b-versatile",
    needs_key: true,
    hint: "Hosted — fastest token throughput; paste your Groq API key.",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    base_url: "https://openrouter.ai/api/v1",
    default_model: "meta-llama/llama-3.3-70b-instruct",
    needs_key: true,
    hint: "Hosted — multi-vendor router; paste your OpenRouter key.",
  },
];

function blankOpenAiCompatProfile(): OpenAiCompatProfile {
  return {
    name: "",
    base_url: "",
    model: "",
    api_key: "",
    headers: {},
    temperature: null,
    description: "",
    created_at: null,
  };
}

function LocalModelsTab() {
  const [profiles, setProfiles] = useState<OpenAiCompatProfile[]>([]);
  const [editing, setEditing] = useState<OpenAiCompatProfile | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<
    Record<string, { running: boolean; result?: OpenAiCompatTestResult; error?: string }>
  >({});

  const reload = useCallback(async () => {
    try {
      const list = await api.openaiCompatProfilesList();
      setProfiles(list);
      setLoadError(null);
    } catch (e) {
      setLoadError(String(e));
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);

  async function test(name: string) {
    setTestResults((prev) => ({ ...prev, [name]: { running: true } }));
    try {
      const result = await api.openaiCompatTest(name);
      setTestResults((prev) => ({ ...prev, [name]: { running: false, result } }));
    } catch (e) {
      setTestResults((prev) => ({
        ...prev,
        [name]: { running: false, error: String(e) },
      }));
    }
  }

  async function remove(name: string) {
    if (!window.confirm(`Remove the "${name}" profile?`)) return;
    try {
      const next = await api.openaiCompatProfileRemove(name);
      setProfiles(next);
    } catch (e) {
      setLoadError(String(e));
    }
  }

  return (
    <>
      <PaneHeader
        title="Local & Custom Models"
        subtitle="OpenAI-compatible endpoints — Ollama, HuggingFace, Together, Groq, OpenRouter, vLLM, anything that speaks /v1/chat/completions."
      />
      {loadError && (
        <div className="text-[11.5px] text-red mb-3" role="alert">
          {loadError}
        </div>
      )}
      <div className="mb-3.5 flex items-center gap-2">
        <span className="text-[11.5px] text-text-3 flex-1">
          {profiles.length === 0
            ? "No profiles yet. Add one to chat with a local or hosted model."
            : `${profiles.length} profile${profiles.length === 1 ? "" : "s"} configured.`}
        </span>
        <Button
          variant="default"
          size="xs"
          onClick={() => setEditing(blankOpenAiCompatProfile())}
        >
          + Add profile
        </Button>
      </div>
      {profiles.length > 0 && (
        <Card>
          {profiles.map((p) => {
            const status = testResults[p.name];
            return (
              <div key={p.name} className="flex items-center gap-2.5 py-3">
                <span
                  className="mt-0.5 h-1.5 w-1.5 shrink-0 self-start rounded-full bg-text-5"
                  aria-hidden
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[12.5px] text-text-1">{p.name}</span>
                    <span className="text-[10.5px] text-text-4 font-mono">
                      {p.model}
                    </span>
                    {!p.api_key && (
                      <span className="text-[9.5px] text-text-4 border border-line-soft rounded px-1 py-0.5 uppercase tracking-wider">
                        no-key
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 text-[10.5px] text-text-4 font-mono truncate">
                    {p.base_url}
                  </div>
                  {status?.running && (
                    <div className="mt-0.5 text-[10.5px] text-text-4">
                      Testing…
                    </div>
                  )}
                  {status?.result && (
                    <div
                      className="mt-0.5 text-[10.5px]"
                      style={{
                        color: status.result.ok
                          ? "var(--color-accent-green, #4ade80)"
                          : "var(--color-red, #fca5a5)",
                      }}
                    >
                      {status.result.message}
                    </div>
                  )}
                  {status?.error && (
                    <div className="mt-0.5 text-[10.5px] text-red">
                      {status.error}
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() => void test(p.name)}
                    disabled={status?.running}
                    title="Hit the endpoint with a 1-token ping to verify connectivity"
                  >
                    Test
                  </Button>
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() => setEditing(p)}
                  >
                    Edit
                  </Button>
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() => void remove(p.name)}
                    className="text-red hover:text-red"
                  >
                    Remove
                  </Button>
                </div>
              </div>
            );
          })}
        </Card>
      )}
      {editing && (
        <OpenAiCompatEditor
          entry={editing}
          existingNames={profiles.map((p) => p.name)}
          onCancel={() => setEditing(null)}
          onSave={async (next) => {
            try {
              const list = await api.openaiCompatProfileSave(next);
              setProfiles(list);
              setEditing(null);
            } catch (e) {
              setLoadError(String(e));
            }
          }}
        />
      )}
    </>
  );
}

function OpenAiCompatEditor({
  entry,
  existingNames,
  onCancel,
  onSave,
}: {
  entry: OpenAiCompatProfile;
  existingNames: string[];
  onCancel: () => void;
  onSave: (entry: OpenAiCompatProfile) => void;
}) {
  const [draft, setDraft] = useState<OpenAiCompatProfile>({
    ...entry,
    headers: entry.headers ?? {},
  });
  // Headers as a single textarea — `Key: Value` per line. Keeps the
  // editor simple; advanced users (HF dedicated endpoints with
  // multi-header auth) just paste a block.
  const [headersText, setHeadersText] = useState<string>(() => {
    const h = entry.headers ?? {};
    return Object.entries(h)
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n");
  });

  const isNew = !entry.created_at;
  const nameTaken =
    isNew &&
    existingNames.some(
      (n) => n.toLowerCase() === draft.name.trim().toLowerCase(),
    );

  function applyPreset(preset: OpenAiCompatPreset) {
    setDraft((prev) => ({
      ...prev,
      base_url: preset.base_url,
      model: prev.model || preset.default_model,
      description: prev.description || preset.hint,
    }));
  }

  function parseHeaders(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const raw of headersText.split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const i = line.indexOf(":");
      if (i <= 0) continue;
      const key = line.slice(0, i).trim();
      const value = line.slice(i + 1).trim();
      if (key) out[key] = value;
    }
    return out;
  }

  function save() {
    const headers = parseHeaders();
    onSave({
      ...draft,
      name: draft.name.trim(),
      base_url: draft.base_url.trim(),
      model: draft.model.trim(),
      api_key: draft.api_key?.trim() || null,
      headers,
      temperature:
        typeof draft.temperature === "number" && !Number.isNaN(draft.temperature)
          ? draft.temperature
          : null,
      description: draft.description?.trim() || null,
    });
  }

  const saveDisabled =
    !draft.name.trim() ||
    !draft.base_url.trim() ||
    !draft.model.trim() ||
    nameTaken;

  return (
    <FullscreenOverlay
      onClose={onCancel}
      contentClassName="overflow-y-auto"
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant="accentSoft"
            size="sm"
            onClick={save}
            disabled={saveDisabled}
          >
            {isNew ? "Add profile" : "Save changes"}
          </Button>
        </>
      }
    >
      <div className="flex w-full flex-col items-center px-6 py-12 sm:py-16">
        <div className="flex w-full max-w-[640px] flex-col gap-8">
          <div>
            <h1 className="text-[18px] font-medium leading-7 text-text-1">
              {isNew ? "New local-model profile" : `Edit ${entry.name}`}
            </h1>
            <p className="mt-1.5 text-[13px] leading-relaxed text-text-3">
              Connect any OpenAI-compatible endpoint — Ollama, HuggingFace,
              Together, Groq, OpenRouter, vLLM — and chat with it just like a
              built-in model.
            </p>
          </div>

          <FormField
            label="Quick presets"
            description="Pre-fill the base URL and a sensible default model. You can still edit everything below."
          >
            <div className="flex flex-wrap gap-1.5">
              {OPENAI_COMPAT_PRESETS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => applyPreset(p)}
                  className="h-8 rounded-md bg-bg-content px-3 text-[12.5px] font-medium text-text-2 shadow-[var(--shadow-field)] transition-colors hover:text-text-1"
                  title={p.hint}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </FormField>

          <div className="flex flex-col gap-6">
            <FormField
              label="Name"
              htmlFor="oac-name"
              description="Display label — also the row id. Letters, digits, spaces."
              error={
                nameTaken ? "A profile with this name already exists." : undefined
              }
            >
              <Input
                id="oac-name"
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                disabled={!isNew}
                placeholder="Llama 3 (local)"
                invalid={nameTaken}
              />
            </FormField>

            <FormField
              label="Base URL"
              htmlFor="oac-url"
              description="Endpoint root — typically ends in /v1. Aura appends /chat/completions and /models."
            >
              <Input
                id="oac-url"
                value={draft.base_url}
                onChange={(e) =>
                  setDraft({ ...draft, base_url: e.target.value })
                }
                placeholder="http://localhost:11434/v1"
                className="font-mono"
              />
            </FormField>

            <FormField
              label="Model"
              htmlFor="oac-model"
              description="Whatever model id the endpoint exposes — Ollama tag, HF repo path, vendor model name."
            >
              <Input
                id="oac-model"
                value={draft.model}
                onChange={(e) => setDraft({ ...draft, model: e.target.value })}
                placeholder="llama3.2 / qwen2.5-coder:7b / meta-llama/Llama-3.3-70B-Instruct"
                className="font-mono"
              />
            </FormField>

            <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
              <FormField
                label="API key"
                htmlFor="oac-key"
                optional
                description="Sent as Authorization: Bearer. Leave blank for Ollama or other unauthenticated local servers."
              >
                <Input
                  id="oac-key"
                  type="password"
                  value={draft.api_key ?? ""}
                  onChange={(e) =>
                    setDraft({ ...draft, api_key: e.target.value })
                  }
                  placeholder="sk-… / hf_…"
                  className="font-mono"
                  autoComplete="off"
                />
              </FormField>
              <FormField
                label="Temperature"
                htmlFor="oac-temp"
                optional
                description="0.0 = deterministic, 1.0 = creative. Blank leaves the server default."
              >
                <Input
                  id="oac-temp"
                  type="number"
                  step="0.05"
                  min="0"
                  max="2"
                  value={
                    typeof draft.temperature === "number" ? draft.temperature : ""
                  }
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      temperature:
                        e.target.value === "" ? null : Number(e.target.value),
                    })
                  }
                  placeholder="0.7"
                  className="font-mono"
                />
              </FormField>
            </div>

            <FormField
              label="Extra headers"
              htmlFor="oac-headers"
              optional
              description="One header per line — Name: Value. Useful for HF dedicated endpoints, OpenRouter routing hints, etc."
            >
              <Textarea
                id="oac-headers"
                value={headersText}
                onChange={(e) => setHeadersText(e.target.value)}
                rows={3}
                placeholder={"X-HF-Endpoint: my-endpoint\nHTTP-Referer: https://example.com"}
                className="font-mono"
              />
            </FormField>

            <FormField
              label="Description"
              htmlFor="oac-desc"
              optional
              description="Shown under the row in the model picker."
            >
              <Input
                id="oac-desc"
                value={draft.description ?? ""}
                onChange={(e) =>
                  setDraft({ ...draft, description: e.target.value })
                }
                placeholder="Local Llama 3 via Ollama"
              />
            </FormField>

            <div className="rounded-lg border border-accent-amber/25 bg-accent-amber/8 px-3.5 py-2.5 text-[12px] leading-relaxed text-accent-amber">
              API keys are stored in plaintext at{" "}
              <code className="font-mono">~/.aura/agents/openai-compat.json</code>{" "}
              for this iteration. We&apos;ll move them to the OS keychain in a
              follow-up.
            </div>
          </div>
        </div>
      </div>
    </FullscreenOverlay>
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
      <p className="text-[11.5px] text-text-3 mb-2">
        Anonymous only — never your code, files, what you type, or your name. We
        use it to see which features help and to fix crashes. Change it anytime.
      </p>
      <Toggle
        label="Crash reports"
        hint="Tells us when Aura breaks so we can fix it. The most useful to leave on."
        value={consent?.crash ?? true}
        onChange={(v) => apply(consent?.product ?? true, v)}
      />
      <Toggle
        label="Usage analytics"
        hint="Anonymous counts of which features get opened. No content of any kind."
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
      {error && <div className="text-[11.5px] text-red mb-2">{error}</div>}
      {view ? (
        view.enabled ? (
          <>
            <Row label="Status">
              <StatusPill tone="muted" text={`${total} events`} />
            </Row>
            {view.last_updated && (
              <Row label="Last updated">
                <span className="text-[11.5px] text-text-3">
                  {new Date(view.last_updated * 1000).toLocaleString()}
                </span>
              </Row>
            )}
            {sorted.length > 0 ? (
              <ul className="text-[11.5px] font-mono mt-2 max-h-64 overflow-auto">
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
              <p className="text-[11.5px] text-text-4 mt-2">
                No events recorded yet.
              </p>
            )}
            <div className="flex justify-end mt-3">
              <Button
                variant="ghost"
                size="xs"
                onClick={async () => {
                  if (!window.confirm("Clear local telemetry counters?")) return;
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
          <p className="text-[11.5px] text-text-3">
            Telemetry is disabled. Toggle it on under <em>Policy &rarr; Telemetry</em>.
          </p>
        )
      ) : (
        <p className="text-[11.5px] text-text-4">loading…</p>
      )}
    </Section>
  );
}

// ── Help & Support ─────────────────────────────────────────────────────
//
// One calm place for the things people hunt for when they're stuck:
// the keyboard map, the docs/repo/issue links, and which build they're
// running. Shortcuts mirror the Command Palette's canonical hints
// (CommandPalette.tsx APP_ACTIONS) so there's a single source of truth —
// if a binding changes there, update the row here too.

const HELP_SHORTCUTS: Array<{ label: string; keys: string }> = [
  { label: "Command palette", keys: "⌘K" },
  { label: "Toggle sidebar", keys: "⌘B" },
  { label: "Toggle terminal", keys: "⌘J" },
  { label: "Toggle review panel", keys: "⌘R" },
  { label: "Search across files", keys: "⌘⇧F" },
  { label: "Save file", keys: "⌘S" },
  { label: "Close tab", keys: "⌘W" },
  { label: "New chat", keys: "⌘N" },
  { label: "Open tasks board", keys: "⌘T" },
  { label: "Open team notes", keys: "⌘⇧N" },
  { label: "Log task intent", keys: "⌘⇧I" },
  { label: "Open settings", keys: "⌘," },
];

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
    hint: "github.com/Naridon-Inc/aura — fully open source",
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

// A shortcut combo split into per-glyph key caps, each our shared `Kbd`
// primitive (the `@nari/ui` Medusa-kit key cap) so every hint reads identically.
function KbdCombo({ combo }: { combo: string }) {
  return (
    <span className="inline-flex items-center gap-0.5">
      {[...combo].map((glyph, i) => (
        <Kbd key={i}>{glyph}</Kbd>
      ))}
    </span>
  );
}

function HelpTab() {
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
      <Section title="Keyboard shortcuts">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6">
          {HELP_SHORTCUTS.map((s) => (
            <div
              key={s.label}
              className="flex items-center justify-between gap-3 py-1.5 border-b border-line-soft/40 last:border-b-0"
            >
              <span className="text-[12px] text-text-2 flex items-center gap-2">
                <Keyboard className="h-3.5 w-3.5 text-text-4" aria-hidden />
                {s.label}
              </span>
              <KbdCombo combo={s.keys} />
            </div>
          ))}
        </div>
        <p className="mt-2 text-[10.5px] text-text-4">
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
              className="group flex items-center gap-3 rounded-md px-2 py-2 text-left hover:bg-bg-2 transition-colors"
            >
              <span className="shrink-0 text-text-3 group-hover:text-accent">
                {l.icon}
              </span>
              <span className="flex-1 min-w-0">
                <span className="block text-[12.5px] text-text-1">
                  {l.label}
                </span>
                <span className="block text-[11px] text-text-4 truncate">
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

      <Section title="About">
        <Row label="Aura">
          <span className="text-[12px] text-text-2 tabular-nums">
            {version ? `v${version}` : "—"}
          </span>
        </Row>
        <Row label="Semantic version control">
          <span className="text-[11px] text-text-4">
            CLI · Desktop · Cloud
          </span>
        </Row>
        <p className="mt-2 text-[10.5px] text-text-4 leading-relaxed">
          Aura watches every change the way a careful teammate would — it sees
          what each edit means, checks it still matches what you asked for, and
          lets you bring back a single piece if something breaks. Open source
          under the Naridon umbrella.
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
      !confirm(
        `Delete profile "${name}"? This removes ~/.aura/agent-profiles/${name}/ — any agent CLI login state inside (Claude tokens, Gemini config, etc.) is GONE.`,
      )
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
    if (!confirm(`Delete git profile "${id}"?`)) return;
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
      <PaneHeader
        title="Profiles"
        subtitle="Isolated agent logins and per-workspace git identities."
      />
      {error && (
        <div className="text-rose-400 text-xs px-3 py-2 bg-rose-500/10 rounded border border-rose-500/30">
          {error}
        </div>
      )}

      <Section
        title={
          repoRoot
            ? `This workspace — ${shortRepoLabel(repoRoot)}`
            : "This workspace"
        }
      >
        {repoRoot && (
          <div className="flex flex-col gap-3">
            <LabeledRow label="Git identity">
              <Select
                value={binding.git_profile_id ?? ""}
                onChange={(v) =>
                  void saveBinding({
                    ...binding,
                    git_profile_id: v || null,
                  })
                }
                options={[
                  { value: "", label: "(none — use system default)" },
                  ...gitProfiles.map((p) => ({
                    value: p.id,
                    label: `${p.label} — ${p.user_email}`,
                  })),
                ]}
                aria-label="Git identity"
                className="min-w-[200px]"
              />
            </LabeledRow>
            <LabeledRow label="Default agent profile">
              <Select
                value={binding.agent_profile_name ?? ""}
                onChange={(v) =>
                  void saveBinding({
                    ...binding,
                    agent_profile_name: v || null,
                  })
                }
                options={[
                  { value: "", label: "(none — inherit system HOME)" },
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
              <div className="flex items-center gap-2 text-[11.5px]">
                <label className="flex items-center gap-1 cursor-pointer">
                  <input
                    type="radio"
                    name="bindscope"
                    checked={bindingScope === "repo"}
                    onChange={() => setBindingScope("repo")}
                  />
                  Repo file (.aura/profile.json)
                </label>
                <label className="flex items-center gap-1 cursor-pointer">
                  <input
                    type="radio"
                    name="bindscope"
                    checked={bindingScope === "global"}
                    onChange={() => setBindingScope("global")}
                  />
                  Global path map
                </label>
                {binding.source && (
                  <span className="text-text-4 ml-2">
                    (loaded from {binding.source})
                  </span>
                )}
              </div>
            </LabeledRow>
          </div>
        )}
      </Section>

      <Section title="Agent profiles">
        <div className="flex flex-col gap-1.5">
          {agentProfiles.length === 0 && (
            <div className="text-[11.5px] text-text-4">No profiles yet.</div>
          )}
          {agentProfiles.map((p) => (
            <div
              key={p.name}
              className="flex items-center gap-2 px-2.5 py-1.5 rounded border border-line-soft bg-bg-2"
            >
              <span className="font-medium text-[12.5px] text-text-1">
                {p.label ?? p.name}
              </span>
              <span className="text-[11px] text-text-4 font-mono">
                ~/.aura/agent-profiles/{p.name}
              </span>
              <button
                type="button"
                onClick={() => void deleteAgentProfile(p.name)}
                disabled={busy}
                className="ml-auto h-6 px-2 rounded text-[11px] text-rose-400 hover:bg-rose-500/10 transition-colors"
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
            placeholder="new-profile-name"
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
            <div className="text-[11.5px] text-text-4">No git profiles yet.</div>
          )}
          {gitProfiles.map((p) => (
            <div
              key={p.id}
              className="flex items-center gap-2 px-2.5 py-1.5 rounded border border-line-soft bg-bg-2"
            >
              <div className="flex flex-col">
                <span className="font-medium text-[12.5px] text-text-1">
                  {p.label}
                </span>
                <span className="text-[11px] text-text-4">
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
                  className="h-6 px-2 rounded text-[11px] text-text-2 hover:bg-bg-3"
                >
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() => void deleteGitProfile(p.id)}
                  disabled={busy}
                  className="h-6 px-2 rounded text-[11px] text-rose-400 hover:bg-rose-500/10"
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

function shortRepoLabel(repoRoot: string): string {
  const parts = repoRoot.split("/").filter(Boolean);
  return parts.slice(-2).join("/") || repoRoot;
}

// ── Identity tab (II.9) ───────────────────────────────────────────────
//
// Surfaces the per-repo identity override map + the alias-augmented
// roster for the current repo. Two concerns intentionally co-located so
// a user fixing "messages don't appear under @teammate" doesn't have to
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
  return <IdentityPanel repoRoots={repoRoots} />;
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
      <span className="text-[11.5px] text-text-2 min-w-[140px]">{label}</span>
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
          <span className="text-rose-400 text-[11px] ml-2">
            id already in use
          </span>
        )}
      </LabeledRow>
      <LabeledRow label="Label">
        <Input
          value={draft.label}
          onChange={(e) => setDraft({ ...draft, label: e.target.value })}
          placeholder="Work — TouchStage"
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
