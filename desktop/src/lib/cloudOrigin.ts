// cloudOrigin — which cloud the frontend talks to, asked once and remembered.
//
// The rule lives in Rust (`src-tauri/src/cloud_endpoint.rs`): `AURA_CLOUD_URL`
// beats the signed-in credentials, and an override never carries the production
// bearer. Everything that goes through a Tauri command already obeys it.
//
// What did not: five places in the frontend answered the question themselves,
// with a literal `wss://auravcs.com` / `https://auravcs.com` — the chat WS, the
// reactions snapshot, the global-commons WS, the Pages CRDT socket and the
// voice-token POST. So an app started against a staging or self-hosted server
// was HALF pointed at it: writes landed on staging while the sockets subscribed
// to production. Chat looked broken (messages sent, nothing arrives — the exact
// failure `chat_doctor` was written to diagnose), and a test run put real
// traffic on the live cloud, which is precisely what a staging stack exists to
// prevent.
//
// So: one answer, from the side that owns the rule. The websocket origin is
// derived here rather than fetched separately, because `https`→`wss` /
// `http`→`ws` is the whole of the difference and a second round trip would just
// be a second thing to keep in step.

import { invoke } from "@tauri-apps/api/core";

export type CloudOrigins = {
  /** Where HTTP writes go, no trailing slash. */
  http: string;
  /** The same host as a websocket origin. */
  ws: string;
};

/** What the public cloud is, and what we assume before Rust has answered. It is
 *  also the answer for anyone who never set `cloud_url` and never overrode it,
 *  so the fallback is the common case rather than a guess. */
export const PUBLIC_CLOUD: CloudOrigins = {
  http: "https://auravcs.com",
  ws: "wss://auravcs.com",
};

/** `https://x` → `wss://x`, `http://x` → `ws://x`. A bare host with no scheme
 *  is treated as `https`, matching how the Rust side normalises. */
export function wsOriginFor(http: string): string {
  const trimmed = http.trim().replace(/\/+$/, "");
  if (trimmed.startsWith("https://")) return `wss://${trimmed.slice(8)}`;
  if (trimmed.startsWith("http://")) return `ws://${trimmed.slice(7)}`;
  return `wss://${trimmed}`;
}

let resolved: CloudOrigins | null = null;
let inflight: Promise<CloudOrigins> | null = null;

/** The cloud this app is talking to. Resolved once and cached for the life of
 *  the window — the answer comes from the environment and the credentials file,
 *  neither of which changes under a running app without a restart. */
export async function cloudOrigins(): Promise<CloudOrigins> {
  if (resolved) return resolved;
  if (!inflight) {
    inflight = (async () => {
      try {
        const origin = await invoke<string>("cloud_room_origin");
        const http = (origin ?? "").trim().replace(/\/+$/, "");
        // An empty answer means the command is missing or the server said
        // nothing useful; the public cloud is the right thing to fall back to,
        // and pretending otherwise would break chat for everyone signed in.
        if (!http) return PUBLIC_CLOUD;
        return { http, ws: wsOriginFor(http) };
      } catch (err) {
        // Say it out loud. The fallback is the PUBLIC cloud, so a silent
        // failure here is the very bug this module was written to remove: an
        // app the user started against staging would quietly open its sockets
        // on production instead.
        console.warn(
          "[cloudOrigin] couldn't ask which cloud this app is on — " +
            "falling back to the public cloud, so chat, Pages and voice will " +
            "use auravcs.com even if this app was started against another server.",
          err,
        );
        return PUBLIC_CLOUD;
      } finally {
        inflight = null;
      }
    })().then((v) => {
      resolved = v;
      return v;
    });
  }
  return inflight;
}

/** The last resolved answer, without waiting. For the rare sync path — a value
 *  read while rendering, where blocking is not an option. Callers that can await
 *  should, because before the first resolve this is the public cloud. */
export function cloudOriginsNow(): CloudOrigins {
  return resolved ?? PUBLIC_CLOUD;
}

/** Ask early, so the sync accessor is warm by the time anything renders. Fire
 *  and forget; a failure just leaves the public-cloud fallback in place. */
export function primeCloudOrigins(): void {
  void cloudOrigins().catch(() => {});
}

/** Tests only — drops the cached answer so a case can install its own. */
export function __resetCloudOriginsForTest(): void {
  resolved = null;
  inflight = null;
}
