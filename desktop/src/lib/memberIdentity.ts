// How a team member's second line reads.
//
// A roster row is name-on-top, identity-underneath, and the identity is
// normally the git email — which is what the person themselves typed into
// `git config`, so it is theirs and it is legible.
//
// Not every row has one. When someone opens the project in Aura and hasn't
// signed in, the presence beacon carries a display name and a device id but no
// address, so `merge_presence_into_manifest` mints a stable synthetic key —
// `device:<uuid>@presence.local` — to keep that person on their own row
// instead of colliding with a stranger's git identity. That key is a join
// column. It was being printed:
//
//     aura-user
//     device:09fdeeb1-fc6b-41fd-9a17-712150498088@presence.local
//
// under "2 members · 1 admin", in Settings, where a person goes to find out
// who is on their team. A UUID in the place an email goes doesn't say "we
// don't know who this is yet" — it reads as a system account, or a bug.
//
// So the key stays the key and the LINE says the true thing in words.

/** Domain the presence merge mints synthetic identities under. */
export const PRESENCE_DOMAIN = "@presence.local";

/** Is this a device-keyed placeholder rather than a real address? */
export function isDeviceIdentity(email: string | null | undefined): boolean {
  return (email ?? "").trim().toLowerCase().endsWith(PRESENCE_DOMAIN);
}

/** The second line of a member row: their address, or what we actually know. */
export function memberIdentityLine(email: string | null | undefined): string {
  if (isDeviceIdentity(email)) return "Not signed in yet — seen on a device";
  return (email ?? "").trim();
}
