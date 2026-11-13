// The workspace list's own state: how it is grouped, sorted and filtered, which repositories are
// folded, which "Show more" lists are open, when each workspace was last
// opened, the row being renamed, and the ⌘-hold quick switch.

import { useEffect, useRef, useState } from "react";
import { setWorkspaceName } from "../../../lib/workspaceCustomization";
import type { RosterSort } from "./rosterLayout";
import type { RosterGroupBy } from "./rosterStatusLayout";
import type { Customization, Renaming } from "./rosterTypes";

const SORT_KEY = "aura.roster.sort";
const GROUP_KEY = "aura.roster.groupBy";
const FILTER_KEY = "aura.roster.repoFilter";
const COLLAPSED_KEY = "aura.roster.collapsed";
const VISITED_KEY = "aura.roster.visited";

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full or blocked: the list still works, it just forgets */
  }
}

function readSort(): RosterSort {
  try {
    return localStorage.getItem(SORT_KEY) === "created" ? "created" : "updated";
  } catch {
    return "updated";
  }
}

function readGroupBy(): RosterGroupBy {
  try {
    return localStorage.getItem(GROUP_KEY) === "status" ? "status" : "repo";
  } catch {
    return "repo";
  }
}

function readFilter(): string | null {
  try {
    return localStorage.getItem(FILTER_KEY) || null;
  } catch {
    return null;
  }
}

/** A text field has focus, so ⌘1–⌘9 belong to it, not to the list. */
function isEditing(): boolean {
  const el = document.activeElement as HTMLElement | null;
  return (
    !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)
  );
}

export function useRosterState(input: {
  activePath: string;
  custom: Customization;
  onOpenWorktree?: (path: string) => void;
}) {
  const { activePath, custom, onOpenWorktree } = input;

  const [sort, setSort] = useState<RosterSort>(readSort);
  const chooseSort = (s: RosterSort) => {
    setSort(s);
    try {
      localStorage.setItem(SORT_KEY, s);
    } catch {
      /* ignore quota errors */
    }
  };

  const [repoFilter, setRepoFilter] = useState<string | null>(readFilter);
  const chooseRepoFilter = (id: string | null) => {
    setRepoFilter(id);
    try {
      if (id) localStorage.setItem(FILTER_KEY, id);
      else localStorage.removeItem(FILTER_KEY);
    } catch {
      /* ignore quota errors */
    }
  };

  // Folded repositories survive a reload: a list you tidied should come back
  // tidied, not unfolded every time the app starts.
  const [collapsed, setCollapsedState] = useState<Record<string, boolean>>(() =>
    readJson<Record<string, boolean>>(COLLAPSED_KEY, {}),
  );
  const setCollapsed = (next: Record<string, boolean>) => {
    setCollapsedState(next);
    writeJson(COLLAPSED_KEY, next);
  };
  const toggleCollapsed = (id: string) => {
    const next = { ...collapsed };
    if (next[id]) delete next[id];
    else next[id] = true;
    setCollapsed(next);
  };

  /** Fold or unfold one section, and remember that it was set by hand. A
   *  stage's section folds by default, so unfolding one is kept as `false`
   *  rather than forgotten. */
  const setFold = (key: string, folded: boolean) => setCollapsed({ ...collapsed, [key]: folded });

  // Switching how the list is grouped folds every section of the new grouping,
  // so the list you land on is a short one you open as you like.
  const [groupBy, setGroupBy] = useState<RosterGroupBy>(readGroupBy);
  const chooseGroupBy = (g: RosterGroupBy, sectionKeys: readonly string[]) => {
    setGroupBy(g);
    try {
      localStorage.setItem(GROUP_KEY, g);
    } catch {
      /* ignore quota errors */
    }
    const next = { ...collapsed };
    for (const key of sectionKeys) next[key] = true;
    setCollapsed(next);
  };

  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const toggleExpanded = (id: string) => setExpanded((m) => ({ ...m, [id]: !m[id] }));
  const [showArchived, setShowArchived] = useState(false);

  // When each workspace was last opened, so a copy you were in this morning
  // stays on screen after a reload.
  const [visited, setVisited] = useState<Record<string, number>>(() =>
    readJson<Record<string, number>>(VISITED_KEY, {}),
  );
  useEffect(() => {
    if (!activePath) return;
    setVisited((prev) => {
      const next = { ...prev, [activePath]: Date.now() };
      writeJson(VISITED_KEY, next);
      return next;
    });
  }, [activePath]);

  // Renaming happens in the row, with no dialog: the thing being named is the
  // row. Enter or leaving the field keeps the name, Escape drops it, and an
  // empty name puts the derived one back.
  const [renaming, setRenaming] = useState<Renaming | null>(null);
  const startRename = (key: string, at: Renaming["at"]) =>
    setRenaming({ key, at, value: custom[key]?.name ?? "" });
  const setRenameValue = (value: string) =>
    setRenaming((r) => (r ? { ...r, value } : r));
  const commitRename = () => {
    if (!renaming) return;
    setWorkspaceName(renaming.key, renaming.value);
    setRenaming(null);
  };
  const cancelRename = () => setRenaming(null);

  // ⌘-hold quick switch. While Command is held each numbered row shows its
  // number, and ⌘+number opens it. `switchPathsRef` is refilled on every
  // render of the list from the same layout the rows are painted from, so the
  // number on screen is the number that fires.
  const [cmdHeld, setCmdHeld] = useState(false);
  const switchPathsRef = useRef<string[]>([]);
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === "Meta") {
        setCmdHeld(true);
        return;
      }
      if (e.metaKey && !e.altKey && !e.ctrlKey && e.key >= "1" && e.key <= "9" && !isEditing()) {
        const path = switchPathsRef.current[Number(e.key) - 1];
        if (path) {
          e.preventDefault();
          onOpenWorktree?.(path);
        }
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === "Meta") setCmdHeld(false);
    };
    // ⌘-tabbing away would otherwise leave the numbers stuck on.
    const clear = () => setCmdHeld(false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", clear);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", clear);
    };
  }, [onOpenWorktree]);

  return {
    groupBy,
    chooseGroupBy,
    sort,
    chooseSort,
    repoFilter,
    chooseRepoFilter,
    collapsed,
    setCollapsed,
    setFold,
    toggleCollapsed,
    expanded,
    toggleExpanded,
    showArchived,
    setShowArchived,
    visited,
    renaming,
    startRename,
    setRenameValue,
    commitRename,
    cancelRename,
    cmdHeld,
    switchPathsRef,
  };
}
