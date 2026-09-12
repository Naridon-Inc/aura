// "Is the panel I'm rendering inside actually on screen?"
//
// Some hosts deliberately keep a panel mounted while it's hidden — the right
// rail keeps the Changes tab alive so a half-typed commit message survives a
// trip to Files. Mounted-but-hidden is the right call for that state, but it
// used to mean the panel's polls kept running forever behind another tab.
//
// This context lets such a host say "you're parked" without unmounting. Polls
// that read it stop while parked and catch up the moment the panel comes back.
// The default is `true`, so any component rendered outside a provider behaves
// exactly as it always has.

import { createContext, useContext } from "react";

export const PanelActiveContext = createContext(true);

/** False while the surrounding panel is mounted but off-screen. */
export function usePanelActive(): boolean {
  return useContext(PanelActiveContext);
}
