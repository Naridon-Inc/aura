import {
  Building2,
  CreditCard,
  Cpu,
  FlaskConical,
  GitBranch,
  Import,
  Keyboard,
  KeyRound,
  KeySquare,
  Palette,
  Plug,
  Router,
  Server,
  Settings2,
  SlidersHorizontal,
  Terminal,
  UserCircle,
  Users,
} from "lucide-react";
import type { ReactNode } from "react";

import { ProjectAvatar } from "../ProjectAvatar";
import type { SettingsNavigationGroup } from "../ui/settings-layout";

// The settings page list, in the library's shape: one list of Personal,
// Agents & environment, Organization, Services, one entry per repository that
// opens to Scripts, Actions and Misc, and More. The repositories come after
// the organization pages on purpose: someone with many projects would
// otherwise scroll past every one of them to find Billing. Each page draws its few rows; the rarer
// parts of it sit in one collapsed Advanced at its foot (FOLDED_PAGES). A
// search finds a page by its own words and by the words of what is folded
// into it, and every old link still lands, opening the Advanced it names.

export type SettingsPageId =
  | "general"
  | "account"
  | "import"
  | "appearance"
  | "shortcuts"
  | "models"
  | "git"
  | "agents"
  | "environment"
  | "mcp"
  | "computer"
  | "organization"
  | "team"
  | "billing"
  | "api"
  | "experimental"
  | "advanced"
  | "terminal";

/** A part of a page, drawn inside it, that a link can name. */
export type FoldedPageId =
  | "editor"
  | "hud"
  | "identity"
  | "profiles"
  | "connected"
  | "telemetry"
  | "mobile"
  | "look"
  | "themes"
  | "routing"
  | "brain"
  | "local-models"
  | "machine"
  | "modes"
  | "plugins"
  | "capture"
  | "aurawatch"
  | "policy"
  | "access"
  | "cloud"
  | "base"
  | "env-vars"
  | "help";

/** A repository's own pages. */
export type RepoSection = "scripts" | "actions" | "misc";

/** `repo:<root>` is a repository's Scripts; Actions and Misc have their own prefix. */
export type RepoPage = `repo:${string}` | `repo-actions:${string}` | `repo-misc:${string}`;

export type SettingsPage = SettingsPageId | RepoPage;

/** What a page can send you to: another page, or a part folded into one. */
export type SettingsLink = SettingsPage | FoldedPageId;

interface PageEntry {
  id: SettingsPageId;
  label: string;
  icon: ReactNode;
  keywords: string[];
  /** Acts on the repository picked in the toolbar rather than on you. */
  repo?: boolean;
}

interface PageGroup {
  label: string;
  items: PageEntry[];
}

interface FoldEntry {
  id: FoldedPageId;
  /** The heading it has inside the page that holds it. */
  label: string;
  /** The page that holds it; a repository section means the open repository's. */
  into: SettingsPageId | RepoSection;
  keywords: string[];
  /** Drawn in the page's own rows rather than in its Advanced. */
  inline?: boolean;
}

/** The group drawn after the repositories; every other group comes before them. */
const MORE_GROUP = "More";

export const PAGE_GROUPS: PageGroup[] = [
  {
    label: "Personal",
    items: [
      { id: "general", label: "General", icon: <SlidersHorizontal size={16} />, keywords: ["follow-up", "followup", "steer", "queue", "sound", "chime", "notification", "disk access", "permissions", "chat", "interrupt", "redirect", "composer"] },
      { id: "account", label: "Account", icon: <UserCircle size={16} />, keywords: ["name", "email", "account", "login", "sign in", "sign out", "workspace", "plan", "cloud"] },
      { id: "import", label: "Import", icon: <Import size={16} />, keywords: ["import", "migrate", "switch", "move", "bring over", "conductor", "superset", "cursor", "windsurf", "void", "zed", "workspaces", "chats", "history", "rules", "mcp"] },
      { id: "appearance", label: "Appearance", icon: <Palette size={16} />, keywords: ["theme", "dark", "light", "contrast", "font", "size", "zoom", "look", "terminal font"] },
      { id: "shortcuts", label: "Keyboard shortcuts", icon: <Keyboard size={16} />, keywords: ["keyboard", "shortcut", "keys", "hotkey", "binding"] },
      { id: "models", label: "Default models", icon: <Cpu size={16} />, keywords: ["model", "loadout", "favorite", "favourite", "output style", "default"] },
      { id: "git", label: "Git", icon: <GitBranch size={16} />, keywords: ["git", "author", "name", "email", "commit", "identity", "github", "your github", "connect github", "push", "pull request"] },
    ],
  },
  {
    label: "Agents & environment",
    items: [
      { id: "agents", label: "Agents", icon: <Router size={16} />, keywords: ["claude", "gemini", "codex", "cursor", "kimi", "opencode", "provider", "agent", "cli", "login", "api key", "executable", "providers", "registry", "acp", "agent client protocol", "install", "update", "uninstall", "sign in", "earlier chats", "resume", "qwen", "goose", "amp"] },
      { id: "environment", label: "Environment", icon: <KeyRound size={16} />, keywords: ["secret", "secrets", "vault", "env", "environment", "variable", "token", "api key", "credential", ".env", "toolchain", "tools", "spec", "machine", "install", "place"], repo: true },
      { id: "mcp", label: "MCP", icon: <Plug size={16} />, keywords: ["mcp", "mcps", "servers", "atlassian", "linear", "github", "sentry", "model context protocol", "tools"], repo: true },
      { id: "computer", label: "Cloud computer", icon: <Server size={16} />, keywords: ["cloud", "computer", "machine", "machines", "box", "vm", "build", "install", "software", "repositories", "repository", "clone", "shared", "specs"] },
    ],
  },
  {
    label: "Organization",
    items: [
      { id: "organization", label: "Organization", icon: <Building2 size={16} />, keywords: ["organization", "org", "name", "address", "slug", "create organization", "new organization", "switch"] },
      { id: "team", label: "Members", icon: <Users size={16} />, keywords: ["team", "members", "admin", "organization", "standup", "activity", "tokens", "usage", "billing", "report", "rollup", "people"], repo: true },
      { id: "billing", label: "Billing", icon: <CreditCard size={16} />, keywords: ["billing", "plan", "pro", "teams", "enterprise", "upgrade", "checkout", "subscription", "invoice", "payment", "card", "seats", "trial", "stripe"] },
    ],
  },
  {
    label: "Services",
    items: [
      { id: "api", label: "API access", icon: <KeySquare size={16} />, keywords: ["api", "api key", "keys", "token", "ci", "integration", "scope", "revoke", "automation"] },
    ],
  },
  {
    label: MORE_GROUP,
    items: [
      { id: "experimental", label: "Experimental", icon: <FlaskConical size={16} />, keywords: ["flags", "preview", "lab", "glass", "token"] },
      { id: "advanced", label: "Advanced", icon: <Settings2 size={16} />, keywords: ["root", "directory", "folder", "worktree", "parallel", "copies", "dev mode", "embeddings", "offline", "search"] },
      { id: "terminal", label: "Terminal", icon: <Terminal size={16} />, keywords: ["shell", "pty", "bell", "cursor", "scrollback", "profile", "gpu"] },
    ],
  },
];

export const REPO_SECTIONS: { id: RepoSection; label: string; keywords: string[] }[] = [
  { id: "scripts", label: "Scripts", keywords: ["setup", "startup", "run", "archive", "script", "scripts", "install"] },
  { id: "actions", label: "Actions", keywords: ["actions", "named scripts", "review", "pull request", "pr", "conflict", "instructions", "prompt"] },
  { id: "misc", label: "Misc", keywords: ["copy", "copies", "files", "branch", "base", "binary", "github", "host", "enterprise", "landing", "worktree"] },
];

export const FOLDED_PAGES: FoldEntry[] = [
  { id: "editor", label: "Sounds and editor", into: "general", keywords: ["sound", "message", "huddle", "vim", "minimap", "sticky", "indent", "editor", "keybindings"] },
  { id: "hud", label: "Floating HUD", into: "general", keywords: ["hud", "overlay", "floating", "capsule", "minimal", "always on top", "shape", "opacity", "glance", "sidebar", "fab", "desk pet"] },
  { id: "identity", label: "You in each repository", into: "account", keywords: ["identity", "alias", "handle", "per-repo", "override", "mention", "team", "git"] },
  { id: "profiles", label: "Agent profiles", into: "account", keywords: ["profile", "profiles", "claude", "isolated", "default profile", "workspace"] },
  { id: "connected", label: "Connected services", into: "account", keywords: ["jira", "linear", "atlassian", "sync", "tasks", "issues", "oauth", "tracker", "beads", "import", "integration", "connect", "store", "anthropic", "openai", "gemini", "mercury", "secret", "key", "api key", "provider", "integrations"] },
  { id: "telemetry", label: "Usage data", into: "account", keywords: ["usage", "anonymous", "metrics", "telemetry", "privacy", "crash"] },
  { id: "mobile", label: "Mobile", into: "account", keywords: ["mobile", "phone", "iphone", "ios", "android", "app", "waitlist", "testflight", "invite", "beta", "notify"] },
  { id: "look", label: "Style and editor font", into: "appearance", keywords: ["style", "accent", "amber", "emerald", "editor font"] },
  { id: "themes", label: "Editor themes", into: "appearance", keywords: ["vscode", "vs code", "theme", "import", "color", "syntax", "tokencolors", "monaco", "extension", "code theme"] },
  { id: "routing", label: "Default model", into: "models", keywords: ["new sessions", "default model", "start on"] },
  { id: "brain", label: "Brain & models", into: "models", keywords: ["brain", "model", "provider", "anthropic", "openai", "gemini", "byok", "api key", "subscription", "claude"] },
  { id: "local-models", label: "Local & custom models", into: "models", keywords: ["ollama", "huggingface", "together", "groq", "openrouter", "vllm", "local", "llama", "qwen", "openai-compat", "hf", "chat", "completions"] },
  { id: "machine", label: "This machine", into: "agents", keywords: ["look again", "detect", "add an agent", "aura first", "manager", "onboarding", "sync", "config"] },
  { id: "modes", label: "Modes", into: "agents", keywords: ["modes", "mode", "marketplace", "architect", "debug", "persona", "specialist", "system prompt", "code"] },
  { id: "plugins", label: "Plugins", into: "agents", keywords: ["plugin", "skill", "marketplace", "extension"] },
  { id: "capture", label: "Record changes", into: "misc", keywords: ["capture", "enable", "disable", "hooks", "git hook", "checkpoint", "semantic", "record", "merge", "smart merge", "no mcp", "drop-in"] },
  { id: "aurawatch", label: "Change reasons", into: "misc", keywords: ["change reasons", "reason", "why", "aurawatch", "nudge", "remind", "watch", "intent", "auto-fill", "autonomous", "backend", "ollama"] },
  { id: "policy", label: "Security & policy", into: "misc", keywords: ["strict", "passcode", "lock", "policy", "templates", "grants", "rules", "security"] },
  { id: "access", label: "Who can use it", into: "computer", inline: true, keywords: ["who can use", "access", "seat", "seats", "permission", "permissions", "let in", "share", "members", "teammate"] },
  { id: "cloud", label: "Connected machines", into: "computer", keywords: ["always-on", "runner", "remote", "always on", "connect", "agents", "machines", "sign in"] },
  { id: "base", label: "Base builds", into: "computer", inline: true, keywords: ["base", "build", "warm", "shared", "install", "cache", "team environment", "place"] },
  { id: "env-vars", label: "Environment variables", into: "computer", inline: true, keywords: ["env", "environment", "variable", "variables", "secret", "token", "import", "cloud workspace", "workspace"] },
  { id: "help", label: "Help & about", into: "advanced", keywords: ["help", "support", "docs", "github", "issue", "bug", "report", "about", "version", "community", "discord", "star", "documentation", "discussions", "open source", "tour"] },
];

const ALL_PAGES = PAGE_GROUPS.flatMap((group) => group.items);

const PREFIX: Record<RepoSection, string> = { scripts: "repo:", actions: "repo-actions:", misc: "repo-misc:" };

export function repoName(root: string): string {
  return root.split("/").filter(Boolean).pop() || root;
}

export function repoPage(root: string, section: RepoSection = "scripts"): RepoPage {
  return `${PREFIX[section]}${root}` as RepoPage;
}

/** The repository and section a repository page is, or null for any other page. */
export function repoPageOf(page: string): { root: string; section: RepoSection } | null {
  for (const section of ["actions", "misc", "scripts"] as const) {
    if (page.startsWith(PREFIX[section])) return { root: page.slice(PREFIX[section].length), section };
  }
  return null;
}

export function isRepoPage(page: SettingsPage): page is RepoPage {
  return repoPageOf(page) !== null;
}

/** Whether a page acts on the repository picked in the toolbar. */
export function pageActsOnRepo(page: SettingsPage): boolean {
  return isRepoPage(page) || !!ALL_PAGES.find((entry) => entry.id === page)?.repo;
}

export function pageLabel(page: SettingsPage): string {
  const repo = repoPageOf(page);
  if (repo) return REPO_SECTIONS.find((section) => section.id === repo.section)!.label;
  return ALL_PAGES.find((entry) => entry.id === page)?.label ?? "Settings";
}

/** The heading a folded part carries inside the page that holds it. */
export function foldLabel(id: FoldedPageId): string {
  return FOLDED_PAGES.find((fold) => fold.id === id)?.label ?? id;
}

const homeOf = (page: SettingsPage): FoldEntry["into"] => repoPageOf(page)?.section ?? (page as SettingsPageId);

const matches = (q: string, label: string, keywords: string[] = []) =>
  !q || label.toLowerCase().includes(q) || keywords.some((word) => word.includes(q));

/** Whether the page's Advanced should open: a link named a part of it, or a
 *  search matches one. */
export function advancedOpens(page: SettingsPage, asked: FoldedPageId | null, query: string): boolean {
  const q = query.trim().toLowerCase();
  return FOLDED_PAGES.some(
    (fold) =>
      fold.into === homeOf(page) &&
      !fold.inline &&
      (fold.id === asked || (!!q && matches(q, fold.label, fold.keywords))),
  );
}

const REPOSITORY_KEYWORDS = ["repository", "repo", "workspace", "agent", "isolated"];

/** The page list the frame draws, filtered by the search box against each
 *  page's label and keywords and against the parts folded into it. */
export function navigationGroups(roots: string[], query: string): SettingsNavigationGroup[] {
  const q = query.trim().toLowerCase();
  const hitFolds = (into: FoldEntry["into"]) =>
    !!q && FOLDED_PAGES.some((fold) => fold.into === into && matches(q, fold.label, fold.keywords));
  const draw = (group: PageGroup) => ({
    label: group.label,
    items: group.items
      .filter((entry) => matches(q, entry.label, entry.keywords) || hitFolds(entry.id))
      .map(({ id, label, icon }) => ({ id, label, icon })),
  });
  const sections = REPO_SECTIONS.filter(
    (section) => !q || matches(q, section.label, section.keywords) || hitFolds(section.id),
  );
  const repos = {
    label: "Repositories",
    items: roots
      .filter((root) => sections.length > 0 || matches(q, repoName(root), REPOSITORY_KEYWORDS))
      .map((root) => ({
        id: `repo-entry:${root}`,
        label: repoName(root),
        icon: <ProjectAvatar root={root} name={repoName(root)} />,
        children: (sections.length > 0 ? sections : REPO_SECTIONS).map((section) => ({
          id: repoPage(root, section.id),
          label: section.label,
        })),
      })),
  };
  const drawn = PAGE_GROUPS.map(draw);
  const before = drawn.filter((group) => group.label !== MORE_GROUP);
  const after = drawn.filter((group) => group.label === MORE_GROUP);
  return [...before, repos, ...after].filter((group) => group.items.length > 0);
}

/** Every page id the list draws, sub-pages included. */
export function visiblePages(groups: SettingsNavigationGroup[]): string[] {
  return groups.flatMap((group) =>
    group.items.flatMap((item) => (item.children?.length ? item.children.map((child) => child.id) : [item.id])),
  );
}

/** Older links name pages by ids the settings used before; each resolves to
 *  the page that now holds it. */
const LEGACY_PAGES: Record<string, SettingsPageId | FoldedPageId | RepoSection> = {
  behavior: "general",
  vault: "environment",
  copies: "scripts",
  repository: "scripts",
};

const asSection = (id: string): RepoSection | null =>
  REPO_SECTIONS.some((section) => section.id === id) ? (id as RepoSection) : null;

export function resolvePageLink(id: string, currentRepo: string): SettingsPage | null {
  const mapped = LEGACY_PAGES[id] ?? id;
  if (repoPageOf(mapped)) return mapped as SettingsPage;
  const fold = FOLDED_PAGES.find((entry) => entry.id === mapped);
  const into = fold ? fold.into : mapped;
  const section = asSection(into);
  if (section) return currentRepo ? repoPage(currentRepo, section) : null;
  return ALL_PAGES.some((entry) => entry.id === into) ? (into as SettingsPageId) : null;
}

/** The folded part a link names, so the page can open and bring it into view. */
export function foldOfLink(id: string): FoldedPageId | null {
  const mapped = LEGACY_PAGES[id] ?? id;
  return FOLDED_PAGES.some((entry) => entry.id === mapped) ? (mapped as FoldedPageId) : null;
}
