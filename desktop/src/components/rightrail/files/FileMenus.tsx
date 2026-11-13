// The right-click menus of All files: one on each row — the file actions every
// file list shares, then what only this tree does (open beside, reveal in
// Finder, make, rename, delete) — and one on the space below the rows, for the
// project's top folder.
//
// Anything that takes focus (a name field, a confirmation) runs once the menu
// has closed and handed focus back, or the menu's own focus return would blur
// it the moment it opened.

import type { ReactNode } from "react";
import {
  ChevronsDownUp,
  Columns2,
  FilePlus,
  FolderPlus,
  FolderSearch,
  Pencil,
  RefreshCw,
  Rows2,
  Trash2,
} from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "../../ui/context-menu";
import { useAfterMenuClose } from "../../ui/after-menu-close";
import { FileMenuItems, type FileActions } from "../../ui/file-actions-menu";

export type FileRowActions = FileActions & {
  onSplitBelow?: () => void;
  onSplitRight?: () => void;
  onReveal?: () => void;
  onNewFile?: () => void;
  onNewFolder?: () => void;
  onRename?: () => void;
  onDelete?: () => void;
  /** "Delete", or "Delete 3 items" when the row is part of a selection. */
  deleteLabel?: string;
};

export function FileRowMenu({
  children,
  onSplitBelow,
  onSplitRight,
  onReveal,
  onNewFile,
  onNewFolder,
  onRename,
  onDelete,
  deleteLabel = "Delete",
  onDiscard,
  ...shared
}: FileRowActions & { children: ReactNode }) {
  const { later, onCloseAutoFocus } = useAfterMenuClose();
  const opens = onSplitBelow || onSplitRight || onReveal;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent onCloseAutoFocus={onCloseAutoFocus}>
        <FileMenuItems {...shared} onDiscard={later(onDiscard)} />
        {opens && <ContextMenuSeparator />}
        {onSplitBelow && (
          <ContextMenuItem onSelect={onSplitBelow}>
            <Rows2 />
            Open in split below
          </ContextMenuItem>
        )}
        {onSplitRight && (
          <ContextMenuItem onSelect={onSplitRight}>
            <Columns2 />
            Open in split right
          </ContextMenuItem>
        )}
        {onReveal && (
          <ContextMenuItem onSelect={onReveal}>
            <FolderSearch />
            Reveal in Finder
          </ContextMenuItem>
        )}
        {(onNewFile || onNewFolder) && <ContextMenuSeparator />}
        {onNewFile && (
          <ContextMenuItem onSelect={later(onNewFile)}>
            <FilePlus />
            New file
          </ContextMenuItem>
        )}
        {onNewFolder && (
          <ContextMenuItem onSelect={later(onNewFolder)}>
            <FolderPlus />
            New folder
          </ContextMenuItem>
        )}
        {(onRename || onDelete) && <ContextMenuSeparator />}
        {onRename && (
          <ContextMenuItem onSelect={later(onRename)}>
            <Pencil />
            Rename
          </ContextMenuItem>
        )}
        {onDelete && (
          <ContextMenuItem className="ui-menu-danger" onSelect={later(onDelete)}>
            <Trash2 />
            {deleteLabel}
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** The menu on the empty space under the rows: the verbs for the top folder. */
export function FilesSpaceMenu({
  children,
  onNewFile,
  onNewFolder,
  onCollapseAll,
  onRefresh,
}: {
  children: ReactNode;
  onNewFile: () => void;
  onNewFolder: () => void;
  onCollapseAll: () => void;
  onRefresh: () => void;
}) {
  const { later, onCloseAutoFocus } = useAfterMenuClose();
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent onCloseAutoFocus={onCloseAutoFocus}>
        <ContextMenuItem onSelect={later(onNewFile)}>
          <FilePlus />
          New file
        </ContextMenuItem>
        <ContextMenuItem onSelect={later(onNewFolder)}>
          <FolderPlus />
          New folder
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={onCollapseAll}>
          <ChevronsDownUp />
          Collapse all folders
        </ContextMenuItem>
        <ContextMenuItem onSelect={onRefresh}>
          <RefreshCw />
          Refresh
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
