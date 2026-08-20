// Deriving a git author from the signed-in Aura account.
//
// The premise of the goal: when an Aura account is signed in, that account IS
// the identity — you shouldn't have to also configure git's user.name /
// user.email, and a team shouldn't fight git identity when Aura already knows
// who everyone is. This is the pure derivation the client uses to offer "use
// my Aura account" as the git author, so the account becomes the one place the
// identity lives.

import type { CloudAuthStatus } from "./api";

export type GitAuthor = { name: string; email: string };

/** The registrable host to hang a no-reply address off, pulled from the
 *  account's own cloud URL. `https://auravcs.com/…` → `auravcs.com`. Falls
 *  back to `auravcs.com` when the URL is missing or unparseable, so the
 *  derived address is always well-formed. */
export function noreplyHost(cloudUrl: string | null | undefined): string {
  const raw = (cloudUrl ?? "").trim();
  if (raw) {
    // Strip scheme, then take up to the first slash / colon (port).
    const noScheme = raw.replace(/^[a-z]+:\/\//i, "");
    const host = noScheme.split(/[/:?#]/)[0]?.trim().toLowerCase();
    if (host && host.includes(".")) return host;
  }
  return "auravcs.com";
}

/** Derive a stable git author from a signed-in Aura account, or `null` when
 *  there's nothing to derive (signed out, or the account carries no username) —
 *  in which case the caller leaves git identity to its existing resolution
 *  rather than inventing one.
 *
 *  The account reliably carries only a username, so the email is a stable
 *  no-reply address keyed to that username on the account's own host — the same
 *  shape as GitHub's `users.noreply` addresses. It never bounces, doesn't leak
 *  a personal address, and is identical on every machine the user signs in on,
 *  which is the whole point: one identity, derived, not re-typed per repo. */
export function gitIdentityFromAccount(
  account: CloudAuthStatus | null | undefined,
): GitAuthor | null {
  if (!account?.connected) return null;
  const user = (account.user ?? "").trim();
  if (!user) return null;
  return {
    name: user,
    email: `${user}@users.noreply.${noreplyHost(account.cloud_url)}`,
  };
}
