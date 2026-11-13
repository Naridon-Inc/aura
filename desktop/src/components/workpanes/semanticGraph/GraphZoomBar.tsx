// The Code Map canvas's floating zoom bar: scale, zoom, fit, reset, and the
// layout verbs (restart, unpin). Library ghost buttons on the quiet sheet.

import type { ReactNode } from "react";
import {
  Crosshair,
  Maximize2,
  Minus,
  PinOff,
  Plus,
  RefreshCcw,
  RotateCcw,
} from "lucide-react";
import { Button } from "../../ui/button";

/** The canvas's own controls, floating bottom-left: zoom, fit, reset, and
 *  the layout verbs. Library ghost buttons on the quiet sheet. */
export function GraphZoomBar({
  scale,
  pinnedCount,
  onReset,
  onFit,
  onFitSelected,
  onZoomIn,
  onZoomOut,
  onReheat,
  onUnpinAll,
}: {
  scale: number;
  pinnedCount: number;
  onReset: () => void;
  onFit: () => void;
  onFitSelected?: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onReheat: () => void;
  onUnpinAll: () => void;
}) {
  const tool = (title: string, icon: ReactNode, onClick?: () => void) => (
    <Button
      variant="ghost"
      size="iconXs"
      type="button"
      title={title}
      aria-label={title}
      disabled={!onClick}
      onClick={onClick}
    >
      {icon}
    </Button>
  );
  return (
    <div className="ui-graph-zoom">
      <span className="ui-graph-zoom-scale">{Math.round(scale * 100)}%</span>
      {tool("Zoom out", <Minus />, onZoomOut)}
      {tool("Zoom in", <Plus />, onZoomIn)}
      <span className="ui-graph-zoom-rule" />
      {tool("Fit graph", <Maximize2 />, onFit)}
      {tool("Fit selection", <Crosshair />, onFitSelected)}
      {tool("Reset pan and zoom", <RotateCcw />, onReset)}
      <span className="ui-graph-zoom-rule" />
      {tool("Restart layout", <RefreshCcw />, onReheat)}
      {tool("Unpin all pieces", <PinOff />, pinnedCount > 0 ? onUnpinAll : undefined)}
      {pinnedCount > 0 && <span className="ui-graph-zoom-pinned">{pinnedCount}</span>}
    </div>
  );
}
