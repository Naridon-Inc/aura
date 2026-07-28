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
  onAction,
  registerActionTypes,
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

/** Public focus check — lets callers pick the focused path (an in-app chime)
 *  vs the unfocused path (an OS notification with its own sound) so a single
 *  event never plays two sounds. */
export function isWindowFocused(): Promise<boolean> {
  return isFocused();
}

/** Fire an OS notification when the window isn't focused. `dedupeKey`
 *  squelches duplicate fires within 4 seconds — the permission flow
 *  fans the same prompt through several listeners and we don't want
 *  three pings for one event.
 *
 *  `sound` names an OS system sound (macOS: "Ping", "Glass", …). `actionTypeId`
 *  attaches a registered action set (see {@link ensureChatReplyActionType}) so
 *  the notification can carry an inline Reply field; `extra` is an opaque
 *  payload round-tripped back to the {@link onChatReply} handler so it knows
 *  which repo/channel to post the reply into. */
export async function notify(opts: {
  title: string;
  body?: string;
  dedupeKey?: string;
  sound?: string;
  actionTypeId?: string;
  extra?: Record<string, unknown>;
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
      sound: opts.sound,
      actionTypeId: opts.actionTypeId,
      extra: opts.extra,
    });
  } catch (err) {
    console.warn("notify failed:", err);
  }
}

// ── Inline reply from the OS notification ──────────────────────────────────
//
// macOS/Linux notifications can carry a text-input action ("Reply"). We
// register one action type up front, then a single global listener routes any
// reply back to the app via the caller-supplied sender. The notifier tags each
// chat notification with `extra.kind === "chat"` plus the repo/channel so the
// listener knows where to post.

/** actionTypeId to pass to {@link notify} for a chat message that should offer
 *  an inline reply. */
export const CHAT_REPLY_ACTION_TYPE = "aura.chat.reply";
const CHAT_REPLY_ACTION_ID = "REPLY";

let replyActionsReady: Promise<void> | null = null;

/** Register the "Reply" action type once. Safe to call repeatedly and in a
 *  non-Tauri context (it just no-ops on failure). */
export function ensureChatReplyActionType(): Promise<void> {
  if (replyActionsReady) return replyActionsReady;
  replyActionsReady = (async () => {
    try {
      await registerActionTypes([
        {
          id: CHAT_REPLY_ACTION_TYPE,
          actions: [
            {
              id: CHAT_REPLY_ACTION_ID,
              title: "Reply",
              input: true,
              inputButtonTitle: "Send",
              inputPlaceholder: "Reply…",
            },
          ],
        },
      ]);
    } catch (err) {
      console.warn("registerActionTypes failed:", err);
    }
  })();
  return replyActionsReady;
}

/** The typed reply text isn't delivered under a stable field name across
 *  platforms, so probe the known candidates on the action payload. */
function replyTextFrom(payload: Record<string, unknown>): string {
  for (const k of ["userText", "inputValue", "input", "value", "text"]) {
    const v = payload[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

export type ChatReply = { text: string; extra: Record<string, unknown> };

let replyListenerReady = false;

/** Install the single global notification-action listener. `cb` fires only for
 *  chat notifications (tagged `extra.kind === "chat"`) that carry reply text;
 *  when the user taps the notification without typing, the window is focused
 *  instead so they can reply in-app. Idempotent. */
export async function onChatReply(cb: (r: ChatReply) => void): Promise<void> {
  if (replyListenerReady) return;
  replyListenerReady = true;
  try {
    await onAction((n) => {
      const payload = n as unknown as Record<string, unknown>;
      const actionId = (payload["actionId"] ?? payload["action"]) as
        | string
        | undefined;
      // Only handle our reply action (or an untyped tap on a chat notif).
      if (actionId && actionId !== CHAT_REPLY_ACTION_ID) return;
      const extra = ((n as { extra?: Record<string, unknown> }).extra ??
        {}) as Record<string, unknown>;
      if (extra["kind"] !== "chat") return;
      const text = replyTextFrom(payload);
      if (!text) {
        void focusWindow();
        return;
      }
      cb({ text, extra });
    });
  } catch (err) {
    console.warn("onAction listen failed:", err);
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
