// Being yourself on a machine several people use.
//
// A shared box used to mean one login. Everybody SSHed in as whatever the image
// came with — `ubuntu`, `ec2-user`, `admin` — and from there everything was
// shared whether or not anyone meant it to be: one home directory, one Claude
// sign-in, one runner token, one shell history. `aura runner install --user`
// installed "a runner per user" into a box that had exactly one user, so the
// isolation was a flag with nothing behind it.
//
// The account itself is made by `place_member_account` (Rust, over the one ssh
// door, so an Aura-provisioned place gets it identically to a box you brought).
// What lives here is the part that has to happen in the wizard's OWN terminal,
// because the terminal is a session that is already signed in as somebody:
//
//   1. finding out who this session actually is — `whoProbe`, and not the login
//      typed into a form, which says who we DIALLED, not who we ARE after a
//      handover,
//   2. becoming the member — `becomeMember`,
//   3. writing their runner token where only they can read it —
//      `writeRunnerEnv`.
//
// Kept out of the wizard component so it can be tested under `bun` against the
// exact strings a real shell receives. The quoting is the part that bites.

import { shQuote, stripAnsi } from "./remoteShell";

/** What the far shell prints when asked who it is. */
export const WHOAMI = "___AURA_WHOAMI___";

/**
 * Ask the far shell for the login it is actually running as.
 *
 * Split with `""` for the same reason every other probe here is: the terminal
 * echoes the command line, and a marker that appears in the echo would be found
 * before the command had run — reporting the shell we were about to leave.
 *
 * `id -un` rather than `whoami` or `$USER`: `whoami` is missing on some minimal
 * images, and `$USER` is an environment variable, which `sudo -i` may or may not
 * have reset — it can say `ubuntu` inside a shell that is genuinely `mo`.
 */
export function whoProbe(): string {
  return `printf '%s %s\\n' "___AURA""_WHOAMI___" "$(id -un)"`;
}

/**
 * The login the far shell last said it was, or null if it hasn't answered yet.
 *
 * The LAST answer, deliberately: a handover leaves two answers in one stream —
 * the shell we asked before, and the one we asked after — and the second is the
 * one that is still true.
 */
export function sawWho(stream: string): string | null {
  const re = new RegExp(`${WHOAMI}[ \\t]+([A-Za-z0-9._-]+)`, "g");
  let login: string | null = null;
  for (const m of stripAnsi(stream).matchAll(re)) login = m[1];
  return login;
}

/**
 * Hand this session over to the member, so everything after it is theirs.
 *
 * `-i` is a login shell: it lands in the member's own home, reads their own
 * profile (including the `umask 077` provisioning put there) and carries none
 * of the shared account's environment. `-n` refuses to prompt for a password —
 * the wizard has no way to answer one and would otherwise hang on an invisible
 * prompt with the terminal apparently idle.
 *
 * Deliberately NOT `exec sudo …`. Replacing the outer shell would be tidier
 * when it works, and fatal when it doesn't: a `sudo` that exits non-zero would
 * take the whole SSH session with it, and the wizard could no longer ask what
 * went wrong. Without `exec`, a refusal leaves us standing where we were, able
 * to say so.
 */
export function becomeMember(login: string): string {
  return `sudo -n -u ${shQuote(login)} -i`;
}

/**
 * Write the runner token into the member's own config, readable by nobody else.
 *
 * The token IS the machine's identity on your board: anything that can read it
 * can check work in as you. The wizard used to write it with a plain
 * redirection, which on every default `umask 022` box lands `0644` — so on the
 * very machine where several people have shells, each member's token was
 * readable by all the others. `umask 077` in a subshell scopes the tightening to
 * this one write, and the explicit `chmod`s heal a file or directory that an
 * earlier, laxer run already created.
 *
 * Reads `$AURA_RUNNER_TOKEN` out of the shell rather than taking the token as an
 * argument: the export has already happened, and a secret that is interpolated
 * into a second command line is a secret in the box's shell history twice.
 */
export function writeRunnerEnv(): string {
  return (
    "mkdir -p ~/.config/aura && chmod 700 ~/.config/aura && " +
    `(umask 077; printf 'AURA_RUNNER_TOKEN=%s\\n' "$AURA_RUNNER_TOKEN" > ~/.config/aura/runner.env) && ` +
    "chmod 600 ~/.config/aura/runner.env"
  );
}
