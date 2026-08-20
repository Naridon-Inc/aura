// Knowing when a shell on the other end of an SSH session is actually ours.
//
// Opening a pty is instant; reaching a shell on a machine across the internet
// is not. Between the two there is a window — key exchange, auth, the MOTD —
// where anything written into the pty is simply lost. A wizard that types its
// setup during that window gets no error back: the commands vanish, and it
// waits forever for output that was never going to come.
//
// So we don't guess, and we don't wait a fixed time either — a cold box takes
// as long as it takes. We knock, and a knock that gets no answer is just sent
// again. The first answer proves the far shell is reading us, which is the
// only thing that makes every command after it safe to send.
//
// ── What this module no longer does ──────────────────────────────────────────
//
// It used to build the `ssh` lines too: `sshLine`, `remoteShellCommand`,
// `remoteAttachCommand`, `remoteAgentCommand`, all assembled out of three
// fields off a machine row. They worked, which is what made them dangerous —
// they were a whole second transport to a box, reached by a different route
// from the Rust one, with none of its connection multiplexing, none of its
// agreed quoting, and no way to learn anything the other learned. A place that
// is not reached over ssh at all could never have been added to one of them.
//
// That is now `Place::boot`, asked for over IPC — see `lib/place/boot.ts`. What
// stays here is what genuinely belongs to a pty this app is looking at rather
// than to the machine on the other end of it: the knock, and the quoting for
// the handful of lines typed into a shell that is *already open*.

/** What the far shell says back. Seeing this in the stream is the proof. */
export const SHELL_READY = "___AURA_SHELL_READY___";

/**
 * The knock, as a shell command.
 *
 * Split with `""` so the terminal's echo of the *command line* can never
 * contain the marker — only the command's *output* can. Without that, the
 * probe would match its own echo and report a shell that hasn't answered yet.
 */
export function readyProbe(): string {
  return `echo "___AURA""_SHELL_READY___"`;
}

/** Has the far shell answered anywhere in this stream? */
export function sawReady(stream: string): boolean {
  return stream.includes(SHELL_READY);
}

/**
 * A terminal stream as plain text.
 *
 * Everything scraped off a pty arrives dressed for a screen — colour, cursor
 * moves, a prompt that repaints itself. A marker is still findable through
 * that, but anything read *beside* a marker is not: a login printed next to one
 * can have a reset sequence sitting between the two. So every scrape that reads
 * a value strips first, and the ones that only look for a marker are welcome to
 * as well.
 */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
}

/**
 * Wrap a value so the far shell reads it as one literal argument.
 *
 * Everything the wizard sends is typed into a real bash, and some of it comes
 * from a text field the user filled in — a space in a machine name would split
 * into two arguments, and a quote would end the string and run whatever came
 * after it as a command. Single quotes suspend every expansion bash has, so the
 * only character needing care is the single quote itself: close, escape one,
 * reopen.
 *
 * A copy of Rust's `cloudbox::script::quote`, which is the authority — it wraps
 * every value this app sends to a machine. This one survives because a handful
 * of lines are typed into a shell that is already open (a token to export, a
 * runner name), where there is no argv to hand anything to. The two are pinned
 * to each other by `quoting.cases.json` rather than by a comment asking people
 * to look: a copy that quietly stopped agreeing would be a quoting bug found on
 * somebody's box instead of in a test.
 */
export function shQuote(v: string): string {
  return `'${v.replace(/'/g, `'\\''`)}'`;
}

/** How long to leave between knocks. Long enough not to spam the terminal. */
export const PROBE_EVERY_MS = 1_500;

/**
 * When to stop knocking and say so.
 *
 * Generous: a cold VM plus key exchange plus a slow MOTD can genuinely take
 * half a minute. Past this it isn't slow, it's wrong — bad address, wrong
 * user, or a key the box won't take — and the honest move is to say the
 * machine never answered rather than spin.
 */
export const READY_TIMEOUT_MS = 45_000;
