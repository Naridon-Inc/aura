// Dragging rows: into a folder to move them, or out onto a terminal or the
// chat box to hand over their paths.
//
// A row opens on mouse *up*. Opening on mouse down re-rendered the tree the
// instant a drag began, which aborted the drag before it carried the path
// anywhere — so "drag a file out" just opened it. The webview also swallows
// the click on a draggable row now and then, so the release opens the row and
// the click that may follow it is ignored; a click with no release before it
// (a screen reader's, say) still opens the row.
//
// The row stays an HTML5 drag, not a pointer drag: an HTML5 drag can leave the
// window and hand its path to another app, which a pointer drag never can. The
// desktop app's web view never delivers that drag's `dragover` or `drop`, so
// neither the move into a folder nor the hand-over to a terminal is landed by
// the row it ends on: the window's drop router (lib/osFileDrop.ts) lands both
// from wherever the release is reported, and folders are marked
// `data-file-move-dir` for it to find.

import { useRef, useState, type HTMLAttributes, type MouseEvent } from "react";
import { beginInAppFileDrag, endInAppFileDrag } from "../../../lib/osFileDrop";
import type { FileTreeNode } from "../../ui/file-tree";
import { canMoveInto } from "./fileNodes";

type RowAttributes = HTMLAttributes<HTMLDivElement> & Record<`data-${string}`, string | undefined>;

/** Farther than this between press and release is a drag, not a click. */
const CLICK_SLOP_PX = 4;

export function useRowDrag({
  dragSet,
  onMove,
  onActivate,
}: {
  /** What a drag that starts on `path` picks up: the whole selection when the
   *  row is part of it, otherwise the row alone. */
  dragSet: (path: string) => string[];
  onMove: (paths: string[], destDir: string) => void;
  onActivate: (node: FileTreeNode, event: MouseEvent<HTMLDivElement>) => void;
}) {
  const press = useRef<{ x: number; y: number } | null>(null);
  const dragged = useRef(false);
  const released = useRef<{ id: string; at: number } | null>(null);
  // The move a drop lands is the one this render was handed, not the one the
  // drag started under.
  const latestMove = useRef(onMove);
  latestMove.current = onMove;
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  const rowProps = (node: FileTreeNode): RowAttributes => {
    const folder = node.children !== undefined;
    return {
      draggable: true,
      "data-drop-target": dropTarget === node.id ? "" : undefined,
      "data-file-move-dir": folder ? node.id : undefined,
      onDragStart: (event) => {
        dragged.current = true;
        const paths = dragSet(node.id);
        // Recorded for the window's drop router, which lands the drop: the
        // webview can strip the drag's data mid-flight, and a drop on a
        // folder, the terminal or the chat box still has to land.
        beginInAppFileDrag(paths, {
          accepts: (dir) => canMoveInto(paths, dir),
          into: (dir) => {
            setDropTarget(null);
            if (paths.length > 0) latestMove.current(paths, dir);
          },
          hover: (dir) => setDropTarget(dir),
        });
        // A move inside the tree, a copy (of the path) everywhere else.
        event.dataTransfer.effectAllowed = "copyMove";
        try {
          event.dataTransfer.setData("text/plain", paths.join("\n"));
          if (paths.length === 1)
            event.dataTransfer.setData("text/uri-list", "file://" + encodeURI(paths[0]));
        } catch {
          /* some platforms restrict setData — the ref carries the paths */
        }
      },
      onDragEnd: () => {
        endInAppFileDrag();
        setDropTarget(null);
      },
      onMouseDown: (event) => {
        if (event.button !== 0) return;
        dragged.current = false;
        press.current = { x: event.clientX, y: event.clientY };
      },
      onMouseUp: (event) => {
        if (event.button !== 0) return;
        const start = press.current;
        press.current = null;
        if (dragged.current) return;
        if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > CLICK_SLOP_PX)
          return;
        released.current = { id: node.id, at: event.timeStamp };
        onActivate(node, event);
      },
    };
  };

  /** The tree's click: ignored when the release just before it opened the row. */
  const onRowClick = (node: FileTreeNode, event: MouseEvent<HTMLDivElement>) => {
    const last = released.current;
    released.current = null;
    if (last && last.id === node.id && event.timeStamp - last.at < 1000) return;
    onActivate(node, event);
  };

  return { rowProps, onRowClick };
}
