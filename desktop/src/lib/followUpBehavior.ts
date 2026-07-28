// Follow-up behavior — what happens when you send a message while a turn is
// already running.
//
//  • "queue" (default) — the message parks in the per-session queue and fires
//    when the current turn ends cleanly. Nothing interrupts the running agent.
//  • "steer"           — the message interrupts the running turn immediately
//    and redirects it: the agent stops, keeps everything it did so far (the
//    partial turn is persisted), and picks up the new instruction with full
//    context. This is how you course-correct an agent mid-flight.
//
// Regardless of the setting, ⌘↵ (Ctrl+↵) always steers — it's the explicit
// "redirect now" shortcut. Plain ↵ follows whichever behavior is set here.
//
// This is a pure client-side UX preference (like the composer's mode / effort
// / approval prefs), so it lives in localStorage rather than the durable
// settings.toml. Both the composer and the Settings dialog read/write it
// through here, and a change event keeps a live composer in sync the moment
// the toggle flips in Settings.

import { useEffect, useState } from "react";

export type FollowUpBehavior = "queue" | "steer";

const KEY = "aura.composer.followUp";
const EVENT = "aura:followup-behavior";

export function readFollowUpBehavior(): FollowUpBehavior {
  try {
    return localStorage.getItem(KEY) === "steer" ? "steer" : "queue";
  } catch {
    return "queue";
  }
}

export function writeFollowUpBehavior(value: FollowUpBehavior): void {
  try {
    if (value === "steer") localStorage.setItem(KEY, "steer");
    else localStorage.removeItem(KEY);
  } catch {
    /* private mode / quota — best-effort */
  }
  try {
    window.dispatchEvent(new CustomEvent(EVENT, { detail: value }));
  } catch {
    /* SSR / no window — irrelevant in the app shell */
  }
}

/** Live-updating read: re-renders when the toggle flips in Settings (via the
 *  in-page event) or in another window (via the storage event). */
export function useFollowUpBehavior(): FollowUpBehavior {
  const [value, setValue] = useState<FollowUpBehavior>(readFollowUpBehavior);
  useEffect(() => {
    const onEvent = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      setValue(detail === "steer" ? "steer" : "queue");
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === KEY) setValue(readFollowUpBehavior());
    };
    window.addEventListener(EVENT, onEvent);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(EVENT, onEvent);
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  return value;
}
