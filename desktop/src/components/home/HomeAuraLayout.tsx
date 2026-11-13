// Home with Aura docked on its right: Home's list keeps the room it needs and
// the panel takes a width you can drag, bounded against the row it sits in so
// the list is never squeezed to a sliver on a narrow window.

import { useRef, type ReactNode } from "react";
import { ResizablePane, fitMax, useMeasuredWidth } from "../ui/resizable";
import {
  AURA_PANEL_BODY_MIN,
  AURA_PANEL_MAX,
  AURA_PANEL_MIN,
} from "../../lib/homeAuraPanel";
import "./home-aura-panel.css";

export function HomeAuraLayout({
  home,
  panel,
  shown,
  width,
  onResize,
}: {
  home: ReactNode;
  panel: ReactNode;
  shown: boolean;
  width: number;
  onResize: (next: number) => void;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  const rowWidth = useMeasuredWidth(rowRef);
  const max = fitMax(rowWidth, AURA_PANEL_BODY_MIN, AURA_PANEL_MIN, AURA_PANEL_MAX);
  return (
    <div ref={rowRef} className="home-aura-row">
      <div className="home-aura-row__body">{home}</div>
      {shown && (
        <ResizablePane
          edge="trailing"
          size={width}
          min={AURA_PANEL_MIN}
          max={max}
          onResize={onResize}
          label="Resize Aura"
          className="home-aura-row__pane"
        >
          {panel}
        </ResizablePane>
      )}
    </div>
  );
}
