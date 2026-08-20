// Which box and which session — the decisions a remote workspace makes before
// it draws anything.
//
// What a tab IS, and what opening or closing one does to the strip, is not here:
// that belongs to `lib/remoteWorkspaceSnapshot`, because the strip outlives this
// component — it is saved per (machine, project) and restored when you walk back
// in. A second copy of those rules living beside the component is how a restored
// workspace starts disagreeing with the one you left.
//
// All of these lived inside `RemoteWorkspace.tsx` as `useMemo` bodies and
// reducer callbacks, which is why none of them could be asserted. That matters
// more here than in most components, because every one of them fails *plausibly*
// — the wrong box, the wrong session, a second view of a session that then
// fights the first for the keyboard. Nothing throws. You just end up somewhere
// you didn't mean to be, on hardware that isn't yours to guess about.
//
// They are separated from the component rather than copied out of it: the
// component imports these and holds no second opinion.

import type { BoxSession, CloudRunner, Machine } from "../../lib/api";

/** Stable per-machine, per-tab session key, so re-entering a workspace lands
 *  back in the session you left rather than opening a second one beside it.
 *
 *  The machine id is in the key because two boxes can hold sessions of the same
 *  name — `main` is the obvious one — and a key without it would attach the
 *  second box's tab to the first box's terminal. */
export function instanceIdFor(machine: Pick<Machine, "id">, tabId: string): string {
  return `remote:${machine.id}:${tabId}`;
}

/**
 * The machine this workspace should stand in.
 *
 * A request already made is kept: the entry named a box, or you picked one, and
 * a list arriving late must not move you. Otherwise the first of the book,
 * which is most-recently-used — because that is what "my machine" means to
 * someone who has two.
 */
export function machineToOpen(
  current: string | null,
  book: Pick<Machine, "id">[],
): string | null {
  return current ?? book[0]?.id ?? null;
}

/**
 * The machine this workspace asked for, when the book no longer holds it.
 *
 * A workspace can outlive the machine it names — a box removed from the book,
 * or an entry that arrived from somewhere this laptop has never been. Opening a
 * *different* machine instead would be the worse answer: the shells would come
 * up fine, somewhere else, and look right. So we name what is missing and let
 * the user choose.
 *
 * Null while the book is still loading. "We haven't looked yet" and "we looked
 * and it's gone" are different things to say, and saying the second one early
 * flashes an error at someone whose machine is perfectly fine.
 */
export function missingMachine(
  book: Pick<Machine, "id">[] | null,
  wanted: string | null,
): string | null {
  if (!book || !wanted) return null;
  return book.some((m) => m.id === wanted) ? null : wanted;
}

/**
 * The board row for this box, if the board has one.
 *
 * Matched by name, case- and space-insensitively, because the name is typed
 * twice — once into the connect wizard and once into `aura runner install` on
 * the box itself — and the two rarely agree about capitalisation.
 *
 * A box registered under a genuinely different label is still worth matching
 * when there is only one runner on the board. Never among several: the cost of
 * guessing wrong is showing someone another machine's liveness, and a box that
 * reads as online when it is stopped is a shell that hangs instead of a
 * sentence that explains.
 */
export function runnerFor(
  machine: Pick<Machine, "name"> | null,
  board: CloudRunner[] | null,
): CloudRunner | null {
  if (!machine || !board) return null;
  const name = machine.name.trim().toLowerCase();
  const named = board.find((r) => r.name.trim().toLowerCase() === name);
  if (named) return named;
  return board.length === 1 ? board[0]! : null;
}

/**
 * What to put you in front of when you walk into a machine.
 *
 * Sessions outlive this window, so the most recently active one is almost
 * always the thing you left. If the box is idle this is null and the workspace
 * lands on Chat — the honest answer, rather than opening a shell on someone's
 * machine so there is something to show.
 */
export function sessionToGreet(sessions: BoxSession[] | null): BoxSession | null {
  if (!sessions?.length) return null;
  // Copied before sorting: this is state the box owns and the caller re-reads,
  // and sorting it in place reorders the list the session picker draws.
  return [...sessions].sort((a, b) => b.activity_at - a.activity_at)[0]!;
}
