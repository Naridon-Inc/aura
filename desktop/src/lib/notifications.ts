// OS-level notifications for "agent is waiting on you" moments. Fired
// when the window is unfocused so we don't double-notify the user when
// they're already looking at the surface. Click → focus the window.
//
// Triggers we fire from:
//   - permission:prompt    → claude paused on a tool call
//   - tool_use of AskUserQuestion / ExitPlanMode → claude wants input
//   - aurawatch:nudge      → background watcher detected missing intent
//
// Permission is requested lazily on first fire; macOS / Windows / GNOME
// each show their own consent prompt. If the user denies, every later
// `notify()` call just no-ops.

import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { getCurrentWindow } from "@tauri-apps/api/window";

let permissionState: "unknown" | "granted" | "denied" = "unknown";
// The single in-flight permission request. Several notifications can fire
// in the same tick while the window is unfocused — each a distinct
// `dedupeKey`, so the dedup map doesn't collapse them — and on a fresh
// `permissionState` they'd each call `requestPermission()` before the first
// resolves, popping the OS consent prompt more than once for one decision.
// Memoizing the promise funnels every concurrent caller onto one request.
let permissionInFlight: Promise<boolean> | null = null;
const dedupe = new Map<string, number>();

async function ensurePermission(): Promise<boolean> {
  if (permissionState === "granted") return true;
  if (permissionState === "denied") return false;
  if (permissionInFlight) return permissionInFlight;
  permissionInFlight = (async () => {
    try {
      let granted = await isPermissionGranted();
      if (!granted) {
        const result = await requestPermission();
        granted = result === "granted";
      }
      permissionState = granted ? "granted" : "denied";
      return granted;
    } catch {
      permissionState = "denied";
      return false;
    } finally {
      permissionInFlight = null;
    }
  })();
  return permissionInFlight;
}

async function isFocused(): Promise<boolean> {
  try {
    return await getCurrentWindow().isFocused();
  } catch {
    return false;
  }
}

/** Fire an OS notification when the window isn't focused. `dedupeKey`
 *  squelches duplicate fires within 4 seconds — the permission flow
 *  fans the same prompt through several listeners and we don't want
 *  three pings for one event. */
export async function notify(opts: {
  title: string;
  body?: string;
  dedupeKey?: string;
}): Promise<void> {
  if (await isFocused()) return;
  if (opts.dedupeKey) {
    const last = dedupe.get(opts.dedupeKey) ?? 0;
    const now = Date.now();
    if (now - last < 4000) return;
    dedupe.set(opts.dedupeKey, now);
    // Evict expired keys so the map can't grow unbounded. Every entry
    // older than the 4s window is dead — with always-on chat
    // notifications the key is the message id, so without this sweep the
    // map gains one permanent entry per message for the whole session.
    // Sweep lazily (only past a small cap) to keep the common path O(1).
    if (dedupe.size > 256) {
      for (const [k, t] of dedupe) {
        if (now - t >= 4000) dedupe.delete(k);
      }
    }
  }
  if (!(await ensurePermission())) return;
  try {
    sendNotification({
      title: opts.title,
      body: opts.body,
    });
  } catch (err) {
    console.warn("notify failed:", err);
  }
}

/** Bring the window forward — call from notification click handlers
 *  and from places we want to surface a freshly-arrived prompt. */
export async function focusWindow(): Promise<void> {
  try {
    const w = getCurrentWindow();
    await w.show();
    await w.unminimize();
    await w.setFocus();
  } catch {
    /* swallow — best-effort */
  }
}
