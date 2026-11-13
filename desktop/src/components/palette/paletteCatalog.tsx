// The ⌘K palette's fixed rows, as data: what each says, the words that find
// it, its key when Aura has one, and what it does (`CatalogRun`, carried out
// by paletteRun). Which rows a place offers is decided here too: the cloud
// has no checkout to search or archive, and no repository to add.

import {
  Archive,
  AppWindow,
  BookOpen,
  ChevronRight,
  CircleCheck,
  FileDiff,
  FileSearch,
  FileText,
  FolderPlus,
  FolderTree,
  GitPullRequestCreate,
  House,
  Keyboard,
  Maximize2,
  PanelLeft,
  PanelRight,
  Play,
  Plus,
  RefreshCw,
  Settings,
  Sun,
} from "lucide-react";
import type { ReactNode } from "react";

import type { AppActionId } from "../../lib/keymap";
import { FOLDED_PAGES, PAGE_GROUPS } from "../settings/nav";
import type { CatalogGroupKey } from "./paletteRank";

export type CatalogRun =
  | { kind: "action"; id: AppActionId }
  /** Puts this in the field: a scope prefix that turns the list into a search. */
  | { kind: "query"; text: string }
  /** The Workspaces tab, showing only archived workspaces. */
  | { kind: "archived" }
  | { kind: "event"; name: string; detail?: unknown }
  | { kind: "url"; url: string }
  | { kind: "theme" }
  | { kind: "updates" }
  | { kind: "zen" }
  | { kind: "cloud-page"; page: "home" | "routines" }
  | { kind: "cloud-create" }
  | { kind: "open-in"; app: string; name: string }
  | { kind: "archive-workspace" };

export type CatalogItem = {
  id: string;
  label: string;
  icon: ReactNode;
  keywords: string[];
  shortcut?: string;
  run: CatalogRun;
};

export type CatalogPlace = {
  kind: "local" | "cloud" | "machine";
  /** A workspace is open in front of the palette. */
  hasWorkspace: boolean;
  /** The open workspace is a copy that can be archived (not the main checkout). */
  canArchive: boolean;
  /** The theme in use now, which "Toggle theme" leaves. */
  theme: "dark" | "light";
  /** Apps the open folder can be opened in. */
  editors: { id: string; name: string }[];
};

export const DOCS_URL = "https://auravcs.com/docs";
export const CHANGELOG_URL = "https://auravcs.com/changelog";

function workspaceActions(place: CatalogPlace): CatalogItem[] {
  if (place.kind === "cloud" || !place.hasWorkspace) return [];
  const rows: CatalogItem[] = [
    { id: "quick-open", label: "File picker", icon: <FileText />, keywords: ["quick", "open", "file", "search", "find", "picker"], run: { kind: "query", text: ":" } },
    { id: "search-in-files", label: "Search in files", icon: <FileSearch />, keywords: ["search", "find", "grep", "files", "code", "text"], run: { kind: "query", text: "?" } },
    { id: "show-changes", label: "Show changes", icon: <FileDiff />, keywords: ["show", "changes", "diff", "git", "uncommitted"], shortcut: "⌥⌘U", run: { kind: "action", id: "toggle_changes" } },
    { id: "show-all-files", label: "Show all files", icon: <FolderTree />, keywords: ["show", "all", "files", "tree"], run: { kind: "event", name: "aura:open-files-panel" } },
    { id: "show-checks", label: "Show checks", icon: <CircleCheck />, keywords: ["show", "checks", "ci", "pull", "request"], run: { kind: "event", name: "aura:open-checks" } },
    { id: "create-pull-request", label: "Create PR", icon: <GitPullRequestCreate />, keywords: ["create", "pull", "request", "pr", "github"], run: { kind: "action", id: "open_prs" } },
  ];
  if (place.kind === "local" && place.canArchive)
    rows.push({ id: "archive-workspace", label: "Archive workspace", icon: <Archive />, keywords: ["archive", "current", "workspace"], shortcut: "⇧⌘A", run: { kind: "archive-workspace" } });
  return rows;
}

function actions(place: CatalogPlace): CatalogItem[] {
  const rows: CatalogItem[] = [
    {
      id: "new-workspace",
      label: "Create workspace",
      icon: <Plus />,
      keywords: ["new", "workspace", "create", "create workspace"],
      run: place.kind === "cloud" ? { kind: "cloud-create" } : { kind: "event", name: "aura:new-workspace", detail: { createFrom: true } },
    },
  ];
  if (place.kind === "local")
    rows.push({ id: "add-repository", label: "Add repository", icon: <FolderPlus />, keywords: ["add", "project", "repository", "repo", "open", "import"], shortcut: "⌥⌘A", run: { kind: "action", id: "add_project" } });
  rows.push(
    { id: "toggle-theme", label: "Toggle theme", icon: <Sun />, keywords: ["toggle", "theme", "dark", "light", place.theme], run: { kind: "theme" } },
    { id: "toggle-left-sidebar", label: "Toggle left sidebar", icon: <PanelLeft />, keywords: ["toggle", "left", "sidebar", "panel"], shortcut: "⌘B", run: { kind: "action", id: "toggle_sidebar" } },
    { id: "toggle-right-sidebar", label: "Toggle right sidebar", icon: <PanelRight />, keywords: ["toggle", "right", "sidebar", "panel"], shortcut: "⌥⌘B", run: { kind: "action", id: "toggle_review" } },
    { id: "toggle-zen-mode", label: "Toggle zen mode", icon: <Maximize2 />, keywords: ["toggle", "zen", "mode", "focus", "distraction"], run: { kind: "zen" } },
    { id: "show-shortcuts", label: "Show keyboard shortcuts", icon: <Keyboard />, keywords: ["show", "keyboard", "shortcuts", "keys", "hotkeys"], shortcut: "⌘/", run: { kind: "action", id: "shortcuts" } },
    { id: "check-for-updates", label: "Check for updates", icon: <RefreshCw />, keywords: ["check", "update", "updates", "version"], run: { kind: "updates" } },
    { id: "open-changelog", label: "Open changelog", icon: <BookOpen />, keywords: ["open", "changelog", "change", "log", "release", "notes", "updates", "version"], run: { kind: "url", url: CHANGELOG_URL } },
  );
  return rows;
}

function navigation(place: CatalogPlace): CatalogItem[] {
  const cloud = place.kind === "cloud";
  const rows: CatalogItem[] = [
    { id: "go-to-next-unread", label: "Go to next unread", icon: <ChevronRight />, keywords: ["go", "to", "next", "unread", "attention", "chat", "session"], shortcut: "⌥⌘L", run: { kind: "action", id: "next_attention" } },
    { id: "settings", label: "Settings", icon: <Settings />, keywords: ["settings", "preferences", "config"], shortcut: "⌘,", run: { kind: "action", id: "settings" } },
    { id: "home", label: "Home", icon: <House />, keywords: ["home", "history", "all", "workspaces", "activity"], run: cloud ? { kind: "cloud-page", page: "home" } : { kind: "action", id: "go_home" } },
  ];
  if (cloud)
    rows.push({ id: "routines", label: "Routines", icon: <Play />, keywords: ["routines", "routine", "automations", "automation", "cron", "webhook", "runs"], run: { kind: "cloud-page", page: "routines" } });
  rows.push(
    { id: "view-archived-workspaces", label: "View archived workspaces", icon: <Archive />, keywords: ["archive", "archived", "workspaces", "view", "show"], run: { kind: "archived" } },
    { id: "open-docs", label: "Open documentation", icon: <BookOpen />, keywords: ["docs", "documentation", "help", "guide"], run: { kind: "url", url: DOCS_URL } },
  );
  return rows;
}

/** Every settings page; with a query, also the parts folded inside them. */
function settings(query: string): CatalogItem[] {
  const pages = PAGE_GROUPS.flatMap((g) => g.items).map<CatalogItem>((p) => ({
    id: `settings-${p.id}`,
    label: p.label,
    icon: p.icon,
    keywords: p.keywords,
    run: { kind: "event", name: "aura:open-settings", detail: { pane: p.id } },
  }));
  if (!query.trim()) return pages;
  const folded = FOLDED_PAGES.map<CatalogItem>((f) => ({
    id: `settings-${f.id}`,
    label: f.label,
    icon: <Settings />,
    keywords: f.keywords,
    run: { kind: "event", name: "aura:open-settings", detail: { pane: f.id } },
  }));
  return [...pages, ...folded];
}

function openIn(place: CatalogPlace): CatalogItem[] {
  if (place.kind === "cloud" || !place.hasWorkspace) return [];
  return place.editors.map((app) => ({
    id: `open-in-${app.id}`,
    label: app.name,
    icon: <AppWindow />,
    keywords: ["open", "in", app.name, app.id],
    run: { kind: "open-in", app: app.id, name: app.name },
  }));
}

/** The rows of one group in this place. */
export function catalogRows(key: CatalogGroupKey, place: CatalogPlace, query: string): CatalogItem[] {
  switch (key) {
    case "workspace-actions":
      return workspaceActions(place);
    case "actions":
      return actions(place);
    case "navigation":
      return navigation(place);
    case "settings":
      return settings(query);
    case "open-in":
      return openIn(place);
  }
}
