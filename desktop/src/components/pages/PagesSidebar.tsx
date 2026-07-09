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
  FileText,
  FolderPlus,
  Plus,
  GripVertical,
  Search,
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
import { PageFolderGroup } from "./PageFolderGroup";
import { DEFAULT_FOLDER_COLOR } from "../pages2/folderColors";

const FOLDERS_EXPANDED_KEY = "aura.pages.folders.expanded";

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
};

export function PagesSidebar({
  summaries,
  activeKey,
  onPick,
  onCreate,
  query = "",
  onQuery,
  className,
  folders,
  expandedFolders,
  onToggleFolder,
  onCreateFolder,
  onRenameFolder,
  onSetFolderColor,
  onDeleteFolder,
  onMovePageToFolder,
}: Props) {
  const [parents, setParents] = useState<ParentMap>(() => readParentMap());
  const [expanded, setExpanded] = useState<Set<string>>(() => readExpanded());
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);

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
      {/* Shared ADE section header (matches Trace / Tasks) — the +New page
          action rides the header's right slot. paddingInline:14 aligns the
          label + action with the 14px content inset of the rows below. */}
      <div className="ade-sec-h h-8 text-[10.5px]" style={{ paddingInline: 12 }}>
        Pages
        {(onCreateFolder || onCreate) && (
          <span className="right flex items-center gap-0.5">
            {onCreateFolder && (
              <button
                type="button"
                onClick={onCreateFolder}
                title="New folder"
                className="w-5 h-5 grid place-items-center rounded text-text-4 hover:text-text-1 hover:bg-bg-2 transition-colors"
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
                className="w-5 h-5 grid place-items-center rounded text-text-4 hover:text-text-1 hover:bg-bg-2 transition-colors"
              >
                <Plus className="w-3.5 h-3.5" strokeWidth={1.75} aria-hidden />
              </button>
            )}
          </span>
        )}
      </div>
      {onQuery && (
        <div className="px-1.5 pb-2 flex-shrink-0">
          <div className="relative">
            <Search
              className="w-3 h-3 absolute left-2 top-1/2 -translate-y-1/2 text-text-5"
              strokeWidth={1.5}
            />
            <Input
              type="text"
              value={query}
              onChange={(e) => onQuery(e.target.value)}
              placeholder="Filter…"
              className="h-6 pl-7 pr-2 text-[11px]"
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
        {tree.length === 0 && sortedFolders.length === 0 && (
          <div className="px-3 py-4 text-[11.5px] text-text-5 text-center">
            {query.trim() ? "No pages match." : "No pages yet."}
          </div>
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
                <div className="pl-7 pr-2 py-1 text-[11px] text-text-5 select-none">
                  Empty — drag a page here.
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
        {dateGroups.map((group) => (
          <div key={group.label} className="mb-1">
            <div className="px-2 pt-1.5 pb-0.5 text-[9.5px] font-medium uppercase tracking-[0.12em] text-text-5 select-none">
              {group.label}
            </div>
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
          </div>
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
        className={cn(
          "group h-[22px] flex items-center gap-1 rounded-sm text-[11.5px] cursor-pointer select-none transition-colors",
          isActive
            ? "bg-bg-2 text-text-1"
            : "text-text-2 hover:bg-bg-2 hover:text-text-1",
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
          className="w-3 h-3 text-text-5 flex-shrink-0"
          strokeWidth={1.5}
          aria-hidden
        />
        <span className="flex-1 min-w-0 truncate">
          {node.summary.title || "(untitled)"}
        </span>
        <span
          className="opacity-0 group-hover:opacity-100 w-3 h-3 grid place-items-center text-text-5 cursor-grab active:cursor-grabbing"
          aria-hidden
          title="Drag to reparent"
        >
          <GripVertical
            className="w-3 h-3"
            strokeWidth={1.5}
          />
        </span>
        <ScopeBadge scope={node.summary.scope} bucket={node.summary.bucket} />
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

function ScopeBadge({ scope, bucket }: { scope: NoteScope; bucket: string }) {
  const label =
    scope === "team" ? "T" : scope === "channel" ? `#` : `@`;
  const title =
    scope === "team"
      ? "Team"
      : scope === "channel"
        ? `#${bucket}`
        : `@${bucket}`;
  return (
    <span
      title={title}
      className="text-[8.5px] font-mono text-text-5/80 w-3 grid place-items-center flex-shrink-0"
      aria-hidden
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
  const [summaries, setSummaries] = useState<NoteSummary[]>([]);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [folders, setFolders] = useState<PageFolder[]>([]);
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
  useEffect(() => {
    if (!repoRoot) return;
    let cancelled = false;
    api
      .notesList({ repoRoot })
      .then((rows) => {
        if (!cancelled) setSummaries(rows);
      })
      .catch(() => {
        /* swallow — NotesWorkpane will mirror once it mounts */
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

  function openPage(s: NoteSummary) {
    const key = keyOf(s);
    setActiveKey(key);
    // Two dispatches so a rail click always lands somewhere:
    //   • `aura:pages:open` — caught immediately IF a Pages pane is already
    //     mounted (NotesWorkpane / pages2 PagesSurface listen for it).
    //   • `aura:open-page` — App.tsx's handler runs `editor.openPages(root)`
    //     first and then re-opens the page, so clicking from the rail while
    //     the centre shows the agent (or anything else) opens the Pages pane
    //     instead of silently doing nothing.
    window.dispatchEvent(
      new CustomEvent("aura:pages:open", { detail: { key } }),
    );
    window.dispatchEvent(
      new CustomEvent("aura:open-page", {
        detail: { scope: s.scope, bucket: s.bucket, id: s.id },
      }),
    );
  }

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
    <aside className="h-full w-full flex flex-col relative">
      {onClose && (
        <button
          type="button"
          onClick={onClose}
          title="Close Pages rail"
          className="absolute top-2.5 right-2 z-10 w-5 h-5 grid place-items-center rounded text-text-4 hover:text-text-1 hover:bg-bg-2 transition-colors"
        >
          <X className="w-3.5 h-3.5" strokeWidth={1.75} aria-hidden />
        </button>
      )}
      <PagesSidebar
        summaries={summaries}
        activeKey={activeKey}
        onPick={openPage}
        onCreate={newPage}
        query={query}
        onQuery={setQuery}
        className="border-r-0 flex-1 min-h-0"
        folders={folders}
        expandedFolders={expandedSet}
        onToggleFolder={toggleFolder}
        onCreateFolder={createFolder}
        onRenameFolder={renameFolder}
        onSetFolderColor={setFolderColor}
        onDeleteFolder={deleteFolder}
        onMovePageToFolder={movePageToFolder}
      />
    </aside>
  );
}
