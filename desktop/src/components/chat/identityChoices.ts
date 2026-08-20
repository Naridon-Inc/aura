// Which identities Aura is allowed to offer you as "you".
//
// The rule this module exists to enforce: **never offer an identity the
// person at this computer has no evidence of owning.**
//
// Why it needs enforcing. The team roster (`.aura/team/team.json`) is
// rebuilt from `git log` and committed into the repo, so it travels with
// the code. Clone a project and you inherit the full list of everyone who
// has ever committed to it — their names, their emails, their handles.
// That list is a directory of other people, not a menu of things you might
// be. The picker used to enumerate every roster member marked `claimed`
// and present them as candidate identities, which meant a stranger who
// cloned a public repo, was not signed in, and had no local git email
// configured was shown exactly one option on their first message: a real
// teammate's name, email and handle, offered as themselves.
//
// So an identity may only be offered when something ties it to this
// machine:
//   • this computer's saved git email is that person's address (or one of
//     the spare addresses linked to their seat) — resolved server-side by
//     `canonical_member_for_email`;
//   • the GitHub account signed in on this machine is recorded on that
//     seat's `github_login` — resolved server-side by
//     `member_for_github_login`;
//   • the signed-in Aura account is recorded on that seat.
//
// Anything else — including "this seat is claimed by somebody" — is
// evidence about a different person and is not offered. When nothing
// qualifies and the computer has no git identity at all, the answer isn't
// a shorter menu, it's a different question: help them set one up. See
// `identityBannerKind`.
//
// This is the same rule the runner applies one layer down, where a machine
// that can't tell which member it is refuses to author rather than signing
// as itself. The vocabulary lines up: an evidence-backed choice here is
// *mine*; the bare local git author is the *machine*'s; a roster seat with
// no evidence behind it is *someone*, and is never offered; no git author
// at all is *missing*, and is the one case we offer to repair.

import { gitIdentityFromAccount } from "../../lib/accountIdentity";
import type {
  ChatDoctorReport,
  CloudAuthStatus,
  TeamManifest,
  TeamMember,
} from "../../lib/api";

/** How this machine proved the identity belongs to the person using it.
 *  There is deliberately no "someone claimed this seat" member. */
export type IdentityEvidence =
  | "git-email"
  | "github-account"
  | "aura-account"
  | "local-git";

export type IdentityChoice = {
  /** Stable id used for the radio button. */
  id: string;
  /** Handle without the leading `@`. */
  handle: string;
  /** Display name for the second line. Falls back to the handle. */
  name: string;
  /** Email this choice represents. Persisted into the override so the
   *  cloud presence beacon stamps the address teammates already see. */
  email: string;
  /** Whether this is the local git identity (the do-nothing default). */
  isLocalGit: boolean;
  /** What tied this identity to this computer. */
  evidence: IdentityEvidence;
  /** Plain-language "why you're seeing this", shown under the row. The
   *  audience is not engineers, so it says what matched, not which
   *  function matched it. */
  reason: string;
};

export type IdentityContext = {
  report: ChatDoctorReport;
  manifest: TeamManifest | null;
  /** Cloud sign-in state. `null` when it hasn't been read yet, which is
   *  treated the same as signed out — an unknown account proves nothing. */
  account: CloudAuthStatus | null;
};

/** The roster seat the signed-in Aura account holds, or `null`.
 *
 *  Only *recorded claims* count: the seat's `github_login`, or the
 *  account's own derived no-reply address appearing as the seat's email or
 *  one of its linked spares. Notably it does NOT match on `handle` — a
 *  member's handle is derived from the local part of whatever address they
 *  committed with, so two unrelated people can share one, and matching on
 *  it would hand somebody a stranger's seat all over again. */
export function memberForAccount(
  members: TeamMember[],
  account: CloudAuthStatus | null | undefined,
): TeamMember | null {
  if (!account?.connected) return null;
  const login = (account.user ?? "").trim().toLowerCase();
  if (!login) return null;
  const derivedEmail = (gitIdentityFromAccount(account)?.email ?? "")
    .trim()
    .toLowerCase();
  const match = members.find((m) => {
    const gh = (m.github_login ?? "").trim().toLowerCase();
    if (gh && gh === login) return true;
    if (!derivedEmail) return false;
    if (m.email.trim().toLowerCase() === derivedEmail) return true;
    return (m.also_emails ?? []).some(
      (a) => a.trim().toLowerCase() === derivedEmail,
    );
  });
  return match ?? null;
}

/** True when this computer has no git identity — nothing to sign work
 *  with, and nothing for the roster to recognise. */
export function localIdentityMissing(report: ChatDoctorReport): boolean {
  return (report.git_email ?? "").trim() === "";
}

/** Every identity this machine can honestly claim, best evidence first,
 *  deduped by email. The local git identity, when there is one, comes last
 *  as the explicit "leave it as it is" option. */
export function buildIdentityChoices({
  report,
  manifest,
  account,
}: IdentityContext): IdentityChoice[] {
  const out: IdentityChoice[] = [];
  const seen = new Set<string>();
  const pushOnce = (choice: IdentityChoice) => {
    const key =
      choice.email.trim().toLowerCase() ||
      `handle:${choice.handle.trim().toLowerCase()}`;
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(choice);
  };

  const gitEmail = (report.git_email ?? "").trim();

  // 1. The seat this computer's own email belongs to. `canonical_handle`
  //    is only ever populated when the local git email matched that
  //    member's address or a linked spare, and an empty local email
  //    matches nothing — which is exactly why the empty case must not
  //    fall through to somebody else's row.
  const canonical = (report.canonical_handle ?? "").trim();
  if (gitEmail && canonical && canonical !== report.handle) {
    pushOnce({
      id: `git-email:${canonical}`,
      handle: canonical,
      name: canonical,
      email: (report.canonical_email ?? gitEmail).trim(),
      isLocalGit: false,
      evidence: "git-email",
      reason: `This computer saves your work under ${gitEmail}, which belongs to this person on the team.`,
    });
  }

  // 2. The seat the GitHub account signed in on this machine holds.
  const githubHandle = (report.github_member_handle ?? "").trim();
  if (githubHandle) {
    const login = (report.github_login ?? "").trim();
    pushOnce({
      id: `github-account:${githubHandle}`,
      handle: githubHandle,
      name: (report.github_member_name ?? "").trim() || githubHandle,
      email: (report.github_member_email ?? "").trim(),
      isLocalGit: false,
      evidence: "github-account",
      reason: login
        ? `You're signed in to GitHub as ${login}, and that's this person on the team.`
        : "This is the GitHub account signed in on this computer.",
    });
  }

  // 3. The seat the signed-in Aura account holds.
  const auraMember = memberForAccount(manifest?.members ?? [], account);
  if (auraMember) {
    pushOnce({
      id: `aura-account:${auraMember.handle}`,
      handle: auraMember.handle,
      name: auraMember.name || auraMember.handle,
      email: auraMember.email,
      isLocalGit: false,
      evidence: "aura-account",
      reason: `Your Aura account, ${(account?.user ?? "").trim()}, is this person on the team.`,
    });
  }

  // 4. The local git identity itself — the "change nothing" option. Last
  //    so the eye lands on the team identity first.
  if (gitEmail) {
    pushOnce({
      id: `local-git:${gitEmail}`,
      handle: report.handle || emailLocalPart(gitEmail),
      name: report.git_name || report.handle,
      email: gitEmail,
      isLocalGit: true,
      evidence: "local-git",
      reason: "The name this computer already signs your work with.",
    });
  }

  return out;
}

/** The identities that would actually change who the user sends as. An
 *  empty list means there is nothing to pick between, no matter how many
 *  people are on the roster. */
export function switchableIdentityChoices(
  ctx: IdentityContext,
): IdentityChoice[] {
  return buildIdentityChoices(ctx).filter((c) => !c.isLocalGit);
}

/** What, if anything, the sidebar should offer to fix.
 *
 *  `"choose"` — this machine has evidence of a team identity that differs
 *  from what it is currently sending as; the user can switch to it.
 *  `"setup"`  — this machine has no git identity at all; the user can set
 *  one up. `null` — nothing the user can legitimately act on, so no
 *  banner. Crucially, a roster full of other people's claimed seats now
 *  falls in the last bucket. */
export type IdentityBannerKind = "choose" | "setup";

export function identityBannerKind(
  ctx: IdentityContext,
): IdentityBannerKind | null {
  const { report } = ctx;
  if (report.identity_override_active === true) return null;
  if (report.roster_email_match === true) return null;
  if (switchableIdentityChoices(ctx).length > 0) return "choose";
  if (localIdentityMissing(report)) return "setup";
  return null;
}

export function emailLocalPart(email: string): string {
  const at = email.indexOf("@");
  return (at >= 0 ? email.slice(0, at) : email).toLowerCase();
}
