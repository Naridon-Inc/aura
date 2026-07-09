// Per-tab user customization (name, accent color, icon glyph). Stored in
// localStorage under `aura.tabs.<repoRoot>` so customization survives
// reopen and is keyed to the project, not to the in-memory tab handle.
//
// Tab id conventions (the keys in the persisted map):
//   - file:    `file:<repo-relative-or-abs-path>`
//   - agent:   `agent:<sessionId>`  (session id is already stable across
//              re-opens since aura-shell uses `agent_id@root#sid`)
//   - term:    `term:<termId>`      (termId is `term-<uuid>`)
//
// Multi-tab subscribers use a tiny pub-sub so changes propagate across
// every component reading the same repo's map without prop drilling.

import { useEffect, useState } from "react";

export type TabAccent =
  | "default"
  | "cobalt"
  | "plum"
  | "amber"
  | "emerald"
  | "ruby"
  | "slate"
  | "rose"
  | "teal";

export type TabIcon =
  | "default"
  | "claude"
  | "gemini"
  | "codex"
  | "cursor"
  | "flame"
  | "bolt"
  | "flask"
  | "anchor"
  | "book"
  | "star"
  | "leaf";

export type TabCustomization = {
  name?: string;
  accent?: TabAccent;
  icon?: TabIcon;
};

export type TabKind = "file" | "agent" | "term" | "manager";

export function tabIdFor(kind: TabKind, raw: string): string {
  return `${kind}:${raw}`;
}

const subs = new Map<string, Set<() => void>>();

function notify(repoRoot: string) {
  subs.get(repoRoot)?.forEach((fn) => fn());
}

function storageKey(repoRoot: string): string {
  return `aura.tabs.${repoRoot}`;
}

function readMap(repoRoot: string): Record<string, TabCustomization> {
  try {
    const raw = localStorage.getItem(storageKey(repoRoot));
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed;
    return {};
  } catch {
    return {};
  }
}

function writeMap(repoRoot: string, map: Record<string, TabCustomization>) {
  try {
    localStorage.setItem(storageKey(repoRoot), JSON.stringify(map));
  } catch {
    /* full quota or private mode — best-effort */
  }
  notify(repoRoot);
}

/** Read the customization map for a repo. Subscribes to live updates so
 *  the consumer re-renders when any tab in the repo is renamed/recolored. */
export function useTabCustomizationMap(
  repoRoot: string | null | undefined,
): Record<string, TabCustomization> {
  const key = repoRoot ?? "";
  const [map, setMap] = useState<Record<string, TabCustomization>>(() =>
    key ? readMap(key) : {},
  );

  useEffect(() => {
    if (!key) {
      setMap({});
      return;
    }
    const fn = () => setMap(readMap(key));
    fn();
    if (!subs.has(key)) subs.set(key, new Set());
    subs.get(key)!.add(fn);
    // Cross-tab/cross-window updates from the OS-level storage event.
    const onStorage = (e: StorageEvent) => {
      if (e.key === storageKey(key)) fn();
    };
    window.addEventListener("storage", onStorage);
    return () => {
      subs.get(key)?.delete(fn);
      window.removeEventListener("storage", onStorage);
    };
  }, [key]);

  return map;
}

/** Convenience accessor for a single tab. */
export function useTabCustomization(
  repoRoot: string | null | undefined,
  tabId: string,
): TabCustomization | undefined {
  const map = useTabCustomizationMap(repoRoot);
  return map[tabId];
}

/** Imperative actions. Each repoRoot keeps an isolated map. */
export function setTabCustomization(
  repoRoot: string,
  tabId: string,
  patch: Partial<TabCustomization>,
) {
  const cur = readMap(repoRoot);
  const merged: TabCustomization = { ...(cur[tabId] ?? {}), ...patch };
  // Drop empty-string overrides so the auto-derived label can come back.
  if (merged.name === "") delete merged.name;
  // Drop "default" sentinels so the renderer falls back to brand defaults.
  if (merged.accent === "default") delete merged.accent;
  if (merged.icon === "default") delete merged.icon;
  // If nothing left, remove the entry entirely.
  if (Object.keys(merged).length === 0) {
    delete cur[tabId];
  } else {
    cur[tabId] = merged;
  }
  writeMap(repoRoot, cur);
}

export function clearTabCustomization(repoRoot: string, tabId: string) {
  const cur = readMap(repoRoot);
  if (!(tabId in cur)) return;
  delete cur[tabId];
  writeMap(repoRoot, cur);
}

/** Accent palette — paired Tailwind-friendly tokens that work on dark bg. */
export const ACCENT_PALETTE: Record<TabAccent, { fg: string; bg: string }> = {
  default: { fg: "var(--color-text-2)", bg: "transparent" },
  cobalt: { fg: "#5b9dff", bg: "color-mix(in srgb, #5b9dff 18%, transparent)" },
  plum: { fg: "#c678dd", bg: "color-mix(in srgb, #c678dd 18%, transparent)" },
  amber: { fg: "#f0b042", bg: "color-mix(in srgb, #f0b042 18%, transparent)" },
  emerald: { fg: "#56d394", bg: "color-mix(in srgb, #56d394 18%, transparent)" },
  ruby: { fg: "#ff6b6b", bg: "color-mix(in srgb, #ff6b6b 18%, transparent)" },
  slate: { fg: "#9aa0aa", bg: "color-mix(in srgb, #9aa0aa 18%, transparent)" },
  rose: { fg: "#ff8fa3", bg: "color-mix(in srgb, #ff8fa3 18%, transparent)" },
  teal: { fg: "#4ec9b0", bg: "color-mix(in srgb, #4ec9b0 18%, transparent)" },
};

export const ACCENTS: TabAccent[] = [
  "default",
  "cobalt",
  "plum",
  "amber",
  "emerald",
  "ruby",
  "slate",
  "rose",
  "teal",
];

export const ICONS: TabIcon[] = [
  "default",
  "claude",
  "gemini",
  "codex",
  "cursor",
  "flame",
  "bolt",
  "flask",
  "anchor",
  "book",
  "star",
  "leaf",
];
