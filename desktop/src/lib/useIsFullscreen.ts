// Tracks macOS native fullscreen so chrome can drop the traffic-light
// inset. In fullscreen the window's red/amber/green lights vanish, but
// our header still reserves their horizontal space (paddingLeft) — that
// reservation becomes an ugly empty gap before the brand, and the left
// icon cluster never slides to the window edge. Subscribing here lets the
// header collapse the inset the moment the window enters fullscreen (and
// restore it on exit).
//
// Why this is more than a single `onResized`: on macOS the fullscreen
// transition is an ~0.6s animation. The resize/move events fire at the
// *start* of that animation, and `isFullscreen()` queried at that instant
// still reports the pre-transition value — so a probe that only re-queries
// on the resize event latches the stale value and the inset never
// collapses (the bug this file exists to fix, regressed once the ADE moved
// its traffic-light reservation onto the header). We therefore re-query on
// resize AND move, and also schedule two settled re-queries after the
// animation window so we always latch the final state. No polling loop —
// the timers are one-shot per transition and no-op once unmounted.

import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

export function useIsFullscreen(): boolean {
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    let alive = true;
    const win = getCurrentWindow();

    const sync = () => {
      win
        .isFullscreen()
        .then((v) => {
          if (alive) setFullscreen(v);
        })
        .catch(() => {
          /* non-Tauri / probe failed — stay windowed */
        });
    };

    // Re-query now, then again after the fullscreen animation settles so a
    // stale mid-transition `isFullscreen()` can't leave us latched wrong.
    const syncSettled = () => {
      sync();
      window.setTimeout(sync, 250);
      window.setTimeout(sync, 700);
    };

    syncSettled();

    // Fullscreen changes both the window size and its origin; subscribe to
    // both so we catch the transition regardless of which fires first.
    const unResized = win.onResized(() => syncSettled());
    const unMoved = win.onMoved(() => syncSettled());

    return () => {
      alive = false;
      unResized.then((f) => f()).catch(() => {});
      unMoved.then((f) => f()).catch(() => {});
    };
  }, []);

  return fullscreen;
}
