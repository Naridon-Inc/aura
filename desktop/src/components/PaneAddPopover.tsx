// The "+" on a pane's tab strip: the app's one launcher, in a popover.
//
// This file used to be a second launcher written from scratch — same question
// as the empty pane's ("what goes in this pane?"), a different answer, and
// four capabilities missing: it could only start things in the current
// project, and it had no way to reach a local model, an isolated login or a
// lane. All of that lives in launcher/Launcher.tsx now, so both doors open
// onto the same room.
//
// What's left here is what a popover actually is: a position, a size, and
// closing when you click away.

import { useRef } from "react";

import {
  useEditorStore,
  type WorkPaneRef,
  type WorkSplitLeaf,
} from "../lib/editorStore";
import { Launcher } from "./launcher/Launcher";
import { useDismiss } from "../lib/useDismiss";

export function PaneAddPopover({
  leaf,
  currentRepoRoot,
  onClose,
}: {
  leaf: WorkSplitLeaf;
  currentRepoRoot: string;
  onClose: () => void;
}) {
  const store = useEditorStore();
  const ref = useRef<HTMLDivElement | null>(null);

  // Outside-click + Esc close. The launcher's own flyouts render inside this
  // element, so opening one never counts as clicking away.
  useDismiss(true, onClose, ref);

  return (
    <div
      ref={ref}
      // No `overflow-hidden`: the launcher's footer menus open upward, out of
      // this box on purpose, and a clipped flyout is a menu you can't read.
      // The list inside does its own scrolling.
      className="absolute right-0 top-full mt-1 z-30 w-[360px] rounded-lg border border-line-soft bg-bg-1 shadow-[var(--shadow-flyout)]"
    >
      <Launcher
        className="max-h-[460px]"
        currentRepoRoot={currentRepoRoot}
        present={leaf.tabs}
        place={(r: WorkPaneRef) => store.addTabToPane(leaf.paneId, r)}
        autoFocus
        onPicked={onClose}
      />
    </div>
  );
}
