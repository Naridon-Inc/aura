// How the ⌘K palette orders its fixed groups and keeps the rows of each.
//
// With nothing typed the groups stand in their own order. Once something is
// typed, each group's words are counted against the query's words and the
// group that names more of them moves up, so "theme" brings Actions above
// Workspace actions and "git" brings Settings up. Inside a group a row is
// kept when its label and keywords score above a floor, best first.

import { defaultFilter } from "cmdk";

export type CatalogGroupKey = "workspace-actions" | "actions" | "navigation" | "settings" | "open-in";

export const CATALOG_GROUP_ORDER: CatalogGroupKey[] = [
  "workspace-actions",
  "actions",
  "navigation",
  "settings",
  "open-in",
];

export const CATALOG_GROUP_LABEL: Record<CatalogGroupKey, string> = {
  "workspace-actions": "Workspace actions",
  actions: "Actions",
  navigation: "Navigation",
  settings: "Settings",
  "open-in": "Open in",
};

const GROUP_WORDS: Record<Exclude<CatalogGroupKey, "open-in">, string> = {
  "workspace-actions":
    "quick open file search find picker changes diff uncommitted all files tree checks ci pull request github archive",
  actions:
    "new workspace create add repository project toggle theme dark light left right sidebar panel zen mode focus distraction show keyboard shortcuts keys hotkeys check update updates version changelog release notes",
  navigation:
    "go to next unread attention chat session settings preferences config archive archived workspaces view show open docs documentation help guide home history routines",
  settings:
    "settings preferences config chat appearance theme git env environment variables agents account experimental advanced models mcp terminal",
};

/** The query split into lowercase words. */
function wordsOf(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

/** The groups in the order they are drawn for this query. `openIn` is the
 *  names of the apps the folder can be opened in, which are that group's
 *  words. */
export function rankCatalogGroups(query: string, openIn: readonly string[]): CatalogGroupKey[] {
  const words = wordsOf(query);
  if (!words.length) return CATALOG_GROUP_ORDER;
  const vocabulary = (key: CatalogGroupKey) =>
    key === "open-in" ? `${openIn.join(" ").toLowerCase()} open in` : GROUP_WORDS[key];
  return CATALOG_GROUP_ORDER.map((key, index) => ({
    key,
    index,
    hits: words.filter((w) => vocabulary(key).includes(w)).length,
  }))
    .sort((a, b) => b.hits - a.hits || a.index - b.index)
    .map((g) => g.key);
}

/** The groups a tab draws. */
export function catalogGroupsFor(tab: string): CatalogGroupKey[] {
  if (tab === "all") return CATALOG_GROUP_ORDER;
  if (tab === "actions") return ["workspace-actions", "actions", "open-in"];
  if (tab === "settings") return ["settings"];
  return [];
}

/** Below this a row is not a match. */
const SCORE_FLOOR = 0.2;

export function catalogScore(label: string, query: string, keywords: readonly string[]): number {
  const q = query.trim();
  if (!q) return 1;
  const score = defaultFilter(label, q, [...keywords]);
  return score > SCORE_FLOOR ? score : 0;
}

/** The rows of one group that match, best first; every row when nothing is
 *  typed. */
export function matchCatalog<T extends { label: string; keywords: readonly string[] }>(
  rows: readonly T[],
  query: string,
): T[] {
  if (!query.trim()) return [...rows];
  return rows
    .map((row, index) => ({ row, index, score: catalogScore(row.label, query, row.keywords) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((r) => r.row);
}
