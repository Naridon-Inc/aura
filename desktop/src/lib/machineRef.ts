// One machine, every name it has gone by.
//
// A row in the machine book used to be named by its address, `user@host:/repo`,
// so a box that came back on a new address came back under a new name, and
// every workspace, chat and tab strip still holding the old one found its
// machine gone. Rows now have names of their own (`m-…`, nothing about where
// the box is), and each row lists the ids it answered to before in `aliases`:
// the address key it was renamed from, or the id of a machine it was
// reconnected as. The backend resolves those everywhere it is handed an id.
// This is the same rule for the places this side keeps an id of its own.
//
// Two jobs:
//
//   • Finding a row by an id somebody saved, through `findMachine`. It takes
//     the book it searches as an argument, so it is always exactly as current
//     as the list the caller is drawing.
//   • Reading a pointer that was filed under an old id (`aura.machineChat.<id>`
//     and its neighbours), through `carryForward`, which moves it to the
//     current id the first time it is read so it is never looked up the long
//     way twice.
//
// For the comparisons that have only an id in hand and no book, every book
// this window reads is also remembered here (`learnMachineIds`, fed by
// `api.machinesList` and `api.placesList`). Before the first read an id
// is simply itself, which is what it always was.

/** As much of a machine row as naming needs. */
export type MachineNames = {
  id: string;
  aliases?: readonly string[] | null;
};

/** Every id `m` answers to: its own first, then the ones it went by before. */
export function machineIdsOf(m: MachineNames): string[] {
  return [m.id, ...(m.aliases ?? []).filter((a) => a && a !== m.id)];
}

/** Does `m` answer to `id`, now or under a name it used to have? */
export function answersTo(m: MachineNames, id: string | null | undefined): boolean {
  const wanted = id?.trim();
  if (!wanted) return false;
  return m.id === wanted || (m.aliases ?? []).includes(wanted);
}

/** The row in `book` that `id` names.
 *
 *  A row's own id wins over another row's old one, the same order the backend
 *  resolves in, so a name handed out today can never be shadowed by something
 *  a different machine used to be called. */
export function findMachine<T extends MachineNames>(
  book: readonly T[] | null | undefined,
  id: string | null | undefined,
): T | null {
  const wanted = id?.trim();
  if (!book || !wanted) return null;
  return (
    book.find((m) => m.id === wanted) ??
    book.find((m) => (m.aliases ?? []).includes(wanted)) ??
    null
  );
}

// Old id → current id, for every row any book read has shown this window.
const current = new Map<string, string>();
// Current id → every id it answers to.
const known = new Map<string, string[]>();

/** Remember the names in a book this window just read. A reply that is not
 *  a list teaches nothing rather than failing the read it came with. */
export function learnMachineIds(book: readonly MachineNames[] | null | undefined): void {
  if (!Array.isArray(book)) return;
  for (const m of book) {
    if (!m?.id) continue;
    known.set(m.id, machineIdsOf(m));
    for (const alias of m.aliases ?? []) {
      if (alias && alias !== m.id) current.set(alias, m.id);
    }
  }
}

/** The id a machine goes by now, for one that may have been saved under an
 *  older name. An id nothing has renamed is returned as it is — including
 *  `null`, which is this laptop. */
export function canonicalMachineId(id: string | null | undefined): string | null {
  const wanted = id?.trim();
  if (!wanted) return null;
  return current.get(wanted) ?? wanted;
}

/** Every id the machine `id` names answers to, current one first. */
export function knownIdsOf(id: string): string[] {
  const now = canonicalMachineId(id) ?? id;
  return known.get(now) ?? (now === id ? [id] : [now, id]);
}

/** Forget what has been learned. For tests: the app never needs to, because a
 *  name a machine had stays its name. */
export function forgetLearnedMachineIds(): void {
  current.clear();
  known.clear();
}

/** The slice of `Storage` a carry-forward needs. */
export type PointerStore = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

/**
 * Read a value filed under a key that embeds a machine id, wherever it was
 * filed. `ids` is the machine's current id first, then its old ones — what
 * `machineIdsOf` and `knownIdsOf` answer.
 *
 * Found under an old id, it is moved to the current one before it is
 * returned. Left where it was, a caller that later clears the current key — a
 * chat that no longer loads — would find the stale copy under the old key on
 * the next visit and try it all over again.
 */
export function carryForward(
  store: PointerStore,
  keyFor: (id: string) => string,
  ids: readonly string[],
): string | null {
  const [now, ...before] = ids;
  if (!now) return null;
  const here = store.getItem(keyFor(now));
  if (here !== null) return here;
  for (const old of before) {
    const key = keyFor(old);
    const value = store.getItem(key);
    if (value === null) continue;
    try {
      store.setItem(keyFor(now), value);
      store.removeItem(key);
    } catch {
      // Nowhere to write it — still the right answer for this read.
    }
    return value;
  }
  return null;
}
