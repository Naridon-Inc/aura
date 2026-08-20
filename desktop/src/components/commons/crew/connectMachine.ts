// What the connect-a-machine wizard decides, apart from what it draws.
//
// `remoteShell` already holds how to tell that a far shell has answered, and
// `memberAccount` how to make somebody an account on a box they share. This is
// the third piece: the name the box will answer to, the command that turns it
// into a service, what to make of the bytes coming back, and when the login we
// bootstrapped through stops being a way in.
//
// They were inside the component, in `useCallback` bodies and a pty listener,
// and every one of them can be wrong in a way that looks like the box being
// slow: a sign-in link never recognised, a runner installed for everybody on a
// machine several people share, a spinner that waits for a name the board will
// never report. None of that raises anything.

import type { CloudRunner } from "../../../lib/api";
import { shQuote, stripAnsi } from "./remoteShell";

/** Who else uses this machine. Not a label — it decides the shape of
 *  everything that follows. */
export type BoxKind = "mine" | "shared";

/**
 * The name the runner reports under on the board.
 *
 * Editable up front so naming isn't blocked on the host address, and it falls
 * back rather than refusing: the host is a name the user will recognise in a
 * list, and `my-machine` is at least something to click on. An empty name would
 * register a runner nobody can find again.
 */
export function boardName(typed: string, host: string): string {
  return typed.trim() || host.trim() || "my-machine";
}

/**
 * The limits every runner this wizard installs is held to.
 *
 * `auto` rather than numbers, and that is the whole point of the spelling. This
 * wizard runs on somebody's Mac and is typing into a machine it has never
 * measured — a constant chosen here is most of a small box's memory and a
 * rounding error on a large one. So the box answers, out of its own core count,
 * its own `MemTotal`, its own swap and its own account list. See the CLI's
 * `runner_limits` for the arithmetic and for what it does and does not promise.
 *
 * Passed on *every* box, not only shared ones. The machine that wedged on
 * 2026-08-04 — swapless, 8 GB, one build taking every page while its health
 * check still read green — was one person's own box. "One member cannot take
 * the whole machine" is the same promise whether there is one member or five;
 * on a box of your own it means the memory the kernel and sshd need stays
 * outside the runner's ceiling, so the box under a runaway build is still a box
 * you can log into and look at.
 */
export const LIMIT_FLAGS = "--cpu-quota auto --memory-max auto --memory-swap-max auto";

/**
 * Turn the box into a runner that survives your laptop closing.
 *
 * A *service*, not a backgrounded command. The promise of this step is "it
 * stays awake after you close your Mac", and `nohup … &` doesn't keep it: it
 * dies at the box's next reboot, and the token it inherited from this shell
 * dies with it, so the machine silently stops draining work with nothing on the
 * board to say why. `aura runner install` writes a unit that starts at boot and
 * restarts on crash.
 *
 * On a box of your own: the system unit first, because it doesn't depend on
 * lingering, with `-n` so a box that wants a sudo password fails immediately
 * instead of hanging the wizard on a prompt nobody can see. The per-user unit
 * is the fallback and needs no root.
 *
 * On a shared box: straight to the per-user unit, with no `sudo` attempt at
 * all. A system unit there would be one runner for everybody, holding one set
 * of credentials and checking work in under one identity — the exact opposite
 * of what was asked for. It also needs no root, so a member who doesn't
 * administer the machine can still set themselves up.
 *
 * Both spellings carry [`LIMIT_FLAGS`]. Until they did, `--user` installed a
 * unit with no `CPUQuota` and no `MemoryMax` in it at all: the per-member
 * isolation this step promises was a flag that separated *credentials* and left
 * every member free to take the whole machine's memory.
 */
export function installCommand(name: string, boxKind: BoxKind): string {
  const q = shQuote(name);
  const install = (scope: string) =>
    `aura runner install ${scope}--name ${q} ${LIMIT_FLAGS}`;
  return boxKind === "shared"
    ? `${install("--user ")} > ~/aura-runner.log 2>&1`
    : `sudo -n ${install("")} > ~/aura-runner.log 2>&1 || ` +
        `${install("--user ")} >> ~/aura-runner.log 2>&1`;
}

/** Fences we `echo` around the runner-log tail so the log body can be scraped
 *  out of a terminal stream that also carries the shell's own prompts. */
export const LOG_START = "___AURA_LOG_START___";
export const LOG_END = "___AURA_LOG_END___";

/**
 * Pull the last of `~/aura-runner.log` off the box.
 *
 * The fences are written split (`"___AURA""_LOG_START___"`) so that the shell's
 * echo of the command itself doesn't contain them. Without that, the scrape
 * matches the command line before the log has been read and hands the user
 * their own `tail` invocation instead of the reason the runner didn't start.
 */
export function tailLogCommand(): string {
  return `echo "___AURA""_LOG_START___"; tail -n 60 ~/aura-runner.log 2>&1; echo "___AURA""_LOG_END___"`;
}

/** What a runner log with nothing in it means, said as something to do about
 *  it. An empty panel would read as "still loading", forever. */
export const EMPTY_LOG_NOTE =
  "The runner log was empty. The box may not have run `aura` at all. Check that aura is installed and on PATH there.";

/**
 * The log body, once the closing fence has arrived.
 *
 * Null means "not yet" — the tail is still coming, and the caller keeps
 * listening. A missing *opening* fence is not a failure: the terminal's
 * scrollback is trimmed, so on a long log the start can fall off the front, and
 * everything up to the end fence is still the log.
 */
export function setupLogIn(scrollback: string): string | null {
  const end = scrollback.indexOf(LOG_END);
  if (end === -1) return null;
  const start = scrollback.indexOf(LOG_START);
  const body =
    start !== -1
      ? scrollback.slice(start + LOG_START.length, end)
      : scrollback.slice(0, end);
  return stripAnsi(body).trim() || EMPTY_LOG_NOTE;
}

/**
 * The sign-in link `claude setup-token` prints, if it has printed yet.
 *
 * Matched loosely on purpose: the host has changed more than once, and a
 * pattern pinned to one domain would leave the user staring at a step that had
 * already succeeded on the box in front of them. Stopping at whitespace and
 * quotes is what keeps a wrapped terminal line from being swallowed whole.
 */
export function loginUrlIn(scrollback: string): string | null {
  const m = scrollback.match(
    /https?:\/\/[^\s"'<>]*(?:anthropic|claude\.ai|oauth|login|auth)[^\s"'<>]*/i,
  );
  return m ? m[0] : null;
}

/**
 * Keep a recent tail of the terminal stream, so matching stays cheap on a shell
 * that has been open for a while.
 *
 * The *tail*, not the head: what we are waiting for has not arrived yet, so it
 * is the newest bytes that matter.
 */
export function keepTail(text: string, limit: number): string {
  return text.length > limit ? text.slice(-limit) : text;
}

/**
 * Is the box we just connected up on the board?
 *
 * Matched by exact name, which is stricter than anywhere else in the app on
 * purpose: this wizard registered the runner under this exact string moments
 * ago. A looser match here would report success for some other machine that
 * happened to be up — and the whole reason to poll the board is that it is the
 * only witness for a box somewhere else.
 */
export function seenOnBoard(board: CloudRunner[], name: string): boolean {
  return board.some((r) => r.name === name && r.online);
}

/**
 * What to do with the `user@host` we bootstrapped through, once the machine has
 * been written to the book.
 *
 * On a shared box we arrive as whatever login the image came with and become
 * the member once they have an account of their own. At that point the shared
 * login stops being a way in that Aura offers: leaving it in the book would
 * leave every later surface — a workspace, a terminal, a session it starts —
 * free to open a shell as `ubuntu` again, which is the thing this flow exists
 * to end. Nothing on the machine is touched; the account is still there for
 * whoever administers it, Aura just no longer holds its address.
 *
 * Until the member has an account, the bootstrap id is *held* rather than
 * replaced. Overwriting it on every save would lose the one address that needs
 * dropping later, and the shared login would quietly stay in the book.
 */
export function afterSaving(
  held: string | null,
  memberLogin: string | null,
  savedId: string,
): { hold: string; forget: string | null } {
  if (memberLogin && held && held !== savedId) {
    return { hold: savedId, forget: held };
  }
  return { hold: held ?? savedId, forget: null };
}
