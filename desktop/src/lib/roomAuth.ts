// Room authentication for the JS-side surfaces.
//
// The cloud bearer lives in Rust (`~/.aura/credentials.json`) and the message
// send/list paths attach it there. But the live surfaces — the chat + pages
// WebSockets and the reaction / pages-collab REST calls — are opened directly
// from the renderer, where Rust can't add a header for us. These helpers hand
// those call sites the token so they authenticate too, which is what lets the
// server enforce room membership once `AURA_ROOMS_REQUIRE_AUTH` is flipped on.
//
// The token is fetched over IPC (`api.cloudRoomToken`) and cached briefly so a
// burst of socket reconnects doesn't hammer the command. Signed-out users get
// `null` / empty output, so every call site degrades to an unauthenticated
// request — matching legacy behaviour while the server still allows it.

// Calls `cloud_room_token` over IPC directly (rather than via `./api`) so this
// module has no dependency on `api.ts` — `api.ts` imports these helpers for its
// own room fetches (callsToken), and a mutual import would be a cycle.
import { invoke } from "@tauri-apps/api/core";

const TTL_MS = 30_000;

let cache: { token: string | null; at: number } | null = null;

/** Fetch the cloud bearer (cached ~30s). `null` when signed out. */
export async function getRoomToken(): Promise<string | null> {
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) return cache.token;
  let token: string | null = null;
  try {
    token = await invoke<string | null>("cloud_room_token");
  } catch {
    token = null;
  }
  cache = { token: token ?? null, at: now };
  return cache.token;
}

/**
 * A `token=<jwt>` query fragment for WebSocket URLs (the server reads `?token=`
 * on `/ws`), or `""` when signed out. Does NOT include a leading `?`/`&` — the
 * caller joins it with whatever separator its URL already needs.
 */
export async function roomTokenParam(): Promise<string> {
  const token = await getRoomToken();
  return token ? `token=${encodeURIComponent(token)}` : "";
}

/**
 * `{ Authorization: "Bearer <jwt>" }` for room REST `fetch` calls, or an empty
 * object when signed out (spread it into an existing headers object).
 */
export async function roomAuthHeaders(): Promise<Record<string, string>> {
  const token = await getRoomToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** Drop the cached token — call after sign-in/sign-out so the next room
 *  connection picks up the change without waiting out the TTL. */
export function clearRoomTokenCache(): void {
  cache = null;
}
