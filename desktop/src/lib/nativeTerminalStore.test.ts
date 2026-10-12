// The claim under test: which engine a terminal asks for.
//
// Two of these answers are load-bearing for a default-on GPU terminal. A
// popout must say "no" even when the user explicitly turned native ON —
// `cmd_native_term::prepare` attaches its child surface to the window labelled
// "main", so a popout that asked for the GPU engine would hand main-window
// coordinates a surface nobody in that window can see, and paint it over
// whatever the main window happens to show there. And a user who has turned
// native OFF must keep getting xterm, because that setting is the only way
// back for a machine where the surface misbehaves.

import { describe, expect, it, beforeEach, mock } from "bun:test";

let windowLabel = "main";

mock.module("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: windowLabel }),
}));

// Bun has no DOM storage; the module only ever gets/sets one key.
const store = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: () => null,
  length: 0,
} as unknown as Storage;

const { isNativeTerminalEnabled, setNativeTerminalEnabled } = await import(
  "./nativeTerminalStore"
);

beforeEach(() => {
  store.clear();
  windowLabel = "main";
});

describe("isNativeTerminalEnabled", () => {
  it("gives an undecided user the GPU engine", () => {
    // Tracks NATIVE_DEFAULT_READY. The whole point of the branch: someone who
    // has never opened the setting gets the fast renderer, not the one that
    // lags under an agent's output.
    expect(isNativeTerminalEnabled()).toBe(true);
  });

  it("honours an explicit opt-out", () => {
    setNativeTerminalEnabled(false);
    expect(isNativeTerminalEnabled()).toBe(false);
  });

  it("honours an explicit opt-in", () => {
    setNativeTerminalEnabled(true);
    expect(isNativeTerminalEnabled()).toBe(true);
  });

  it("refuses the native engine in a popout window", () => {
    windowLabel = "agent-popout-1";
    expect(isNativeTerminalEnabled()).toBe(false);
  });

  it("refuses it in a popout even when the user turned native on", () => {
    // The guard is not a default — it is a capability check, so the stored
    // preference must not be able to talk a popout into a surface that would
    // land in another window.
    setNativeTerminalEnabled(true);
    windowLabel = "terminal-popout-7";
    expect(isNativeTerminalEnabled()).toBe(false);
  });
});
