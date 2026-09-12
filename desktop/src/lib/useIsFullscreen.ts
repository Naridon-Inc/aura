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
// resize AND move, and also schedule a settled re-query after the animation
// window so we always latch the final state.
//
// Why the probes are coalesced: `onResized` does not fire once per
// transition, it fires continuously while the user drags a window edge —
// tens of events a second. Scheduling a fresh set of probes per event turned
// one drag into hundreds of `isFullscreen()` round-trips, and on macOS every
// one of those hops the *main thread*, which is the same thread AppKit is
// using to service the resize. That is a self-inflicted storm on the thread
// least able to absorb it (see `reference_tauri_ipc_cost_and_terminal_latency`,
// and `src-tauri/src/watchdog.rs` for what a wedged main thread costs). So
// each event now replaces the pending probes instead of adding to them: a
// drag of any length costs one settled probe after the user lets go.

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

    // Re-query once the geometry stops changing, so a stale mid-transition
    // `isFullscreen()` can't leave us latched wrong. 900ms clears the ~0.6s
    // macOS fullscreen animation with room to spare, and each new event
    // restarts the timer rather than queueing another one — so a long drag
    // costs exactly one probe, fired after it ends.
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    const syncSettled = () => {
      if (settleTimer !== undefined) clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        settleTimer = undefined;
        sync();
      }, 900);
    };

    // The mount probe answers immediately: there is no transition in flight to
    // wait out, and the header would otherwise render one frame with the wrong
    // inset.
    sync();

    // Fullscreen changes both the window size and its origin; subscribe to
    // both so we catch the transition regardless of which fires first.
    const unResized = win.onResized(() => syncSettled());
    const unMoved = win.onMoved(() => syncSettled());

    return () => {
      alive = false;
      if (settleTimer !== undefined) clearTimeout(settleTimer);
      unResized.then((f) => f()).catch(() => {});
      unMoved.then((f) => f()).catch(() => {});
    };
  }, []);

  return fullscreen;
}
