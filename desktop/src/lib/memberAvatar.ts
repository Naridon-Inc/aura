// A person's profile photo, derived from what we already know about them.
//
// Three rungs, best first: a photo the person picked themselves (stored locally,
// keyed by email — see cmd_identity_avatar.rs), then their GitHub picture (most
// real people are linked to a login, directly via `teamSyncCollaborators` or
// implicitly through a `…@users.noreply.github.com` commit email), and finally
// nothing — at which point <Avatar/> draws the deterministic animal monogram.
// Everything flows through the same `src` prop on <Avatar/>, so callers just ask
// `avatarSrcForMember` for the best available and hand the result straight in.

type MemberLike = {
  email?: string | null;
  github_login?: string | null;
};

/** GitHub login for a member, or null. Prefers the explicit `github_login`,
 *  then recovers it from a GitHub noreply commit email
 *  (`19923200+octocat@users.noreply.github.com` → `octocat`,
 *  `octocat@users.noreply.github.com` → `octocat`). */
export function githubLoginForMember(m: MemberLike): string | null {
  const explicit = m.github_login?.trim();
  if (explicit) return explicit;
  const email = m.email?.trim().toLowerCase();
  if (!email) return null;
  const match = /^([^@]+)@users\.noreply\.github\.com$/.exec(email);
  if (!match) return null;
  // Strip the numeric-id prefix GitHub prepends on newer noreply addresses.
  const local = match[1].includes("+") ? match[1].split("+").pop()! : match[1];
  return local || null;
}

/** Profile-photo URL for a member, or null when we have nothing better than
 *  the animal monogram. `size` is the square pixel size GitHub should serve. */
export function githubAvatarForMember(m: MemberLike, size = 64): string | null {
  const login = githubLoginForMember(m);
  return login
    ? `https://github.com/${encodeURIComponent(login)}.png?size=${size}`
    : null;
}

/** A self-picked photo for a member, or null. `avatars` is the email→data-URL
 *  map from `api.identityAvatarsGet()`; keys are lowercased. */
export function storedAvatarForMember(
  m: MemberLike,
  avatars: Record<string, string> | null | undefined,
): string | null {
  const email = m.email?.trim().toLowerCase();
  if (!email || !avatars) return null;
  return avatars[email] ?? null;
}

/** The best photo we have for a member: their own picked photo, else GitHub,
 *  else null (Avatar then draws the animal monogram). Pass the stored-avatar
 *  map when you have it; omit it to fall straight through to GitHub. */
export function avatarSrcForMember(
  m: MemberLike,
  avatars?: Record<string, string> | null,
  size = 64,
): string | null {
  return storedAvatarForMember(m, avatars) ?? githubAvatarForMember(m, size);
}
