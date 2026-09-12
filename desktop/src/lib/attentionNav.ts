// Find the next tab that needs a person, starting after the one you're on.
//
// The state already existed — an agent tab carries `attention` when it is
// waiting on a permission prompt, a chat tab has a pending question or plan,
// a tab can be marked unread by hand — and nothing was bound to it. ⌘⌥L
// walks forward through the strip order (wrapping) and stops at the first
// tab whose predicate says "this one needs you". Pure: the caller supplies
// the order and the test, this supplies the walk.

/** Index of the next item after `currentIndex` for which `needs` is true,
 *  wrapping around, and checking the current item LAST so a second press
 *  moves on rather than staying put. -1 when nothing needs attention. */
export function nextNeedingAttention(
  count: number,
  currentIndex: number,
  needs: (index: number) => boolean,
): number {
  if (count <= 0) return -1;
  const start = currentIndex >= 0 && currentIndex < count ? currentIndex : -1;
  for (let step = 1; step <= count; step++) {
    const i = (start + step + count) % count;
    if (needs(i)) return i;
  }
  return -1;
}
