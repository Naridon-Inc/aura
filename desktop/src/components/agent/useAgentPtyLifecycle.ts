// Is this agent's process still there, and what should the pane show if not?
//
// Engine-independent on purpose: whether the pane is drawn by xterm.js or by
// the native GPU surface, a tab can be restored onto a PTY that died while the
// app was shut, and an agent can exit under a live tab. Both answers are about
// the session, not about pixels, so they live here rather than inside either
// canvas.

import { useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { api } from "../../lib/api";

type Options = {
  sessionId: string;
  /** Cold/click-to-start. A workspace restore re-stamps this, and it is the
   *  difference between "resume the tab you were using" and "launch a Claude
   *  process nobody asked for". */
  dormant?: boolean;
  /** Silently restart a PTY that died under a still-live tab. Withheld by
   *  surfaces that must never relaunch on their own (a detached window). */
  onAutoRespawn?: () => void | Promise<void>;
};

type Lifecycle = {
  /** The process is gone and the user never asked to resume it — cover the
   *  pane with the start affordance. */
  showStart: boolean;
  /** The process ended mid-session — show the slim Restart banner over the
   *  bottom edge, leaving the final output readable. */
  exited: boolean;
};

export function useAgentPtyLifecycle({
  sessionId,
  dormant,
  onAutoRespawn,
}: Options): Lifecycle {
  const [showStart, setShowStart] = useState(false);
  const [exited, setExited] = useState(false);
  // Latched so a mid-session exit only triggers one respawn even if the exit
  // event fires more than once before we unmount.
  const respawnFiredRef = useRef(false);

  useEffect(() => {
    respawnFiredRef.current = false;
    setShowStart(false);
    setExited(false);

    let cancelled = false;
    let unlistenExit: UnlistenFn | null = null;

    (async () => {
      // Subscribe BEFORE probing. An agent that exits during the is-alive
      // round-trip would otherwise fire into a listener that doesn't exist
      // yet, and the pane would sit frozen with no banner and no explanation.
      unlistenExit = await listen(`agent-pty-exit:${sessionId}`, () => {
        if (cancelled) return;
        // Deliberately no auto-respawn on exit: relaunching on every exit is
        // what produced the swarm of self-spawning agents when tabs were
        // closed (each Stop killed the PTY, the exit event spawned a fresh
        // one, and replaceAgent — finding the tab already gone — opened a
        // brand-new tab for it). Surface the dead state and let the user ask.
        setExited(true);
      });
      if (cancelled) return;

      // A tab restored after an app restart or an auto-update relaunch can be
      // pointing at a child that is already gone. Nothing about the pane says
      // so, which is why this probe exists: it used to be the difference
      // between a working tab and a blank one with no recovery path.
      try {
        const alive = await api.agentPtyIsAlive(sessionId);
        if (cancelled || alive) return;
        if (dormant) {
          setShowStart(true);
          return;
        }
        if (onAutoRespawn && !respawnFiredRef.current) {
          respawnFiredRef.current = true;
          // Fire-and-forget: the parent's replaceAgent unmounts us.
          Promise.resolve(onAutoRespawn()).catch(() => {});
        }
      } catch {
        /* daemon down — leave the live state alone rather than claiming death */
      }
    })();

    return () => {
      cancelled = true;
      unlistenExit?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  return { showStart, exited };
}
