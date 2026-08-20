/** Team (chat) bounded context — local persistence (unread + pinned + drafts).
 *
 *  Thin localStorage adapters for the pieces of per-user chat state that
 *  live on-device only: the last-read timestamp per conversation (drives
 *  unread counts), the set of locally-pinned message ids per conversation,
 *  and unsent composer text per conversation. No React; every accessor is
 *  guarded so test/headless envs without localStorage degrade to empty.
 *  The first two were lifted verbatim from CommsPanel. */

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

// ── draft persistence (per conv) ─────────────────────────────────────
//
// Unsent composer text. It stayed in a per-mount `useState` before, so
// typing half a message and clicking another channel threw it away —
// and the Drafts destination showed a permanent "No drafts" whose copy
// promised exactly the behaviour that didn't exist.
//
// On-device only, and deliberately so: a draft is a thought you haven't
// decided to send yet, and syncing it to the cloud would put words you
// never committed to in front of the team.

const DRAFT_PREFIX = "aura.chat.draft.";

export type Draft = {
  convId: string;
  body: string;
  /** Unix ms of the last keystroke — orders the list and dates the row. */
  ts: number;
};

export function loadDraft(convId: string): Draft | null {
  try {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem(`${DRAFT_PREFIX}${convId}`);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const { body, ts } = parsed as { body?: unknown; ts?: unknown };
    if (typeof body !== "string" || !body.trim()) return null;
    return { convId, body, ts: typeof ts === "number" ? ts : 0 };
  } catch {
    return null;
  }
}

/** Empty (or whitespace-only) text clears the row rather than storing a
 *  blank draft — otherwise deleting what you typed would leave a ghost in
 *  the list that can't be got rid of. */
export function persistDraft(convId: string, body: string, ts: number) {
  try {
    if (typeof localStorage === "undefined") return;
    const key = `${DRAFT_PREFIX}${convId}`;
    if (!body.trim()) {
      localStorage.removeItem(key);
    } else {
      localStorage.setItem(key, JSON.stringify({ body, ts }));
    }
  } catch {
    /* noop */
  }
}

export function clearDraft(convId: string) {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.removeItem(`${DRAFT_PREFIX}${convId}`);
  } catch {
    /* noop */
  }
}

/** Every saved draft, newest first — what the Drafts destination lists. */
export function loadAllDrafts(): Draft[] {
  const out: Draft[] = [];
  try {
    if (typeof localStorage === "undefined") return out;
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(DRAFT_PREFIX)) continue;
      const draft = loadDraft(k.slice(DRAFT_PREFIX.length));
      if (draft) out.push(draft);
    }
  } catch {
    /* localStorage may be unavailable in test envs */
  }
  return out.sort((a, b) => b.ts - a.ts);
}
