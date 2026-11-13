// Choices about being in a team's cloud, kept on this computer: whether an
// @mention interrupts you, whether teammates see you online, and whether you
// poke and get poked. All default to on. A browser that refuses storage keeps
// the default. Pokes are the server's to decide — it refuses a poke to someone
// who turned them off — so that one is only this computer's copy of it.

import { useSyncExternalStore } from "react";

const MENTIONS_KEY = "aura.cloud.mentionAlerts";
const ONLINE_KEY = "aura.cloud.showOnline";
const POKES_KEY = "aura.cloud.pokes";

const listeners = new Set<() => void>();

function read(key: string): boolean {
  try {
    return localStorage.getItem(key) !== "0";
  } catch {
    return true;
  }
}

function write(key: string, on: boolean): void {
  try {
    localStorage.setItem(key, on ? "1" : "0");
  } catch {
    /* storage refused — the choice lasts until the app closes */
  }
  for (const l of listeners) l();
}

export const mentionAlertsOn = () => read(MENTIONS_KEY);
export const setMentionAlerts = (on: boolean) => write(MENTIONS_KEY, on);
export const showOnlineOn = () => read(ONLINE_KEY);
export const setShowOnline = (on: boolean) => write(ONLINE_KEY, on);
export const pokesOn = () => read(POKES_KEY);
/** Keep the server's answer; `setPokes` in the pokes store is what changes it. */
export const cachePokes = (on: boolean) => {
  if (on !== pokesOn()) write(POKES_KEY, on);
};

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function useMentionAlerts(): boolean {
  return useSyncExternalStore(subscribe, mentionAlertsOn, mentionAlertsOn);
}

export function useShowOnline(): boolean {
  return useSyncExternalStore(subscribe, showOnlineOn, showOnlineOn);
}

export function usePokes(): boolean {
  return useSyncExternalStore(subscribe, pokesOn, pokesOn);
}
