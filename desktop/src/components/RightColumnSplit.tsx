// The right column's two halves: the git panel on top and the terminal panel
// under it, split 50/50 by default with the split remembered per workspace.
// The terminal panel never goes under a fifth of the column while open, and
// collapses to its 32px header; maximized, it takes the whole column.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { ResizablePane } from "./ui/resizable";

/** The terminal panel's share of the column when nothing was remembered. */
export const SCRIPTS_DEFAULT_SHARE = 0.5;
/** The least share it keeps while open. */
export const SCRIPTS_MIN_SHARE = 0.2;
/** Its header, all that shows while collapsed. */
export const SCRIPTS_COLLAPSED_PX = 32;

const KEY_PREFIX = "aura.rightPanels.scripts:";

/** The share a stored value stands for: a number between the minimum and the
 *  whole column, or the default for anything else. */
export function parseScriptsShare(raw: string | null): number {
  const n = raw === null ? NaN : Number(raw);
  if (!Number.isFinite(n)) return SCRIPTS_DEFAULT_SHARE;
  return Math.min(1, Math.max(SCRIPTS_MIN_SHARE, n));
}

function readShare(key: string): number {
  try {
    return parseScriptsShare(localStorage.getItem(KEY_PREFIX + key));
  } catch {
    return SCRIPTS_DEFAULT_SHARE;
  }
}

function writeShare(key: string, share: number): void {
  try {
    localStorage.setItem(KEY_PREFIX + key, String(share));
  } catch {
    /* best-effort */
  }
}

export function RightColumnSplit({
  top,
  bottom,
  open,
  maximized,
  storageKey,
}: {
  top: ReactNode;
  bottom: ReactNode;
  /** False while the terminal panel is collapsed to its header. */
  open: boolean;
  maximized: boolean;
  /** Which workspace's split this is. */
  storageKey: string;
}) {
  const colRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);
  const [share, setShare] = useState(() => readShare(storageKey));

  useEffect(() => {
    setShare(readShare(storageKey));
  }, [storageKey]);

  useEffect(() => {
    const el = colRef.current;
    if (!el) return;
    const measure = () => setHeight(el.clientHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const fill = open && maximized;
  return (
    <div ref={colRef} className="flex flex-1 min-h-0 flex-col overflow-hidden">
      <div className={fill ? "hidden" : "flex-1 min-h-0 overflow-hidden"}>{top}</div>
      {fill ? (
        <div className="flex-1 min-h-0 overflow-hidden border-t border-line-soft">{bottom}</div>
      ) : open && height > 0 ? (
        <ResizablePane
          orientation="horizontal"
          edge="trailing"
          size={Math.round(share * height)}
          min={Math.round(SCRIPTS_MIN_SHARE * height)}
          max={height}
          onResize={(px) => {
            const next = parseScriptsShare(String(px / height));
            setShare(next);
            writeShare(storageKey, next);
          }}
          label="Resize terminal panel"
          className="overflow-hidden border-t border-line-soft"
        >
          {bottom}
        </ResizablePane>
      ) : (
        <div
          className="flex-shrink-0 overflow-hidden border-t border-line-soft"
          style={{ height: open ? "50%" : SCRIPTS_COLLAPSED_PX }}
        >
          {bottom}
        </div>
      )}
    </div>
  );
}
