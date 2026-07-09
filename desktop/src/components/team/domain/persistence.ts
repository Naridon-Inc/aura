/** Team (chat) bounded context — local persistence (unread + pinned).
 *
 *  Thin localStorage adapters for the two pieces of per-user chat state
 *  that live on-device only: the last-read timestamp per conversation
 *  (drives unread counts) and the set of locally-pinned message ids per
 *  conversation. No React; every accessor is guarded so test/headless
 *  envs without localStorage degrade to empty. Lifted verbatim from
 *  CommsPanel. */

// ── unread persistence ───────────────────────────────────────────────

const LAST_READ_PREFIX = "aura.chat.lastRead.";

export function loadLastRead(): Record<string, number> {
  const out: Record<string, number> = {};
  try {
    if (typeof localStorage === "undefined") return out;
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(LAST_READ_PREFIX)) continue;
      const id = k.slice(LAST_READ_PREFIX.length);
      const v = Number(localStorage.getItem(k) ?? 0);
      if (Number.isFinite(v)) out[id] = v;
    }
  } catch {
    /* localStorage may be unavailable in test envs */
  }
  return out;
}

export function persistLastRead(id: string, ts: number) {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(`${LAST_READ_PREFIX}${id}`, String(ts));
  } catch {
    /* noop */
  }
}

// ── pinned-message persistence (per conv) ────────────────────────────

const PINNED_PREFIX = "aura.chat.pinned.";

export function loadPinned(convId: string): Set<string> {
  try {
    if (typeof localStorage === "undefined") return new Set();
    const raw = localStorage.getItem(`${PINNED_PREFIX}${convId}`);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return new Set();
    return new Set(arr.filter((x): x is string => typeof x === "string"));
  } catch {
    return new Set();
  }
}

export function persistPinned(convId: string, ids: Set<string>) {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(
      `${PINNED_PREFIX}${convId}`,
      JSON.stringify(Array.from(ids)),
    );
  } catch {
    /* noop */
  }
}
