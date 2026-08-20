// Shared pin/unpin store for coding-agent presets.
//
// Which agents the user has pinned is a preference, not a per-component
// detail — the tab strip's "+" menu and the Settings → Agents roster
// both read and write it, and popout windows should agree. This lifts what
// used to live inside PresetsBar into one small external store (localStorage
// + useSyncExternalStore), keeping the original keys so existing pins carry
// over untouched.
//
// Pinning is on by default: on first run every installed CLI is pinned, and
// the native Aura Manager is pinned unless explicitly turned off. Users
// unpin the ones they don't reach for.

import { useSyncExternalStore } from "react";
import { MANAGER_AGENT } from "./agents";

// Back-compat: the original PresetsBar wrote these exact keys.
const PINNED_KEY = "aura.presetsBar.pinned";
const SHOW_KEY = "aura.presetsBar.show";

export type PinMap = Record<string, boolean>;

type State = {
  // null = the user has never touched pins → seed on first discovery.
  pinned: PinMap | null;
  show: boolean;
};

function load(): State {
  let pinned: PinMap | null = null;
  try {
    const raw = localStorage.getItem(PINNED_KEY);
    pinned = raw ? (JSON.parse(raw) as PinMap) : null;
  } catch {
    pinned = null;
  }
  const show = localStorage.getItem(SHOW_KEY) !== "0";
  return { pinned, show };
}

let state: State = load();
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function persistPinned(map: PinMap) {
  try {
    localStorage.setItem(PINNED_KEY, JSON.stringify(map));
  } catch {
    /* quota — in-memory state still works */
  }
}

export function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function getState(): State {
  return state;
}

// The native Aura Manager rides the bar pinned-by-default: "no stored flag"
// counts as pinned. Every CLI agent is off until the first-run seed (or an
// explicit pin) sets its flag.
export function isAgentPinned(agentId: string, pinned: PinMap | null): boolean {
  if (agentId === MANAGER_AGENT.id) return pinned?.[agentId] !== false;
  return !!pinned?.[agentId];
}

export function togglePin(agentId: string) {
  const base = state.pinned ?? {};
  const next: PinMap = { ...base, [agentId]: !isAgentPinned(agentId, state.pinned) };
  state = { ...state, pinned: next };
  persistPinned(next);
  emit();
}

export function setShow(next: boolean) {
  state = { ...state, show: next };
  try {
    localStorage.setItem(SHOW_KEY, next ? "1" : "0");
  } catch {
    /* ignore */
  }
  emit();
}

// First-run seed: with no saved map, pin every installed CLI so the ones
// present on this machine show by default. Idempotent — a no-op once any
// pin state exists. Manager is skipped (it's default-on without a flag).
export function seedPinsIfUnset(availableCliIds: string[]) {
  if (state.pinned !== null) return;
  if (availableCliIds.length === 0) return;
  const seed: PinMap = {};
  for (const id of availableCliIds) {
    if (id === MANAGER_AGENT.id) continue;
    seed[id] = true;
  }
  state = { ...state, pinned: seed };
  persistPinned(seed);
  emit();
}

// Keep popout windows and the main window in lockstep.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === PINNED_KEY || e.key === SHOW_KEY) {
      state = load();
      emit();
    }
  });
}

export type UsePinned = {
  pinned: PinMap | null;
  show: boolean;
  isPinned: (agentId: string) => boolean;
  toggle: (agentId: string) => void;
  setShow: (next: boolean) => void;
};

export function usePinned(): UsePinned {
  const snap = useSyncExternalStore(subscribe, getState, getState);
  return {
    pinned: snap.pinned,
    show: snap.show,
    isPinned: (id) => isAgentPinned(id, snap.pinned),
    toggle: togglePin,
    setShow,
  };
}
