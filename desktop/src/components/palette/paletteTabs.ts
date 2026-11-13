// The ⌘K palette's tabs: All, Workspaces, Repositories, Actions, Settings.
// Repositories is only offered on this computer; a remote place has no
// repositories of yours to list. Tab and Shift-Tab step through the tabs on
// show, wrapping at the ends, and each tab says in the field what it searches.

export type PaletteTab = "all" | "workspaces" | "repositories" | "actions" | "settings";

export const PALETTE_TABS: { id: PaletteTab; label: string }[] = [
  { id: "all", label: "All" },
  { id: "workspaces", label: "Workspaces" },
  { id: "repositories", label: "Repositories" },
  { id: "actions", label: "Actions" },
  { id: "settings", label: "Settings" },
];

/** The tabs on show: Repositories only when the place lists them. */
export function paletteTabsFor(showRepositories: boolean): { id: PaletteTab; label: string }[] {
  return PALETTE_TABS.filter((t) => showRepositories || t.id !== "repositories");
}

/** The tab after `at` (Tab), or before it (Shift-Tab), wrapping around. A tab
 *  that is no longer on show starts from the first. */
export function stepPaletteTab(
  at: PaletteTab,
  showRepositories: boolean,
  backwards = false,
): PaletteTab {
  const tabs = paletteTabsFor(showRepositories).map((t) => t.id);
  const i = tabs.indexOf(at);
  if (i < 0) return tabs[0];
  const step = backwards ? -1 : 1;
  return tabs[(i + step + tabs.length) % tabs.length];
}

const PLACEHOLDER: Record<PaletteTab, string> = {
  all: "Type a command or search...",
  workspaces: "Search workspaces...",
  repositories: "Search repositories...",
  actions: "Search actions...",
  settings: "Search settings...",
};

export function palettePlaceholder(tab: PaletteTab): string {
  return PLACEHOLDER[tab];
}

/** What the empty list says on a tab other than All. */
export function paletteNoMatch(tab: PaletteTab): string {
  return `No matching ${tab}`;
}
