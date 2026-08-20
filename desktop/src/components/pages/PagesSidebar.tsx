// PagesSidebar — hierarchical tree for the Pages workpane.
//
// Replaces the flat list rendering inside NotesWorkpane's list mode
// with a Notion/Plane-style indented tree. Each row is 24px tall,
// chevron toggles children, indent step is 16px per depth, drag
// handle reveals on hover. Drag-to-reparent uses native HTML5
// drag-drop — no react-dnd dependency.
//
// Parent linkage: `NoteSummary` does NOT carry a `parent_id` field
// today, so the tree falls back to a flat (depth-1) layout grouped
// by scope chip. localStorage stores the user's drag-reparent
// intentions so the visual hierarchy persists across reloads while
// the backend catches up. When `NoteSummary.parent_id` lands,
// `parentForKey()` should be replaced with `summary.parent_id`.
//
// Storage key: `aura.pages.tree.parents` — JSON map of
// `{ [childKey]: parentKey | null }`. Keys are the `scope|bucket|id`
// tuple used by NotesWorkpane.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronRight,
  ChevronDown,
  ArrowLeft,
  ArrowRight,
  FileText,
  FolderPlus,
  Plus,
  GripVertical,
  Search,
  SearchX,
  X,
} from "lucide-react";
import {
  api,
  type NoteSummary,
  type NoteScope,
  type Folder as PageFolder,
} from "../../lib/api";
import { cn } from "../../lib/utils";
import { Input } from "../ui/input";
import { EmptyState, ErrorState, LoadingState } from "../ui/state";
import { PageFolderGroup } from "./PageFolderGroup";
import { DEFAULT_FOLDER_COLOR } from "../pages2/folderColors";
import { PlaceRail, PlaceRailGroup, PlaceRailScope } from "../places/PlaceRail";
import { setProjectScope, useKnownProjects } from "../../lib/projectRoots";

const FOLDERS_EXPANDED_KEY = "aura.pages.folders.expanded";

/** How far along the read of this project's pages is. `summaries` starts as
 *  `[]`, and an empty array is what a project with no pages looks like too —
 *  so without this the rail cannot tell the two apart, and it didn't. */
export type PagesRead = "pending" | "failed" | "done";

/** What the rail body should be, given what it actually knows.
 *
 *  The rail had one answer for four questions. `summaries` is `[]` before
 *  `api.notesList` returns, and the catch on that call is a comment — one
 *  whose stated fallback is "NotesWorkpane will mirror once it mounts", which
 *  is precisely the case the effect exists to cover when it ISN'T mounted. So
 *  the first frame of every visit to Pages, and every frame after a read that
 *  threw, said:
 *
 *      No pages yet
 *      Pages are where the thinking lives — what you decided, what you ruled
 *      out, what someone needs to know next time.
 *
 *  …with a "New page" button under it, to somebody who might have forty.
 *
 *  Rows win over the read state on purpose: the mirror from NotesWorkpane can
 *  deliver pages before `notesList` resolves, and a rail with pages in it is
 *  never loading as far as the reader is concerned. */
export function pagesRailState(s: {
  hasProject: boolean;
  read: PagesRead;
  hasRows: boolean;
  filtering: boolean;
}): "no-project" | "list" | "loading" | "failed" | "no-match" | "empty" {
  if (!s.hasProject) return "no-project";
  if (s.hasRows) return "list";
  if (s.read === "pending") return "loading";
  if (s.read === "failed") return "failed";
  return s.filtering ? "no-match" : "empty";
}

const PARENT_MAP_KEY = "aura.pages.tree.parents";
const EXPANDED_KEY = "aura.pages.tree.expanded";

type ParentMap = Record<string, string | null>;

function keyOf(s: NoteSummary): string {
  return `${s.scope}|${s.bucket}|${s.id}`;
}

function readParentMap(): ParentMap {
  try {
    const raw = localStorage.getItem(PARENT_MAP_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed as ParentMap;
    return {};
  } catch {
    return {};
  }
}

function writeParentMap(map: ParentMap) {
  try {
    localStorage.setItem(PARENT_MAP_KEY, JSON.stringify(map));
  } catch {
    /* localStorage denied — drag-reparent will not persist */
  }
  // TODO(backend): when `NoteSummary.parent_id` lands, change
  // `onReparent` below to call `api.notesWrite({ ..., parent_id })`
  // instead of writing the local map. Same field also needs to flow
  // through `api.notesList` and the on-disk frontmatter.
}

function readExpanded(): Set<string> {
  try {
    const raw = localStorage.getItem(EXPANDED_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) return new Set(arr.map(String));
    return new Set();
  } catch {
    return new Set();
  }
}

function writeExpanded(set: Set<string>) {
  try {
    localStorage.setItem(EXPANDED_KEY, JSON.stringify(Array.from(set)));
  } catch {
    /* localStorage denied */
  }
}

type TreeNode = {
  summary: NoteSummary;
  key: string;
  children: TreeNode[];
  depth: number;
};

function buildTree(
  summaries: NoteSummary[],
  parents: ParentMap,
): TreeNode[] {
  const byKey = new Map<string, NoteSummary>();
  for (const s of summaries) byKey.set(keyOf(s), s);

  // Resolve effective parent — if the recorded parent isn't in the
  // current summary set, treat as root. Prevents orphaned subtrees
  // when notes are deleted out from under a parent reference.
  function rootedParent(k: string): string | null {
    const p = parents[k];
    if (!p) return null;
    if (!byKey.has(p)) return null;
    // Cycle defense: walk up to root and bail if we revisit `k`.
    const seen = new Set<string>([k]);
    let cur: string | null = p;
    while (cur) {
      if (seen.has(cur)) return null;
      seen.add(cur);
      const nextParent: string | null = parents[cur] ?? null;
      if (!nextParent || !byKey.has(nextParent)) break;
      cur = nextParent;
    }
    return p;
  }

  const childrenByParent = new Map<string | null, NoteSummary[]>();
  for (const s of summaries) {
    const k = keyOf(s);
    const p = rootedParent(k);
    const list = childrenByParent.get(p) ?? [];
    list.push(s);
    childrenByParent.set(p, list);
  }
  for (const list of childrenByParent.values()) {
    list.sort((a, b) => (b.updated_at || "").localeCompare(a.updated_at || ""));
  }

  function walk(parentKey: string | null, depth: number): TreeNode[] {
    const kids = childrenByParent.get(parentKey) ?? [];
    return kids.map((s) => ({
      summary: s,
      key: keyOf(s),
      depth,
      children: walk(keyOf(s), depth + 1),
    }));
  }

  return walk(null, 0);
}

// Date buckets for the listing — Today / Yesterday / Previous 7 days, then
// older grouped by "Month Year" (newest first). Top-level rows are placed by
// their own `updated_at`; a row's subtree travels with it so nesting + drag
// still work inside a bucket. `order` sorts the bucket list deterministically.
type DateBucket = { order: number; label: string };

function dateBucketFor(iso: string, now: number): DateBucket {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return { order: Number.MAX_SAFE_INTEGER, label: "Undated" };
  const d = new Date(now);
  const startToday = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const dayMs = 86_400_000;
  if (t >= startToday) return { order: 0, label: "Today" };
  if (t >= startToday - dayMs) return { order: 1, label: "Yesterday" };
  if (t >= startToday - 7 * dayMs) return { order: 2, label: "Previous 7 days" };
  const md = new Date(t);
  // Older → one bucket per calendar month, most-recent month first. Order is
  // "months ago" offset past the three relative buckets (base 10), so the
  // current month sorts to 10 (just under Previous 7 days) and each older
  // month sorts strictly below it. Computed relative to `now` — never an
  // absolute year arithmetic that can go negative for real-world years.
  const nowD = new Date(now);
  const monthsAgo =
    (nowD.getFullYear() * 12 + nowD.getMonth()) -
    (md.getFullYear() * 12 + md.getMonth());
  const order = 10 + Math.max(0, monthsAgo);
  const label = md.toLocaleString(undefined, { month: "long", year: "numeric" });
  return { order, label };
}

type DateGroup = { label: string; order: number; nodes: TreeNode[] };

function groupNodesByDate(nodes: TreeNode[]): DateGroup[] {
  const now = Date.now();
  const byLabel = new Map<string, DateGroup>();
  for (const n of nodes) {
    const b = dateBucketFor(n.summary.updated_at || "", now);
    const g = byLabel.get(b.label) ?? { label: b.label, order: b.order, nodes: [] };
    g.nodes.push(n);
    byLabel.set(b.label, g);
  }
  return [...byLabel.values()].sort((a, b) => a.order - b.order);
}

type Props = {
  summaries: NoteSummary[];
  activeKey: string | null;
  onPick: (s: NoteSummary) => void;
  /** Optional "+ new" trigger — when set, renders a button on the
   *  header. The caller usually wraps this in a DropdownMenu (template
   *  picker) so we only need the click handler. */
  onCreate?: () => void;
  query?: string;
  onQuery?: (s: string) => void;
  className?: string;
  // ── Back / forward through visited-page history ───────────────────────────
  /** Step back to the previously-open page. Rendered only when provided. */
  onBack?: () => void;
  /** Step forward again after going back. */
  onForward?: () => void;
  /** Whether there's an earlier page to step back to. */
  canBack?: boolean;
  /** Whether there's a later page to step forward to. */
  canForward?: boolean;
  // ── Folders (optional — when absent the tree renders flat as before) ──────
  /** All folders across the visible scopes, keyed by id below. */
  folders?: PageFolder[];
  /** Folder ids currently expanded. */
  expandedFolders?: Set<string>;
  onToggleFolder?: (id: string) => void;
  /** Create a new folder (the mount picks the scope + a default color). */
  onCreateFolder?: () => void;
  onRenameFolder?: (id: string, name: string) => void;
  onSetFolderColor?: (id: string, token: string) => void;
  onDeleteFolder?: (id: string) => void;
  /** Move a page into a folder (id) or back to root (null). */
  onMovePageToFolder?: (s: NoteSummary, folderId: string | null) => void;
  // ── What the rail is allowed to conclude from an empty list ───────────────
  /** How far the caller's read of this project's pages has got. Defaults to
   *  `"done"` so a caller that hands over an already-loaded list — a test, a
   *  preview — behaves exactly as before. */
  read?: PagesRead;
  /** Whether there is a project to read pages from at all. */
  hasProject?: boolean;
  /** Re-run the read that failed. */
  onRetry?: () => void;
};

export function PagesSidebar({
  summaries,
  activeKey,
  onPick,
  onCreate,
  query = "",
  onQuery,
  className,
  onBack,
  onForward,
  canBack = false,
  canForward = false,
  folders,
  expandedFolders,
  onToggleFolder,
  onCreateFolder,
  onRenameFolder,
  onSetFolderColor,
  onDeleteFolder,
  onMovePageToFolder,
  read = "done",
  hasProject = true,
  onRetry,
}: Props) {
  const [parents, setParents] = useState<ParentMap>(() => readParentMap());
  const [expanded, setExpanded] = useState<Set<string>>(() => readExpanded());
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  // The filter is a magnifier you press, not a box that is always open. It used
  // to hold a whole 30px band of its own directly under the 28px icon band, so
  // this rail spent two bands of chrome before the first page — for a control
  // that is idle until you are looking for something. Same shape as the Team
  // rail's filter, which is the one the reader has already met.
  const [filtering, setFiltering] = useState(false);
  const closeFilter = useCallback(() => {
    onQuery?.("");
    setFiltering(false);
  }, [onQuery]);

  useEffect(() => {
    writeExpanded(expanded);
  }, [expanded]);

  const filtered = useMemo(() => {
    if (!query.trim()) return summaries;
    const q = query.trim().toLowerCase();
    return summaries.filter((s) => {
      const t = (s.title || "").toLowerCase();
      const b = (s.bucket || "").toLowerCase();
      return t.includes(q) || b.includes(q);
    });
  }, [summaries, query]);

  // Folders are an organizational layer ABOVE the date-grouped tree. We split
  // the filtered pages into those that live in a known folder (grouped) and
  // the rest (rendered flat as before). A page whose `folder` points at a
  // folder that doesn't exist is treated as ungrouped, so a stale id never
  // hides a page. Folder ids are globally unique, so a single id→folder map
  // (built across whatever scopes the mount loaded) is enough.
  const folderById = useMemo(() => {
    const m = new Map<string, PageFolder>();
    for (const f of folders ?? []) m.set(f.id, f);
    return m;
  }, [folders]);

  const { groupedByFolder, ungrouped } = useMemo(() => {
    const groupedByFolder = new Map<string, NoteSummary[]>();
    const ungrouped: NoteSummary[] = [];
    for (const s of filtered) {
      const fid = s.folder ?? null;
      if (fid && folderById.has(fid)) {
        const list = groupedByFolder.get(fid) ?? [];
        list.push(s);
        groupedByFolder.set(fid, list);
      } else {
        ungrouped.push(s);
      }
    }
    return { groupedByFolder, ungrouped };
  }, [filtered, folderById]);

  // Folders sorted by their backend order (already sorted on load, but resort
  // defensively so a late color/rename never reshuffles the visual order).
  const sortedFolders = useMemo(
    () =>
      [...(folders ?? [])].sort(
        (a, b) => a.order - b.order || a.name.localeCompare(b.name),
      ),
    [folders],
  );

  // The date-grouped tree is built from the UNGROUPED pages only — folder
  // contents render under their folder header instead.
  const tree = useMemo(
    () => buildTree(ungrouped, parents),
    [ungrouped, parents],
  );

  // Top-level rows grouped into date buckets (Today / Yesterday / Previous 7
  // days / older-by-month). The grouping only re-buckets the roots — each
  // root still renders its own subtree via <TreeRow>.
  const dateGroups = useMemo(() => groupNodesByDate(tree), [tree]);

  // What the body under the header is. See `pagesRailState`.
  const body = pagesRailState({
    hasProject,
    read,
    hasRows: tree.length > 0 || sortedFolders.length > 0,
    filtering: query.trim().length > 0,
  });

  // A page row dropped onto a folder header → file it into that folder. A
  // page dropped on the root background → pull it back out of its folder.
  const handleDropOnFolder = useCallback(
    (folderId: string) => {
      if (!dragKey || !onMovePageToFolder) return;
      const dragged = summaries.find((x) => keyOf(x) === dragKey);
      if (dragged) onMovePageToFolder(dragged, folderId);
      setDragKey(null);
      setDropTarget(null);
    },
    [dragKey, summaries, onMovePageToFolder],
  );

  const toggle = useCallback((k: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }, []);

  function isDescendant(
    candidateParent: string,
    child: string,
    map: ParentMap,
  ): boolean {
    // Walk up from `candidateParent` — if we hit `child` we'd create a
    // cycle. Bounded by visited-set so a corrupt map can't loop us.
    const seen = new Set<string>();
    let cur: string | null = candidateParent;
    while (cur) {
      if (seen.has(cur)) return false;
      seen.add(cur);
      if (cur === child) return true;
      cur = map[cur] ?? null;
    }
    return false;
  }

  const reparent = useCallback(
    (childKey: string, newParent: string | null) => {
      setParents((prev) => {
        // Prevent dropping onto yourself or your own descendant.
        if (childKey === newParent) return prev;
        if (newParent && isDescendant(newParent, childKey, prev)) return prev;
        const next = { ...prev, [childKey]: newParent };
        writeParentMap(next);
        return next;
      });
    },
    [],
  );

  const dropOnRoot = useCallback(() => {
    if (!dragKey) return;
    reparent(dragKey, null);
    // Dropping on the root background also pulls a page out of any folder it
    // was filed under (back to the top level), so the root is a real target.
    if (onMovePageToFolder) {
      const dragged = summaries.find((x) => keyOf(x) === dragKey);
      if (dragged?.folder) onMovePageToFolder(dragged, null);
    }
    setDragKey(null);
    setDropTarget(null);
  }, [dragKey, reparent, summaries, onMovePageToFolder]);

  return (
    <div className={cn("flex flex-col h-full", className)}>
      {/* Shared ADE section header (matches Trace / Tasks / Team) — the +New
          page action rides the header's right slot. The 12px inline padding
          aligns the label + action with the content inset of the rows below;
          everything else (size, weight, colour, height) is `.ade-sec-h`. */}
      <div className="ade-sec-h" style={{ paddingInline: 12 }}>
        {(onBack || onForward) && (
          <span className="flex items-center gap-0.5 mr-2 -ml-1">
            <button
              type="button"
              onClick={onBack}
              disabled={!canBack}
              /* "Previous page", not "Back". The window chrome has its own
                 back/forward 110px above this one, and that pair switches the
                 whole project. Two identical words, two different scopes, one
                 column. */
              title="Previous page"
              aria-label="Previous page"
              className="w-5 h-5 grid place-items-center rounded text-text-4 enabled:hover:text-text-1 enabled:hover:bg-state-hover disabled:opacity-30 disabled:cursor-default transition-colors"
            >
              <ArrowLeft className="w-3.5 h-3.5" strokeWidth={1.75} aria-hidden />
            </button>
            <button
              type="button"
              onClick={onForward}
              disabled={!canForward}
              title="Next page"
              aria-label="Next page"
              className="w-5 h-5 grid place-items-center rounded text-text-4 enabled:hover:text-text-1 enabled:hover:bg-state-hover disabled:opacity-30 disabled:cursor-default transition-colors"
            >
              <ArrowRight className="w-3.5 h-3.5" strokeWidth={1.75} aria-hidden />
            </button>
          </span>
        )}
        {/* No name. The nav row above this panel already says Pages and is
            lit; a second "Pages" 30px under it is the reader being told
            where they just chose to go. What's left is what the chrome
            can't say: history, new folder, new page. */}
        {(onQuery || onCreateFolder || onCreate) && (
          <span className="right flex items-center gap-0.5">
            {onQuery && (
              <button
                type="button"
                onClick={() => (filtering ? closeFilter() : setFiltering(true))}
                title="Filter pages"
                aria-label="Filter pages"
                aria-expanded={filtering}
                className="w-5 h-5 grid place-items-center rounded text-text-4 hover:text-text-1 hover:bg-state-hover transition-colors"
              >
                <Search className="w-3.5 h-3.5" strokeWidth={1.75} aria-hidden />
              </button>
            )}
            {onCreateFolder && (
              <button
                type="button"
                onClick={onCreateFolder}
                title="New folder"
                className="w-5 h-5 grid place-items-center rounded text-text-4 hover:text-text-1 hover:bg-state-hover transition-colors"
              >
                <FolderPlus
                  className="w-3.5 h-3.5"
                  strokeWidth={1.75}
                  aria-hidden
                />
              </button>
            )}
            {onCreate && (
              <button
                type="button"
                onClick={onCreate}
                title="New page"
                className="w-5 h-5 grid place-items-center rounded text-text-4 hover:text-text-1 hover:bg-state-hover transition-colors"
              >
                <Plus className="w-3.5 h-3.5" strokeWidth={1.75} aria-hidden />
              </button>
            )}
          </span>
        )}
      </div>
      {onQuery && filtering && (
        <div className="px-1.5 pb-2 flex-shrink-0">
          <div className="relative">
            <Search
              className="w-3 h-3 absolute left-2 top-1/2 -translate-y-1/2 text-text-5"
              strokeWidth={1.5}
            />
            <Input
              type="text"
              autoFocus
              /* WebKit remembers text-input values and floats them back as a
                 suggestion chip — which lands on top of the first result, the
                 exact row you were filtering towards. A filter has nothing to
                 remember: the list below it is the suggestion. */
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              value={query}
              onChange={(e) => onQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") closeFilter();
              }}
              placeholder="Filter pages by name"
              aria-label="Filter pages by name"
              className="h-6 pl-7 pr-2 text-xs"
            />
          </div>
        </div>
      )}
      <div
        className="flex-1 min-h-0 overflow-y-auto px-1.5 pb-2 pt-0.5"
        onDragOver={(e) => {
          if (!dragKey) return;
          e.preventDefault();
          setDropTarget("__root__");
        }}
        onDrop={(e) => {
          if (!dragKey) return;
          e.preventDefault();
          dropOnRoot();
        }}
      >
        {/* One of these, decided by `pagesRailState` — which knows the
            difference between a project with no pages and a read that hasn't
            finished. The rail used to draw the first of them for both. */}
        {body === "loading" && <LoadingState size="sm" label="Opening your pages…" />}
        {body === "failed" && (
          <ErrorState
            size="sm"
            title="Aura couldn’t open your pages"
            message="They’re still on your machine. This is the reading that failed, not the writing."
            onRetry={onRetry}
          />
        )}
        {body === "no-project" && (
          <EmptyState
            icon={FileText}
            title="No project open"
            body="Pages belong to a project. Open one from the sidebar and its pages appear here."
            size="sm"
          />
        )}
        {body === "no-match" && (
          <EmptyState
            icon={SearchX}
            title="No pages match"
            body={`Nothing here is called “${query.trim()}”.`}
            size="sm"
          />
        )}
        {body === "empty" && (
          <EmptyState
            icon={FileText}
            title="No pages yet"
            body="Pages are where the thinking lives. What you decided, what you ruled out, what someone needs to know next time. Your agents can read them too."
            action={
              onCreate
                ? { label: "New page", onClick: onCreate, icon: Plus }
                : undefined
            }
            size="sm"
          />
        )}
        {/* Folders first — collapsible, color-tinted groups. Each renders its
            own pages as a small tree so nesting + drag still work inside it. */}
        {sortedFolders.map((folder) => {
          const pages = groupedByFolder.get(folder.id) ?? [];
          // While filtering, hide a folder that has no matching pages so the
          // results stay tight; show empty folders only in the unfiltered view.
          if (query.trim() && pages.length === 0) return null;
          const isOpen = expandedFolders?.has(folder.id) ?? true;
          const folderTree = buildTree(pages, parents);
          return (
            <PageFolderGroup
              key={folder.id}
              folder={folder}
              count={pages.length}
              expanded={isOpen}
              onToggle={() => onToggleFolder?.(folder.id)}
              isDropTarget={dropTarget === `folder:${folder.id}` && !!dragKey}
              onDragOver={() => setDropTarget(`folder:${folder.id}`)}
              onDrop={() => handleDropOnFolder(folder.id)}
              onRename={(name) => onRenameFolder?.(folder.id, name)}
              onSetColor={(token) => onSetFolderColor?.(folder.id, token)}
              onDelete={() => onDeleteFolder?.(folder.id)}
            >
              {pages.length === 0 ? (
                <div className="pl-7 pr-2 py-1 text-xs text-text-5 select-none">
                  Empty. Drag a page here.
                </div>
              ) : (
                <div className="pl-3">
                  {folderTree.map((n) => (
                    <TreeRow
                      key={n.key}
                      node={n}
                      activeKey={activeKey}
                      expanded={expanded}
                      onToggle={toggle}
                      onPick={onPick}
                      dragKey={dragKey}
                      dropTarget={dropTarget}
                      onDragStart={setDragKey}
                      onDragOver={setDropTarget}
                      onDragEnd={() => {
                        setDragKey(null);
                        setDropTarget(null);
                      }}
                      onDrop={(target) => {
                        if (!dragKey) return;
                        reparent(dragKey, target);
                        setDragKey(null);
                        setDropTarget(null);
                      }}
                    />
                  ))}
                </div>
              )}
            </PageFolderGroup>
          );
        })}
        {/* Today / Yesterday / Last 7 days — `PlaceRailGroup`, the same group
            the Changes panel and the other rails render, so these collapse and
            carry a count like every other bucket in the app. They were fixed
            open headers: on a long list you scrolled past every week you
            weren't looking for, and the header never said how many that was. */}
        {dateGroups.map((group) => (
          <PlaceRailGroup
            key={group.label}
            title={group.label}
            count={group.nodes.length}
            defaultOpen
          >
            {group.nodes.map((n) => (
              <TreeRow
                key={n.key}
                node={n}
                activeKey={activeKey}
                expanded={expanded}
                onToggle={toggle}
                onPick={onPick}
                dragKey={dragKey}
                dropTarget={dropTarget}
                onDragStart={setDragKey}
                onDragOver={setDropTarget}
                onDragEnd={() => {
                  setDragKey(null);
                  setDropTarget(null);
                }}
                onDrop={(target) => {
                  if (!dragKey) return;
                  reparent(dragKey, target);
                  setDragKey(null);
                  setDropTarget(null);
                }}
              />
            ))}
          </PlaceRailGroup>
        ))}
      </div>
    </div>
  );
}

function TreeRow({
  node,
  activeKey,
  expanded,
  onToggle,
  onPick,
  dragKey,
  dropTarget,
  onDragStart,
  onDragOver,
  onDragEnd,
  onDrop,
}: {
  node: TreeNode;
  activeKey: string | null;
  expanded: Set<string>;
  onToggle: (k: string) => void;
  onPick: (s: NoteSummary) => void;
  dragKey: string | null;
  dropTarget: string | null;
  onDragStart: (k: string) => void;
  onDragOver: (k: string) => void;
  onDragEnd: () => void;
  onDrop: (target: string) => void;
}) {
  const isOpen = expanded.has(node.key);
  const hasKids = node.children.length > 0;
  const isActive = node.key === activeKey;
  const isDropping = dropTarget === node.key && dragKey && dragKey !== node.key;
  const rowRef = useRef<HTMLDivElement | null>(null);
  const fullTitle = node.summary.title || "(untitled)";
  const { name, detail } = splitPageTitle(fullTitle);

  return (
    <>
      <div
        ref={rowRef}
        draggable
        onDragStart={(e) => {
          e.stopPropagation();
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", node.key);
          onDragStart(node.key);
        }}
        onDragOver={(e) => {
          if (!dragKey || dragKey === node.key) return;
          e.preventDefault();
          e.stopPropagation();
          e.dataTransfer.dropEffect = "move";
          onDragOver(node.key);
        }}
        onDrop={(e) => {
          if (!dragKey || dragKey === node.key) return;
          e.preventDefault();
          e.stopPropagation();
          onDrop(node.key);
        }}
        onDragEnd={(e) => {
          e.stopPropagation();
          onDragEnd();
        }}
        // The full title, always. A name can still outrun one line — 11 of
        // the 49 here do — and until now a cut name had nowhere left to be
        // read: no tooltip, no expansion, nothing short of opening the page.
        title={fullTitle}
        className={cn(
          "group min-h-[22px] py-[3px] flex items-center gap-1 rounded-sm text-sm cursor-pointer select-none transition-colors",
          // The page you're on takes the accent tint, not a surface fill.
          // Fills mark which PART of the app you're in (the nav row above,
          // "Pages"); the tint marks which page inside it. Two fills stacked
          // read as two equal claims on "you are here".
          isActive
            ? "row-selected"
            : "text-text-2 hover:bg-state-hover hover:text-text-1",
          isDropping && "ring-1 ring-accent ring-inset",
          dragKey === node.key && "opacity-40",
        )}
        // Leaf rows (the common case — the tree is flat until parent_id
        // lands) skip the chevron column entirely so the file icon anchors
        // at the shared 14px inset instead of being pushed right by an empty
        // 12px toggle. Expandable rows render the chevron before the icon.
        style={{ paddingLeft: 7 + node.depth * 12, paddingRight: 5 }}
        onClick={() => onPick(node.summary)}
      >
        {hasKids && (
          <span
            className="w-3 h-3 grid place-items-center flex-shrink-0 -ml-0.5 text-text-5"
            onClick={(e) => {
              e.stopPropagation();
              onToggle(node.key);
            }}
          >
            {isOpen ? (
              <ChevronDown className="w-3 h-3" strokeWidth={1.75} aria-hidden />
            ) : (
              <ChevronRight className="w-3 h-3" strokeWidth={1.75} aria-hidden />
            )}
          </span>
        )}
        <FileText
          className={cn(
            "w-3 h-3 text-text-5 flex-shrink-0",
            // The icon centres on a one-line row and rides the first line of
            // a two-line one, so it stays level with the name rather than
            // floating in the middle of the pair.
            detail && "self-start mt-[5px]",
          )}
          strokeWidth={1.5}
          aria-hidden
        />
        <span className="flex-1 min-w-0">
          <span className="block truncate">{name}</span>
          {detail && (
            <span className="block truncate text-2xs leading-[14px] text-text-4">
              {detail}
            </span>
          )}
        </span>
        {/* One gutter, two occupants. The grip is invisible until you hover
            the row and the scope mark is absent on 30 of 31 rows, so giving
            each its own 12px column spent a sixth of the name's width on
            two things that are almost never both there. They share it now:
            hover shows the grip, otherwise the mark (or nothing). */}
        <span className="w-3 flex-shrink-0 grid place-items-center self-center">
          <span
            className="hidden group-hover:grid w-3 h-3 place-items-center text-text-5 cursor-grab active:cursor-grabbing"
            aria-hidden
            title="Drag to reparent"
          >
            <GripVertical className="w-3 h-3" strokeWidth={1.5} />
          </span>
          <span className="group-hover:hidden">
            <ScopeBadge
              scope={node.summary.scope}
              bucket={node.summary.bucket}
            />
          </span>
        </span>
      </div>
      {isOpen &&
        node.children.map((c) => (
          <TreeRow
            key={c.key}
            node={c}
            activeKey={activeKey}
            expanded={expanded}
            onToggle={onToggle}
            onPick={onPick}
            dragKey={dragKey}
            dropTarget={dropTarget}
            onDragStart={onDragStart}
            onDragOver={onDragOver}
            onDragEnd={onDragEnd}
            onDrop={onDrop}
          />
        ))}
    </>
  );
}

// A page title in this app is almost always two things joined by a dash:
// the NAME, then what it is about. "Aura Commons — W2 Lounge: presence +
// ship log (design)". In a 232px rail the second half is what got cut, so
// the row printed the half you already knew and hid the half you were
// looking for — of this project's 49 pages, 37 (75%) died mid-title, and
// three of them opened with the identical words "Aura Commons".
//
// So the row is given the two parts rather than one long string: the name
// on its own line where it fits whole for 38 of the 49, and the rest
// beneath it in the muted tone, where it reads as a subtitle instead of
// competing for the same 180 pixels. Titles with no dash or colon (14 of
// 49 — "Changelog", "Release checklist") find no split and stay exactly as
// they were, one line.
//
// The em-dash and en-dash are matched with spaces around them so hyphenated
// names ("Cross-agent", "Remote-VM") are never mistaken for a split; the
// colon needs a trailing space for the same reason ("W2 Lounge: presence"
// splits, "12:30" does not). Only the FIRST separator counts — everything
// after it belongs to the subtitle, dashes and all.
const TITLE_SPLIT = /\s+[—–]\s+|:\s+/;

export function splitPageTitle(title: string): {
  name: string;
  detail: string | null;
} {
  const m = TITLE_SPLIT.exec(title);
  if (!m || m.index === 0) return { name: title, detail: null };
  const detail = title.slice(m.index + m[0].length).trim();
  // A separator with nothing after it is punctuation, not a split.
  if (!detail) return { name: title, detail: null };
  return { name: title.slice(0, m.index).trim(), detail };
}

function ScopeBadge({ scope, bucket }: { scope: NoteScope; bucket: string }) {
  // Team is where a page lands unless you sent it somewhere else, so a "T"
  // marked almost every row in the list — 30 of 31 here. A mark that never
  // varies carries nothing and reads as clutter down the right edge; the
  // information is in the exceptions, so only those are drawn. The gutter
  // stays so the hover grip sits in the same column on every row.
  if (scope === "team") {
    return <span className="w-3 flex-shrink-0" aria-hidden />;
  }
  const label = scope === "channel" ? `#` : `@`;
  const title = scope === "channel" ? `#${bucket}` : `@${bucket}`;
  return (
    <span
      title={title}
      // The mark is a single glyph standing in for a name, so the name has to
      // be readable somewhere. `title` alone was on an aria-hidden node, which
      // means it reached the mouse and nobody else.
      aria-label={title}
      role="img"
      className="text-2xs font-mono text-text-5/80 w-3 grid place-items-center flex-shrink-0"
    >
      {label}
    </span>
  );
}

// ─── External mount (Fix 1) ────────────────────────────────────────────
//
// `PagesSidebarMount` is the wrapper that App.tsx mounts in the
// sidebar slot whenever the Notes/Pages surface is active. It owns its
// own summaries load (api.notesList) BUT prefers the live mirror that
// the NotesWorkpane broadcasts via `aura:pages:summaries`, so opening
// a page from either side stays in lock-step.
//
// Interaction protocol — three window events, scoped to `aura:pages:*`:
//   • inbound   `aura:pages:summaries`  — mirror of NotesWorkpane's
//               state ({ summaries, activeKey })
//   • outbound  `aura:pages:open`       — { key } — open a page
//   • outbound  `aura:pages:close`      — back to the list
//   • outbound  `aura:pages:refresh`    — ask the workpane to re-poll

type PagesSidebarMountProps = {
  repoRoot: string;
  /** Wired by App.tsx — flips the active sidebar tab back to "files"
   *  (the same close pattern InboxSidebar / TasksSidebar use). */
  onClose?: () => void;
};

export function PagesSidebarMount({ repoRoot, onClose }: PagesSidebarMountProps) {
  // Which project's pages these are. Pages reads one project at a time — a
  // page is edited, autosaved and shared inside one repo — so the picker names
  // a project and does not offer All projects. `repoRoot` already arrives
  // resolved against the shared scope (App mounts it through `usePlaceRoot`),
  // so showing it is showing what's actually on screen.
  const projects = useKnownProjects(repoRoot);
  const [summaries, setSummaries] = useState<NoteSummary[]>([]);
  /** `summaries` is `[]` before the read returns and `[]` for a project with
   *  no pages. This is the field that tells them apart — without it the rail
   *  opened on "No pages yet" every single time, and stayed there forever if
   *  the read threw. */
  const [read, setRead] = useState<PagesRead>("pending");
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [folders, setFolders] = useState<PageFolder[]>([]);
  // Visited-page history for the back/forward arrows. `stack` is the ordered
  // trail of page keys; `idx` is where we currently sit in it. A back/forward
  // move sets `navigatingRef` so the visit-recording effect below doesn't push
  // the resulting activeKey change as a NEW entry (which would strand forward
  // history). Every open path — sidebar click, mention/backlink jump, the
  // mirror from the surface — funnels through `activeKey`, so recording off it
  // captures them all.
  const [nav, setNav] = useState<{ stack: string[]; idx: number }>({
    stack: [],
    idx: -1,
  });
  const navRef = useRef(nav);
  navRef.current = nav;
  const navigatingRef = useRef(false);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(FOLDERS_EXPANDED_KEY);
      // Absence means "expand all" — we only persist COLLAPSED folders, so an
      // unseen folder defaults to open (its pages are visible right away).
      return new Set(raw ? (JSON.parse(raw) as string[]) : []);
    } catch {
      return new Set();
    }
  });

  // Reload the folder index for every scope/bucket the current pages span, so
  // a folder's pages can live in team / a channel / a member's space and still
  // group correctly. Folder ids are globally unique, so we merge them flat.
  const reloadFolders = useCallback(async () => {
    if (!repoRoot) return;
    // Distinct (scope, bucket) pairs present in the summaries, plus team (the
    // default scope new pages + folders land in) so an empty repo still lets
    // you make a folder.
    const pairs = new Map<string, { scope: NoteScope; bucket: string }>();
    pairs.set("team|", { scope: "team", bucket: "" });
    for (const s of summaries) {
      pairs.set(`${s.scope}|${s.bucket}`, { scope: s.scope, bucket: s.bucket });
    }
    try {
      const lists = await Promise.all(
        [...pairs.values()].map((p) =>
          api
            .noteFoldersList(repoRoot, p.scope, p.bucket)
            .catch(() => [] as PageFolder[]),
        ),
      );
      const merged = new Map<string, PageFolder>();
      for (const list of lists) for (const f of list) merged.set(f.id, f);
      setFolders([...merged.values()]);
    } catch {
      /* keep last-good folders */
    }
  }, [repoRoot, summaries]);

  useEffect(() => {
    void reloadFolders();
  }, [reloadFolders]);

  // The (scope, bucket) a folder lives in — needed to address its backend
  // mutations. We derive it from the folder's member pages when possible,
  // falling back to team (the default a folder is created in).
  const folderLocation = useCallback(
    (folderId: string): { scope: NoteScope; bucket: string } => {
      const member = summaries.find((s) => s.folder === folderId);
      if (member) return { scope: member.scope, bucket: member.bucket };
      return { scope: "team", bucket: "" };
    },
    [summaries],
  );

  const toggleFolder = useCallback((id: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      // We persist COLLAPSED ids: present ⇒ collapsed. Toggling flips that.
      if (next.has(id)) next.delete(id);
      else next.add(id);
      try {
        localStorage.setItem(FOLDERS_EXPANDED_KEY, JSON.stringify([...next]));
      } catch {
        /* storage disabled — expansion just won't persist */
      }
      return next;
    });
  }, []);

  // `expandedFolders` stores COLLAPSED ids; PagesSidebar wants the set of
  // EXPANDED ids (default-open). Invert against the known folders so a folder
  // not in the collapsed set reads as expanded.
  const expandedSet = useMemo(() => {
    const open = new Set<string>();
    for (const f of folders) if (!expandedFolders.has(f.id)) open.add(f.id);
    return open;
  }, [folders, expandedFolders]);

  const createFolder = useCallback(async () => {
    if (!repoRoot) return;
    try {
      await api.noteFolderCreate(
        repoRoot,
        "team",
        "",
        "New folder",
        DEFAULT_FOLDER_COLOR,
        null,
      );
      await reloadFolders();
    } catch {
      /* no-op — folder list stays as-is on failure */
    }
  }, [repoRoot, reloadFolders]);

  const renameFolder = useCallback(
    async (id: string, name: string) => {
      const { scope, bucket } = folderLocation(id);
      try {
        await api.noteFolderRename(repoRoot, scope, bucket, id, name);
        await reloadFolders();
      } catch {
        /* no-op */
      }
    },
    [repoRoot, folderLocation, reloadFolders],
  );

  const setFolderColor = useCallback(
    async (id: string, token: string) => {
      const { scope, bucket } = folderLocation(id);
      try {
        await api.noteFolderSetColor(repoRoot, scope, bucket, id, token);
        await reloadFolders();
      } catch {
        /* no-op */
      }
    },
    [repoRoot, folderLocation, reloadFolders],
  );

  const deleteFolder = useCallback(
    async (id: string) => {
      const { scope, bucket } = folderLocation(id);
      try {
        // Backend moves the folder's pages to root (never deletes them).
        await api.noteFolderDelete(repoRoot, scope, bucket, id);
        await reloadFolders();
        // Pages changed folder membership → ask the workpane to re-poll the
        // list so the moved pages reappear at the root.
        window.dispatchEvent(new CustomEvent("aura:pages:refresh"));
      } catch {
        /* no-op */
      }
    },
    [repoRoot, folderLocation, reloadFolders],
  );

  const movePageToFolder = useCallback(
    async (s: NoteSummary, folderId: string | null) => {
      try {
        await api.noteSetFolder(repoRoot, s.scope, s.bucket, s.id, folderId);
        // Reflect the move locally for an instant response, then re-poll.
        setSummaries((prev) =>
          prev.map((p) =>
            keyOf(p) === keyOf(s) ? { ...p, folder: folderId } : p,
          ),
        );
        window.dispatchEvent(new CustomEvent("aura:pages:refresh"));
      } catch {
        /* no-op */
      }
    },
    [repoRoot],
  );

  // Initial load — fall back if NotesWorkpane isn't mounted yet (e.g.
  // user lands on Pages rail directly).
  //
  // The catch used to be a comment: "swallow — NotesWorkpane will mirror once
  // it mounts". That excuse is the exact case this effect exists to cover —
  // the one where NotesWorkpane ISN'T mounted, which is the sentence directly
  // above. So a failure here left the rail on "No pages yet" with nothing
  // coming to correct it.
  const reloadSummaries = useCallback(() => {
    if (!repoRoot) return;
    setRead("pending");
    api
      .notesList({ repoRoot })
      .then((rows) => {
        setSummaries(rows);
        setRead("done");
      })
      .catch(() => setRead("failed"));
  }, [repoRoot]);

  useEffect(() => {
    if (!repoRoot) return;
    let cancelled = false;
    setRead("pending");
    api
      .notesList({ repoRoot })
      .then((rows) => {
        if (cancelled) return;
        setSummaries(rows);
        setRead("done");
      })
      .catch(() => {
        if (!cancelled) setRead("failed");
      });
    return () => {
      cancelled = true;
    };
  }, [repoRoot]);

  // Live mirror from NotesWorkpane. Whenever it dispatches its state,
  // we replace our local copy so highlight + counts stay aligned.
  useEffect(() => {
    function onMirror(e: Event) {
      const detail = (
        e as CustomEvent<{ summaries: NoteSummary[]; activeKey: string | null }>
      ).detail;
      if (!detail) return;
      setSummaries(detail.summaries);
      setActiveKey(detail.activeKey);
      // The mirror is a completed read too — and it's the one that arrives
      // when the workpane is mounted, so it must clear a pending or failed
      // state rather than leaving the rail waiting under real rows.
      setRead("done");
    }
    window.addEventListener(
      "aura:pages:summaries",
      onMirror as EventListener,
    );
    return () =>
      window.removeEventListener(
        "aura:pages:summaries",
        onMirror as EventListener,
      );
  }, []);

  // Open a page by its `scope|bucket|id` key. Two dispatches so a rail click
  // always lands somewhere:
  //   • `aura:pages:open` — caught immediately IF a Pages pane is already
  //     mounted (NotesWorkpane / pages2 PagesSurface listen for it).
  //   • `aura:open-page` — App.tsx's handler runs `editor.openPages(root)`
  //     first and then re-opens the page, so clicking from the rail while
  //     the centre shows the agent (or anything else) opens the Pages pane
  //     instead of silently doing nothing.
  const openKey = useCallback((key: string) => {
    setActiveKey(key);
    window.dispatchEvent(
      new CustomEvent("aura:pages:open", { detail: { key } }),
    );
    const parts = key.split("|");
    if (parts.length >= 3) {
      const [scope, bucket, ...rest] = parts;
      window.dispatchEvent(
        new CustomEvent("aura:open-page", {
          detail: { scope, bucket, id: rest.join("|") },
        }),
      );
    }
  }, []);

  const openPage = useCallback(
    (s: NoteSummary) => openKey(keyOf(s)),
    [openKey],
  );

  // Record each visit as activeKey settles. A back/forward move already set
  // navigatingRef, so we consume it and skip pushing (the trail is unchanged,
  // only `idx` moved). Otherwise truncate any forward entries and append.
  useEffect(() => {
    if (!activeKey) return;
    if (navigatingRef.current) {
      navigatingRef.current = false;
      return;
    }
    setNav((prev) => {
      if (prev.stack[prev.idx] === activeKey) return prev;
      const trail = prev.stack.slice(0, prev.idx + 1);
      trail.push(activeKey);
      // Cap the trail so a long session can't grow it without bound.
      const capped = trail.slice(-50);
      return { stack: capped, idx: capped.length - 1 };
    });
  }, [activeKey]);

  // Step through history. Reads the latest trail from the ref (so rapid clicks
  // don't act on a stale closure), flags the move, then re-opens the target.
  const navigate = useCallback(
    (delta: number) => {
      const cur = navRef.current;
      const idx = cur.idx + delta;
      if (idx < 0 || idx >= cur.stack.length) return;
      navigatingRef.current = true;
      setNav({ stack: cur.stack, idx });
      openKey(cur.stack[idx]);
    },
    [openKey],
  );
  const goBack = useCallback(() => navigate(-1), [navigate]);
  const goForward = useCallback(() => navigate(1), [navigate]);
  const canBack = nav.idx > 0;
  const canForward = nav.idx < nav.stack.length - 1;

  function newPage() {
    // Default to a blank team page — matches the in-workpane "+ new"
    // affordance. We create through the API directly so the sidebar
    // doesn't need a callback wired up from App.tsx.
    api
      .notesWrite({
        repoRoot,
        scope: "team",
        bucket: "",
        body: "# Untitled\n\n",
        title: "Untitled",
        visibility: "shared",
      })
      .then((note) => {
        const key = `team||${note.id}`;
        window.dispatchEvent(new CustomEvent("aura:pages:refresh"));
        window.dispatchEvent(
          new CustomEvent("aura:pages:open", { detail: { key } }),
        );
      })
      .catch(() => {
        /* surface failures through the workpane's error banner —
         * silent here keeps the sidebar from growing its own toast
         * surface. */
      });
  }

  return (
    <PlaceRail
      scroll={false}
      scope={
        // Project on the left, close on the right, one row. The close button
        // used to float `absolute top-1.5 right-2` over the rail — which put
        // it exactly on top of the picker's chevron the moment the picker
        // arrived, so reaching for "which project" hit "shut this".
        <div className="flex items-center gap-1">
          <div className="min-w-0 flex-1">
            <PlaceRailScope
              value={repoRoot}
              onChange={setProjectScope}
              projects={projects}
            />
          </div>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              title="Close Pages rail"
              aria-label="Close Pages rail"
              className="shrink-0 w-5 h-5 grid place-items-center rounded text-text-4 hover:text-text-1 hover:bg-state-hover transition-colors"
            >
              <X className="w-3.5 h-3.5" strokeWidth={1.75} aria-hidden />
            </button>
          )}
        </div>
      }
    >
      <PagesSidebar
        summaries={summaries}
        activeKey={activeKey}
        onPick={openPage}
        onCreate={newPage}
        query={query}
        onQuery={setQuery}
        onBack={goBack}
        onForward={goForward}
        canBack={canBack}
        canForward={canForward}
        className="border-r-0 flex-1 min-h-0"
        folders={folders}
        expandedFolders={expandedSet}
        onToggleFolder={toggleFolder}
        onCreateFolder={createFolder}
        onRenameFolder={renameFolder}
        onSetFolderColor={setFolderColor}
        onDeleteFolder={deleteFolder}
        onMovePageToFolder={movePageToFolder}
        read={read}
        hasProject={!!repoRoot}
        onRetry={reloadSummaries}
      />
    </PlaceRail>
  );
}
