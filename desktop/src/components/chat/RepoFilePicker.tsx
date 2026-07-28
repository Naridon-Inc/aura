// Repo-scoped file picker for chat attachments. Opens as a modal overlay
// (similar to CommandPalette) and returns a repo-relative path via
// `onPick`. The picker never uploads — chat is per-repo, so every
// teammate with the same origin clone has the same files on disk and can
// open the link locally.
//
// Three tabs:
//   • Recent   — pulls localStorage `aura.recents.<repoRoot>` (last 50)
//   • Tree     — lazy-loaded folder tree via `api.listDir`
//   • Modified — `api.gitStatusV2` entries (staged + worktree)
//
// When the search box is non-empty, all tabs collapse into a flat fuzzy
// match list (case-insensitive substring + initial-letter scoring),
// capped at 200 results, indexed once-per-open via `api.fsFindFiles`.
//
// Keyboard: ↑↓ navigate, ↵ pick, esc close.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type DirEntry, type GitStatusEntry } from "../../lib/api";
import { FileIcon } from "../FileIcon";
import { Kbd } from "../ui/kbd";

type Tab = "recent" | "tree" | "modified";

export type RepoFilePickerProps = {
  open: boolean;
  repoRoot: string;
  onClose: () => void;
  /** Receives the path relative to `repoRoot`. */
  onPick: (path: string) => void;
};

type FlatRow = {
  /** repo-relative path */
  path: string;
  /** basename for display */
  name: string;
  /** dim "src/foo/bar" portion to render after the name */
  parent: string;
  /** optional status letter from gitStatusV2 (M/A/D/?) */
  status?: string;
};

type TreeNode = {
  /** repo-relative path */
  rel: string;
  /** basename */
  name: string;
  isDir: boolean;
  depth: number;
  /** for dirs: undefined = not yet loaded; [] = loaded empty */
  children?: TreeNode[];
  expanded?: boolean;
};

const HIDDEN_DIRS = new Set([".git", "node_modules", "target", ".aura"]);
const RECENT_LIMIT = 50;
const FLAT_LIMIT = 200;
const TAB_LABELS: Record<Tab, string> = {
  recent: "Recent",
  tree: "Tree",
  modified: "Modified",
};

// --------------------------------------------------------------------- //
// helpers                                                               //
// --------------------------------------------------------------------- //

function toRelative(repoRoot: string, abs: string): string {
  if (abs === repoRoot) return "";
  const prefix = repoRoot.endsWith("/") ? repoRoot : repoRoot + "/";
  if (abs.startsWith(prefix)) return abs.slice(prefix.length);
  // Already relative — pass through.
  return abs;
}

function joinAbs(repoRoot: string, rel: string): string {
  if (!rel) return repoRoot;
  return repoRoot.endsWith("/") ? `${repoRoot}${rel}` : `${repoRoot}/${rel}`;
}

function splitParent(rel: string): { name: string; parent: string } {
  const segs = rel.split("/");
  const name = segs[segs.length - 1] ?? rel;
  const parent = segs.slice(0, -1).join("/");
  return { name, parent };
}

function loadRecents(repoRoot: string): string[] {
  try {
    const raw = localStorage.getItem(`aura.recents.${repoRoot}`);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // The store may hold either absolute paths or already-relative ones;
    // normalize to repo-relative for display + return.
    const out: string[] = [];
    const seen = new Set<string>();
    for (const item of parsed) {
      if (typeof item !== "string") continue;
      const rel = toRelative(repoRoot, item);
      if (!rel || seen.has(rel)) continue;
      seen.add(rel);
      out.push(rel);
      if (out.length >= RECENT_LIMIT) break;
    }
    return out;
  } catch {
    return [];
  }
}

/** Case-insensitive substring score; higher = better. 0 = no match. */
function fuzzyScore(rel: string, name: string, q: string): number {
  if (!q) return 1;
  const nL = name.toLowerCase();
  const rL = rel.toLowerCase();
  if (nL === q) return 1000;
  if (nL.startsWith(q)) return 600;
  if (nL.includes(q)) return 400;
  if (rL.includes(q)) return 200 - rL.split("/").length;
  return 0;
}

function truncateMiddle(s: string, max: number): string {
  if (s.length <= max) return s;
  const head = Math.ceil((max - 1) / 2);
  const tail = Math.floor((max - 1) / 2);
  return `${s.slice(0, head)}…${s.slice(s.length - tail)}`;
}

// --------------------------------------------------------------------- //
// component                                                             //
// --------------------------------------------------------------------- //

export function RepoFilePicker({
  open,
  repoRoot,
  onClose,
  onPick,
}: RepoFilePickerProps) {
  const [tab, setTab] = useState<Tab>("recent");
  const [query, setQuery] = useState("");
  const [selIdx, setSelIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const [recents, setRecents] = useState<string[]>([]);
  const [modified, setModified] = useState<GitStatusEntry[]>([]);
  const [allFiles, setAllFiles] = useState<string[]>([]);
  const [rootNodes, setRootNodes] = useState<TreeNode[]>([]);
  const [, forceRender] = useState(0);

  // Reset on open + focus input.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setSelIdx(0);
    setTab("recent");
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  // Load recents + modified + workspace index once per open.
  useEffect(() => {
    if (!open || !repoRoot) return;
    let cancelled = false;
    setRecents(loadRecents(repoRoot));
    api
      .gitStatusV2(repoRoot)
      .then((entries) => {
        if (!cancelled) setModified(entries);
      })
      .catch(() => {
        if (!cancelled) setModified([]);
      });
    api
      .fsFindFiles(repoRoot)
      .then((rels) => {
        if (!cancelled) setAllFiles(rels);
      })
      .catch(() => {
        if (!cancelled) setAllFiles([]);
      });
    // Seed tree root.
    loadDirInto("", 0).then((children) => {
      if (!cancelled) setRootNodes(children);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, repoRoot]);

  const loadDirInto = useCallback(
    async (rel: string, depth: number): Promise<TreeNode[]> => {
      try {
        const entries = await api.listDir(joinAbs(repoRoot, rel));
        const visible = entries.filter(
          (e: DirEntry) => !(e.is_dir && HIDDEN_DIRS.has(e.name)),
        );
        visible.sort((a, b) => {
          if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
        return visible.map<TreeNode>((e) => ({
          rel: rel ? `${rel}/${e.name}` : e.name,
          name: e.name,
          isDir: e.is_dir,
          depth,
        }));
      } catch {
        return [];
      }
    },
    [repoRoot],
  );

  const toggleNode = useCallback(
    async (node: TreeNode) => {
      if (!node.isDir) return;
      if (node.expanded) {
        node.expanded = false;
        forceRender((n) => n + 1);
        return;
      }
      if (!node.children) {
        const kids = await loadDirInto(node.rel, node.depth + 1);
        node.children = kids;
      }
      node.expanded = true;
      forceRender((n) => n + 1);
    },
    [loadDirInto],
  );

  // ---------------------------------------------------------------- //
  // Build the visible row list for the current tab + query.         //
  // ---------------------------------------------------------------- //

  const flatRows: FlatRow[] = useMemo(() => {
    const q = query.trim().toLowerCase();

    // SEARCH MODE — flat fuzzy results across the whole workspace.
    if (q) {
      const seen = new Set<string>();
      const scored: Array<{ row: FlatRow; score: number }> = [];
      const tryAdd = (rel: string, status?: string) => {
        if (seen.has(rel)) return;
        const { name, parent } = splitParent(rel);
        const s = fuzzyScore(rel, name, q);
        if (s <= 0) return;
        seen.add(rel);
        scored.push({ row: { path: rel, name, parent, status }, score: s });
      };
      // Score recents + modified slightly higher by adding them first.
      for (const rel of recents) tryAdd(rel);
      for (const e of modified) tryAdd(e.path, statusLetter(e));
      for (const rel of allFiles) tryAdd(rel);
      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, FLAT_LIMIT).map((s) => s.row);
    }

    // NO-QUERY MODE — depends on tab. Tree is rendered separately.
    if (tab === "recent") {
      return recents.map((rel) => {
        const { name, parent } = splitParent(rel);
        return { path: rel, name, parent };
      });
    }
    if (tab === "modified") {
      return modified.map((e) => {
        const { name, parent } = splitParent(e.path);
        return { path: e.path, name, parent, status: statusLetter(e) };
      });
    }
    return [];
  }, [query, tab, recents, modified, allFiles]);

  // Flattened tree view (only used when tab === "tree" and !query).
  const treeRows = useMemo(() => {
    if (query.trim() || tab !== "tree") return [] as TreeNode[];
    const out: TreeNode[] = [];
    const walk = (nodes: TreeNode[]) => {
      for (const n of nodes) {
        out.push(n);
        if (n.isDir && n.expanded && n.children) walk(n.children);
      }
    };
    walk(rootNodes);
    return out;
    // forceRender bumps rerender; the dependency on rootNodes identity
    // alone is not enough because we mutate `expanded` in place.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootNodes, tab, query]);

  // The selectable list is either `flatRows` or the *file* subset of
  // `treeRows`. Directories in the tree don't count as picks.
  const navigable = useMemo(() => {
    if (query.trim() || tab !== "tree") return flatRows.map((r) => r.path);
    return treeRows.filter((n) => !n.isDir).map((n) => n.rel);
  }, [flatRows, treeRows, query, tab]);

  // Clamp selection when the row count changes.
  useEffect(() => {
    setSelIdx((i) => Math.max(0, Math.min(navigable.length - 1, i)));
  }, [navigable.length]);

  // ---------------------------------------------------------------- //
  // Keyboard                                                          //
  // ---------------------------------------------------------------- //

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelIdx((i) => Math.min(navigable.length - 1, i + 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelIdx((i) => Math.max(0, i - 1));
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        const path = navigable[selIdx];
        if (path) {
          onPick(path);
          onClose();
        }
        return;
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, navigable, selIdx, onClose, onPick]);

  if (!open) return null;

  // ---------------------------------------------------------------- //
  // Render                                                            //
  // ---------------------------------------------------------------- //

  const searching = !!query.trim();
  const showTree = !searching && tab === "tree";

  return (
    <div
      className="fixed inset-0 flex items-start justify-center pt-[12vh] z-50"
      style={{ background: "rgba(0,0,0,0.4)", backdropFilter: "blur(4px)" }}
      onMouseDown={onClose}
    >
      <div
        className="bg-bg-chrome border border-line-soft rounded-lg shadow-xl overflow-hidden flex flex-col"
        style={{ width: 700, height: 500 }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* Search row */}
        <div className="flex items-center px-3 py-2 border-b border-line-soft flex-shrink-0">
          <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            className="text-text-4"
          >
            <circle
              cx="7"
              cy="7"
              r="4"
              stroke="currentColor"
              strokeWidth="1.4"
              fill="none"
            />
            <line
              x1="10"
              y1="10"
              x2="13.5"
              y2="13.5"
              stroke="currentColor"
              strokeWidth="1.4"
            />
          </svg>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelIdx(0);
            }}
            placeholder="Find a file…"
            className="flex-1 bg-transparent outline-none ml-3 text-text-1 text-[12.5px] placeholder:text-text-4"
          />
          <span className="text-[10px] text-text-5 tracking-wider">esc</span>
        </div>

        {/* Tabs */}
        <div className="flex items-center gap-1 px-3 py-1.5 border-b border-line-soft flex-shrink-0">
          {(Object.keys(TAB_LABELS) as Tab[]).map((t) => {
            const active = !searching && tab === t;
            const count =
              t === "recent"
                ? recents.length
                : t === "modified"
                  ? modified.length
                  : undefined;
            return (
              <button
                key={t}
                type="button"
                onClick={() => {
                  setTab(t);
                  setSelIdx(0);
                }}
                disabled={searching}
                className={`px-2 py-0.5 rounded text-[11.5px] transition-colors ${
                  active
                    ? "bg-bg-card text-text-1"
                    : "text-text-3 hover:text-text-1 hover:bg-bg-hover"
                } ${searching ? "opacity-50 cursor-not-allowed" : ""}`}
              >
                {TAB_LABELS[t]}
                {count !== undefined && (
                  <span className="ml-1.5 text-text-5">{count}</span>
                )}
              </button>
            );
          })}
          {searching && (
            <span className="ml-auto text-[10.5px] text-text-4">
              {navigable.length} match{navigable.length === 1 ? "" : "es"}
            </span>
          )}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto py-1">
          {showTree ? (
            <TreeView
              rows={treeRows}
              selIdx={selIdx}
              onSetIdx={setSelIdx}
              navigable={navigable}
              onToggle={toggleNode}
              onPickFile={(p) => {
                onPick(p);
                onClose();
              }}
            />
          ) : (
            <FlatList
              rows={flatRows}
              selIdx={selIdx}
              onSetIdx={setSelIdx}
              emptyHint={
                searching
                  ? "no matches"
                  : tab === "recent"
                    ? "no recent files yet — open one in the editor"
                    : "no modified files"
              }
              onPick={(p) => {
                onPick(p);
                onClose();
              }}
            />
          )}
        </div>

        {/* Footer hint */}
        <div className="flex items-center px-3 py-1.5 border-t border-line-soft text-[10.5px] text-text-5 gap-3 flex-shrink-0">
          <span>
            <Kbd>↑↓</Kbd> navigate
          </span>
          <span>
            <Kbd>↵</Kbd> attach
          </span>
          <span>
            <Kbd>esc</Kbd> cancel
          </span>
          <span className="ml-auto truncate">{truncateMiddle(repoRoot, 60)}</span>
        </div>
      </div>
    </div>
  );
}

// --------------------------------------------------------------------- //
// internal sub-components                                               //
// --------------------------------------------------------------------- //

function statusLetter(e: GitStatusEntry): string {
  // Prefer the worktree letter; fall back to staged.
  return (e.worktree || e.index || "M").trim() || "M";
}

function FlatList({
  rows,
  selIdx,
  onSetIdx,
  onPick,
  emptyHint,
}: {
  rows: FlatRow[];
  selIdx: number;
  onSetIdx: (i: number) => void;
  onPick: (path: string) => void;
  emptyHint: string;
}) {
  if (rows.length === 0) {
    return (
      <div className="px-3 py-4 text-text-4 text-[12px]">{emptyHint}</div>
    );
  }
  return (
    <ul>
      {rows.map((r, i) => (
        <li
          key={r.path}
          onMouseEnter={() => onSetIdx(i)}
          onMouseDown={(ev) => {
            ev.preventDefault();
            onPick(r.path);
          }}
          className={`flex items-center gap-2 px-3 py-1.5 cursor-pointer text-[12.5px] ${
            i === selIdx
              ? "bg-bg-card text-text-1"
              : "text-text-2 hover:bg-bg-hover"
          }`}
        >
          <FileIcon name={r.name} size={14} />
          <span className="font-medium truncate" style={{ maxWidth: 240 }}>
            {r.name}
          </span>
          {r.parent && (
            <span
              className="text-text-4 truncate"
              style={{ maxWidth: 360 }}
              title={r.parent}
            >
              {truncateMiddle(r.parent, 56)}
            </span>
          )}
          {r.status && (
            <span
              className="ml-auto text-[10px] font-semibold uppercase tracking-wider"
              style={{
                color:
                  r.status === "A"
                    ? "var(--color-green)"
                    : r.status === "D"
                      ? "var(--color-red)"
                      : "var(--color-amber)",
              }}
            >
              {r.status}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

function TreeView({
  rows,
  selIdx,
  onSetIdx,
  navigable,
  onToggle,
  onPickFile,
}: {
  rows: TreeNode[];
  selIdx: number;
  onSetIdx: (i: number) => void;
  navigable: string[];
  onToggle: (n: TreeNode) => void | Promise<void>;
  onPickFile: (path: string) => void;
}) {
  if (rows.length === 0) {
    return (
      <div className="px-3 py-4 text-text-4 text-[12px]">empty repo</div>
    );
  }
  const selectedPath = navigable[selIdx];
  return (
    <ul>
      {rows.map((n) => {
        const isSelected = !n.isDir && n.rel === selectedPath;
        const idxInNavigable = n.isDir ? -1 : navigable.indexOf(n.rel);
        return (
          <li
            key={n.rel}
            onMouseEnter={() => {
              if (idxInNavigable >= 0) onSetIdx(idxInNavigable);
            }}
            onMouseDown={(ev) => {
              ev.preventDefault();
              if (n.isDir) {
                void onToggle(n);
              } else {
                onPickFile(n.rel);
              }
            }}
            className={`flex items-center gap-1.5 px-3 py-1 cursor-pointer text-[12.5px] ${
              isSelected
                ? "bg-bg-card text-text-1"
                : "text-text-2 hover:bg-bg-hover"
            }`}
            style={{ paddingLeft: 12 + n.depth * 14 }}
          >
            {n.isDir ? (
              <Chevron expanded={!!n.expanded} />
            ) : (
              <span style={{ width: 10, display: "inline-block" }} />
            )}
            <FileIcon
              name={n.name}
              isDirectory={n.isDir}
              isOpen={n.isDir && !!n.expanded}
              size={14}
            />
            <span className="truncate">{n.name}</span>
          </li>
        );
      })}
    </ul>
  );
}

function Chevron({ expanded }: { expanded: boolean }) {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 10 10"
      fill="none"
      className="text-text-4"
      style={{
        transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
        transition: "transform 120ms",
      }}
    >
      <path
        d="M3.5 2L6.5 5L3.5 8"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
