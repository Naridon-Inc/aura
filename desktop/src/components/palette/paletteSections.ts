// What the ⌘K palette lists for a tab and a query, in order, as sections of
// rows. Every row has one key, used both as the list's value and to keep the
// selection, so the arrows and Enter walk exactly what is drawn.
//
// All, nothing typed: the recent workspaces, then the fixed groups, then the
// rest of Aura's actions. All, something typed: the fixed groups ranked by the
// query, Aura's actions, repositories, conversations, the place's workspaces
// (saying so when none match), then definitions, files, code, reasons and
// commands. Actions and Settings draw their groups only; Repositories its
// repositories; Workspaces the place's workspaces under its filters.

import { paletteKey } from "./PaletteRows";
import type { PaletteEntry } from "../CommandPalette";
import { catalogRows, type CatalogItem, type CatalogPlace } from "./paletteCatalog";
import type { AllLaneHits } from "./paletteHits";
import { CATALOG_GROUP_LABEL, catalogGroupsFor, matchCatalog, rankCatalogGroups } from "./paletteRank";
import type { PaletteTab } from "./paletteTabs";
import {
  WORKSPACE_LIMIT,
  filterWorkspaces,
  recentWorkspaces,
  searchWorkspaces,
  type PaletteWorkspace,
  type WorkspaceFilters,
} from "./paletteWorkspaces";

export type PaletteRepository = { id: string; name: string; repo: PaletteWorkspace["repo"] };

export type PaletteRow =
  | { type: "catalog"; key: string; item: CatalogItem }
  | { type: "entry"; key: string; entry: PaletteEntry }
  | { type: "workspace"; key: string; row: PaletteWorkspace }
  | { type: "repository"; key: string; repo: PaletteRepository }
  | { type: "none"; key: string };

export type PaletteSectionView = { key: string; heading?: string; rows: PaletteRow[] };

const catalogRow = (item: CatalogItem): PaletteRow => ({ type: "catalog", key: `catalog:${item.id}`, item });
const entryRow = (entry: PaletteEntry): PaletteRow => ({ type: "entry", key: paletteKey(entry), entry });
const workspaceRow = (row: PaletteWorkspace): PaletteRow => ({ type: "workspace", key: `workspace:${row.id}`, row });
const repositoryRow = (repo: PaletteRepository): PaletteRow => ({ type: "repository", key: `repository:${repo.id}`, repo });

/** Repositories whose name holds every word typed. */
export function matchRepositories(repos: readonly PaletteRepository[], query: string): PaletteRepository[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return repos.filter((r) => words.every((w) => r.name.toLowerCase().includes(w))).slice(0, WORKSPACE_LIMIT);
}

export type SectionInput = {
  tab: PaletteTab;
  query: string;
  place: CatalogPlace;
  /** Aura's own actions beyond the fixed groups. */
  more: readonly PaletteEntry[];
  workspaces: readonly PaletteWorkspace[];
  activeId: string | null;
  /** The place's repositories; null where it lists none. */
  repositories: readonly PaletteRepository[] | null;
  lanes: AllLaneHits;
  filters: WorkspaceFilters;
};

export function buildPaletteSections(input: SectionInput): PaletteSectionView[] {
  const { tab, query, place } = input;
  const typed = query.trim() !== "";
  const out: PaletteSectionView[] = [];
  const push = (key: string, heading: string | undefined, rows: PaletteRow[]) => {
    if (rows.length) out.push({ key, heading, rows });
  };

  if (tab === "workspaces") {
    const { active, archived } = filterWorkspaces(input.workspaces, query, input.filters);
    push("workspaces", "Workspaces", active.map(workspaceRow));
    push("archived", "Archived", archived.map(workspaceRow));
    return out;
  }
  if (tab === "repositories") {
    push("repositories", undefined, matchRepositories(input.repositories ?? [], query).map(repositoryRow));
    return out;
  }

  if (tab === "all" && !typed)
    push("recent", "Recent workspaces", recentWorkspaces(input.workspaces, input.activeId).map(workspaceRow));

  const groups = catalogGroupsFor(tab);
  for (const key of rankCatalogGroups(query, place.editors.map((e) => e.name))) {
    if (!groups.includes(key)) continue;
    push(key, CATALOG_GROUP_LABEL[key], matchCatalog(catalogRows(key, place, query), query).map(catalogRow));
  }
  if (tab === "all" || tab === "actions") {
    const more = matchCatalog(
      input.more.map((entry) => ({ entry, label: entry.label, keywords: [] as string[] })),
      query,
    );
    push("aura", "Aura", more.map((m) => entryRow(m.entry)));
  }
  if (tab !== "all" || !typed) return out;

  if (input.repositories)
    push("repositories", "Repositories", matchRepositories(input.repositories, query).map(repositoryRow));
  push("chats", "Conversations", input.lanes.chats.map(entryRow));
  const { active, archived } = searchWorkspaces(input.workspaces, query);
  const found = [...active, ...archived].map(workspaceRow);
  out.push({ key: "workspaces", heading: "Workspaces", rows: found.length ? found : [{ type: "none", key: "no-results" }] });
  push("symbols", "Definitions", input.lanes.symbols.map(entryRow));
  push("files", "Files", input.lanes.files.map(entryRow));
  push("matches", "In your code", input.lanes.matches.map(entryRow));
  push("intents", "Reasons & history", input.lanes.intents.map(entryRow));
  push("commands", "Commands", input.lanes.commands.map(entryRow));
  return out;
}

/** The keys of the rows that can be picked, in the order drawn. */
export function sectionKeys(sections: readonly PaletteSectionView[]): string[] {
  return sections.flatMap((s) => s.rows.filter((r) => r.type !== "none").map((r) => r.key));
}
