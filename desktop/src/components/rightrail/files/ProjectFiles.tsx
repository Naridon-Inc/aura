// All files: the whole project as the file tree, with git's mark and line
// counts on every changed file. Folders are read as they open. The filter box
// above the tabs narrows it to matching names across the whole project, not
// just the folders already open; Enter there looks for the words inside the
// files instead.
//
// A click opens; Option-click opens beside the current file; Command-click and
// Shift-click pick several rows to drag or delete together. Rows drag into a
// folder to move, or out onto a terminal or the chat box. Everything else is
// on the right-click menus: the row's, and the one on the space below the rows
// for the project's top folder.

import { useEffect, useMemo, useState, type MouseEvent, type ReactNode } from "react";
import { useDebouncedValue } from "../../../lib/useDebouncedValue";
import { useGitChanges, useGitChangesMany } from "../../../lib/useGitChanges";
import { useNestedRepos } from "../../../lib/nestedRepos";
import { needsPolling } from "../../../lib/place/workApi";
import { FileTree, type FileTreeNode } from "../../ui/file-tree";
import { DetailsCaption } from "../../ui/details-panel";
import { ErrorState, LoadingState } from "../../ui/state";
import { useRailFilter } from "../railFilter";
import {
  NEW_ENTRY_ID,
  SEARCH_LIMIT,
  changeMap,
  filterNodes,
  folderIds,
  hitTree,
  listingNodes,
  rankHits,
  relativeTo,
  visibleIds,
  withNestedChanges,
  withNewEntry,
} from "./fileNodes";
import { FileNameField } from "./FileNameField";
import { FileRowMenu, FilesSpaceMenu } from "./FileMenus";
import { useDirListings } from "./useDirListings";
import { useEditors, useFileActions } from "./useFileActions";
import { useProjectIndex } from "./useProjectIndex";
import { useRowDrag } from "./useRowDrag";
import "../../ui/details-files.css";

export type ProjectFilesProps = {
  root: string;
  selected: string | null;
  onSelect: (path: string) => void;
  /** Open `path` in a split beside the current file. Without it, Option-click
   *  and the split items open it plainly. */
  onSelectSplit?: (path: string, direction: "row" | "column") => void;
  /** The name filter. Omitted, the rail's filter box is read. */
  filter?: string;
};

/** A row being named: an existing one renamed, or a new one being made. */
type Naming =
  | { kind: "rename"; path: string }
  | { kind: "new"; parent: string; folder: boolean }
  | null;

export function ProjectFiles({ root, selected, onSelect, onSelectSplit, filter }: ProjectFilesProps) {
  const railFilter = useRailFilter();
  const typed = (filter ?? railFilter).trim();
  const needle = useDebouncedValue(typed, 120).toLowerCase();
  const remote = needsPolling(root);
  const dirs = useDirListings(root);
  const git = useGitChanges(root);
  // Separate repositories inside the project report their own changes.
  const nestedRepos = useNestedRepos(root);
  const nestedRoots = useMemo(() => nestedRepos.map((r) => r.root), [nestedRepos]);
  const nestedGit = useGitChangesMany(nestedRoots);
  const changes = useMemo(
    () =>
      withNestedChanges(
        changeMap(git),
        nestedRepos.flatMap((r) => {
          const g = nestedGit.get(r.root);
          return g ? [{ rel: r.rel_path, git: g }] : [];
        }),
      ),
    [git.staged, git.unstaged, git.untracked, nestedRepos, nestedGit],
  );
  const projectIndex = useProjectIndex(root, needle !== "");
  const editors = useEditors(!remote);
  const [naming, setNaming] = useState<Naming>(null);
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  // Filtering opens every folder with a match; these are the ones closed since.
  const [closedInFilter, setClosedInFilter] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => setClosedInFilter(new Set()), [needle]);
  useEffect(() => {
    setNaming(null);
    setPicked(new Set());
    setAnchor(null);
  }, [root]);

  const actions = useFileActions({
    root,
    selected,
    onSelect,
    relist: dirs.relist,
    relistAll: dirs.relistAll,
    open: (dir) => dirs.setOpen(dir, true),
    afterChange: () => {
      projectIndex.reset();
      git.refresh();
    },
  });
  const refresh = () => {
    projectIndex.reset();
    git.refresh();
    void dirs.relistAll();
  };

  const tree = useMemo(
    () => listingNodes(root, dirs.listings, changes),
    [root, dirs.listings, changes],
  );
  const { index } = projectIndex;
  const search = useMemo(() => {
    if (!needle) return null;
    if (index === null) return { nodes: [] as FileTreeNode[], total: 0, waiting: true };
    // No index (not a git repo): filter what has been read.
    if (index.length === 0) return { nodes: filterNodes(tree, needle), total: 0, waiting: false };
    const { hits, total } = rankHits(index, needle);
    return { nodes: hitTree(root, hits, changes), total, waiting: false };
  }, [needle, index, tree, root, changes]);

  const shown = search ? search.nodes : tree;
  const nodes = useMemo(
    () => (naming?.kind === "new" ? withNewEntry(shown, naming.parent, naming.folder) : shown),
    [shown, naming],
  );
  const expanded = useMemo(() => {
    const open = search
      ? new Set(folderIds(search.nodes).filter((id) => !closedInFilter.has(id)))
      : new Set(dirs.expanded);
    if (naming?.kind === "new") open.add(naming.parent);
    return open;
  }, [search, closedInFilter, dirs.expanded, naming]);

  const setFolderOpen = (id: string, open: boolean) => {
    if (id === NEW_ENTRY_ID) return;
    if (search)
      setClosedInFilter((prev) => {
        const next = new Set(prev);
        if (open) next.delete(id);
        else next.add(id);
        return next;
      });
    else dirs.setOpen(id, open);
  };

  const startNew = (parent: string, folder: boolean) => {
    if (parent !== root) dirs.setOpen(parent, true);
    setNaming({ kind: "new", parent, folder });
  };

  const editing = (id: string) =>
    id === NEW_ENTRY_ID || (naming?.kind === "rename" && naming.path === id);

  const activate = (node: FileTreeNode, event: MouseEvent<HTMLDivElement>) => {
    if (editing(node.id)) return;
    const folder = node.children !== undefined;
    if (event.altKey && !folder && onSelectSplit) {
      event.preventDefault();
      onSelectSplit(node.id, "column");
      return;
    }
    if (event.metaKey || event.ctrlKey) {
      event.preventDefault();
      setPicked((prev) => {
        const next = new Set(prev);
        if (next.has(node.id)) next.delete(node.id);
        else next.add(node.id);
        // The open file joins a selection started beside it.
        if (selected && next.size > 0 && !next.has(selected)) next.add(selected);
        return next;
      });
      setAnchor(node.id);
      return;
    }
    if (event.shiftKey && anchor) {
      const order = visibleIds(nodes, expanded);
      const from = order.indexOf(anchor);
      const to = order.indexOf(node.id);
      if (from >= 0 && to >= 0) {
        setPicked(new Set(order.slice(Math.min(from, to), Math.max(from, to) + 1)));
        return;
      }
    }
    setPicked(new Set());
    setAnchor(node.id);
    if (folder) setFolderOpen(node.id, !expanded.has(node.id));
    else onSelect(node.id);
  };

  const drag = useRowDrag({
    dragSet: (path) => (picked.has(path) ? [...picked] : [path]),
    onMove: (paths, destDir) => {
      setPicked(new Set());
      void actions.move(paths, destDir);
    },
    onActivate: activate,
  });

  const rowProps = (node: FileTreeNode) =>
    editing(node.id)
      ? { draggable: false }
      : {
          ...drag.rowProps(node),
          title: node.id,
          "aria-selected": selected === node.id || picked.has(node.id),
        };

  const renderName = (node: FileTreeNode): ReactNode => {
    if (node.id === NEW_ENTRY_ID && naming?.kind === "new") {
      const { parent, folder } = naming;
      return (
        <FileNameField
          folder={folder}
          onCommit={(name) => {
            setNaming(null);
            void actions.create(parent, name, folder);
          }}
          onCancel={() => setNaming(null)}
        />
      );
    }
    if (naming?.kind === "rename" && naming.path === node.id)
      return (
        <FileNameField
          initial={node.name}
          folder={node.children !== undefined}
          onCommit={(name) => {
            setNaming(null);
            void actions.rename(node.id, name);
          }}
          onCancel={() => setNaming(null)}
        />
      );
    return node.name;
  };

  const wrapRow = (node: FileTreeNode, row: ReactNode): ReactNode => {
    if (node.id === NEW_ENTRY_ID) return row;
    const folder = node.children !== undefined;
    const path = node.id;
    const change = folder ? undefined : changes.get(relativeTo(root, path));
    const group = picked.has(path) && picked.size > 1;
    const split = !folder && onSelectSplit ? onSelectSplit : undefined;
    return (
      <FileRowMenu
        onView={folder ? undefined : () => onSelect(path)}
        onAttach={folder ? undefined : () => actions.attach(path)}
        applications={editors.map((app) => ({
          id: app.id,
          label: app.name,
          onOpen: () => actions.openIn(path, app.id),
        }))}
        onCopyPath={() => actions.copyPath(path)}
        onCopyRelativePath={() => actions.copyRelativePath(path)}
        onDiscard={change?.discardable ? () => void actions.discard(path, change.untracked) : undefined}
        onSplitBelow={split && (() => split(path, "column"))}
        onSplitRight={split && (() => split(path, "row"))}
        onReveal={remote ? undefined : () => actions.reveal(path)}
        onNewFile={folder ? () => startNew(path, false) : undefined}
        onNewFolder={folder ? () => startNew(path, true) : undefined}
        onRename={() => setNaming({ kind: "rename", path })}
        onDelete={() => void actions.remove(group ? [...picked] : [path], !group && folder)}
        deleteLabel={group ? `Delete ${picked.size} items` : "Delete"}
      >
        {row}
      </FileRowMenu>
    );
  };

  let body: ReactNode;
  if (dirs.loading) body = <LoadingState label="Reading the files…" />;
  else if (dirs.error)
    body = (
      <ErrorState size="sm" title="Couldn't read the files" message={dirs.error} onRetry={refresh} />
    );
  else if (search?.waiting) body = <LoadingState label="Searching the repository…" />;
  else if (nodes.length === 0)
    body = search ? (
      <DetailsCaption>
        No file is named “{typed}”. This looks at file and folder names; press Enter to look for
        the words inside your files.
      </DetailsCaption>
    ) : (
      <DetailsCaption>Nothing here yet. Right-click to make a file or a folder.</DetailsCaption>
    );
  else
    body = (
      <FileTree
        nodes={nodes}
        selected={selected ?? undefined}
        onSelect={(node) => {
          if (!editing(node.id)) onSelect(node.id);
        }}
        expanded={expanded}
        onExpandedChange={(_next, node, open) => setFolderOpen(node.id, open)}
        onRowClick={drag.onRowClick}
        rowProps={rowProps}
        renderName={renderName}
        wrapRow={wrapRow}
      />
    );

  return (
    <FilesSpaceMenu
      onNewFile={() => startNew(root, false)}
      onNewFolder={() => startNew(root, true)}
      onCollapseAll={() => {
        dirs.collapseAll();
        if (search) setClosedInFilter(new Set(folderIds(search.nodes)));
      }}
      onRefresh={refresh}
    >
      <div className="ui-details-files">
        {actions.problem && (
          <div role="alert" className="ui-details-files-problem">
            {actions.problem}
          </div>
        )}
        {body}
        {search && search.total > SEARCH_LIMIT && (
          <DetailsCaption>
            Showing the closest {SEARCH_LIMIT} of {search.total} matches. Type more of the name to
            narrow it down.
          </DetailsCaption>
        )}
      </div>
    </FilesSpaceMenu>
  );
}
