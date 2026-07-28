// Recursive file tree with branded material-icon-theme glyphs, a
// superset.sh-style toolbar (search + new file/folder + collapse +
// refresh), per-row right-click context menu, and inline rename /
// new-entry input. Backed by tauri::list_dir + the fs_* mutation
// commands in cmd_files.rs.
//
// Layout: rows are flat <div>s with depth-driven left padding so
// hover highlights span the full sidebar width and a future virtual
// list can drop in without restructuring the tree.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronsDownUp,
  Columns2,
  Copy,
  ExternalLink,
  FilePlus,
  FolderPlus,
  Pencil,
  RefreshCw,
  Rows2,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { api, type DirEntry, type EditorInfo } from "../lib/api";
import { beginInAppFileDrag, endInAppFileDrag } from "../lib/osFileDrop";
import { useDebouncedValue } from "../lib/useDebouncedValue";
import { AsciiSpinner } from "./ui/ascii-spinner";
import { FileIcon } from "./FileIcon";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "./ui/context-menu";
import { Input } from "./ui/input";

type FileTreeProps = {
  root: string;
  selected: string | null;
  onSelect: (path: string) => void;
  /** Optional — open `path` as a new split pane next to the active
   *  pane. Wired by FilesSidebar → App to editor.openFileSplit. When
   *  omitted, Alt+click and the context-menu "Open in Split" items
   *  fall back to a plain open. */
  onSelectSplit?: (path: string, direction: "row" | "column") => void;
};

type Node = DirEntry & {
  depth: number;
  children: Node[] | null; // null = not loaded yet
};

/** Inline editor state — either renaming an existing path, or creating
 *  a new file/folder underneath a parent path. Kept outside the tree
 *  data so React re-renders just the affected row. */
type EditorState =
  | { kind: "rename"; path: string; initial: string }
  | { kind: "new-file"; parent: string }
  | { kind: "new-folder"; parent: string }
  | null;

type PendingDelete =
  | { kind: "one"; node: Node }
  | { kind: "many"; paths: string[] }
  | null;

export function FileTree({ root, selected, onSelect, onSelectSplit }: FileTreeProps) {
  const [tree, setTree] = useState<Node[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [editor, setEditor] = useState<EditorState>(null);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete>(null);
  const [multiSelected, setMultiSelected] = useState<Set<string>>(new Set());
  const [lastClickedPath, setLastClickedPath] = useState<string | null>(null);
  // Installed external editors for the "Open in…" submenu. Probed once —
  // the set changes only when the user installs/removes an editor, which a
  // reload picks up. Empty until the probe resolves.
  const [editors, setEditors] = useState<EditorInfo[]>([]);
  // The folder new files/folders land in — tracks the last folder the user
  // opened, or the parent of the file they selected, so the toolbar's New
  // File / New Folder buttons create *where the user is looking* instead of
  // always at the repo root. Null until the user touches the tree (we then
  // fall back to root).
  const [activeDir, setActiveDir] = useState<string | null>(null);
  // Paths picked up by an in-flight row drag (a single row, or the whole
  // multi-selection when the dragged row belongs to it). Folder rows read
  // this on dragover/drop to decide validity + perform the move. A ref, not
  // state, so drag handlers see the latest value without re-rendering.
  const dragPathsRef = useRef<string[]>([]);
  const expandedRef = useRef<Set<string>>(new Set());
  const [, forceTick] = useState(0);
  const refresh = () => forceTick((n) => n + 1);

  // Load root + recursively re-fetch any directories the user already
  // expanded so a refresh after an external change reflects reality.
  async function reloadAll(): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      const rootEntries = await api.listDir(root);
      const rootNodes = rootEntries.map((e) => toNode(e, 0));
      // Re-expand previously-open dirs depth-first.
      async function expand(nodes: Node[]) {
        for (const n of nodes) {
          if (n.is_dir && expandedRef.current.has(n.path)) {
            try {
              const kids = await api.listDir(n.path);
              n.children = kids.map((e) => toNode(e, n.depth + 1));
              await expand(n.children);
            } catch {
              n.children = [];
            }
          }
        }
      }
      await expand(rootNodes);
      setTree(rootNodes);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void reloadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root]);

  // Probe for installed editors once — the "Open in…" submenu renders only
  // what actually resolved. A probe failure just leaves the submenu absent.
  useEffect(() => {
    let alive = true;
    api
      .editorsList()
      .then((list) => {
        if (alive) setEditors(list);
      })
      .catch(() => {
        /* no editors surfaced — submenu stays hidden */
      });
    return () => {
      alive = false;
    };
  }, []);

  async function toggle(node: Node) {
    if (!node.is_dir) {
      onSelect(node.path);
      return;
    }
    if (expandedRef.current.has(node.path)) {
      expandedRef.current.delete(node.path);
    } else {
      expandedRef.current.add(node.path);
      if (node.children == null) {
        try {
          const kids = await api.listDir(node.path);
          node.children = kids.map((e) => toNode(e, node.depth + 1));
        } catch {
          node.children = [];
        }
      }
    }
    setTree([...tree]);
  }

  /** Reload one folder's children in place. Used after create/rename
   *  /delete so we don't re-walk the whole tree. */
  async function reloadFolder(folderPath: string): Promise<void> {
    const node = findNode(tree, folderPath);
    try {
      const kids = await api.listDir(folderPath);
      const nextChildren = kids.map((e) =>
        toNode(e, (node?.depth ?? 0) + 1),
      );
      if (node) {
        node.children = nextChildren;
        expandedRef.current.add(folderPath);
        setTree([...tree]);
      } else {
        // Root reload.
        const top = kids.map((e) => toNode(e, 0));
        setTree(top);
      }
    } catch (e) {
      setError(String(e));
    }
  }

  // Toolbar actions ─────────────────────────────────────────────────────
  async function startNew(kind: "file" | "folder", parent?: string) {
    // Default the new entry into the folder the user is currently in (the
    // last folder opened / the parent of the selected file), falling back to
    // the repo root. An explicit `parent` (from a folder's right-click menu)
    // always wins.
    const target = parent ?? activeDir ?? root;
    if (target !== root) {
      expandedRef.current.add(target);
      // Ensure the target folder is expanded AND its children are loaded, so
      // the inline editor row actually renders underneath it.
      const node = findNode(tree, target);
      if (node && node.is_dir && node.children == null) {
        try {
          const kids = await api.listDir(target);
          node.children = kids.map((e) => toNode(e, node.depth + 1));
          setTree([...tree]);
        } catch {
          /* fall through — editor still appears; create surfaces errors */
        }
      }
    }
    setEditor(
      kind === "file"
        ? { kind: "new-file", parent: target }
        : { kind: "new-folder", parent: target },
    );
    refresh();
  }

  /** Move one or more paths into a destination folder. `fs_rename` IS our
   *  move (atomic). Skips no-ops (already in dest) and illegal moves (into
   *  self or a descendant), then reloads from root so every affected folder
   *  reflects reality. */
  async function moveInto(paths: string[], destDir: string) {
    let moved = 0;
    for (const from of paths) {
      if (from === destDir) continue;
      if (destDir === from || destDir.startsWith(from + "/")) continue; // into self/child
      if (parentOf(from) === destDir) continue; // already here
      const dest = `${destDir}/${basenameOf(from)}`;
      try {
        await api.fsRename(from, dest);
        moved++;
        if (selected === from) onSelect(dest);
      } catch (e) {
        setError(String(e));
      }
    }
    if (moved > 0) {
      expandedRef.current.add(destDir);
      setMultiSelected(new Set());
      await reloadAll();
    }
  }

  function collapseAll() {
    expandedRef.current.clear();
    refresh();
  }

  // Editor commit handlers ──────────────────────────────────────────────
  async function commitEditor(value: string) {
    if (!editor) return;
    const trimmed = value.trim();
    if (!trimmed) {
      setEditor(null);
      return;
    }
    try {
      if (editor.kind === "rename") {
        const dir = parentOf(editor.path);
        const dest = dir ? `${dir}/${trimmed}` : trimmed;
        await api.fsRename(editor.path, dest);
        if (dir) await reloadFolder(dir);
        else await reloadAll();
        // If the renamed file was selected, follow it.
        if (selected === editor.path) onSelect(dest);
      } else {
        const dest = `${editor.parent}/${trimmed}`;
        if (editor.kind === "new-file") {
          await api.fsCreateFile(dest);
          await reloadFolder(editor.parent);
          onSelect(dest);
        } else {
          await api.fsCreateFolder(dest);
          await reloadFolder(editor.parent);
        }
      }
      setEditor(null);
    } catch (e) {
      setError(String(e));
      setEditor(null);
    }
  }

  // Context-menu actions ────────────────────────────────────────────────
  async function onCopyPath(node: Node) {
    try {
      await navigator.clipboard.writeText(node.path);
    } catch {
      /* ignore clipboard denial */
    }
  }
  async function onCopyRelative(node: Node) {
    const rel = node.path.startsWith(root + "/")
      ? node.path.slice(root.length + 1)
      : node.path;
    try {
      await navigator.clipboard.writeText(rel);
    } catch {
      /* ignore */
    }
  }
  async function onReveal(node: Node) {
    try {
      await api.fsRevealInFinder(node.path);
    } catch (e) {
      setError(String(e));
    }
  }
  async function onOpenInEditor(node: Node, editorId: string) {
    try {
      await api.editorOpen(node.path, editorId);
    } catch (e) {
      setError(String(e));
    }
  }
  function onDelete(node: Node) {
    setPendingDelete({ kind: "one", node });
  }
  function onDeleteMany(paths: string[]) {
    if (paths.length === 0) return;
    if (paths.length === 1) {
      const n = findNode(tree, paths[0]);
      if (n) setPendingDelete({ kind: "one", node: n });
      return;
    }
    setPendingDelete({ kind: "many", paths });
  }
  async function confirmDelete() {
    const target = pendingDelete;
    if (!target) return;
    setPendingDelete(null);
    try {
      if (target.kind === "one") {
        await api.fsDelete(target.node.path);
        const dir = parentOf(target.node.path);
        if (dir) await reloadFolder(dir);
        else await reloadAll();
      } else {
        // Bulk delete: drop nested paths so we don't double-delete a
        // folder's children after the folder itself is gone.
        const sorted = [...target.paths].sort();
        const top: string[] = [];
        for (const p of sorted) {
          if (!top.some((t) => p === t || p.startsWith(t + "/"))) top.push(p);
        }
        for (const p of top) {
          try {
            await api.fsDelete(p);
          } catch (e) {
            setError(String(e));
          }
        }
        setMultiSelected(new Set());
        await reloadAll();
      }
    } catch (e) {
      setError(String(e));
    }
  }
  function onRename(node: Node) {
    setEditor({ kind: "rename", path: node.path, initial: node.name });
  }

  const debouncedQuery = useDebouncedValue(query, 120);
  const filtered = useMemo(
    () => filterTree(tree, expandedRef.current, debouncedQuery.trim().toLowerCase()),
    [tree, debouncedQuery, /* re-run on tick */ editor],
  );

  function onRowClick(node: Node, e: React.MouseEvent) {
    // Alt/Option+click on a file opens it in a split pane below the
    // active pane — VSCode convention (Cmd+click is reserved here for
    // multi-select). Folders ignore the modifier and toggle as usual.
    if (e.altKey && !node.is_dir && onSelectSplit) {
      e.preventDefault();
      onSelectSplit(node.path, "column");
      return;
    }
    if (e.metaKey || e.ctrlKey) {
      e.preventDefault();
      setMultiSelected((prev) => {
        const next = new Set(prev);
        if (next.has(node.path)) next.delete(node.path);
        else next.add(node.path);
        if (selected && next.size > 0 && !next.has(selected)) {
          next.add(selected);
        }
        return next;
      });
      setLastClickedPath(node.path);
      return;
    }
    if (e.shiftKey && lastClickedPath) {
      const idxA = filtered.findIndex((r) => r.path === lastClickedPath);
      const idxB = filtered.findIndex((r) => r.path === node.path);
      if (idxA >= 0 && idxB >= 0) {
        const lo = Math.min(idxA, idxB);
        const hi = Math.max(idxA, idxB);
        setMultiSelected(new Set(filtered.slice(lo, hi + 1).map((r) => r.path)));
        return;
      }
    }
    setMultiSelected(new Set());
    setLastClickedPath(node.path);
    setActiveDir(node.is_dir ? node.path : parentOf(node.path) ?? root);
    void toggle(node);
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <FileTreeToolbar
        query={query}
        onQuery={setQuery}
        onNewFile={() => void startNew("file")}
        onNewFolder={() => void startNew("folder")}
        onCollapseAll={collapseAll}
        onRefresh={() => void reloadAll()}
      />
      <div className="overflow-y-auto flex-1 min-h-0">
        {loading ? (
          <div className="text-text-3 text-xs px-3 py-2 inline-flex items-center gap-1.5">
            <AsciiSpinner /> Loading…
          </div>
        ) : error ? (
          <div className="text-red text-xs px-3 py-2">{error}</div>
        ) : (
          <FlatList
            rows={filtered}
            selected={selected}
            editor={editor}
            expandedSet={expandedRef.current}
            multiSelected={multiSelected}
            onRowClick={onRowClick}
            onCopyPath={onCopyPath}
            onCopyRelative={onCopyRelative}
            onReveal={onReveal}
            editors={editors}
            onOpenInEditor={onOpenInEditor}
            onDelete={onDelete}
            onDeleteMany={onDeleteMany}
            onRename={onRename}
            onNewFile={(parent) => void startNew("file", parent)}
            onNewFolder={(parent) => void startNew("folder", parent)}
            onSelectSplit={onSelectSplit}
            onMoveInto={(paths, destDir) => void moveInto(paths, destDir)}
            dragPaths={dragPathsRef}
            onEditorCommit={commitEditor}
            onEditorCancel={() => setEditor(null)}
          />
        )}
      </div>
      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pendingDelete?.kind === "many"
                ? `Delete ${pendingDelete.paths.length} items?`
                : `Delete ${pendingDelete?.kind === "one" && pendingDelete.node.is_dir ? "folder" : "file"}?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDelete?.kind === "one" && (
                <>
                  This will permanently delete{" "}
                  <span className="text-text-1 font-medium">
                    {pendingDelete.node.name}
                  </span>
                  {pendingDelete.node.is_dir ? " and all its contents" : ""}.
                  This action cannot be undone.
                </>
              )}
              {pendingDelete?.kind === "many" && (
                <>
                  This will permanently delete{" "}
                  <span className="text-text-1 font-medium">
                    {pendingDelete.paths.length} items
                  </span>
                  {": "}
                  {pendingDelete.paths
                    .slice(0, 5)
                    .map((p) => basenameOf(p))
                    .join(", ")}
                  {pendingDelete.paths.length > 5
                    ? `, and ${pendingDelete.paths.length - 5} more`
                    : ""}
                  . This action cannot be undone.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void confirmDelete()}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function toNode(e: DirEntry, depth: number): Node {
  return { ...e, depth, children: null };
}

function parentOf(path: string): string | null {
  const idx = path.lastIndexOf("/");
  return idx <= 0 ? null : path.slice(0, idx);
}

function basenameOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx < 0 ? path : path.slice(idx + 1);
}

function findNode(nodes: Node[], path: string): Node | null {
  for (const n of nodes) {
    if (n.path === path) return n;
    if (n.children) {
      const hit = findNode(n.children, path);
      if (hit) return hit;
    }
  }
  return null;
}

/** Walk the tree honoring expansion state and an optional query. When
 *  the query is non-empty, surface matching leaves with their ancestor
 *  dirs (forced expanded for visibility). */
function filterTree(
  nodes: Node[],
  expanded: Set<string>,
  query: string,
): Node[] {
  if (!query) {
    const rows: Node[] = [];
    function walk(ns: Node[]) {
      for (const n of ns) {
        rows.push(n);
        if (n.is_dir && expanded.has(n.path) && n.children) walk(n.children);
      }
    }
    walk(nodes);
    return rows;
  }
  const rows: Node[] = [];
  function visit(ns: Node[]): boolean {
    let anyMatch = false;
    for (const n of ns) {
      const matches = n.name.toLowerCase().includes(query);
      if (n.is_dir && n.children) {
        const childMatch = visit(n.children);
        if (matches || childMatch) {
          rows.push(n);
          if (childMatch) {
            // Ensure children render below this dir even if not expanded.
            for (const c of childRows(n, expanded, query)) rows.push(c);
          }
          anyMatch = true;
        }
      } else if (matches) {
        rows.push(n);
        anyMatch = true;
      }
    }
    return anyMatch;
  }
  visit(nodes);
  return rows;
}

function childRows(node: Node, expanded: Set<string>, query: string): Node[] {
  if (!node.children) return [];
  const out: Node[] = [];
  for (const c of node.children) {
    const matches = c.name.toLowerCase().includes(query);
    if (c.is_dir && c.children) {
      const sub = childRows(c, expanded, query);
      if (matches || sub.length) {
        out.push(c);
        out.push(...sub);
      }
    } else if (matches) {
      out.push(c);
    }
  }
  return out;
}

function FileTreeToolbar(props: {
  query: string;
  onQuery: (q: string) => void;
  onNewFile: () => void;
  onNewFolder: () => void;
  onCollapseAll: () => void;
  onRefresh: () => void;
}) {
  // Match toggles for the content search (mirrors VS Code's Aa / ab / .*).
  // The box itself stays a live file-NAME filter as you type; pressing
  // Enter escalates to a project-wide CONTENT search by opening the full
  // Search workpane (results, per-file jump, replace) prefilled with the
  // query + these toggles. Backed by the existing `aura:open-search` event.
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [regex, setRegex] = useState(false);

  const runContentSearch = () => {
    const q = props.query.trim();
    if (!q) return;
    window.dispatchEvent(
      new CustomEvent("aura:open-search", {
        detail: { query: q, regex, caseSensitive, wholeWord },
      }),
    );
  };

  return (
    <div className="flex flex-col gap-1.5 px-2 py-1.5 border-b border-line-soft">
      <div className="relative flex-1">
        <Search
          className="absolute left-1.5 top-1/2 -translate-y-1/2 text-text-4 z-10"
          size={11}
        />
        <Input
          value={props.query}
          onChange={(e) => props.onQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              runContentSearch();
            }
          }}
          placeholder="Search files — Enter for contents"
          className="h-7 pl-6 pr-[78px] text-[11.5px]"
        />
        <div className="absolute right-1 top-1/2 -translate-y-1/2 flex items-center gap-0.5">
          <SearchToggle
            active={caseSensitive}
            onClick={() => setCaseSensitive((v) => !v)}
            title="Match case"
          >
            Aa
          </SearchToggle>
          <SearchToggle
            active={wholeWord}
            onClick={() => setWholeWord((v) => !v)}
            title="Match whole word"
          >
            <span className="underline underline-offset-1">ab</span>
          </SearchToggle>
          <SearchToggle
            active={regex}
            onClick={() => setRegex((v) => !v)}
            title="Use regular expression"
          >
            .*
          </SearchToggle>
          {props.query && (
            <button
              type="button"
              onClick={() => props.onQuery("")}
              className="w-[18px] h-[18px] inline-flex items-center justify-center rounded text-text-4 hover:text-text-1 hover:bg-bg-hover"
              title="Clear"
            >
              <X size={11} />
            </button>
          )}
        </div>
      </div>
      <div className="flex items-center gap-0.5">
        <ToolbarButton title="New File" onClick={props.onNewFile}>
          <FilePlus size={12} />
        </ToolbarButton>
        <ToolbarButton title="New Folder" onClick={props.onNewFolder}>
          <FolderPlus size={12} />
        </ToolbarButton>
        <ToolbarButton title="Collapse All" onClick={props.onCollapseAll}>
          <ChevronsDownUp size={12} />
        </ToolbarButton>
        <ToolbarButton title="Refresh" onClick={props.onRefresh}>
          <RefreshCw size={12} />
        </ToolbarButton>
      </div>
    </div>
  );
}

function ToolbarButton(props: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className="w-6 h-6 inline-flex items-center justify-center rounded text-text-3 hover:text-text-1 hover:bg-bg-hover"
      title={props.title}
    >
      {props.children}
    </button>
  );
}

/** Compact Aa / ab / .* match toggle that lives inside the search input,
 *  mirroring VS Code's search affordances. Active uses the arctic-blue
 *  accent so it reads as "this filter is on". */
function SearchToggle(props: {
  title: string;
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={props.title}
      aria-pressed={props.active}
      onClick={props.onClick}
      className={`w-[18px] h-[18px] inline-flex items-center justify-center rounded text-[9.5px] font-semibold leading-none transition-colors ${
        props.active
          ? "text-accent bg-accent/15"
          : "text-text-4 hover:text-text-1 hover:bg-bg-hover"
      }`}
    >
      {props.children}
    </button>
  );
}

type RowHandlers = {
  onRowClick: (n: Node, e: React.MouseEvent) => void;
  onCopyPath: (n: Node) => void;
  onCopyRelative: (n: Node) => void;
  onReveal: (n: Node) => void;
  /** Installed editors for the "Open in…" submenu (empty ⇒ submenu hidden). */
  editors: EditorInfo[];
  onOpenInEditor: (n: Node, editorId: string) => void;
  onDelete: (n: Node) => void;
  onDeleteMany: (paths: string[]) => void;
  onRename: (n: Node) => void;
  onNewFile: (parent: string) => void;
  onNewFolder: (parent: string) => void;
  onSelectSplit?: (path: string, direction: "row" | "column") => void;
  /** Move the given paths into a destination folder (drag-and-drop). */
  onMoveInto: (paths: string[], destDir: string) => void;
  /** Paths under an in-flight drag — set by the dragged row, read by folder
   *  rows to validate + perform a drop. */
  dragPaths: React.MutableRefObject<string[]>;
};

function FlatList(props: {
  rows: Node[];
  selected: string | null;
  editor: EditorState;
  expandedSet: Set<string>;
  multiSelected: Set<string>;
  onEditorCommit: (v: string) => void;
  onEditorCancel: () => void;
} & RowHandlers) {
  // Splice in a placeholder row when we're creating something new.
  const display: Array<Node | { kind: "editor"; depth: number; mode: "new-file" | "new-folder" }> = [];
  for (const r of props.rows) {
    display.push(r);
    if (
      props.editor &&
      (props.editor.kind === "new-file" || props.editor.kind === "new-folder") &&
      r.is_dir &&
      r.path === props.editor.parent
    ) {
      display.push({ kind: "editor", depth: r.depth + 1, mode: props.editor.kind });
    }
  }
  // Root-level new (parent === root).
  const editor = props.editor;
  if (
    editor &&
    (editor.kind === "new-file" || editor.kind === "new-folder") &&
    !props.rows.some((r) => r.path === editor.parent)
  ) {
    display.unshift({ kind: "editor", depth: 0, mode: editor.kind });
  }
  return (
    <>
      {display.map((entry, i) => {
        if ("kind" in entry && entry.kind === "editor") {
          return (
            <EditorRow
              key={`editor-${i}`}
              depth={entry.depth}
              isFolder={entry.mode === "new-folder"}
              onCommit={props.onEditorCommit}
              onCancel={props.onEditorCancel}
            />
          );
        }
        const n = entry as Node;
        if (props.editor?.kind === "rename" && props.editor.path === n.path) {
          return (
            <EditorRow
              key={`rename-${n.path}`}
              depth={n.depth}
              isFolder={n.is_dir}
              initial={props.editor.initial}
              onCommit={props.onEditorCommit}
              onCancel={props.onEditorCancel}
            />
          );
        }
        return (
          <Row
            key={n.path}
            node={n}
            expanded={props.expandedSet.has(n.path)}
            selected={props.selected === n.path}
            multiSelected={props.multiSelected.has(n.path)}
            multiSelectedSet={props.multiSelected}
            handlers={props}
          />
        );
      })}
    </>
  );
}

function Row(props: {
  node: Node;
  expanded: boolean;
  selected: boolean;
  multiSelected: boolean;
  multiSelectedSet: Set<string>;
  handlers: RowHandlers;
}) {
  const { node, expanded, selected, multiSelected, multiSelectedSet, handlers } = props;
  const indent = node.depth * 12;
  const badge = statusBadge(node.git_status);
  const highlighted = selected || multiSelected;
  const inMultiGroup = multiSelected && multiSelectedSet.size > 1;
  const [dragOver, setDragOver] = useState(false);
  // Press bookkeeping so a drag gesture doesn't also open the file. `pressRef`
  // holds the mousedown point (to reject a click that turned into a drag);
  // `draggedRef` flips true the moment a native drag starts.
  const pressRef = useRef<{ x: number; y: number } | null>(null);
  const draggedRef = useRef(false);
  // What this row drags: the whole multi-selection if it's part of one,
  // otherwise just itself.
  const dragSet =
    multiSelected && multiSelectedSet.size > 0
      ? Array.from(multiSelectedSet)
      : [node.path];
  // A folder is a valid drop target unless every dragged path is itself,
  // a descendant of itself, or already a direct child of this folder.
  function canDropHere(): boolean {
    if (!node.is_dir) return false;
    const paths = handlers.dragPaths.current;
    return (
      paths.length > 0 &&
      paths.some(
        (p) =>
          p !== node.path &&
          !node.path.startsWith(p + "/") &&
          parentOf(p) !== node.path,
      )
    );
  }
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          draggable
          onDragStart={(e) => {
            draggedRef.current = true;
            handlers.dragPaths.current = dragSet;
            // Record the payload for the window-level in-app drop router — it
            // recovers the paths even when WKWebView strips the dataTransfer
            // mid-drag, so a drop onto the agent terminal / composer lands.
            beginInAppFileDrag(dragSet);
            // copyMove, not move: a folder reparent inside the tree is a
            // "move", but dropping onto the agent terminal / chat composer is
            // a "copy" (mention the path — the file isn't relocated). With
            // plain "move", those targets set dropEffect=copy and the browser
            // rejects the drop, so the row silently refuses to land there.
            e.dataTransfer.effectAllowed = "copyMove";
            try {
              e.dataTransfer.setData("text/plain", dragSet.join("\n"));
              // A single file also rides as a uri-list — the terminal + chat
              // drop targets read that first to recover the exact path.
              if (dragSet.length === 1) {
                e.dataTransfer.setData(
                  "text/uri-list",
                  "file://" + encodeURI(dragSet[0]),
                );
              }
            } catch {
              /* some platforms restrict setData — the ref carries the truth */
            }
          }}
          onDragEnd={() => {
            handlers.dragPaths.current = [];
            endInAppFileDrag();
            setDragOver(false);
          }}
          onDragOver={
            node.is_dir
              ? (e) => {
                  if (!canDropHere()) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                  if (!dragOver) setDragOver(true);
                }
              : undefined
          }
          onDragLeave={node.is_dir ? () => setDragOver(false) : undefined}
          onDrop={
            node.is_dir
              ? (e) => {
                  e.preventDefault();
                  const paths = handlers.dragPaths.current;
                  setDragOver(false);
                  handlers.dragPaths.current = [];
                  if (paths.length) handlers.onMoveInto(paths, node.path);
                }
              : undefined
          }
          // Open on mouse*up*, not mousedown. Opening on mousedown re-rendered
          // the tree the instant a drag began (onSelect → editor.open), which
          // aborted the native drag before it could carry the path anywhere —
          // so "drag a file out" just opened it. We arm on mousedown and open
          // on mouseup only when no drag happened and the pointer barely moved
          // (a genuine click). onRowClick reads alt/meta/shift off the mouseup
          // event, which carries the same modifiers, so split-open and
          // multi-select keep working. (macOS WKWebView suppresses the synthetic
          // `click` on draggable rows, so we can't rely on onClick — but mouseup
          // fires for a real click and is replaced by dragend during a drag.)
          onMouseDown={(e) => {
            if (e.button !== 0) return;
            draggedRef.current = false;
            pressRef.current = { x: e.clientX, y: e.clientY };
          }}
          onMouseUp={(e) => {
            if (e.button !== 0) return;
            const start = pressRef.current;
            pressRef.current = null;
            if (draggedRef.current) return; // a drag happened — don't open
            if (
              start &&
              Math.hypot(e.clientX - start.x, e.clientY - start.y) > 4
            )
              return; // moved too far for a click
            handlers.onRowClick(node, e);
          }}
          className={`flex items-center h-7 cursor-pointer text-[12.5px] ${
            dragOver
              ? "bg-accent/10 outline outline-1 -outline-offset-1 outline-accent"
              : highlighted
                ? "bg-bg-card"
                : "hover:bg-bg-hover"
          }`}
          style={{ paddingLeft: 8 + indent, paddingRight: 8 }}
          title={node.path}
        >
          {highlighted ? (
            <span
              className="bg-accent rounded-sm"
              style={{ width: 2, height: 16, marginRight: 6 }}
            />
          ) : (
            <span style={{ width: 2, marginRight: 6 }} />
          )}
          <span
            className="text-text-3 inline-flex items-center justify-center"
            style={{ width: 10, fontSize: 9 }}
          >
            {node.is_dir ? (expanded ? "▾" : "▸") : ""}
          </span>
          <span className="ml-1.5 mr-2 inline-flex items-center justify-center">
            {node.is_dir ? (
              <FolderGlyph open={expanded} />
            ) : (
              <FileIcon
                name={node.name}
                isDirectory={false}
                isOpen={false}
                size={14}
              />
            )}
          </span>
          <span
            className={`flex-1 truncate ${
              highlighted ? "text-text-1 font-medium" : "text-text-2"
            }`}
          >
            {node.name}
          </span>
          {badge}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-[200px]">
        {node.is_dir && (
          <>
            <ContextMenuItem onSelect={() => handlers.onNewFile(node.path)}>
              <FilePlus size={12} className="mr-2" /> New File
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => handlers.onNewFolder(node.path)}>
              <FolderPlus size={12} className="mr-2" /> New Folder
            </ContextMenuItem>
            <ContextMenuSeparator />
          </>
        )}
        {!node.is_dir && handlers.onSelectSplit && (
          <>
            <ContextMenuItem
              onSelect={() => handlers.onSelectSplit?.(node.path, "column")}
            >
              <Rows2 size={12} className="mr-2" /> Open in Split Below
            </ContextMenuItem>
            <ContextMenuItem
              onSelect={() => handlers.onSelectSplit?.(node.path, "row")}
            >
              <Columns2 size={12} className="mr-2" /> Open in Split Right
            </ContextMenuItem>
            <ContextMenuSeparator />
          </>
        )}
        <ContextMenuItem onSelect={() => handlers.onCopyPath(node)}>
          <Copy size={12} className="mr-2" /> Copy Path
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => handlers.onCopyRelative(node)}>
          <Copy size={12} className="mr-2" /> Copy Relative Path
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => handlers.onReveal(node)}>
          <Search size={12} className="mr-2" /> Reveal in Finder
        </ContextMenuItem>
        {handlers.editors.length > 0 && (
          <ContextMenuSub>
            <ContextMenuSubTrigger>
              <ExternalLink size={12} className="mr-2" /> Open in
            </ContextMenuSubTrigger>
            <ContextMenuSubContent className="min-w-[180px]">
              {handlers.editors.map((ed) => (
                <ContextMenuItem
                  key={ed.id}
                  onSelect={() => handlers.onOpenInEditor(node, ed.id)}
                >
                  {ed.name}
                </ContextMenuItem>
              ))}
            </ContextMenuSubContent>
          </ContextMenuSub>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => handlers.onRename(node)}>
          <Pencil size={12} className="mr-2" /> Rename
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={() => {
            if (inMultiGroup) handlers.onDeleteMany(Array.from(multiSelectedSet));
            else handlers.onDelete(node);
          }}
          className="text-red focus:text-red"
        >
          <Trash2 size={12} className="mr-2" />
          {inMultiGroup
            ? `Delete ${multiSelectedSet.size} items`
            : "Delete"}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function EditorRow(props: {
  depth: number;
  isFolder: boolean;
  initial?: string;
  onCommit: (v: string) => void;
  onCancel: () => void;
}) {
  const [v, setV] = useState(props.initial ?? "");
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    inputRef.current?.focus();
    if (props.initial) {
      // Select the basename (without extension) for renames.
      const dot = props.initial.lastIndexOf(".");
      const end = dot > 0 ? dot : props.initial.length;
      inputRef.current?.setSelectionRange(0, end);
    }
  }, [props.initial]);
  return (
    <div
      className="flex items-center h-7 text-[12.5px] bg-bg-card"
      style={{ paddingLeft: 8 + props.depth * 12, paddingRight: 8 }}
    >
      <span style={{ width: 2, marginRight: 6 }} />
      <span style={{ width: 10, marginRight: 0 }} />
      <span className="ml-1.5 mr-2 inline-flex items-center justify-center">
        {props.isFolder ? (
          <FolderGlyph open={false} />
        ) : (
          <FileIcon
            name={v || "newfile"}
            isDirectory={false}
            isOpen={false}
            size={14}
          />
        )}
      </span>
      <Input
        ref={inputRef}
        value={v}
        onChange={(e) => setV(e.target.value)}
        onBlur={() => (v.trim() ? props.onCommit(v) : props.onCancel())}
        onKeyDown={(e) => {
          if (e.key === "Enter") props.onCommit(v);
          else if (e.key === "Escape") props.onCancel();
        }}
        placeholder={props.isFolder ? "Folder name" : "File name"}
        className="h-6 flex-1 text-[12px] px-1.5"
      />
    </div>
  );
}

function statusBadge(status: string | null) {
  if (!status) return null;
  const map: Record<string, string> = {
    M: "text-amber",
    A: "text-green",
    "?": "text-text-4",
    D: "text-red",
  };
  const label: Record<string, string> = { M: "M", A: "A", "?": "U", D: "D" };
  return (
    <span
      className={`text-[10px] font-medium ${map[status] ?? "text-text-3"}`}
      style={{ width: 12, textAlign: "right" }}
    >
      {label[status] ?? "·"}
    </span>
  );
}

// Flat outline folder glyph — replaces the branded yellow material-icon
// folder for tree rows. Two variants: closed (single shape) and open
// (slightly lifted lid). Strokes inherit currentColor so the icon reads
// neutral in both light and dark themes.
function FolderGlyph({ open }: { open: boolean }) {
  if (open) {
    return (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
        <path
          d="M2 5.25V12.5a1 1 0 0 0 1 1h10.2a1 1 0 0 0 .96-.72l1.3-4.43A.6.6 0 0 0 14.88 7.5H4.5L3 8.7"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinejoin="round"
        />
        <path
          d="M2 5.25V4a1 1 0 0 1 1-1h2.5L7 4.5h5.5a1 1 0 0 1 1 1V7.5"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M2 4.5v8a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V5.5a1 1 0 0 0-1-1H7L5.5 3H3a1 1 0 0 0-1 1.5z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}
