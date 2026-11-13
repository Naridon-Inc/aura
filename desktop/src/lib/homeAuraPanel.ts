// Aura's panel on Home — whether it is open and how wide, remembered per user.
//
// Aura is the conversation that manages every project, and Home is the page
// that lists every project's workspaces, so the conversation sits beside the
// list rather than on a page of its own. This module is the panel's state and
// the rules that decide when it may show at all; the panel itself is
// components/home/HomeAuraPanel.
//
// The rules are pure so they can be tested without a DOM, and they are the
// ONLY place the feature flag is consulted for the panel: with
// `AURA_MANAGER_ENABLED` off there is no panel and no toggle, and a layout
// persisted while the flag was on (`open: true`) can't bring it back, because
// `panelShown` asks the flag before it asks the stored state.

import { useCallback, useState } from "react";

export const AURA_PANEL_KEY = "aura.home.auraPanel";
export const AURA_PANEL_MIN = 320;
export const AURA_PANEL_MAX = 720;
export const AURA_PANEL_DEFAULT_WIDTH = 420;
/** The narrowest Home's own list may get while the panel is open. */
export const AURA_PANEL_BODY_MIN = 360;

export type AuraPanelState = { open: boolean; width: number };

export const AURA_PANEL_DEFAULT: AuraPanelState = {
  open: true,
  width: AURA_PANEL_DEFAULT_WIDTH,
};

function clampWidth(w: number): number {
  return Math.max(AURA_PANEL_MIN, Math.min(AURA_PANEL_MAX, w));
}

/** Read a stored layout. Anything unreadable — absent, hand-edited, from an
 *  older build — falls back field by field to the default, and the width is
 *  clamped so a stored value can't put the panel outside this build's bounds. */
export function parsePanelState(raw: string | null): AuraPanelState {
  if (!raw) return AURA_PANEL_DEFAULT;
  try {
    const v = JSON.parse(raw) as Partial<AuraPanelState> | null;
    if (!v || typeof v !== "object") return AURA_PANEL_DEFAULT;
    return {
      open: typeof v.open === "boolean" ? v.open : AURA_PANEL_DEFAULT.open,
      width:
        typeof v.width === "number" && Number.isFinite(v.width)
          ? clampWidth(v.width)
          : AURA_PANEL_DEFAULT.width,
    };
  } catch {
    return AURA_PANEL_DEFAULT;
  }
}

export function readPanelState(): AuraPanelState {
  try {
    return parsePanelState(localStorage.getItem(AURA_PANEL_KEY));
  } catch {
    return AURA_PANEL_DEFAULT;
  }
}

export function writePanelState(s: AuraPanelState): void {
  try {
    localStorage.setItem(
      AURA_PANEL_KEY,
      JSON.stringify({ open: s.open, width: clampWidth(s.width) }),
    );
  } catch {
    /* private mode / quota — the panel still works, it just won't remember */
  }
}

/** Whether the panel renders. The flag first: off means never, whatever was
 *  stored while it was on. */
export function panelShown(flagEnabled: boolean, state: AuraPanelState): boolean {
  return flagEnabled && state.open;
}

/** What the panel toggle (toolbar button, ⌥⇧⌘A) does from where you are.
 *
 *  - flag off → nothing; there is no panel to toggle.
 *  - not on Home → go to Home with the panel open. The shortcut is a door to
 *    Aura from anywhere, not a switch that only works on one page.
 *  - on Home → flip it. */
export type AuraPanelAction = "none" | "open-on-home" | "open" | "close";

export function auraPanelAction(
  flagEnabled: boolean,
  onHome: boolean,
  shown: boolean,
): AuraPanelAction {
  if (!flagEnabled) return "none";
  if (!onHome) return "open-on-home";
  return shown ? "close" : "open";
}

/** The panel's state as a hook. `shown` already has the flag folded in. */
export function useAuraPanel(flagEnabled: boolean) {
  const [state, setState] = useState<AuraPanelState>(readPanelState);
  const update = useCallback((next: Partial<AuraPanelState>) => {
    setState((prev) => {
      const merged = { ...prev, ...next, width: clampWidth(next.width ?? prev.width) };
      writePanelState(merged);
      return merged;
    });
  }, []);
  const setOpen = useCallback((open: boolean) => update({ open }), [update]);
  const setWidth = useCallback((width: number) => update({ width }), [update]);
  return {
    shown: panelShown(flagEnabled, state),
    width: state.width,
    setOpen,
    setWidth,
  };
}
