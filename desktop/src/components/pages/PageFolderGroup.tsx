// PageFolderGroup — one collapsible folder in the Pages sidebar. Renders a
// filled, color-tinted Folder glyph (the tinted-folder look from a file app),
// the folder name, a page count, and a chevron; the folder's pages render
// nested beneath it via the `children` render-prop so this component stays
// decoupled from how a page row looks. A compact hover/right-click menu offers
// Rename, a color swatch grid, and Delete (pages move to root, never deleted).
//
// Drag target: dropping a dragged page onto the folder header files that page
// into this folder (the parent owns the actual move). The whole header is a
// native HTML5 drop zone, matching the sidebar's existing drag-to-reparent.

import { useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Folder,
  MoreHorizontal,
  Pencil,
  Trash2,
  Palette,
} from "lucide-react";
import { cn } from "../../lib/utils";
import { MENU_PANEL, MENU_ROW, MENU_ROW_DANGER, MENU_SEP } from "../ui/menuSurface";
import type { Folder as PageFolder } from "../../lib/api";
import { folderTint, folderSoftBg } from "../pages2/folderColors";
import { FolderColorPopover } from "./FolderColorPopover";

type Props = {
  folder: PageFolder;
  /** Number of pages inside, shown as a muted count. */
  count: number;
  expanded: boolean;
  onToggle: () => void;
  /** True while a page is being dragged over this header (drop highlight). */
  isDropTarget: boolean;
  onDragOver: () => void;
  onDrop: () => void;
  onRename: (name: string) => void;
  onSetColor: (token: string) => void;
  onDelete: () => void;
  /** Child page rows, rendered nested under the folder when expanded. */
  children: React.ReactNode;
};

export function PageFolderGroup({
  folder,
  count,
  expanded,
  onToggle,
  isDropTarget,
  onDragOver,
  onDrop,
  onRename,
  onSetColor,
  onDelete,
  children,
}: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState(folder.name);
  const [colorOpen, setColorOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (renaming) {
      setDraftName(folder.name);
      // Focus + select on the next frame so the input is mounted.
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [renaming, folder.name]);

  // Close the kebab menu / color popover on outside click.
  useEffect(() => {
    if (!menuOpen) return;
    function onDown(e: MouseEvent) {
      if (!menuRef.current?.contains(e.target as Node)) {
        setMenuOpen(false);
        setColorOpen(false);
      }
    }
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [menuOpen]);

  const tint = folderTint(folder.color);

  const commitRename = () => {
    const next = draftName.trim();
    if (next && next !== folder.name) onRename(next);
    setRenaming(false);
  };

  return (
    <div className="mb-0.5">
      <div
        role="treeitem"
        aria-expanded={expanded}
        onDragOver={(e) => {
          // Allow a page drop onto the folder header.
          e.preventDefault();
          e.stopPropagation();
          e.dataTransfer.dropEffect = "move";
          onDragOver();
        }}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onDrop();
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenuOpen(true);
        }}
        className={cn(
          "group relative h-7 flex items-center gap-1 rounded-md text-[12px] cursor-pointer select-none transition-colors",
          "text-text-1 hover:bg-bg-2",
          isDropTarget && "ring-1 ring-inset ring-accent",
        )}
        style={{
          paddingLeft: 6,
          paddingRight: 6,
          background: expanded ? folderSoftBg(folder.color) : undefined,
        }}
        onClick={() => !renaming && onToggle()}
      >
        <span
          className="w-3 h-3 grid place-items-center flex-shrink-0 text-text-5"
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
        >
          {expanded ? (
            <ChevronDown className="w-3 h-3" strokeWidth={1.75} aria-hidden />
          ) : (
            <ChevronRight className="w-3 h-3" strokeWidth={1.75} aria-hidden />
          )}
        </span>
        <Folder
          className="w-[15px] h-[15px] flex-shrink-0"
          style={{ color: tint, fill: tint }}
          strokeWidth={1.5}
          aria-hidden
        />
        {renaming ? (
          <input
            ref={inputRef}
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitRename();
              else if (e.key === "Escape") setRenaming(false);
            }}
            onBlur={commitRename}
            className="flex-1 min-w-0 bg-bg-1 border border-line-default rounded px-1 py-0 text-[12px] text-text-1 outline-none"
          />
        ) : (
          <span className="flex-1 min-w-0 truncate font-medium">
            {folder.name}
          </span>
        )}
        {!renaming && count > 0 && (
          <span className="text-[10px] text-text-5 tabular-nums group-hover:hidden">
            {count}
          </span>
        )}
        <button
          type="button"
          title="Folder actions"
          onClick={(e) => {
            e.stopPropagation();
            setMenuOpen((v) => !v);
          }}
          className="opacity-0 group-hover:opacity-100 w-5 h-5 grid place-items-center rounded text-text-4 hover:text-text-1 hover:bg-bg-3 flex-shrink-0"
        >
          <MoreHorizontal className="w-3.5 h-3.5" strokeWidth={1.75} aria-hidden />
        </button>

        {menuOpen && (
          <div
            ref={menuRef}
            role="menu"
            className={cn(MENU_PANEL, "absolute right-1 top-7 w-[180px]")}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              className={MENU_ROW}
              onClick={() => {
                setMenuOpen(false);
                setRenaming(true);
              }}
            >
              <Pencil className="w-3.5 h-3.5" strokeWidth={1.5} aria-hidden />
              Rename
            </button>
            <button
              type="button"
              className={MENU_ROW}
              onClick={() => setColorOpen((v) => !v)}
            >
              <Palette className="w-3.5 h-3.5" strokeWidth={1.5} aria-hidden />
              <span className="flex-1 text-left">Color</span>
              <span
                className="w-3 h-3 rounded-full flex-shrink-0"
                style={{ background: tint }}
                aria-hidden
              />
            </button>
            {colorOpen && (
              <FolderColorPopover
                value={folder.color}
                onPick={(token) => {
                  onSetColor(token);
                  setColorOpen(false);
                  setMenuOpen(false);
                }}
              />
            )}
            <div className={MENU_SEP} />
            <button
              type="button"
              className={cn(MENU_ROW, MENU_ROW_DANGER)}
              onClick={() => {
                setMenuOpen(false);
                onDelete();
              }}
            >
              <Trash2 className="w-3.5 h-3.5" strokeWidth={1.5} aria-hidden />
              Delete folder
            </button>
          </div>
        )}
      </div>
      {expanded && children}
    </div>
  );
}
