// "Tell me when the phone app is ready" — the thin bridge to the Rust side.
//
// Kept out of lib/api.ts on purpose: this is one small, self-contained
// feature, and api.ts is already the app's biggest module. Everything the
// waitlist needs — types, the two calls, and where the local state lives —
// sits here.

import { invoke } from "@tauri-apps/api/core";

/** Which phone app the person is waiting for. */
export type WaitlistPlatform = "ios" | "android" | "both";

export type WaitlistState = {
  joined: boolean;
  email: string;
  platform: WaitlistPlatform | null;
  /** RFC3339; empty until they've joined. */
  joined_at: string;
};

export const NOT_JOINED: WaitlistState = {
  joined: false,
  email: "",
  platform: null,
  joined_at: "",
};

/**
 * Has this install already joined? Never throws — a missing or unreadable
 * state file just means "not yet", which is the honest answer and keeps the
 * form usable.
 */
export async function waitlistStatus(): Promise<WaitlistState> {
  try {
    return await invoke<WaitlistState>("mobile_waitlist_status");
  } catch {
    return NOT_JOINED;
  }
}

/**
 * Join. Rejects with a plain-language message the UI can show as-is — the
 * Rust side already phrases its errors for a human.
 */
export async function waitlistJoin(
  email: string,
  platform: WaitlistPlatform,
  name?: string,
): Promise<WaitlistState> {
  return invoke<WaitlistState>("mobile_waitlist_join", {
    email,
    platform,
    name: name?.trim() ? name.trim() : null,
  });
}

export const PLATFORM_LABEL: Record<WaitlistPlatform, string> = {
  ios: "iPhone",
  android: "Android",
  both: "Both",
};
