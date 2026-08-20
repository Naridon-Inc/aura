// The React side of the generated-portrait fallback.
//
// All of the rules — one fetch per person, a remembered failure, disk before
// network — live in `fallbackAvatars.ts`, which knows nothing about React so
// they can be tested as plain functions. This file is only the binding: it
// wires the store to the Tauri backend once, and hands a component whatever
// portrait exists at this instant.
//
// Nothing here can suspend, block, or delay a paint. `fallbackAvatarFor` is a
// synchronous map read; a miss returns null and the caller draws exactly what
// it draws today. A portrait that arrives later re-renders the disc in place,
// which is a swap of the disc's contents and never a change in its size.

import { useEffect, useSyncExternalStore } from "react";

import { api } from "./api";
import {
  fallbackAvatarFor,
  normalizeAvatarKey,
  requestFallbackAvatar,
  setFallbackAvatarTransport,
  subscribeFallbackAvatars,
} from "./fallbackAvatars";

/** Bind the store to the backend exactly once, the first time any avatar in the
 *  app asks for a face. Done here rather than in app start-up so the store file
 *  itself stays free of both React and Tauri, and so a test importing the store
 *  never inherits a transport that would reach the network. */
let bound = false;
function bindTransportOnce(): void {
  if (bound) return;
  bound = true;
  setFallbackAvatarTransport({
    cached: (keys) => api.fallbackAvatarCached(keys),
    fetchOne: (key) => api.fallbackAvatarFetch(key),
  });
}

/**
 * The generated portrait for this identity, or null.
 *
 * `enabled` is how "a real picture always wins" is enforced: a caller that
 * already has a photo passes false, and this never asks for anything. Callers
 * pass true only once they have nothing better than a monogram to draw.
 */
export function useFallbackAvatar(
  identity: string | null | undefined,
  enabled: boolean,
): string | null {
  const key = normalizeAvatarKey(identity);
  const face = useSyncExternalStore(
    subscribeFallbackAvatars,
    () => (enabled ? fallbackAvatarFor(key) : null),
    () => null,
  );

  useEffect(() => {
    if (!enabled) return;
    bindTransportOnce();
    requestFallbackAvatar(key);
  }, [key, enabled]);

  return face;
}
