// Which machines Aura has been given permission to switch off, read off the row.
//
// Sleeping used to be a question about ownership: Aura made the machine, so Aura
// could stop it. That fell apart the moment a customer could grant Aura a narrow
// role in their own cloud account — the metal is theirs, the bill is theirs, and
// Aura may still stop it. Every surface that draws a Sleep button, or explains
// why there isn't one, has to be able to tell those apart, and none of them can
// afford to reach anything to do it.
//
// So it is written on the row. A machine Aura made carries the substrate's own
// handle; a machine somebody granted carries a QUALIFIED one — the account, then
// the machine — because a stop against their box is signed by the role they
// granted rather than by Aura's own credential, and one field that says both
// cannot come apart the way two fields can.
//
// This is the frontend's reading of that string, and it is deliberately the same
// reading `provisioner::grant::handle` makes on the other side of the seam. Two
// spellings of a wire format is two answers waiting to disagree about whether a
// member's box can be put to sleep.

/** What marks a handle as belonging to an account somebody granted. */
const PREFIX = "grant:";

/** What separates the account from the machine. */
const SEPARATOR = "/";

/** Does this handle name a machine in an account Aura was given a role in?
 *
 *  Purely about the shape of a string — no file is read and nothing is reached —
 *  which is what lets a roster ask it once per row while it paints. Whether that
 *  account is still set up on this computer is a different question, asked later
 *  by the one call that is about to spend it and answered with a sentence. */
export function isGrantedHandle(handle: string | null | undefined): boolean {
  return parseGrantedHandle(handle) !== null;
}

/** The account and the machine a granted handle names, or `null` if it names no
 *  such thing.
 *
 *  Both halves have to be there. A handle with an account and no machine names
 *  nothing to stop, and one with a machine and no account names nothing to sign
 *  with — either would be a request that still looked valid right up until it
 *  went somewhere nobody meant. */
export function parseGrantedHandle(
  handle: string | null | undefined,
): { account: string; machine: string } | null {
  const raw = handle?.trim();
  if (!raw || !raw.startsWith(PREFIX)) return null;
  const rest = raw.slice(PREFIX.length);
  const at = rest.indexOf(SEPARATOR);
  if (at < 0) return null;
  const account = rest.slice(0, at).trim();
  const machine = rest.slice(at + SEPARATOR.length).trim();
  if (!account || !machine) return null;
  return { account, machine };
}
