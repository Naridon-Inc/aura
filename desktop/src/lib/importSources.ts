// Settings → Import: the calls into the importer (src-tauri/src/import) and
// the small rules the page and its promo toast share. The disk reading is all
// in Rust; this file only names the shapes it returns and decides what to show.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { RECENTS_MAX } from "./recentProjects";

export type ImportItemKind = "repo" | "workspace" | "chat" | "scripts" | "rules" | "mcp";
export type ImportItemState = "ready" | "done" | "unavailable";

/** One thing another app holds that maps onto Aura. */
export interface ImportItem {
  /** Stable within its source (`repo:<id>`, `chat:<id>`, `mcp:<name>`, …). */
  key: string;
  kind: ImportItemKind;
  title: string;
  detail: string;
  /** Last activity, epoch milliseconds. */
  when: number | null;
  state: ImportItemState;
  /** Why it is done or unavailable. */
  reason: string | null;
  /** The folder it belongs to, when it has one. */
  root: string | null;
}

/** An app Aura knows how to import from, and whether it left data here. */
export interface ImportSource {
  id: string;
  name: string;
  /** The app itself is still installed. */
  installed: boolean;
  /** Its data is on this Mac (it may outlive the app). */
  found: boolean;
  /** How many things were already brought over from it. */
  imported: number;
}

export interface ImportScan {
  id: string;
  name: string;
  installed: boolean;
  found: boolean;
  items: ImportItem[];
  /** Things worth saying that are not items: encrypted chats, folders gone. */
  notes: string[];
}

export type ImportOutcomeStatus = "imported" | "skipped" | "failed";

export interface ImportOutcome {
  key: string;
  kind: ImportItemKind;
  title: string;
  status: ImportOutcomeStatus;
  reason: string | null;
  auraRef: string | null;
}

/** A folder the window adds to its project list, or names and pins. */
export interface ImportAdopt {
  root: string;
  name: string | null;
  pinned: boolean;
  /** A repository (joins the project list) rather than a worktree of one. */
  project: boolean;
}

export interface ImportReport {
  outcomes: ImportOutcome[];
  adopt: ImportAdopt[];
}

export interface ImportProgress {
  source: string;
  done: number;
  total: number;
  title: string;
}

export function importSourcesDetect(): Promise<ImportSource[]> {
  return invoke("import_sources_detect");
}

export function importSourceScan(source: string, knownRoots: string[]): Promise<ImportScan> {
  return invoke("import_source_scan", { source, knownRoots });
}

export function importRun(
  source: string,
  keys: string[],
  knownRoots: string[],
  projectRoom: number,
): Promise<ImportReport> {
  return invoke("import_run", { source, keys, knownRoots, projectRoom });
}

export function onImportProgress(handler: (p: ImportProgress) => void): Promise<UnlistenFn> {
  return listen<ImportProgress>("import:progress", (e) => handler(e.payload));
}

/** The window event the page sends with the folders an import brought in. */
export const IMPORT_PROJECTS_EVENT = "aura:import-projects";

export function announceAdopted(adopt: ImportAdopt[]) {
  if (adopt.length === 0) return;
  window.dispatchEvent(new CustomEvent(IMPORT_PROJECTS_EVENT, { detail: { adopt } }));
}

/** How many more projects the list takes before it would have to drop one. */
export function projectRoom(recents: readonly string[]): number {
  return Math.max(0, RECENTS_MAX - recents.length);
}

/** The order kinds are drawn in, with the words each group is headed by. */
export const KIND_ORDER: { kind: ImportItemKind; label: string; lands: string }[] = [
  { kind: "repo", label: "Projects", lands: "Added to your project list" },
  { kind: "workspace", label: "Workspaces", lands: "Shown under their project, with the same name and branch" },
  { kind: "chat", label: "Chats", lands: "Become Aura chats in their project" },
  { kind: "scripts", label: "Scripts", lands: "Fill the project's empty setup, run and review settings" },
  { kind: "rules", label: "Rules", lands: "Gathered into the project's AGENTS.md" },
  { kind: "mcp", label: "MCP servers", lands: "Added to Aura's MCP servers" },
];

export interface ImportGroup {
  kind: ImportItemKind;
  label: string;
  lands: string;
  items: ImportItem[];
  ready: number;
}

/** Items grouped by kind, in `KIND_ORDER`, leaving out kinds the source has none of. */
export function groupItems(items: readonly ImportItem[]): ImportGroup[] {
  return KIND_ORDER.flatMap(({ kind, label, lands }) => {
    const mine = items.filter((i) => i.kind === kind);
    if (mine.length === 0) return [];
    // Ready first, newest first, so the part someone is likely to want is on top.
    const rank = (i: ImportItem) => (i.state === "ready" ? 0 : i.state === "done" ? 1 : 2);
    mine.sort((a, b) => rank(a) - rank(b) || (b.when ?? 0) - (a.when ?? 0));
    return [{ kind, label, lands, items: mine, ready: mine.filter((i) => i.state === "ready").length }];
  });
}

/** What is ticked when a source is first opened: everything that can come over. */
export function defaultSelection(items: readonly ImportItem[]): Set<string> {
  return new Set(items.filter((i) => i.state === "ready").map((i) => i.key));
}

/** Keys to send, in the scan's order, dropping anything that stopped being ready. */
export function selectedKeys(items: readonly ImportItem[], picked: ReadonlySet<string>): string[] {
  return items.filter((i) => i.state === "ready" && picked.has(i.key)).map((i) => i.key);
}

export interface OutcomeTally {
  imported: number;
  skipped: number;
  failed: number;
}

export function tally(outcomes: readonly ImportOutcome[]): OutcomeTally {
  const t: OutcomeTally = { imported: 0, skipped: 0, failed: 0 };
  for (const o of outcomes) t[o.status] += 1;
  return t;
}

/** Plural-aware count: `count(2, "chat")` → "2 chats". */
export function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

// ── Opening one app's import from elsewhere (the promo) ──────────────────

let askedSource: string | null = null;
export const IMPORT_SOURCE_EVENT = "aura:import-source";

/** Open Settings → Import with `id` already unfolded. */
export function openImportFor(id: string | null) {
  askedSource = id;
  window.dispatchEvent(new CustomEvent("aura:open-settings", { detail: { pane: "import" } }));
  // A page already on screen hears this; one about to mount takes `askedSource`.
  window.dispatchEvent(new CustomEvent(IMPORT_SOURCE_EVENT, { detail: { id } }));
}

/** The app the last `openImportFor` asked for, once. */
export function takeAskedSource(): string | null {
  const id = askedSource;
  askedSource = null;
  return id;
}

// ── The promo toast ──────────────────────────────────────────────────────

const PROMO_KEY = (id: string) => `aura.import.promoDismissed.${id}`;

export function promoDismissed(id: string): boolean {
  try {
    return localStorage.getItem(PROMO_KEY(id)) === "1";
  } catch {
    // Storage refused: treat it as dismissed rather than ask on every launch.
    return true;
  }
}

export function dismissPromo(id: string) {
  try {
    localStorage.setItem(PROMO_KEY(id), "1");
  } catch {
    /* nothing to keep it in; it will ask again next launch */
  }
}

/** The app the promo offers to import from: the first one whose data is on
 *  this Mac, that nothing was brought over from yet, and that the person has
 *  not waved away. Installed apps come before ones only their data outlived. */
export function promoSource(
  sources: readonly ImportSource[],
  isDismissed: (id: string) => boolean = promoDismissed,
): ImportSource | null {
  const open = sources.filter((s) => s.found && s.imported === 0 && !isDismissed(s.id));
  return open.find((s) => s.installed) ?? open[0] ?? null;
}

/** What each app has worth bringing, in the promo's words. The rest hold
 *  projects and chats. */
const PROMO_WHAT: Record<string, string> = {
  conductor: "your workspaces and chats",
  superset: "your workspaces and their scripts",
  windsurf: "your projects, rules and MCP servers",
};

/** The promo's wording for one app. */
export function promoCopy(source: Pick<ImportSource, "id" | "name">): { title: string; message: string } {
  const what = PROMO_WHAT[source.id] ?? "your projects and chats";
  return {
    title: `Coming from ${source.name}?`,
    message: `Bring ${what} into Aura. It only reads ${source.name}'s files; nothing there changes.`,
  };
}
