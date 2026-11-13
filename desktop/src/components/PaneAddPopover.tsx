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
  focusOrAppendRef,
  useEditorStore,
  type WorkPaneRef,
  type WorkSplitLeaf,
} from "../lib/editorStore";
import { Launcher } from "./launcher/Launcher";
import { useDismiss } from "../lib/useDismiss";
import { cn } from "../lib/utils";
import { MENU_SURFACE_CLASS } from "./ui/menuSurface";
import "./ui/launcher.css";

export function PaneAddPopover({
  leaf,
  currentRepoRoot,
  onClose,
}: {
  /** The pane the pick lands in. Absent on the no-layout strip — the state
   *  with no tabs at all — where the pick seeds a fresh layout instead, so
   *  an empty tab bar is never a dead end. */
  leaf?: WorkSplitLeaf;
  currentRepoRoot: string;
  onClose: () => void;
}) {
  const store = useEditorStore();
  const ref = useRef<HTMLDivElement | null>(null);

  // Outside-click + Esc close. The launcher's own flyouts render inside this
  // element, so opening one never counts as clicking away.
  // Its menus (repository, place, profiles, lanes) are portalled out of this
  // element, so they are named as inside too — choosing from one is not
  // clicking away.
  useDismiss(true, onClose, ref, { insideSelector: "[data-radix-popper-content-wrapper]" });

  return (
    <div
      ref={ref}
      // This is a menu in every way except its markup, so say so: a pane
      // below it may be a native terminal, which is a SIBLING of the webview
      // and paints above every z-index in it. Measured before this attribute
      // existed: 87% of this panel's area landed on an agent pane's terminal
      // hole and was simply not drawn, leaving the 40px search strip sitting
      // on the pane's header row looking like a misplaced control. The
      // attribute is what `openOverlayRects` reads to take the surface away
      // while the panel is up.
      data-over-native-surface=""
      // The list inside does its own scrolling; the footer's menus are
      // portalled, so nothing here needs to overflow.
      className={cn(MENU_SURFACE_CLASS, "ui-popover ui-launcher-popover")}
    >
      <Launcher
        currentRepoRoot={currentRepoRoot}
        present={leaf?.tabs ?? []}
        place={(r: WorkPaneRef) =>
          leaf ? store.addTabToPane(leaf.paneId, r) : focusOrAppendRef(r)
        }
        autoFocus
        onPicked={onClose}
      />
    </div>
  );
}
