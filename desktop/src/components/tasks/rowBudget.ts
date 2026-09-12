// How much of a long list to draw at once.
//
// The Tasks list drew every row it had. On a board of a couple of hundred that
// is fine; on Naridon Mono's 1,149 it is a single render of tens of thousands
// of elements, and the webview has one thread to do it on. What the reader saw
// (AURA-263, AURA-269) was the tab underline move to List while the Board
// stayed on screen for five seconds, a Display menu that "needed a second
// click", and — while the thread was busy — an empty state sitting over a
// board that was not empty. Every one of those is the same five seconds.
//
// So the first paint draws a screenful and a bit, and the rest arrives as the
// reader scrolls toward it. This is deliberately NOT a virtualiser: rows here
// are grouped, collapsible and variable-height, and a virtualiser would have
// to measure all of that to save scrolling work the reader never asked for.
// The cost being paid is the *first* render, and revealing on approach removes
// it without changing what a scrolled-to row looks like.
//
// The counts in the group headers stay true throughout — a header that said
// "40" while showing 12 would be a worse bug than the one this fixes.

/** Rows drawn before the reader has scrolled anywhere. Comfortably more than a
 *  tall window holds, so the scrollbar is honest and the first reveal happens
 *  off-screen rather than under the cursor. */
export const FIRST_PAINT_ROWS = 120;

/** Rows added each time the foot of the drawn list comes into view. */
export const REVEAL_STEP = 200;

/** The same, per *lane*, for the board. A card is several times the DOM of a
 *  row and a lane is a narrow column, so a lane's screenful is much smaller —
 *  and there are four lanes paying the first paint at once. */
export const FIRST_PAINT_CARDS = 40;
export const REVEAL_STEP_CARDS = 80;

/** How many rows to draw after `reveals` steps. */
export function rowCap(
  reveals: number,
  first: number = FIRST_PAINT_ROWS,
  step: number = REVEAL_STEP,
): number {
  return first + Math.max(0, reveals) * step;
}

/** A group as drawn: its rows cut to the budget, its true size kept. */
export type Budgeted<G> = G & { total: number };

/**
 * Cut a list of groups down to `cap` rows, in order.
 *
 * `tasks` is what the caller would draw; `total` — when given — is how big the
 * group really is. They differ for a **collapsed** group, which the caller
 * passes with no rows and a true count: it costs nothing against the budget
 * (nothing is drawn) while its heading still reports the right number. Without
 * that split, collapsing a 900-row Backlog would spend the whole budget on rows
 * nobody can see and hide every group under it.
 *
 * A group that falls entirely past the cap is dropped rather than drawn as an
 * empty heading — it comes back whole on the next reveal, and a run of headings
 * with nothing under them reads as a broken list, not a truncated one. A group
 * that draws nothing to begin with — empty, or collapsed — passes through: it
 * carries the shape of the pipeline, and the caller decides what to do with it.
 */
export function budgetGroups<T, G extends { tasks: T[]; total?: number }>(
  groups: G[],
  cap: number,
): { groups: Array<Budgeted<G>>; hidden: number } {
  let remaining = Math.max(0, cap);
  const out: Array<Budgeted<G>> = [];
  let hidden = 0;

  for (const g of groups) {
    const drawable = g.tasks.length;
    const total = g.total ?? drawable;
    if (drawable === 0) {
      out.push({ ...g, total });
      continue;
    }
    if (remaining <= 0) {
      hidden += drawable;
      continue;
    }
    const take = Math.min(remaining, drawable);
    remaining -= take;
    hidden += drawable - take;
    out.push(take === drawable ? { ...g, total } : { ...g, tasks: g.tasks.slice(0, take), total });
  }

  return { groups: out, hidden };
}
