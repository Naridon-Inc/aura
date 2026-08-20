// The face a person gets when nobody has a picture of them.
//
// Below the self-picked photo and the GitHub avatar (both resolved by
// `memberAvatar.ts`) sits the deterministic animal monogram. This module adds a
// rung between the two: a generated portrait, fetched once per person and then
// held on this machine forever by `cmd_fallback_avatar.rs`.
//
// Why a store and not just a `<img src>`: the portrait endpoint is neither
// deterministic nor seedable — the same URL answers with a different face every
// call. Linking to it would give each teammate a new face on every render. So
// the bytes are claimed once, filed under that person's identity, and read back
// from disk from then on. This module is the part that decides *when* to claim,
// and it is deliberately free of React so its rules can be tested directly.
//
// Three rules it exists to keep:
//   - one fetch per identity, however many rows ask at once;
//   - a failure is remembered, so a person we couldn't get never becomes a
//     request that repeats on every mount;
//   - nothing here ever blocks a render — the monogram is already on screen and
//     stays there until real bytes exist.

/** Where portraits come from. Injected so the rules below can be tested without
 *  a Tauri host, and so nothing in this file reaches the network by itself. */
export type FallbackAvatarTransport = {
  /** Portraits already on disk for these identities. Must not hit the network. */
  cached: (keys: string[]) => Promise<Record<string, string>>;
  /** Claim a portrait for one identity. Resolves to a renderable `data:` URL. */
  fetchOne: (key: string) => Promise<string>;
};

/** Fold an identity so the same person is one key whatever the calling surface
 *  had — an email in the roster, a display name on a commit row. Returns null
 *  for anything that isn't an identity, which callers read as "don't ask". */
export function normalizeAvatarKey(raw: string | null | undefined): string | null {
  const key = (raw ?? "").trim().toLowerCase();
  return key.length > 0 ? key : null;
}

type StoreState = {
  /** Identity → renderable `data:` URL. The only thing readers see. */
  faces: Map<string, string>;
  /** Identities we asked for and did not get. Never asked for again this run. */
  missed: Set<string>;
  /** Identities with a claim in the air, so the second row waits on the first. */
  inFlight: Map<string, Promise<void>>;
  /** Identities already read off disk, so the warm read isn't repeated either. */
  warmed: Set<string>;
};

const state: StoreState = {
  faces: new Map(),
  missed: new Set(),
  inFlight: new Map(),
  warmed: new Set(),
};

const listeners = new Set<() => void>();

let transport: FallbackAvatarTransport | null = null;

/** Point the store at a portrait source. Called once at app start with the
 *  Tauri-backed transport; called by tests with a counting fake. */
export function setFallbackAvatarTransport(next: FallbackAvatarTransport | null): void {
  transport = next;
}

/** Drop everything the store has learned. Tests only — the app wants the
 *  opposite of this, which is why nothing calls it at runtime. */
export function resetFallbackAvatars(): void {
  state.faces.clear();
  state.missed.clear();
  state.inFlight.clear();
  state.warmed.clear();
  emit();
}

function emit(): void {
  for (const fn of listeners) fn();
}

/** Watch for portraits arriving. Returns the unsubscribe. */
export function subscribeFallbackAvatars(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** The portrait we hold for this identity right now, or null. Synchronous and
 *  allocation-free on the hot path: a render asks this, gets what exists, and
 *  draws the monogram for a null without waiting on anything. */
export function fallbackAvatarFor(key: string | null): string | null {
  if (!key) return null;
  return state.faces.get(key) ?? null;
}

/** True once we've tried this identity and come back empty — offline, blocked,
 *  a bad response. Exposed so a caller can tell "not yet" from "not ever". */
export function fallbackAvatarMissed(key: string | null): boolean {
  return key ? state.missed.has(key) : false;
}

/** Ask for this identity's portrait, if it needs asking for.
 *
 *  Returns immediately. The first caller for a key does the work — reading disk,
 *  and only on a genuine miss going out for bytes — and every caller that
 *  arrives while that is in the air joins the same promise rather than starting
 *  a second one. Forty rows of the same person cost one fetch; a person we
 *  already hold, or already failed on, costs nothing at all. */
export function requestFallbackAvatar(key: string | null): void {
  if (!key) return;
  if (state.faces.has(key) || state.missed.has(key)) return;
  if (state.inFlight.has(key)) return;
  const source = transport;
  if (!source) return;

  const work = claim(key, source).finally(() => {
    state.inFlight.delete(key);
  });
  state.inFlight.set(key, work);
}

async function claim(key: string, source: FallbackAvatarTransport): Promise<void> {
  // Disk before network, always. On a second launch this is the whole story:
  // every face the app has seen resolves here and no socket is ever opened.
  if (!state.warmed.has(key)) {
    state.warmed.add(key);
    try {
      const disk = await source.cached([key]);
      const hit = disk[key];
      if (hit) {
        state.faces.set(key, hit);
        emit();
        return;
      }
    } catch {
      // A cache read that fails is not a reason to skip the fetch, and not a
      // reason to say anything: the monogram is on screen either way.
    }
  }

  try {
    const url = await source.fetchOne(key);
    if (url) {
      state.faces.set(key, url);
      emit();
      return;
    }
    state.missed.add(key);
  } catch {
    // Offline, timed out, blocked by a proxy, or an answer that wasn't an
    // image. Record it so this person is never asked for twice, and leave the
    // monogram exactly as it was — this path is today's behaviour, unchanged.
    state.missed.add(key);
  }
}

/** Warm several identities from disk in one call, before any of them render.
 *
 *  A roster knows its forty people up front; asking the backend once beats forty
 *  round trips, and it means the first paint already has the faces rather than
 *  swapping them in a moment later. Never fetches — identities with nothing on
 *  disk are simply left for `requestFallbackAvatar` to claim. */
export async function warmFallbackAvatars(keys: Array<string | null>): Promise<void> {
  const source = transport;
  if (!source) return;
  const wanted = [
    ...new Set(
      keys.filter((k): k is string => !!k && !state.faces.has(k) && !state.warmed.has(k)),
    ),
  ];
  if (wanted.length === 0) return;
  for (const key of wanted) state.warmed.add(key);
  try {
    const disk = await source.cached(wanted);
    let found = false;
    for (const [key, url] of Object.entries(disk)) {
      if (url) {
        state.faces.set(key, url);
        found = true;
      }
    }
    if (found) emit();
  } catch {
    // Same posture as above: a failed warm costs a later per-key read, nothing
    // the person looking at the roster can see.
  }
}
