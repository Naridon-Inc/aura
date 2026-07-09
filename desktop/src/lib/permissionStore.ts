// Subscriber-set store for in-flight permission prompts. The MCP shim
// fires one `permission:prompt` event per pending request; we hold them
// per channel and let the chat surface render an Allow / Allow Always /
// Deny card. Decisions roundtrip via `api.permissionRespond`, which
// resolves the oneshot the socket task is parked on — the shim then
// formats the MCP response and returns to claude.
//
// On mount we also call `permission_list_pending` once so a card that
// fired before the listener attached still shows up.

import { useEffect, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { api, type PermissionPrompt } from "./api";
import { notify } from "./notifications";

type Entry = {
  /** All in-flight prompts globally — per-channel filtering happens at
   *  read time. The MCP bridge has one socket so all prompts arrive on
   *  the same event topic regardless of which agent tab they target. */
  pending: PermissionPrompt[];
  subs: Set<() => void>;
  unlisten: UnlistenFn | null;
  hydrated: boolean;
};

const STORE: Entry = {
  pending: [],
  subs: new Set(),
  unlisten: null,
  hydrated: false,
};

function emit() {
  STORE.subs.forEach((fn) => fn());
}

async function attach() {
  if (STORE.unlisten) return;
  STORE.unlisten = await listen<PermissionPrompt>(
    "permission:prompt",
    (ev) => {
      // Replace any earlier prompt for the same id (defensive — the
      // backend never re-emits, but the React side reconnects on HMR).
      STORE.pending = [
        ...STORE.pending.filter((p) => p.prompt_id !== ev.payload.prompt_id),
        ev.payload,
      ];
      emit();
      // Surface OS notification when window is unfocused. Dedupe by
      // prompt_id so any redundant emit (HMR, replay) only pings once.
      notify({
        title: `Aura — ${ev.payload.tool_name} wants permission`,
        body: shortInputPreview(ev.payload.tool_name, ev.payload.input),
        dedupeKey: `permission:${ev.payload.prompt_id}`,
      }).catch(() => {});
    },
  );
  if (!STORE.hydrated) {
    try {
      const seed = await invoke<PermissionPrompt[]>("permission_list_pending");
      // Merge — events that landed during the await still take precedence.
      const seen = new Set(STORE.pending.map((p) => p.prompt_id));
      for (const p of seed) {
        if (!seen.has(p.prompt_id)) STORE.pending.push(p);
      }
      STORE.hydrated = true;
      emit();
    } catch {
      /* listener still works, just no replay */
    }
  }
}

/** Subscribe to all pending prompts. Filtering by channel is the
 *  caller's responsibility — chat surface passes its own channel; a
 *  global "permission inbox" view would pass null. */
export function usePermissionPrompts(
  channel: string | null,
): PermissionPrompt[] {
  const [, force] = useState(0);
  useEffect(() => {
    const fn = () => force((n) => n + 1);
    STORE.subs.add(fn);
    attach().catch(() => {});
    return () => {
      STORE.subs.delete(fn);
      // Never tear down the listener — other surfaces may still be
      // subscribed, and the global inbox needs it alive at all times.
    };
  }, []);
  if (channel == null) return STORE.pending;
  return STORE.pending.filter((p) => p.channel === channel);
}

/** Send the user's decision back. The card calls this on click — we
 *  optimistically remove the prompt so the UI flips immediately even
 *  before the backend acknowledges. If the invoke fails (rare; would
 *  mean the slot already vanished), we leave the optimistic state so
 *  the user isn't stuck staring at an unresponsive card. */
export async function decidePrompt(
  promptId: string,
  decision: "allow" | "allow_always" | "deny",
  updatedInput?: unknown,
): Promise<void> {
  STORE.pending = STORE.pending.filter((p) => p.prompt_id !== promptId);
  emit();
  try {
    await api.permissionRespond(promptId, decision, updatedInput);
  } catch (err) {
    // Surface the error in the console — the user already moved on
    // visually so a toast would be redundant.
    console.warn("permission_respond failed:", err);
  }
}

function shortInputPreview(name: string, input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const obj = input as Record<string, unknown>;
  if (name === "Bash" && typeof obj.command === "string") {
    return obj.command.length > 100 ? obj.command.slice(0, 97) + "…" : obj.command;
  }
  if (typeof obj.file_path === "string") return obj.file_path;
  if (typeof obj.url === "string") return obj.url;
  return "";
}
