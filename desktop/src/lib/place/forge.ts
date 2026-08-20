// What a git remote IS, as the frontend is allowed to know it.
//
// Split from `secrets.ts` for the same reason the backend split
// `place_forge.rs` out of `place_git.rs`: "whose token a push spends" and "what
// kind of service it is being spent at" are two questions, and one file
// answering both is exactly how the username half ended up hardcoded to
// GitHub's spelling of it.
//
// Note what this file does NOT contain: the table of which service wants which
// username. That lives in `manager::brain::place_forge` and is asked for. A copy
// here would agree with it right up until the day one of the forges changed its
// mind, and the symptom would be a `401` on a token the member added correctly.

import { api } from "../api";

/** What the backend can tell about a remote before anybody types a token in. */
export type ForgeAdvice = {
  /** The remote as it was asked about. */
  remote: string;
  /** The host a credential for it is keyed by. */
  host: string;
  /** `github`, `gitlab`, `bitbucket`, `gitea`, or `unknown` for a self-hosted
   *  server nothing can place — an answer, not a failure. */
  forge: string;
  /** The service in words for a person. */
  label: string;
  /** The username git will send, when the service fixes it. Absent means the
   *  member's own account name is used and a surface should ask for it. */
  git_user?: string;
  /** Does somebody have to say which account the token belongs to? */
  needs_account_name: boolean;
  /** A variable name that will read right in a boot line. */
  suggested_name: string;
  /** Would a push here go across unencrypted? Then no brokered credential is
   *  offered for it. */
  plaintext: boolean;
  /** Reached with a key rather than a stored credential? Then there is nothing
   *  to keep. */
  ssh: boolean;
};

/** Read a remote for everything the credential surfaces need from it.
 *
 *  Asked *before* a member is shown a field to type a token into, so the
 *  surface can say "GitLab — this will be sent as `oauth2`" rather than taking
 *  the token and finding out at the first push. */
export function askForge(remote: string): Promise<ForgeAdvice> {
  return api.placeGitForge(remote);
}

/** What to tell someone about to keep a credential for this remote.
 *
 *  Every branch is a true thing about what will happen, rather than a warning:
 *  an ssh remote does not want a token, an `http://` one will not be given the
 *  member's own, and the three public forges each want their own username. */
export function forgeSentence(advice: ForgeAdvice): string {
  if (advice.ssh) {
    return `${advice.host} is reached with an ssh key, so a push there spends a key rather than a token — there is nothing to keep here.`;
  }
  if (advice.plaintext) {
    return `${advice.host} is an http:// remote, so Aura won't spend your own token on it — it would cross unencrypted. Use https and it will.`;
  }
  if (advice.needs_account_name) {
    return `${advice.host} looks like ${advice.label}, which signs you in as yourself — a token for it is sent under your own account name.`;
  }
  return `${advice.host} is ${advice.label}, which sends a token as ${advice.git_user} — Aura fills that in.`;
}

/** Can a member's own token be kept for this remote at all?
 *
 *  False is not an error: an ssh remote and an `http://` one are both real
 *  answers, and a surface that offers a token field for them is offering
 *  something that will not be used. */
export function canHoldCredential(advice: ForgeAdvice): boolean {
  return !advice.ssh && !advice.plaintext;
}
