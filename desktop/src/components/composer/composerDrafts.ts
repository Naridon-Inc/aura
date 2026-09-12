//! Half-typed messages and the up-arrow recall ring, for any composer.
//!
//! These rules were written for the Aura brain's composer and are not specific
//! to it in any way — a draft belongs to one conversation, recall walks the
//! messages you sent in that conversation, and both have to survive a reload.
//! The agent chat needs exactly the same behaviour for a CLI session, and the
//! HUD composer already re-derived a near-copy of it. Rather than let a third
//! implementation drift (the interesting bugs here are all in the edges — an
//! empty draft has to DELETE its key or stale slots pile up forever; the ring
//! stores the raw text so `/foo` recalls as `/foo` and not as whatever it
//! expanded to), the logic lives here once and each composer supplies its own
//! key prefix so the namespaces can't collide.

/** Build a per-conversation storage key. A null id folds onto one shared slot,
 *  which is what a composer that exists before its session does. */
export function composerKey(prefix: string, sessionId?: string | null): string {
  return `${prefix}${sessionId ?? "__global"}`;
}

// AURA-1296 — the tab strip shows a pencil on a tab whose composer holds a
// draft. For that it needs the prefixes the two composers use (they used to be
// private consts inside each) and a signal when a draft changes, since
// `storage` events only fire in OTHER windows.
/** Prefix the Aura chat composer files its drafts under. */
export const MANAGER_DRAFT_PREFIX = "aura.manager.draft:";
/** Prefix the CLI agent chat composer files its drafts under. */
export const AGENT_DRAFT_PREFIX = "aura.agentchat.draft:";
/** Window event fired after every draft write; `detail` is the storage key. */
export const DRAFT_CHANGED_EVENT = "aura:draft-changed";

export function readDraft(key: string): string {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

/** Persist a draft, or drop the key when empty so stale empty slots don't
 *  accumulate (also how a successful send clears the draft). */
export function writeDraft(key: string, value: string): void {
  try {
    if (value.length === 0) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* storage disabled */
  }
  // AURA-1296 — tell the tab strip in this window.
  try {
    window.dispatchEvent(new CustomEvent(DRAFT_CHANGED_EVENT, { detail: key }));
  } catch {
    /* no window (tests) */
  }
}

/** How many sent messages a conversation remembers for up-arrow recall. */
export const HISTORY_CAP = 50;

export function readHistory(key: string): string[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === "string");
  } catch {
    return [];
  }
}

export function writeHistory(key: string, value: string[]): void {
  try {
    if (value.length === 0) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage disabled */
  }
}

/** Append a sent message to the ring (newest last), collapsing a consecutive
 *  duplicate of the current newest and capping the length. */
export function pushHistory(ring: string[], message: string): string[] {
  if (ring.length > 0 && ring[ring.length - 1] === message) return ring;
  const next = [...ring, message];
  return next.length > HISTORY_CAP ? next.slice(next.length - HISTORY_CAP) : next;
}
