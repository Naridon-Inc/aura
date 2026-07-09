// PagesTree — the left column of the Pages surface. Renders the page
// hierarchy from each summary's parent_id, splits Active vs Archived, and
// supports drag-to-reparent, collapse/expand (persisted per repo), and a
// hover/right-click row menu (Archive / Restore / Delete).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronRight,
  FileText,
  MoreHorizontal,
  Archive,
  ArchiveRestore,
  Trash2,
} from "lucide-react";
import { cn } from "../../lib/utils";
import { pageKey, type NoteSummary } from "./pagesApi";

type RowMenuState = { key: string; top: number; left: number } | null;

type Props = {
  summaries: NoteSummary[];
  /** Currently open page key (`scope|bucket|id`), or null. */
  activeKey: string | null;
  /** Active vs Archived view. Archived shows only `archived_at` rows (flat). */
  view: "active" | "archived";
  repoRoot: string;
  onOpen: (s: NoteSummary) => void;
  onReparent: (s: NoteSummary, parentId: string | null) => void;
  onArchive: (s: NoteSummary, archived: boolean) => void;
  onDelete: (s: NoteSummary) => void;
};

function ago(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const secs = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;
  return `${Math.floor(months / 12)}y`;
}

export function PagesTree({
  summaries,
  activeKey,
  view,
  repoRoot,
  onOpen,
  onReparent,
  onArchive,
  onDelete,
}: Props) {
  const collapseStoreKey = `aura.pages2.collapsed:${repoRoot}`;
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(collapseStoreKey);
      return new Set(raw ? (JSON.parse(raw) as string[]) : []);
    } catch {
      return new Set();
    }
  });
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [dropKey, setDropKey] = useState<string | null>(null);
  const [rowMenu, setRowMenu] = useState<RowMenuState>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  // macOS WKWebView suppresses the synthetic `click` on elements with
  // `draggable=true` — it begins drag-tracking on mousedown and never
  // dispatches the click, so a plain onClick on a draggable row never opens
  // the page. Drive "open" off pointer events instead: remember where the
  // press started, and on release count it as a click only when the pointer
  // barely moved (a real drag travels further and is handled by the native
  // drag events). `pressRef` holds the in-flight press.
  const pressRef = useRef<{ key: string; x: number; y: number } | null>(null);
  const onRowPointerDown = useCallback(
    (key: string, e: React.PointerEvent) => {
      pressRef.current = { key, x: e.clientX, y: e.clientY };
    },
    [],
  );
  const onRowPointerUp = useCallback(
    (s: NoteSummary, key: string, e: React.PointerEvent) => {
      const p = pressRef.current;
      pressRef.current = null;
      if (!p || p.key !== key) return;
      // A release on an interactive child (caret / row menu) is not an open.
      if ((e.target as HTMLElement).closest("button")) return;
      const moved = Math.hypot(e.clientX - p.x, e.clientY - p.y);
      if (moved <= 4) onOpen(s);
    },
    [onOpen],
  );

  useEffect(() => {
    try {
      localStorage.setItem(collapseStoreKey, JSON.stringify([...collapsed]));
    } catch {
      /* storage full / disabled — collapse just won't persist */
    }
  }, [collapsed, collapseStoreKey]);

  const toggleCollapse = useCallback((key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  // Build the active/archived split + children map. Cycle-guarded: a page
  // whose parent chain loops back to itself is treated as top-level.
  const { roots, childrenOf, byId } = useMemo(() => {
    const active = summaries.filter((s) => !s.archived_at);
    const byId = new Map<string, NoteSummary>();
    for (const s of active) byId.set(s.id, s);

    const hasCycle = (s: NoteSummary): boolean => {
      const seen = new Set<string>();
      let cur: NoteSummary | undefined = s;
      while (cur && cur.parent_id) {
        if (seen.has(cur.id)) return true;
        seen.add(cur.id);
        cur = byId.get(cur.parent_id);
      }
      return false;
    };

    const childrenOf = new Map<string, NoteSummary[]>();
    const roots: NoteSummary[] = [];
    for (const s of active) {
      const parent = s.parent_id ? byId.get(s.parent_id) : undefined;
      if (!parent || hasCycle(s)) {
        roots.push(s);
      } else {
        const list = childrenOf.get(s.parent_id as string) ?? [];
        list.push(s);
        childrenOf.set(s.parent_id as string, list);
      }
    }
    const cmp = (a: NoteSummary, b: NoteSummary) =>
      (a.title || "").localeCompare(b.title || "");
    roots.sort(cmp);
    for (const list of childrenOf.values()) list.sort(cmp);
    return { roots, childrenOf, byId };
  }, [summaries]);

  const archived = useMemo(
    () =>
      summaries
        .filter((s) => s.archived_at)
        .sort((a, b) => (b.updated_at || "").localeCompare(a.updated_at || "")),
    [summaries],
  );

  const openRowMenu = useCallback(
    (e: React.MouseEvent | React.PointerEvent, s: NoteSummary) => {
      e.preventDefault();
      e.stopPropagation();
      const rect = rootRef.current?.getBoundingClientRect();
      setRowMenu({
        key: pageKey(s),
        top: e.clientY - (rect?.top ?? 0) + 4,
        left: Math.min(e.clientX - (rect?.left ?? 0), (rect?.width ?? 240) - 160),
      });
    },
    [],
  );

  useEffect(() => {
    if (!rowMenu) return;
    function onDown(e: MouseEvent) {
      const t = e.target as HTMLElement | null;
      if (t?.closest("[data-row-menu]")) return;
      setRowMenu(null);
    }
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [rowMenu]);

  const renderRow = (s: NoteSummary, depth: number) => {
    const key = pageKey(s);
    const kids = childrenOf.get(s.id) ?? [];
    const hasKids = kids.length > 0;
    const isCollapsed = collapsed.has(key);
    const isActive = key === activeKey;
    const isDrop = dropKey === key;
    return (
      <div key={key}>
        <div
          role="treeitem"
          aria-selected={isActive}
          draggable
          onDragStart={(e) => {
            setDragKey(key);
            e.dataTransfer.effectAllowed = "move";
          }}
          onDragOver={(e) => {
            if (dragKey && dragKey !== key) {
              e.preventDefault();
              setDropKey(key);
            }
          }}
          onDragLeave={() => setDropKey((d) => (d === key ? null : d))}
          onDrop={(e) => {
            e.preventDefault();
            if (dragKey && dragKey !== key) {
              const dragged = summaries.find((x) => pageKey(x) === dragKey);
              // Disallow dropping a page onto its own descendant (cycle).
              if (dragged && !isDescendant(s, dragged, byId, childrenOf)) {
                onReparent(dragged, s.id);
              }
            }
            setDragKey(null);
            setDropKey(null);
          }}
          onDragEnd={() => {
            setDragKey(null);
            setDropKey(null);
          }}
          onPointerDown={(e) => onRowPointerDown(key, e)}
          onPointerUp={(e) => onRowPointerUp(s, key, e)}
          onContextMenu={(e) => openRowMenu(e, s)}
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onOpen(s);
            }
          }}
          className={cn(
            "group relative flex items-center h-[26px] pr-1 rounded-sm cursor-pointer select-none",
            isActive
              ? "bg-bg-2 text-text-1"
              : "text-text-2 hover:bg-bg-2 hover:text-text-1",
            isDrop && "ring-1 ring-accent",
          )}
          style={{ paddingLeft: 6 + depth * 12 }}
        >
          {hasKids ? (
            <button
              type="button"
              aria-label={isCollapsed ? "Expand" : "Collapse"}
              onPointerDown={(e) => e.stopPropagation()}
              onPointerUp={(e) => {
                e.stopPropagation();
                toggleCollapse(key);
              }}
              className="flex items-center justify-center w-4 h-4 flex-shrink-0 text-text-4 hover:text-text-2"
            >
              <ChevronRight
                className={cn(
                  "w-3 h-3 transition-transform",
                  !isCollapsed && "rotate-90",
                )}
                strokeWidth={1.75}
              />
            </button>
          ) : (
            <span className="w-4 flex-shrink-0" />
          )}
          <span className="flex items-center justify-center w-4 flex-shrink-0 text-text-4">
            {/* Pages always show the neutral lucide page glyph — no emoji
                indicators (folders carry the colored Folder icon instead). */}
            <FileText className="w-3.5 h-3.5" strokeWidth={1.5} />
          </span>
          <span className="flex-1 min-w-0 truncate text-[12.5px] ml-1">
            {s.title || "Untitled"}
          </span>
          <span className="ml-1.5 text-[10px] text-text-5 group-hover:hidden">
            {ago(s.updated_at)}
          </span>
          <button
            type="button"
            aria-label="Page actions"
            onPointerDown={(e) => e.stopPropagation()}
            onPointerUp={(e) => {
              e.stopPropagation();
              openRowMenu(e, s);
            }}
            className="hidden group-hover:flex items-center justify-center w-5 h-5 rounded-sm text-text-4 hover:text-text-1 hover:bg-bg-3"
          >
            <MoreHorizontal className="w-3.5 h-3.5" strokeWidth={1.75} />
          </button>
        </div>
        {hasKids && !isCollapsed && (
          <div role="group">{kids.map((k) => renderRow(k, depth + 1))}</div>
        )}
      </div>
    );
  };

  const renderArchivedRow = (s: NoteSummary) => {
    const key = pageKey(s);
    const isActive = key === activeKey;
    return (
      <div
        key={key}
        role="treeitem"
        aria-selected={isActive}
        onClick={() => onOpen(s)}
        onContextMenu={(e) => openRowMenu(e, s)}
        className={cn(
          "group flex items-center h-[26px] pl-1.5 pr-1 rounded-sm cursor-pointer select-none",
          isActive
            ? "bg-bg-2 text-text-1"
            : "text-text-3 hover:bg-bg-2 hover:text-text-2",
        )}
      >
        <span className="flex items-center justify-center w-4 flex-shrink-0 text-text-4">
          <FileText className="w-3.5 h-3.5" strokeWidth={1.5} />
        </span>
        <span className="flex-1 min-w-0 truncate text-[12.5px] ml-1">
          {s.title || "Untitled"}
        </span>
        <button
          type="button"
          aria-label="Page actions"
          onClick={(e) => openRowMenu(e, s)}
          className="hidden group-hover:flex items-center justify-center w-5 h-5 rounded-sm text-text-4 hover:text-text-1 hover:bg-bg-3"
        >
          <MoreHorizontal className="w-3.5 h-3.5" strokeWidth={1.75} />
        </button>
      </div>
    );
  };

  const menuSummary =
    rowMenu && summaries.find((x) => pageKey(x) === rowMenu.key);

  const rows = view === "active" ? roots : archived;
  const empty = rows.length === 0;

  return (
    <div ref={rootRef} className="relative flex-1 min-h-0 overflow-y-auto px-1.5 py-1">
      {empty ? (
        <div className="px-2 py-6 text-center text-[11.5px] text-text-4">
          {view === "active" ? "No pages yet" : "Nothing archived"}
        </div>
      ) : view === "active" ? (
        <div role="tree" aria-label="Pages">
          {roots.map((r) => renderRow(r, 0))}
        </div>
      ) : (
        <div role="tree" aria-label="Archived pages">
          {archived.map((s) => renderArchivedRow(s))}
        </div>
      )}
      {rowMenu && menuSummary && (
        <div
          data-row-menu
          role="menu"
          className={cn(
            "absolute z-40 w-[156px] p-1 rounded-lg",
            "bg-bg-1 border border-line-soft shadow-[var(--shadow-flyout)]",
          )}
          style={{ top: rowMenu.top, left: rowMenu.left }}
        >
          {menuSummary.archived_at ? (
            <button
              type="button"
              className="w-full flex items-center gap-2 px-2 py-1.5 text-[12px] rounded text-text-2 hover:bg-bg-2 hover:text-text-1"
              onClick={() => {
                onArchive(menuSummary, false);
                setRowMenu(null);
              }}
            >
              <ArchiveRestore className="w-3.5 h-3.5" strokeWidth={1.5} />
              Restore
            </button>
          ) : (
            <button
              type="button"
              className="w-full flex items-center gap-2 px-2 py-1.5 text-[12px] rounded text-text-2 hover:bg-bg-2 hover:text-text-1"
              onClick={() => {
                onArchive(menuSummary, true);
                setRowMenu(null);
              }}
            >
              <Archive className="w-3.5 h-3.5" strokeWidth={1.5} />
              Archive
            </button>
          )}
          <button
            type="button"
            className="w-full flex items-center gap-2 px-2 py-1.5 text-[12px] rounded text-red hover:bg-bg-2"
            onClick={() => {
              onDelete(menuSummary);
              setRowMenu(null);
            }}
          >
            <Trash2 className="w-3.5 h-3.5" strokeWidth={1.5} />
            Delete
          </button>
        </div>
      )}
    </div>
  );
}

/** True when `candidate` is `node` itself or a descendant of `node` — used to
 *  block dropping a page into its own subtree (which would orphan a cycle). */
function isDescendant(
  node: NoteSummary,
  candidate: NoteSummary,
  byId: Map<string, NoteSummary>,
  childrenOf: Map<string, NoteSummary[]>,
): boolean {
  if (node.id === candidate.id) return true;
  const stack = [...(childrenOf.get(candidate.id) ?? [])];
  const seen = new Set<string>();
  while (stack.length) {
    const cur = stack.pop() as NoteSummary;
    if (cur.id === node.id) return true;
    if (seen.has(cur.id)) continue;
    seen.add(cur.id);
    stack.push(...(childrenOf.get(cur.id) ?? []));
  }
  void byId;
  return false;
}
