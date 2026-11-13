// The state behind Aura's panel on Home, as one hook App can hold: whether it
// shows and how wide (lib/homeAuraPanel), which conversation it is on, and
// the "put the cursor in it" signal every Aura door sends.
//
// The conversation is the orchestrator session (lib/orchestratorSession) —
// the same pointer the old Aura page opened — so a chat started before the
// panel existed is the one the panel opens on. It is looked up lazily, the
// first time the panel is actually on screen, and again when the project the
// app could start one against changes (no project at first run, then one).

import { useCallback, useEffect, useRef, useState } from "react";
import { useAuraPanel } from "../../lib/homeAuraPanel";
import {
  resolveOrchestratorSession,
  setOrchestratorSid,
  startNewOrchestratorSession,
} from "../../lib/orchestratorSession";

export type HomeAura = ReturnType<typeof useHomeAura>;

export function useHomeAura({
  enabled,
  anchor,
  visible,
  pickFolder,
}: {
  /** `AURA_MANAGER_ENABLED`. Off: never shown, never looks anything up. */
  enabled: boolean;
  /** A project a first conversation could be started against, if any. */
  anchor: string | null;
  /** Home is the page on screen right now. */
  visible: boolean;
  /** Ask for a folder — the true first run, nothing open and no chat yet. */
  pickFolder: () => void;
}) {
  const panel = useAuraPanel(enabled);
  const [sid, setSid] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  const [focusNonce, setFocusNonce] = useState(0);
  const anchorRef = useRef(anchor);
  anchorRef.current = anchor;
  const pickRef = useRef(pickFolder);
  pickRef.current = pickFolder;
  const inflight = useRef<Promise<string | null> | null>(null);

  const ensure = useCallback(
    (pickIfNone: boolean) => {
      if (!enabled) return;
      if (!inflight.current) {
        setResolving(true);
        inflight.current = resolveOrchestratorSession(anchorRef.current).finally(() => {
          inflight.current = null;
          setResolving(false);
        });
      }
      inflight.current
        .then((found) => {
          if (found) setSid(found);
          else if (pickIfNone) pickRef.current();
        })
        .catch((e) => console.error("[manager] open Aura failed:", e));
    },
    [enabled],
  );

  const focus = useCallback(() => setFocusNonce((n) => n + 1), []);

  /** Every Aura door: panel open, on the current conversation, cursor in it. */
  const reveal = useCallback(() => {
    if (!enabled) return;
    panel.setOpen(true);
    ensure(true);
    focus();
  }, [enabled, panel.setOpen, ensure, focus]);

  /** A conversation picked from the panel's history or forked from a turn. */
  const openSession = useCallback(
    (next: string) => {
      setOrchestratorSid(next);
      setSid(next);
      focus();
    },
    [focus],
  );

  /** "New chat": a fresh conversation becomes the one every door opens. The
   *  previous one is not deleted; it stays in the history. */
  const newThread = useCallback(() => {
    const root = anchorRef.current;
    if (!root) {
      pickRef.current();
      return;
    }
    void startNewOrchestratorSession(root)
      .then((next) => {
        setSid(next);
        focus();
      })
      .catch((e) => console.error("[manager] new Aura thread failed:", e));
  }, [focus]);

  useEffect(() => {
    if (visible && panel.shown && !sid) ensure(false);
  }, [visible, panel.shown, sid, anchor, ensure]);

  return {
    shown: panel.shown,
    width: panel.width,
    setOpen: panel.setOpen,
    setWidth: panel.setWidth,
    sid,
    resolving,
    focusNonce,
    hasAnchor: !!anchor,
    reveal,
    openSession,
    newThread,
  };
}
