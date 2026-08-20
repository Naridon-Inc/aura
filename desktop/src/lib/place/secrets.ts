// A member's secrets, as the frontend is allowed to know them.
//
// The invariant this file exists to hold is one sentence: a model cannot echo a
// secret it never saw. The backend keeps values in a 0600 file on this laptop
// and puts them into the *process environment* of the work at boot — never into
// a prompt, a transcript, or anything a renderer is handed.
//
// So there is deliberately no `reveal`. Not a masked one, not one behind a
// confirm. A value that crossed to this side would be a value in a devtools
// panel, in a screenshot, and in the next bug report. What crosses is a name, a
// host and eight hex characters of a digest — enough to say "that is the token
// I put on the other machine", and far too little to spend.
//
// Mirrors `manager::brain::place_secrets` and `secret_vault` field for field,
// and takes a `Place` where the backend does, so a secret cannot be arranged for
// one way of getting a place and not the other.

import { api } from "../api";
import type { Place } from "./contract";

/** A secret as anything outside the vault may know it.
 *
 *  Note what is not here: there is no value field, not a redacted one and not
 *  an optional one. A surface cannot render what it was never sent. */
export type SecretRef = {
  /** The environment variable it arrives as, on the place that runs the work. */
  name: string;
  /** Unix seconds. */
  added_at: number;
  /** Set when this is the credential a push to that host should spend. */
  git_host?: string;
  /** The username half of that credential, as the service at `git_host` spells
   *  it — `oauth2` for GitLab, `x-token-auth` for Bitbucket, the member's own
   *  account name for a self-hosted forge. Filled in by the backend when the
   *  secret is kept; see `./forge`. */
  git_user?: string;
  /** Which service answers at `git_host` — `github`, `gitlab`, `bitbucket`,
   *  `gitea`, or `unknown` for a self-hosted one nothing could place. Shown so
   *  a person can see the credential was filed as what they meant. */
  git_forge?: string;
  /** Eight hex characters of `sha256(value)`. Enough to tell two tokens apart,
   *  far too little to be worth attacking. */
  fingerprint: string;
};

/** What a place's next boot will put into the environment. */
export type SecretBoot = {
  /** The place, in words for a person — "this laptop", or the box's name. */
  place: string;
  member: string;
  /** The names that will be in the environment. Names only. */
  names: string[];
  /** Did anything have to be written to the place? False for this laptop, where
   *  a process is handed its environment directly. */
  installed: boolean;
  /** Where it was written, when it was. A path, never contents. */
  at?: string;
  /** The line a terminal on that place runs before the work. A path and two
   *  `set` commands — nothing in it is a value, which is why it is allowed to
   *  be here at all. */
  preload?: string;
};

/** What this member holds for this project.
 *
 *  Takes a project root rather than a `Place` because the vault is on this
 *  laptop whichever place the work runs on. Asking a box would be asking the
 *  wrong computer; asking it over ssh would be sending the secrets there to
 *  find out. */
export function listSecrets(root: string, member?: string): Promise<SecretRef[]> {
  return api.placeSecretList(root, member);
}

/** Keep a secret, and get the list back as it now stands.
 *
 *  `gitHost` is what makes it a credential rather than just a variable: with it
 *  set, a push to that host spends this token instead of whatever the box
 *  happened to be provisioned with — which is the whole reason a member's own
 *  work on a shared box lands under their own name.
 *
 *  `gitForge` names the service for a host that does not give it away, and
 *  `gitUser` overrides the username it sends. Both can be left out for the
 *  three public forges; for a self-hosted one, ask `askForge` in `./forge` and
 *  pass what it says the member has to supply. */
export function keepSecret(
  root: string,
  name: string,
  value: string,
  opts?: { member?: string; gitHost?: string; gitUser?: string; gitForge?: string },
): Promise<SecretRef[]> {
  return api.placeSecretPut(root, name, value, opts);
}

/** Drop one. What is already in a running process's environment stays there
 *  until it ends — this is about what the next boot gets, and a surface should
 *  say so rather than implying a running agent just lost its token. */
export function forgetSecret(
  root: string,
  name: string,
  member?: string,
): Promise<SecretRef[]> {
  return api.placeSecretForget(root, name, member);
}

/** Put this member's secrets where the place's next boot will find them.
 *
 *  One call for both place-modes. On a box it writes a 0600 file in the
 *  member's own home and answers with the line that loads it; on this laptop
 *  there is nothing to install and `installed` is false, which is an answer and
 *  not a failure. */
export function bootSecrets(place: Place, member?: string): Promise<SecretBoot> {
  return api.placeSecretBoot(
    { root: place.project.root, machineId: place.machineId },
    member,
  );
}

/** Is this secret the credential for a push to `host`? */
export function isCredentialFor(secret: SecretRef, host: string): boolean {
  return (secret.git_host ?? "").toLowerCase() === host.trim().toLowerCase();
}

/** The sentence to show against one secret in a list.
 *
 *  Says where it goes rather than what it is, because what it is cannot be
 *  shown and pretending otherwise ("••••••••") only invites someone to look for
 *  the reveal button.
 *
 *  The username is the stored one and never a default. Filling in GitHub's
 *  spelling for a GitLab token would be this surface stating, in a sentence a
 *  person will believe, something that is about to fail. */
export function secretSentence(secret: SecretRef): string {
  const id = `${secret.name} (${secret.fingerprint}…)`;
  if (!secret.git_host) return `${id} — in the environment of work you start.`;
  return secret.git_user
    ? `${id} — pushes to ${secret.git_host} as ${secret.git_user}.`
    : `${id} — pushes to ${secret.git_host}.`;
}

/** What to tell someone after arranging a place's boot.
 *
 *  The two modes say different true things: a box was written to and can be
 *  named, this laptop needed nothing written because the environment is handed
 *  over directly. Neither is a warning. */
export function bootSentence(boot: SecretBoot): string {
  if (boot.names.length === 0) {
    return `${boot.member} has nothing kept for this project, so work on ${boot.place} starts with no extra environment.`;
  }
  const named = boot.names.join(", ");
  return boot.installed
    ? `${named} will be in the environment of work started on ${boot.place}, loaded there from ${boot.at ?? "the member's own home"}.`
    : `${named} will be in the environment of work started on ${boot.place}.`;
}
