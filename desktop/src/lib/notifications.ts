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
//
// Two delivery paths. On macOS everything goes through `os_notify` (Rust,
// `os_notify.rs`) and the modern UserNotifications framework, because the
// notification plugin's desktop path posts through an API macOS stopped
// delivering years ago — every banner this app has ever "sent" on a Mac went
// nowhere, and it dropped `actionTypeId`/`extra` on the way, so the inline
// Reply never existed either. Everywhere else the plugin is the path: its
// Linux and Windows backends deliver, and `os_notify_available` answers false
// there so this file falls back without having to know the platform.

import {
  isPermissionGranted,
  onAction,
  registerActionTypes,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
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

/** The Tauri event the native path emits for a tap or an inline reply. Mirrors
 *  `ACTION_EVENT` in `os_notify.rs`. */
const NATIVE_ACTION_EVENT = "notification://action";

let nativeReady: Promise<boolean> | null = null;

/** Does this build have a native OS path? Asked once and remembered — the
 *  answer is a property of the platform and the bundle, neither of which
 *  changes while the app is running. */
function hasNativePath(): Promise<boolean> {
  if (!nativeReady) {
    nativeReady = invoke<boolean>("os_notify_available").catch(() => false);
  }
  return nativeReady;
}

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
 *  which repo/channel to post the reply into.
 *
 *  `threadId` groups related notifications: ten messages in one channel become
 *  one stack in Notification Center rather than ten banners to dismiss. */
export async function notify(opts: {
  title: string;
  body?: string;
  dedupeKey?: string;
  sound?: string;
  actionTypeId?: string;
  threadId?: string;
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
  try {
    // The native path asks for authorization itself, at startup, and keeps the
    // answer in the OS rather than in this module — so there is nothing to
    // request here and nothing that could deny after the fact.
    if (await hasNativePath()) {
      await invoke("os_notify", {
        title: opts.title,
        body: opts.body,
        sound: opts.sound,
        threadId: opts.threadId,
        extra: opts.extra,
      });
      return;
    }
  } catch (err) {
    console.warn("native notify failed, falling back:", err);
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
    // The native path registers its category in Rust at startup, before
    // anything can post. `registerActionTypes` is a mobile-only command in the
    // plugin anyway, so calling it on desktop only ever logged a rejection.
    if (await hasNativePath()) return;
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
 *  chat notifications (tagged `extra.kind === "chat"`). A tap with reply text
 *  typed arrives with that text; a bare tap arrives with `text: ""` and the
 *  window already focused — it still reaches `cb`, because "take me to this
 *  message" is an intent the app has to act on and only the app knows where
 *  that is. Idempotent. */
export async function onChatReply(cb: (r: ChatReply) => void): Promise<void> {
  if (replyListenerReady) return;
  replyListenerReady = true;
  if (await hasNativePath()) {
    try {
      await listen<{
        action_id: string;
        text: string;
        extra: Record<string, unknown> | null;
      }>(NATIVE_ACTION_EVENT, (ev) => {
        const { action_id, text } = ev.payload;
        // macOS names a bare tap `com.apple.UNNotificationDefaultActionIdentifier`
        // and a swipe-away `…DismissActionIdentifier`. Dismissing is the one
        // response that means "not now" — everything else is a request to go
        // somewhere, so match the reply action and the default and ignore the
        // rest.
        if (action_id !== CHAT_REPLY_ACTION_ID && !action_id.endsWith("DefaultActionIdentifier"))
          return;
        const extra = ev.payload.extra ?? {};
        if (extra["kind"] !== "chat") return;
        const trimmed = text.trim();
        if (!trimmed) void focusWindow();
        cb({ text: trimmed, extra });
      });
    } catch (err) {
      console.warn("native notification listen failed:", err);
    }
    return;
  }
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
      // Bare tap: bring the window forward. Replying inline deliberately does
      // not — answering from the notification is how you stay where you are.
      if (!text) void focusWindow();
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
