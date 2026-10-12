//! Where a native terminal surface belongs, given a measurement of its DOM
//! hole.
//!
//! A wgpu surface is a *sibling* of the webview, not a layer inside it. The DOM
//! cannot clip it, hide it, scroll it or move it. So every effect the page has
//! on the hole has to be turned into an explicit instruction for the surface,
//! and there are only three: place it, park it offscreen, or do nothing yet.
//!
//! The middle one is the one that bites. A hole whose ancestor goes
//! `display:none` still has an element — it just measures 0×0 — and a surface
//! that treats that as "nothing to do" keeps painting at the last place it was
//! told about, on top of whatever the app put there instead. That is how
//! maximizing the terminal dock (which hides the work body wholesale, see
//! `Layout.tsx`) left an agent pane's surface sitting over the dock's own
//! chrome. The native browser hole learned this first — `RailBrowser`'s
//! `visibleRect` returns null for a zero-size rect and hides its webview — and
//! this is the same rule for the terminal.

/** A hole or surface box, top-left origin.
 *
 *  Which unit depends on which side of [`toWindowPoints`] it came from: a
 *  measurement off the DOM is in CSS px, and what a native sibling is placed
 *  with is in window points. They are the same number only at 100% zoom.
 */
export type Bounds = { x: number; y: number; w: number; h: number };

/** The CSS custom property App.tsx publishes the webview's zoom to. */
const ZOOM_VAR = "--webview-zoom";

/** The webview's current zoom level.
 *
 *  Read from CSS rather than from `zoomStore` on purpose. `publishZoomToCss`
 *  sets this on `documentElement` at module load *and* from the zoom effect,
 *  so it is already correct on the first frame — and because it lands as a
 *  `style` attribute edit on `<html>`, the ancestor `MutationObserver` that
 *  every surface already runs sees a zoom change for free. Reading the store
 *  instead would need a second subscription per pane to learn the same thing.
 */
export function webviewZoom(): number {
  if (typeof document === "undefined") return 1;
  const raw = getComputedStyle(document.documentElement).getPropertyValue(ZOOM_VAR);
  return parseZoom(raw);
}

/** The zoom level a published CSS value stands for.
 *
 *  Absent (an older window that never published it), unparseable, or absurd
 *  all mean the same thing: 1, which is exactly what the surface did before
 *  zoom was accounted for at all. A zero or negative factor is the one that
 *  has to be caught rather than trusted — it would multiply the hole down to
 *  nothing and the pane would simply go black.
 *
 *  Split out from the read above so the judgement can be tested without a
 *  DOM: this package's suite runs without one, and standing up a document for
 *  three assertions would change how every other test in it executes.
 */
export function parseZoom(published: string | null | undefined): number {
  const z = parseFloat(published ?? "");
  return Number.isFinite(z) && z > 0 ? z : 1;
}

/** Convert a DOM measurement into the window points a native sibling lives in.
 *
 *  A `wgpu` surface is a sibling of the webview, so it is positioned in the
 *  window's own coordinate space — but `getBoundingClientRect` answers in CSS
 *  px, and a zoomed webview multiplies every CSS px on its way to the window.
 *  At any zoom but 100% the two disagree by exactly that factor, which is why
 *  App.tsx publishes it: the traffic-light gutter divides it out to stay a
 *  constant size on screen, and a hole measured in CSS px has to multiply it
 *  back in to land where the user sees the hole.
 *
 *  Skipped for a surface being parked. `PARKED` is already a window-point
 *  sentinel rather than a measurement — scaling it would just move it to a
 *  different offscreen nowhere, and at the 0.5 floor a 1pt box could round to
 *  nothing.
 */
export function toWindowPoints(b: Bounds, zoom: number): Bounds {
  if (zoom === 1) return b;
  return { x: b.x * zoom, y: b.y * zoom, w: b.w * zoom, h: b.h * zoom };
}

/** Where a surface goes when its hole is no longer on screen.
 *
 *  Parking rather than closing is deliberate: the PTY and the GPU surface are
 *  expensive and the hole usually comes back (a tab switch, an un-maximize), so
 *  the surface waits offscreen with its scrollback intact. Far enough out that
 *  no plausible window geometry or display arrangement drags it back into view.
 */
export const PARKED: Bounds = { x: -100000, y: -100000, w: 1, h: 1 };

/** Below this in either axis a hole is not being shown, it is collapsed. Two
 *  rather than one because a 1px hole is a layout artefact, never a terminal,
 *  and a surface that size would size its shell 1×1 and thrash on first
 *  resize. */
const MIN_PAINTABLE = 2;

/** Whether a hole of this size is actually being shown to someone. */
export function isPaintable(b: Bounds): boolean {
  return b.w >= MIN_PAINTABLE && b.h >= MIN_PAINTABLE;
}

/** Where to sample a hole to ask what is painted over it.
 *
 *  Five points, inset from the edges so a 1px border or a rounded corner on a
 *  neighbour never decides the answer: the centre and the four quarters.
 *  Fractions of the box rather than pixels, so the same rule holds for a hole
 *  of any size.
 */
const SAMPLES: ReadonlyArray<readonly [number, number]> = [
  [0.5, 0.5],
  [0.25, 0.25],
  [0.75, 0.25],
  [0.25, 0.75],
  [0.75, 0.75],
];

/** Is something else drawn over the whole of this hole?
 *
 *  The fourth way a hole stops being on screen, and the one no style answers.
 *  A page the router opens over the work body — `App.tsx` mounts places as
 *  `absolute inset-0 z-20` — leaves the hole beneath it mounted, full size and
 *  `visibility: visible`. For DOM content that is enough: the overlay paints
 *  on top. A native surface is the webview's SIBLING and paints above all of
 *  it, so z-index cannot reach it, and the terminal went on drawing over the
 *  Tasks board and Trace.
 *
 *  Hit-testing is how to ask, because it answers the same question the user is
 *  asking with their eyes: what is in front here. `el` is the hole;
 *  `topmostAt` is `document.elementFromPoint` in the app and a stub in tests.
 *
 *  EVERY sample must be covered, not merely one. A dropdown or a tooltip over
 *  part of a terminal is a small cosmetic wrong; parking the surface for it
 *  would blank the terminal underneath, which is a much larger one. Only a
 *  hole that is covered everywhere is a hole nobody is looking at.
 *
 *  A sample that hits nothing (`null`, i.e. outside the viewport) counts as
 *  uncovered: off-screen is the parked-and-placed caller's business, and a
 *  surface must never be taken away on the strength of a question that was
 *  never answered.
 */
export function isCovered(
  el: Element,
  rect: Bounds,
  topmostAt: (x: number, y: number) => Element | null,
): boolean {
  if (!isPaintable(rect)) return false;
  return SAMPLES.every(([fx, fy]) => {
    const top = topmostAt(rect.x + rect.w * fx, rect.y + rect.h * fy);
    if (!top) return false;
    // The hole itself, something inside it, or an ancestor of it (which is
    // what comes back when the hole is `pointer-events: none`) all mean
    // nothing is in the way.
    return !(top === el || el.contains(top) || top.contains(el));
  });
}

// ---------------------------------------------------------------------------
// …and the fourth-and-a-half: an overlay across PART of the hole
// ---------------------------------------------------------------------------
//
// `isCovered` above asks for EVERY sample, and that is right for what it was
// written against — a router page mounted over the whole work body. It is
// exactly wrong for the far more common case: a menu, a dialog or a popover
// that lands on a corner of the terminal. Measured in the running app, the
// tab strip's "+" launcher is 360×270 CSS px and the hole beneath it is
// 840×771, so the panel overlaps 12% of the hole, every sample bar one is
// still clear, and the surface stays put. 87% of the panel's own area is then
// painted over by the terminal and the reader sees only the 40px strip that
// happens to clear the hole — which is why a launcher that is working
// perfectly reads as a stray search box jammed into the pane's header row.
//
// The first answer to that was to take the surface away while an overlay was
// open, on the reasoning that there were only two ways out — keep overlays
// out of the surface's rectangle, or yield the rectangle — and that the first
// was impossible, since the hole IS the pane and a panel has nowhere else to
// go. Both halves of that were true. The conclusion was still wrong, because
// the choice was never between the whole rectangle and none of it.
//
// Yielding is the worse failure. A terminal that goes black while a menu is
// up is not a cosmetic wrong; it is the pane's entire content gone, which is
// what the user reported: "the popover is readable but the terminal it covers
// has vanished, not just behind it — gone." A menu over a terminal is
// supposed to hide the part of it the menu is on, and nothing else.
//
// So the third way, and the one this module now implements: the surface is
// placed at the largest sub-rectangle of its hole that no open overlay is
// sitting on. [`clearRect`] finds that rectangle. The terminal keeps running
// at its full size — the grid and the shell never hear about this, so nothing
// reflows and no TUI is sent a SIGWINCH for a menu click — and the native
// side simply shows a window onto it. The menu lands on the part the surface
// has stepped off, which is the webview, where z-index works normally.
//
// Taking the surface away stays the answer for the degenerate case: an
// overlay that leaves no room worth painting (see `MIN_CLEAR_W`/`H`) gets a
// park, which is what `isCovered` already did for a full-page layer.
//
// Only overlays someone opened and is reading count. A hover annotation is
// not worth a strip of terminal: a tooltip over a surface stays unreadable,
// which is the small wrong, where clipping the terminal under the pointer
// every time it crosses a button is the large one.

/** What counts as an overlay that must be readable over a native surface.
 *
 *  These are the same set `styles.css` lifts to `--z-menu-portal` — the app's
 *  existing answer to "nothing we draw may cover a menu", now extended to the
 *  one layer z-index cannot reach. `data-over-native-surface` is the opt-in
 *  for the hand-rolled panels that are menus in every way except their markup
 *  and carry no role to say so (the tab strip's launcher is one).
 *
 *  `[role="menu"]` is matched bare, with no `[data-state="open"]`, and that
 *  asymmetry is deliberate. The hand-rolled sheets — the roster's cursor
 *  menu, a pane's overflow menu, the composer's more-menu — are plain divs
 *  with a role and no Radix state attribute, so the state-gated selector saw
 *  none of them; that is why right-clicking a project row left the terminal
 *  painting over the right-hand half of the menu and slicing its labels off
 *  mid-word. Every `role="menu"` in this app is rendered only while it is
 *  open (`{open && …}`), so presence in the document IS openness, and a role
 *  that means "transient sheet of commands" is the right thing to key on
 *  rather than one attribute of one library. `dialog` and `listbox` stay
 *  state-gated: both can legitimately describe something permanently on
 *  screen, and this list may not clip a terminal for one of those.
 *
 *  `[role="alertdialog"]` is bare for the same reason as `menu`, and it is
 *  here because a sweep of every role the app uses turned up two sites that
 *  nothing else in this list matched: the file tree's delete confirmation
 *  (Medusa's `Prompt`, which is Radix `AlertDialog` underneath and so carries
 *  no popper wrapper) and the agent gate's parked request card. Both are
 *  mounted only while they are up. A confirmation you cannot read is worse
 *  than a menu you cannot read, since the thing it is asking about is
 *  usually destructive.
 *
 *  `role="tooltip"` is deliberately absent, and `openOverlayRects` skips it
 *  explicitly: a tooltip follows the pointer, so honouring it would resize
 *  the drawable on every hover.
 *
 *  `.aura-menu-surface` is the marker every panel built from the app's one
 *  flyout recipe carries (`components/ui/menuSurface`, which owns the name —
 *  the literal is repeated here rather than imported so this module stays a
 *  DOM-only unit, and the suite pins the two against each other). It is here
 *  because the list above is keyed on what a sheet IS, and a popover is not a
 *  menu of commands: the roles caught the right-click sheets and left every
 *  panel that merely reports something — the status bar's CLI version chip,
 *  the topbar's two pickers, Ports, the cloud machine and box pickers, the
 *  file- and participant-mention pickers — opening behind a running terminal,
 *  visible only as the strip of themselves that cleared the hole. One of them
 *  is what the user reported; all of them were the same omission, which is why
 *  this names the shared recipe instead of adding eight opt-ins. A ninth panel
 *  written tomorrow is covered by construction.
 *
 *  Unlike `dialog` and `listbox` it is matched bare, on the invariant stated
 *  in `menuSurface`: a panel carrying this class is mounted only while it is
 *  open, so presence is openness. Note this subsumes the state gate on
 *  `listbox` for the two mention pickers, which are hand-rolled and carry no
 *  `data-state` — that gate had never matched them.
 */
export const OVERLAY_SELECTOR = [
  "[data-over-native-surface]",
  "[data-radix-popper-content-wrapper]",
  ".aura-menu-surface",
  '[role="dialog"][data-state="open"]',
  '[role="menu"]',
  '[role="alertdialog"]',
  '[role="listbox"][data-state="open"]',
].join(",");

/** Do two boxes share any area at all? */
export function overlaps(a: Bounds, b: Bounds): boolean {
  return (
    Math.min(a.x + a.w, b.x + b.w) > Math.max(a.x, b.x) &&
    Math.min(a.y + a.h, b.y + b.h) > Math.max(a.y, b.y)
  );
}

// `isOverlaid` used to live here: a boolean "is any of `overlays` drawn across
// this hole", which the pane read and answered by parking the surface. It is
// gone because the boolean was the bug. The question a pane has to ask is not
// whether something is in the way but how much of the hole is still clear, and
// [`clearRect`] below answers that with the rectangle itself — the same rect
// arithmetic, carried far enough to be useful. There is nothing a caller can
// do with the boolean except take the whole terminal away.
//
// Rects rather than hit-testing, either way, and for a reason worth keeping:
// `isCovered` samples five points because it is asking "is the whole of this
// hidden", which sampling can answer; where a menu IS cannot be sampled at all
// — a 200×60 menu on an 840×771 hole misses all five sample points and is
// still a menu nobody can read. Asking the overlays where they are is both
// exact and cheaper than five `elementFromPoint` calls.

/** How far outside its own box an overlay is allowed to need.
 *
 *  `getBoundingClientRect` answers the border box, and a menu is bigger than
 *  that in two ways that both matter here. It carries a drop shadow
 *  (`--shadow-flyout`, `shadow-elevation-flyout`) which paints outside the box
 *  and is the only thing separating a sheet from what it sits on; and it opens
 *  through a `zoom-in-95` transform, so for the first frames after the click
 *  the box it reports is 5% smaller than the box it is about to occupy. A
 *  surface clipped to the measured edge would paint over the shadow always and
 *  over a 2.5% rim of the menu itself for the length of the animation.
 *
 *  Eight px covers both and costs the terminal a hairline it was never going
 *  to be read through.
 */
export const OVERLAY_MARGIN = 8;

/** Every open overlay's box, in the CSS px a hole is measured in, grown by
 *  [`OVERLAY_MARGIN`].
 *
 *  Lives here rather than in the pane so the policy — what counts as an
 *  overlay, and what a tooltip counts as — is stated once, beside the rule
 *  that reads it.
 *
 *  Two things are filtered out, and the order of the two is load-bearing.
 *  Unpaintable boxes go first: several of these sheets wait for their turn
 *  mounted at 0×0, and growing one of those by the margin would invent a
 *  16×16 overlay that clips a terminal for a menu nobody opened. Then
 *  anything the style system is not painting, which a measurement cannot see
 *  — `visibility: hidden` leaves a box at full size — because a selector this
 *  broad may not clip a terminal on the strength of an element that is
 *  present but invisible. One computed-style read per candidate, and there is
 *  almost never more than one candidate.
 */
export function openOverlayRects(): Bounds[] {
  if (typeof document === "undefined") return [];
  const out: Bounds[] = [];
  for (const el of document.querySelectorAll(OVERLAY_SELECTOR)) {
    // See above: a tooltip follows the pointer and nobody opened it.
    if (el.matches('[role="tooltip"]') || el.querySelector('[role="tooltip"]')) continue;
    const r = el.getBoundingClientRect();
    const box = { x: r.left, y: r.top, w: r.width, h: r.height };
    if (!isPaintable(box)) continue;
    if (getComputedStyle(el).visibility !== "visible") continue;
    out.push({
      x: box.x - OVERLAY_MARGIN,
      y: box.y - OVERLAY_MARGIN,
      w: box.w + OVERLAY_MARGIN * 2,
      h: box.h + OVERLAY_MARGIN * 2,
    });
  }
  return out;
}

/** Below this in either axis there is no terminal left to read.
 *
 *  A clear strip narrower than about fifteen columns or shorter than about
 *  three rows is not a view of a terminal, it is a sliver — and asking the
 *  native side for one costs a swapchain reconfigure to show it. A dialog that
 *  leaves only that much is a dialog covering the pane, which is the case
 *  `isCovered` was written for, so it gets the same answer: park.
 */
const MIN_CLEAR_W = 120;
const MIN_CLEAR_H = 64;

/** More overlays over one hole than this and the pane is a backdrop.
 *
 *  The search below is quartic in the number of edges, which is fine for the
 *  one or two sheets a pane ever really has open and pointless for a dozen.
 *  Six is far past anything the app can produce and still costs under a
 *  millisecond, so the cap is a guard against a future bug rather than a
 *  policy anyone will meet.
 */
const MAX_OVERLAYS = 6;

/** The candidate edges of a clear rectangle along one axis: the hole's own two,
 *  plus every overlay edge that falls strictly inside them. Sorted, de-duped.
 *
 *  These are the only coordinates worth trying, because a largest empty
 *  rectangle is always flush on each side against either the hole's boundary
 *  or the edge of something it had to avoid. Anything between two adjacent
 *  edges grows to one of them.
 */
function clearEdges(lo: number, hi: number, spans: ReadonlyArray<readonly [number, number]>): number[] {
  const set = new Set<number>([lo, hi]);
  for (const [a, b] of spans) {
    if (a > lo && a < hi) set.add(a);
    if (b > lo && b < hi) set.add(b);
  }
  return [...set].sort((p, q) => p - q);
}

/** The largest part of `hole` that no open overlay is sitting on, or null when
 *  what is left is not worth painting.
 *
 *  This is the rule the whole module exists for now, and it is the answer to
 *  the long note above: a menu over a terminal should hide the part of the
 *  terminal it is on and nothing else. The surface cannot be clipped by the
 *  page, so the page works out the clip and the surface is placed at it.
 *
 *  Exhaustive over the candidate grid rather than clever: every pair of x
 *  edges against every pair of y edges, keep the biggest rectangle that
 *  touches no overlay. With one sheet open that is 36 rectangles to test. The
 *  answer is exact, which matters — a heuristic that picked, say, "the band
 *  below the overlay" would hand a pane 30% of its terminal in cases where
 *  the band beside it was 80%, and nobody would ever know why.
 *
 *  Measured geometries it has to get right, all from the running app at 100%
 *  zoom with an 840×771 hole at (280,100):
 *  * the tab strip's "+" launcher, 360×270 hanging into the hole's top-right
 *    → the full-width band below it, 840×529
 *  * the roster's cursor menu, 224×300 reaching over the hole's left edge
 *    → the full-height band to its right, 698×771
 *  * an agent tab's context menu dropped from the strip → the band below it
 */
export function clearRect(hole: Bounds, overlays: readonly Bounds[]): Bounds | null {
  if (!isPaintable(hole)) return null;
  const over = overlays.filter((o) => isPaintable(o) && overlaps(hole, o));
  if (over.length === 0) return hole;
  if (over.length > MAX_OVERLAYS) return null;

  const xs = clearEdges(hole.x, hole.x + hole.w, over.map((o) => [o.x, o.x + o.w] as const));
  const ys = clearEdges(hole.y, hole.y + hole.h, over.map((o) => [o.y, o.y + o.h] as const));

  let best: Bounds | null = null;
  let bestArea = 0;
  for (let i = 0; i < xs.length - 1; i += 1) {
    for (let j = xs.length - 1; j > i; j -= 1) {
      const w = xs[j] - xs[i];
      if (w < MIN_CLEAR_W) break; // narrower still as j falls — nothing left here
      for (let k = 0; k < ys.length - 1; k += 1) {
        for (let l = ys.length - 1; l > k; l -= 1) {
          const h = ys[l] - ys[k];
          if (h < MIN_CLEAR_H) break;
          const area = w * h;
          if (area <= bestArea) break; // shorter still as l falls
          const cand = { x: xs[i], y: ys[k], w, h };
          if (over.some((o) => overlaps(cand, o))) continue;
          best = cand;
          bestArea = area;
        }
      }
    }
  }
  return best;
}

/** The three things a surface can be told after its hole is measured. */
export type Placement =
  | { kind: "place"; bounds: Bounds }
  | { kind: "park" }
  | { kind: "wait" };

/** Decide what to do with a surface whose hole just measured `hole`.
 *
 *  `opened` is whether a surface exists yet. It is what separates the two
 *  unpaintable cases: a hole that has never been big enough is a pane still
 *  laying out and we wait for it, while a hole that *was* big and now is not
 *  is a pane that got hidden, and the surface it owns has to be moved out of
 *  the way rather than abandoned in place.
 *
 *  `shown` is the second way a hole can stop being on screen, and the one a
 *  measurement cannot see. `visibility:hidden` leaves the element's layout box
 *  exactly where it was — full width, full height, correct position — and only
 *  stops it being painted. A hole hidden that way measures as healthy as one
 *  in plain sight, so the caller has to ask the style system and say so. The
 *  agent surface hides its terminal precisely this way (to keep the PTY alive
 *  and streaming behind the readable transcript), which is how a live terminal
 *  came to be painted over the transcript it was supposed to be behind.
 *
 *  Note what `hole` means to the caller now: the rect handed in is the one the
 *  surface is to be PLACED at, which for a pane with a menu open is the clip
 *  [`clearRect`] found rather than the whole hole. That is why the paintable
 *  test here is the right place for it to be checked — a clip too small to
 *  paint is as good a reason to park as a hole too small to paint, and there
 *  is one rule for both.
 */
export function placementFor(
  hole: Bounds,
  opened: boolean,
  shown = true,
): Placement {
  if (shown && isPaintable(hole)) return { kind: "place", bounds: hole };
  return opened ? { kind: "park" } : { kind: "wait" };
}

/** Whether two boxes are the same to the nearest hundredth of a pixel.
 *
 *  The comparison exists to suppress redundant IPC on the sweep below, so it
 *  wants to ignore the sub-pixel jitter a fractional device scale puts into
 *  `getBoundingClientRect`, and nothing finer than a hundredth of a pixel can
 *  move a surface anyone can see. */
export function sameBounds(a: Bounds, b: Bounds): boolean {
  const close = (p: number, q: number) => Math.abs(p - q) < 0.01;
  return close(a.x, b.x) && close(a.y, b.y) && close(a.w, b.w) && close(a.h, b.h);
}

/** How often to re-measure a hole that nothing has reported a change to.
 *
 *  `ResizeObserver` fires on *size*, and `scroll`/`resize` listeners catch the
 *  window. Nothing fires when a hole merely *moves* — and the terminal dock is
 *  pinned to an explicit height between a work body and a composer that both
 *  change height on their own, so moving without resizing is its normal
 *  behaviour, not an edge case. This is the safety net for that: a rect read
 *  every few frames, which is also what `RailBrowser` settled on for the
 *  browser hole (400ms there) after the same class of bug.
 */
export const SWEEP_MS = 400;

// ---------------------------------------------------------------------------
// Who gets to move a surface
// ---------------------------------------------------------------------------
//
// A terminal id addresses ONE surface, but more than one pane can be mounted
// against it at the same time — the agent surface keeps a tab's terminal
// mounted while hidden so the PTY keeps streaming, and the same session can be
// on screen in a split or a popout. Each pane runs its own reconcile loop with
// its own idea of where that surface belongs, and the loops do not know about
// each other.
//
// That is enough to make the surface oscillate. A shown pane places it; a
// hidden pane parks it; each dedupes only against what IT last sent, so neither
// ever settles and the surface is yanked offscreen and back every sweep tick —
// a terminal that flickers two or three times a second for as long as both
// panes are mounted.
//
// The rule that fixes it is the obvious one once stated: a pane that is showing
// the surface owns it, and a pane that is not showing it may only park what it
// still owns. Ownership goes to the most recent pane to show it rather than the
// first, so a visible pane can never be starved by a stale or background one —
// the failure that would be worse than the flicker, since it reads as a
// terminal that is simply gone.

/** Current driver of each surface, keyed by terminal id. The value is the
 *  caller's own token — any stable object identity unique to one mounted
 *  loop — so panes are compared by identity and never by name. */
const surfaceOwner = new Map<string, object>();

/** Declare that `holder` is showing `termId` and is therefore the pane whose
 *  bounds the surface should follow. Idempotent, and cheap enough to call on
 *  every reconcile. */
export function takeSurface(termId: string, holder: object): void {
  surfaceOwner.set(termId, holder);
}

/** Give up `termId`, because this pane is hidden, collapsed or unmounting.
 *
 *  Returns whether the caller was the last pane showing the surface and must
 *  therefore park it. A `false` means some other pane is showing it right now,
 *  and parking it would take a terminal away from someone looking at it. */
export function dropSurface(termId: string, holder: object): boolean {
  if (surfaceOwner.get(termId) !== holder) return false;
  surfaceOwner.delete(termId);
  return true;
}

/** Test seam: forget all ownership. Nothing in the app calls this — a surface
 *  outlives every pane that shows it, which is the whole point of parking. */
export function resetSurfaceOwners(): void {
  surfaceOwner.clear();
}
