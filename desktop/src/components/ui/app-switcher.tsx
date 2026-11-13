// The app switcher's panel: a glass strip of app tiles in the middle of the
// window, the selected one ringed and named underneath, Close last.
//
// Drawn from the shared store's state by AppSwitcherHost, which owns the keys
// and the opening. Hovering a tile selects it only once the pointer has
// moved, so a cursor already resting where the panel appears picks nothing.

import { useEffect, useState } from "react";
import { FolderOpen, SquareCode, X } from "lucide-react";

import {
  CLOSE_TILE,
  FILE_MANAGER,
  SWITCHER_COLUMN,
  SWITCHER_PAD_X,
  SWITCHER_PAD_Y,
  SWITCHER_TILE,
  captionInsets,
  type SwitcherEntry,
} from "../../lib/appSwitcher";
import "./app-switcher.css";

export type AppSwitcherProps = {
  entries: SwitcherEntry[];
  selected: number;
  /** Past the reveal delay: draw the panel. */
  visible: boolean;
  /** PNG data URLs of the apps' own icons, by id. */
  icons: Record<string, string>;
  onSelect: (index: number) => void;
  onOpen: (index: number) => void;
  onCancel: () => void;
};

function useMovedPointer(visible: boolean): boolean {
  const [moved, setMoved] = useState(false);
  useEffect(() => {
    if (!visible) {
      setMoved(false);
      return;
    }
    const onMove = () => setMoved(true);
    document.addEventListener("mousemove", onMove, { once: true });
    return () => document.removeEventListener("mousemove", onMove);
  }, [visible]);
  return moved;
}

function AppTileIcon({ entry, icon }: { entry: SwitcherEntry; icon?: string }) {
  if (icon) return <img className="ui-app-switcher-icon" src={icon} alt="" draggable={false} />;
  const Mark = entry.id === FILE_MANAGER ? FolderOpen : SquareCode;
  return <Mark className="ui-app-switcher-mark" aria-hidden />;
}

function CloseTile({ selected }: { selected: boolean }) {
  return (
    <div className="ui-app-switcher-close" data-selected={selected || undefined}>
      <X strokeWidth={2} aria-hidden />
    </div>
  );
}

export function AppSwitcher({ entries, selected, visible, icons, onSelect, onOpen, onCancel }: AppSwitcherProps) {
  const moved = useMovedPointer(visible);
  const [settling, setSettling] = useState(false);
  if (!visible || entries.length === 0) return null;

  const count = entries.length;
  const width = count * SWITCHER_COLUMN + SWITCHER_PAD_X * 2;
  const height = SWITCHER_PAD_Y * 2 + SWITCHER_TILE;
  const current = entries[selected];
  const caption = captionInsets(selected, count);

  return (
    <div className="ui-app-switcher" style={{ pointerEvents: settling ? "none" : "auto" }}>
      <div className="ui-app-switcher-glass" style={{ width, height }} aria-hidden />
      <div
        className="ui-app-switcher-panel"
        role="listbox"
        aria-label="Open in"
        aria-activedescendant={current ? `app-switcher-${current.id}` : undefined}
        style={{ width, height }}
        onAnimationStart={() => setSettling(true)}
        onAnimationEnd={() => setSettling(false)}
      >
        <div className="ui-app-switcher-grid" style={{ gridTemplateColumns: `repeat(${count}, ${SWITCHER_COLUMN}px)` }}>
          {entries.map((entry, i) => {
            const isClose = entry.id === CLOSE_TILE;
            const on = i === selected;
            return (
              <div
                key={entry.id}
                id={`app-switcher-${entry.id}`}
                role="option"
                aria-selected={on}
                className="ui-app-switcher-cell"
                onMouseMove={() => {
                  if (moved) onSelect(i);
                }}
              >
                {on && <div className="ui-app-switcher-ring" data-close={isClose || undefined} />}
                <button
                  type="button"
                  className="ui-app-switcher-tile"
                  aria-label={isClose ? "Close" : `Open in ${entry.name}`}
                  tabIndex={-1}
                  onClick={isClose ? onCancel : () => onOpen(i)}
                >
                  {isClose ? <CloseTile selected={on} /> : <AppTileIcon entry={entry} icon={icons[entry.id]} />}
                </button>
              </div>
            );
          })}
        </div>
        <div className="ui-app-switcher-caption" style={{ width: count * SWITCHER_COLUMN }}>
          <span style={{ left: caption.left, right: caption.right }}>{current?.name ?? ""}</span>
        </div>
      </div>
    </div>
  );
}
