/** Team (chat) bounded context — local-user identity resolution.
 *
 *  The single source of truth for "is this message mine?". The Rust
 *  `chat_send` stamps `from_handle` via `resolve_handle`, which layers
 *  per-repo override → roster alias → email-local-part fallback. That
 *  means the SAME human emits different `from_handle` values over time —
 *  anonymous (email local part) before claiming a roster seat, the roster
 *  handle after, a custom @-name once an override is set. `selfHandle`
 *  only ever reflects the *current* effective handle, so an exact
 *  `from_handle === selfHandle` test mis-files our own older messages as a
 *  peer (the "my messages show as a colleague" bug) AND breaks the WS
 *  self-echo dedup (the "last message I sent appears twice" bug, because
 *  the dedup gates on a `fromMe` that came out false).
 *
 *  The fix is to collect EVERY string that legitimately means "me" — both
 *  identity sources, both their raw and email-local-part forms — into one
 *  normalized set, and test sender membership against it. Membership is
 *  exact (after normalization); we never fuzzy-match, so a peer whose
 *  handle merely resembles ours is never absorbed. The only way a peer
 *  collides is if they genuinely share our handle, in which case the
 *  roster itself can't tell them apart either. */

/** Normalize a handle/name/email fragment to its comparison form:
 *  lowercased + trimmed. Empty in → empty out. */
export function norm(s: string | null | undefined): string {
  return (s ?? "").toLowerCase().trim();
}

/** The set of normalized tokens that identify the local user. Built from
 *  the team identity (roster) and the device identity, each contributing
 *  its raw handle/name and — where it looks like an email — the local
 *  part. Membership in this set is what makes a message `fromMe`. */
export type SelfKeys = Set<string>;

/** Add `value` and, when it contains an `@`, its email-local-part to the
 *  key set. Both forms matter: `resolve_handle` can stamp either the full
 *  address's local part or a bare handle depending on roster state. */
function addKey(keys: SelfKeys, value: string | null | undefined): void {
  const n = norm(value);
  if (!n) return;
  keys.add(n);
  const at = n.indexOf("@");
  if (at > 0) keys.add(n.slice(0, at));
}

/** Build the local-user key set from the two identity sources. Pure —
 *  recompute whenever either identity changes. */
export function buildSelfKeys(opts: {
  /** Resolved effective handle (post override + roster alias). */
  effectiveHandle?: string | null;
  /** Raw roster handle before alias resolution. */
  handle?: string | null;
  /** Git/roster email — contributes its local part too. */
  email?: string | null;
  /** Device display name (often the git user.name). */
  deviceDisplay?: string | null;
  /** Device email — contributes its local part too. */
  deviceEmail?: string | null;
  /** #aura-only pseudonym the user opted into (the `adjective-animal-NNN`
   *  alias). When set, `chat_send` stamps THIS as `from_handle` on the
   *  worldwide channel, so it must count as "me" — otherwise our own
   *  #aura messages echo back as a stranger (the "my messages come back
   *  to me as glacial-fox-836" bug). */
  auraAlias?: string | null;
  /** Handles of the local user's OTHER roster seats they declared as "also
   *  me" — a second GitHub login, a work identity vs a personal one. Folded
   *  in so messages from any of them read as ours, while each seat stays a
   *  DISTINCT roster row (two usernames, never silently merged). See the
   *  linked-identities helpers below. */
  alsoHandles?: readonly string[] | null;
  /** Emails of those same linked seats. Each contributes its local part too,
   *  matching how `resolve_handle` may stamp an email-prefix handle. */
  alsoEmails?: readonly string[] | null;
  /** The machine's GitHub account login (`gh api user`). This is the
   *  per-person anchor: the backend bakes it into the roster handle, so
   *  it equals `effectiveHandle` once known and is what `resolve_handle`
   *  stamps on new messages ("owner", not the "owner" email
   *  prefix). It's stable across repos and across the several git emails
   *  one person commits under, so two of your own machines stay distinct
   *  without anyone signing into Aura. Optional — absent when `gh` isn't
   *  set up, in which case the email-prefix handle carries identity. */
  accountLogin?: string | null;
}): SelfKeys {
  const keys: SelfKeys = new Set();
  // Collect every form our OWN messages could have been stamped with.
  // `resolve_handle` stamps a *handle*: the GitHub login when we know it
  // ("owner"), else the email local-part ("owner"), else a
  // per-repo override — plus the opt-in #aura pseudonym. We add all of
  // them, including the email local-part, so messages we sent *before* the
  // GitHub login became our handle still file as ours.
  addKey(keys, opts.effectiveHandle);
  addKey(keys, opts.accountLogin);
  addKey(keys, opts.auraAlias);
  addKey(keys, opts.handle);
  addKey(keys, opts.email);
  // Linked seats the user declared as "also me" (see readSelfLinks). Their
  // handles/emails join the key set so their messages file as ours — the
  // "unify ownership" half — without merging the roster rows themselves.
  for (const h of opts.alsoHandles ?? []) addKey(keys, h);
  for (const e of opts.alsoEmails ?? []) addKey(keys, e);
  // NOTE: the git *display name* (deviceDisplay) and device email are
  // deliberately NOT folded in. A handle is never the display name, so the
  // name can never match a real sender — but two teammates can share one
  // ("Owner" on both of one person's Macs), so adding it buys nothing and
  // only risks claiming a namesake's messages as ours.
  return keys;
}

/** True when `sender` (a message's `from_handle`) identifies the local
 *  user. Tests the sender both verbatim and as an email-local-part so a
 *  message stamped `alias@example.com` matches a `alias`
 *  key and vice-versa. */
export function isSelfSender(sender: string | null | undefined, keys: SelfKeys): boolean {
  const n = norm(sender);
  if (!n) return false;
  if (keys.has(n)) return true;
  const at = n.indexOf("@");
  if (at > 0 && keys.has(n.slice(0, at))) return true;
  return false;
}

/** Derive a message's stable `from_handle` from the cloud/WS row fields,
 *  WITHOUT ever collapsing onto the DISPLAY NAME.
 *
 *  A handle is an identity key: it buckets DMs and drives self/peer
 *  attribution. Two teammates who merely share a display name — "Owner" on
 *  a second GitHub seat, two "John"s on a team — must NOT merge into one
 *  bucket, which is exactly what a name fallback did (the "aura shows my two
 *  accounts as one user" bug). Precedence mirrors the roster's own keying
 *  and the Rust `handle_from_row`:
 *    1. email local-part — the roster's canonical key ("mo", "owner")
 *    2. a device-scoped token — distinct per machine, so two email-less
 *       senders stay separate; invisible to the reader, who sees `from_name`
 *    3. a name slug — ONLY when neither identifier exists (legacy rows),
 *       accepting that email-less same-name senders can't be told apart. */
export function senderHandle(
  email: string | null | undefined,
  deviceId: string | null | undefined,
  display: string | null | undefined,
): string {
  const e = norm(email);
  if (e) {
    const at = e.indexOf("@");
    return at > 0 ? e.slice(0, at) : e;
  }
  const d = norm(deviceId);
  if (d) return `dev-${d.slice(0, 12)}`;
  return norm(display).replace(/[^a-z0-9_-]/g, "");
}

/* ── linked identities ("these accounts are also me") ─────────────────────
 *
 *  One person can hold several roster seats — a second GitHub login, a work
 *  email vs a personal one — and use each in a different context. They stay
 *  DISTINCT roster seats (two usernames, never silently merged into one row),
 *  but every message from any of them should still read as *mine*. This is
 *  the local user's own private declaration, stored per-machine exactly like
 *  the #aura pseudonym (`aura.chat.handle.aura`): it never travels to
 *  teammates and never rewrites the shared roster. */

const SELF_LINKS_KEY = "aura.chat.selflinks";
/** Fires (same-tab) whenever the linked-identity set changes, so hooks that
 *  read it recompute without a reload. Cross-tab, the native `storage` event
 *  covers it. */
export const SELF_LINKS_EVENT = "aura:selflinks-changed";

/** Read the declared "also me" tokens (emails and/or handles), normalized
 *  and de-duplicated. Tolerant of an absent/corrupt store → []. */
export function readSelfLinks(): string[] {
  try {
    const raw = localStorage.getItem(SELF_LINKS_KEY);
    if (!raw) return [];
    const arr: unknown = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    const seen = new Set<string>();
    for (const v of arr) {
      const n = norm(typeof v === "string" ? v : "");
      if (n) seen.add(n);
    }
    return [...seen];
  } catch {
    return [];
  }
}

/** Persist the token set and notify listeners. No-op-safe on write failure. */
export function writeSelfLinks(tokens: readonly string[]): void {
  try {
    const seen = new Set<string>();
    for (const t of tokens) {
      const n = norm(t);
      if (n) seen.add(n);
    }
    localStorage.setItem(SELF_LINKS_KEY, JSON.stringify([...seen]));
    window.dispatchEvent(new Event(SELF_LINKS_EVENT));
  } catch {
    /* ignore — a read-only store just means the link doesn't persist */
  }
}

/** Declare one token (an email or handle of another roster seat) as "also
 *  me". Returns the updated set. */
export function addSelfLink(token: string): string[] {
  const n = norm(token);
  const next = readSelfLinks();
  if (n && !next.includes(n)) next.push(n);
  writeSelfLinks(next);
  return next;
}

/** Undeclare one token. Returns the updated set. */
export function removeSelfLink(token: string): string[] {
  const n = norm(token);
  const next = readSelfLinks().filter((t) => t !== n);
  writeSelfLinks(next);
  return next;
}

/** True when any of a member's identity tokens (email, handle, github login,
 *  additive alias emails) was declared as "also me". Pure — pass the current
 *  link set from `readSelfLinks()`. */
export function isLinkedSelf(
  tokens: {
    email?: string | null;
    handle?: string | null;
    githubLogin?: string | null;
    alsoEmails?: readonly string[] | null;
  },
  links: readonly string[],
): boolean {
  if (links.length === 0) return false;
  const set = new Set(links);
  const hit = (v: string | null | undefined): boolean => {
    const n = norm(v);
    if (!n) return false;
    if (set.has(n)) return true;
    const at = n.indexOf("@");
    return at > 0 && set.has(n.slice(0, at));
  };
  if (hit(tokens.email) || hit(tokens.handle) || hit(tokens.githubLogin)) return true;
  for (const e of tokens.alsoEmails ?? []) if (hit(e)) return true;
  return false;
}
