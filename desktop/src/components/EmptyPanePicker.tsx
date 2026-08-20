// What an empty split pane shows: the app's one launcher, filling the pane.
//
// This file used to BE a launcher — a thousand lines of tile grid, project
// chooser, kind chips and row builders — and the "+" on a tab strip was a
// second one, written separately, missing four of its capabilities and
// carrying one it didn't have. Both answer "what goes in this pane?", so
// there is one body now (launcher/Launcher.tsx) and two hosts. This is the
// host that fills a pane; PaneAddPopover is the one that hangs off a "+".
//
// The only thing the two hosts disagree about is where a pick lands: an empty
// pane replaces its own slot, a "+" adds a tab to its leaf.

import { useEditorStore, type WorkPaneRef } from "../lib/editorStore";
import { Launcher } from "./launcher/Launcher";

export function EmptyPanePicker({
  paneIndex,
  currentRepoRoot,
  onClosePane,
}: {
  paneIndex: number;
  /** Current workspace root — labels foreign rows and is the default project
   *  anything started here opens in. */
  currentRepoRoot: string;
  onClosePane: () => void;
}) {
  const store = useEditorStore();

  return (
    <div className="h-full w-full flex flex-col bg-bg-content text-text-1">
      {/* Slim header — no title at all; the pane's own tab already says
          "New tab". */}
      <div className="flex items-center justify-end h-8 px-2 flex-shrink-0">
        <button
          type="button"
          onClick={onClosePane}
          className="ml-auto w-6 h-6 rounded flex items-center justify-center text-text-4 hover:text-text-1 hover:bg-state-hover transition-colors"
          title="Close this pane"
          aria-label="Close this pane"
        >
          <XGlyph />
        </button>
      </div>
      <div className="flex-1 min-h-0 flex justify-center">
        <Launcher
          className="w-full max-w-[520px] min-h-0"
          currentRepoRoot={currentRepoRoot}
          // An empty pane holds nothing, so nothing is filtered out of the
          // list — including tabs open in other panes, which `place` moves
          // here rather than duplicating.
          present={EMPTY}
          place={(ref: WorkPaneRef) => store.replaceSplitPaneAt(paneIndex, ref)}
        />
      </div>
    </div>
  );
}

/** Stable identity so the row list isn't rebuilt on every render. */
const EMPTY: WorkPaneRef[] = [];

function XGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
      <path
        d="M4 4l8 8M12 4l-8 8"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}
