import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { clipboardHasImage, readClipboardText, writeClipboardText } from "../lib/clipboard";
import { keyEventToBytes } from "../lib/nativeTerminalKeys";
import { estimatedTerminalLineHeightPx } from "../lib/terminalAppearance";
import { createWheelAccumulator, wheelToLines } from "../lib/terminalWheel";
import {
  PARKED,
  SWEEP_MS,
  clearRect,
  dropSurface,
  isCovered,
  isWithheld,
  NATIVE_OVERLAYS_CHANGED,
  openOverlayRects,
  placementFor,
  sameBounds,
  surfaceHeld,
  takeSurface,
  toWindowPoints,
  webviewZoom,
  type Bounds,
} from "../lib/nativeSurfacePlacement";

/** Props are a subset of the xterm `Terminal`'s — enough to spawn a shell in
 *  the right cwd and report back the session id, or to point the pane at an
 *  agent's PTY with `attachSessionId`. The PTY lives in Rust either way, so
 *  the xterm-only session/persistence props don't apply. */
type NativeTerminalProps = {
  cwd?: string;
  repoRoot?: string;
  instanceId?: string;
  bootCommand?: string;
  /** Render an agent session's existing PTY instead of spawning a shell.
   *  `cmd_agent_pty` owns that PTY — it outlives this pane, so the pane is a
   *  second viewer: nothing here spawns it, and closing the pane detaches
   *  rather than killing the agent. `cwd` and `bootCommand` don't apply. */
  attachSessionId?: string;
  onOpened?: (ptyId: string, reconnected: boolean) => void;
  /** Fired when the native GPU surface / PTY can't be created on this machine
   *  after a couple of attempts. The parent should mount the xterm fallback so
   *  the user still gets a terminal instead of a blank hole. */
  onUnavailable?: () => void;
};

let seq = 0;

// Ids whose Rust PTY + GPU surface should survive a React unmount (a tab or
// group switch), mirroring xterm's persistent session map. A genuine tab-close
// calls releaseNativeTerminalSession() to actually tear the shell down.
const liveNativeTerms = new Set<string>();

/** Permanently close a native terminal's shell + GPU surface. The store calls
 *  this when a terminal TAB is closed — not on tab switches, which unmount the
 *  React tree but keep the session alive for reattach. No-op for ids that were
 *  never opened natively (e.g. an xterm-backed tab), so callers can fire both
 *  this and releaseTerminalSession() without knowing which engine backed it. */
export function releaseNativeTerminalSession(termId: string): void {
  if (!liveNativeTerms.has(termId)) return;
  liveNativeTerms.delete(termId);
  invoke("native_term_close", { termId }).catch(() => {});
}

const encoder = new TextEncoder();

function toBytes(text: string): number[] {
  return Array.from(encoder.encode(text));
}

/** Copy a native pane's selection to the pasteboard. `false` when there was
 *  nothing selected, or no such pane.
 *
 *  The selection lives in the Rust grid, so copying it means asking for it
 *  first — and that await is why this cannot use `navigator.clipboard`: WebKit
 *  allows a write only while the keydown's user gesture is still live, and the
 *  round-trip spends it. The write was rejected every time, into a `catch`,
 *  so ⌘C quietly copied nothing. Rust has no gesture to spend.
 *
 *  Exported because the terminal toolbar's Copy reaches for xterm's session
 *  map, and a GPU pane — the default engine — is not in it. */
export async function copyNativeTerminalSelection(termId: string): Promise<boolean> {
  if (!liveNativeTerms.has(termId)) return false;
  try {
    const text = await invoke<string>("native_term_copy", { termId });
    return text ? await writeClipboardText(text) : false;
  } catch {
    return false; /* the terminal is gone */
  }
}

/** Paste the pasteboard into a native pane. `false` when there is no such
 *  pane, so a caller can fall through to another engine.
 *
 *  Text goes to `native_term_paste`, which fences it per the child's own
 *  bracketed-paste mode — a mode only Rust can see. An image cannot go down a
 *  PTY at all, so it is forwarded as Ctrl+V for the agent CLI to read off the
 *  pasteboard itself. */
export async function pasteIntoNativeTerminal(termId: string): Promise<boolean> {
  if (!liveNativeTerms.has(termId)) return false;
  const text = await readClipboardText();
  if (text) {
    invoke("native_term_paste", { termId, text }).catch(() => {});
    return true;
  }
  if (await clipboardHasImage()) {
    invoke("native_term_write", { termId, data: [0x16] }).catch(() => {});
  }
  return true;
}

/** Clear a native pane's screen and scrollback. `false` when there is no such
 *  pane, so a caller can fall through to the xterm engine.
 *
 *  Handled by the Rust grid rather than written down the PTY: clearing the
 *  view is not a keystroke, and a `\f` would land in whatever command happens
 *  to be running in the pane. */
export async function clearNativeTerminal(termId: string): Promise<boolean> {
  if (!liveNativeTerms.has(termId)) return false;
  await invoke("native_term_clear", { termId }).catch(() => {});
  return true;
}

/** Select a native pane's whole transcript — the scrollback as well as the
 *  visible window, which is what makes ⌘A then ⌘C worth having. */
export async function selectAllNativeTerminal(termId: string): Promise<boolean> {
  if (!liveNativeTerms.has(termId)) return false;
  await invoke("native_term_select_all", { termId }).catch(() => {});
  return true;
}

/** Where a find stands in a native pane: the zero-based current hit and how
 *  many there are. `null` means the pane is not native, so the caller should
 *  try the other engine. */
export type NativeFindResult = { index: number; total: number };

/** Run a find over a native pane's buffer, highlight the hits in the GPU
 *  grid, and scroll the first hit at or after the viewport into view.
 *
 *  Rejects with the regex error message when `regex` is on and the pattern
 *  will not compile — a pattern that cannot be parsed is a different thing
 *  from one that matched nothing, and the widget shows them differently. */
export async function findInNativeTerminal(
  termId: string,
  query: string,
  opts: { caseSensitive?: boolean; wholeWord?: boolean; regex?: boolean } = {},
): Promise<NativeFindResult | null> {
  if (!liveNativeTerms.has(termId)) return null;
  return invoke<NativeFindResult>("native_term_find", {
    termId,
    query,
    caseSensitive: opts.caseSensitive ?? false,
    wholeWord: opts.wholeWord ?? false,
    regex: opts.regex ?? false,
  });
}

/** Step to the next (`forward`) or previous hit in a native pane, wrapping at
 *  either end, and scroll it into view. */
export async function stepNativeTerminalFind(
  termId: string,
  forward: boolean,
): Promise<NativeFindResult | null> {
  if (!liveNativeTerms.has(termId)) return null;
  return invoke<NativeFindResult>("native_term_find_step", { termId, forward }).catch(
    () => null,
  );
}

/** Drop a native pane's query and its highlights (the widget closing). */
export async function clearNativeTerminalFind(termId: string): Promise<boolean> {
  if (!liveNativeTerms.has(termId)) return false;
  await invoke("native_term_find_clear", { termId }).catch(() => {});
  return true;
}

/** Subscribe to a native pane's live match count.
 *
 *  The count moves without anyone touching the widget — new output matches the
 *  query, or matched lines scroll out of the scrollback — so the engine pushes
 *  it and nothing here polls. Returns an unsubscribe function; note that the
 *  listener is registered asynchronously, so unsubscribing before it lands is
 *  honoured once it does. */
export function onNativeTerminalFind(
  termId: string,
  cb: (result: NativeFindResult) => void,
): () => void {
  let unlisten: UnlistenFn | null = null;
  let cancelled = false;
  listen<{ termId: string; index: number; total: number }>("native-term:find", (evt) => {
    if (evt.payload.termId !== termId) return;
    cb({ index: evt.payload.index, total: evt.payload.total });
  })
    .then((u) => {
      if (cancelled) u();
      else unlisten = u;
    })
    .catch(() => {});
  return () => {
    cancelled = true;
    unlisten?.();
  };
}

/**
 * A terminal rendered by the native wgpu engine (cmd_native_term) instead of
 * xterm.js. It leaves a transparent DOM hole and asks the Rust side to
 * composite a GPU surface over that rect — the same hole + `set_bounds`
 * choreography the in-app browser uses. Keyboard/paste/wheel/focus are captured
 * on the hole and forwarded to the shell; the surface itself paints in Rust.
 */
export function NativeTerminal({
  cwd,
  repoRoot,
  instanceId,
  bootCommand,
  attachSessionId,
  onOpened,
  onUnavailable,
}: NativeTerminalProps) {
  const holeRef = useRef<HTMLDivElement>(null);
  // A trackpad's sub-line deltas have to survive between events or a slow
  // scroll rounds to nothing every time.
  const wheelAccumRef = useRef(createWheelAccumulator());
  const termIdRef = useRef<string>(instanceId ?? `native-term-${(seq += 1)}`);
  // The callbacks are held in refs and kept OUT of the effect's deps on
  // purpose. They are notifications, not inputs: nothing about the surface
  // changes when the parent hands us a different closure. Depending on them
  // meant a caller that passed an inline arrow (`onUnavailable={() =>
  // setNative(false)}`) re-ran this effect on every render — parking the
  // surface offscreen and re-opening it each time, which showed up as agent
  // panes that painted black and a log alternating forever between the real
  // rect and (-100000,-100000). A surface's lifetime must not hinge on a
  // parent's render identity.
  const onOpenedRef = useRef(onOpened);
  onOpenedRef.current = onOpened;
  const onUnavailableRef = useRef(onUnavailable);
  onUnavailableRef.current = onUnavailable;
  // Mouse-selection drag state. `selStart` is the down position; `selecting`
  // flips true on the first move so a plain click just clears the selection.
  const selStart = useRef<{ fx: number; fy: number } | null>(null);
  const selecting = useRef(false);

  useEffect(() => {
    const hole = holeRef.current;
    if (!hole) return;
    const el: HTMLDivElement = hole; // non-null alias so nested closures keep the narrowing
    const termId = termIdRef.current;

    let cancelled = false;
    let opened = false;
    // This loop's identity in the surface-owner registry. Scoped to the effect
    // so a remount is a different pane as far as ownership is concerned, which
    // is exactly right: the old loop's cleanup hands the surface back.
    const token = {};
    // What the surface was last told, both halves of it: the hole it is sized
    // against and the sub-rect of that hole it is actually showing. Kept apart
    // because they move independently — a menu opening changes only the clip,
    // a neighbour growing changes only the hole — and either one changing is a
    // reason to send.
    let lastHole: Bounds | null = null;
    let lastClip: Bounds | null = null;
    let raf = 0;
    // Outstanding post-gesture re-reads (see `scheduleOverlayCheck`). Held so
    // unmount can cancel them: a reconcile that lands after the surface has
    // been parked would un-park it against a hole that is gone.
    const overlayTimers = new Set<number>();
    let unlistenClosed: UnlistenFn | null = null;
    // The pane is already laid out (guarded below) before we call open, so a
    // rejection here is a genuine backend failure — the GPU surface or PTY
    // couldn't be created — not a timing hiccup. Tolerate one transient retry,
    // then hand the pane to the xterm fallback rather than looping forever into
    // a blank transparent hole.
    let openFailures = 0;
    const MAX_OPEN_FAILURES = 2;

    const scale = () => window.devicePixelRatio || 1;
    /** The hole, in the window points the GPU surface is placed with.
     *
     *  `getBoundingClientRect` answers in CSS px, and the surface is a sibling
     *  of the webview rather than a box inside it, so it is positioned in the
     *  window's own space. Those two units part company the moment the user
     *  zooms: at 130% the pane is measured 2116 CSS px wide but occupies 2751
     *  points, and a surface handed the CSS number paints a terminal three
     *  quarters of the pane with a dead strip down the right — the content
     *  short on every side at once, because the same factor is missing from
     *  the origin too.
     *
     *  Takes the measurement and the zoom rather than reading them, because a
     *  reconcile has to convert two boxes against the same frame — the hole,
     *  and the clip within it that the overlay policy worked out from the same
     *  measurement — and re-reading either one between the two conversions
     *  would let a box land in a different frame from the box it is part of.
     */
    function rect(css: Bounds, zoom: number): Bounds {
      return toWindowPoints(css, zoom);
    }

    /** The hole as the DOM sees it: CSS px, viewport origin. What
     *  `elementFromPoint` expects, and the unscaled half of `rect()`. */
    function clientRect(): Bounds {
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    }

    /** Whether the hole is actually being painted, as opposed to merely having
     *  a box. A measurement cannot tell the difference: `visibility:hidden`
     *  leaves the element exactly where it was, full size, and only stops it
     *  being drawn. `visibility` inherits, so the computed value here already
     *  accounts for an ancestor hiding the whole pane — which is how the agent
     *  surface swaps its terminal for the readable transcript, deliberately,
     *  so the PTY keeps streaming behind it. Nothing about that reaches a
     *  surface that is the webview's sibling, so it has to be asked.
     *
     *  And the hole can be in plain sight and still show nothing, because a
     *  page is drawn over it. The router mounts places (Tasks, Trace, Pages)
     *  as an opaque layer over the work body and leaves what was underneath
     *  mounted and visible — correct for DOM content, which the layer covers,
     *  and invisible to a native surface that paints above the whole webview.
     *  That is the one that put a live terminal over the Tasks board.
     *
     *  An overlay across only PART of the hole is deliberately NOT this
     *  question. It used to be: a menu that cleared four of the five samples
     *  was treated as a hole that had stopped being shown, the surface was
     *  parked, and the pane went black for as long as the menu was up. That
     *  is the regression. Partial cover is a question about geometry, not
     *  about whether this hole exists, and `clearRect` answers it in
     *  `reconcile` below by working out which part of the hole is still free.
     *  What stays here is the all-or-nothing case, which no geometry can
     *  answer because the thing doing the covering is an ordinary page the
     *  router mounted and never registered as an overlay. */
    function isShown(): boolean {
      // The shell says so outright when a page covers the work surface or the
      // transcript replaces this terminal: the subtree is `inert`. Asked first
      // because it is a fact rather than an inference. `visibility` cannot say
      // it for a page: a descendant's own `visibility: visible` (the agent
      // pane sets one) wins over an ancestor's `hidden`.
      if (isWithheld(el)) return false;
      if (getComputedStyle(el).visibility !== "visible") return false;
      return !isCovered(el, clientRect(), (x, y) => document.elementFromPoint(x, y));
    }

    /** Send the surface offscreen without asking what this loop last sent —
     *  for the two paths that run after the loop has stopped tracking it. */
    function parkNow() {
      invoke("native_term_set_bounds", {
        termId,
        x: PARKED.x,
        y: PARKED.y,
        width: PARKED.w,
        height: PARKED.h,
        clip: { x: PARKED.x, y: PARKED.y, w: PARKED.w, h: PARKED.h },
        scale: 1,
      }).catch(() => {});
    }

    /** Size the surface against the hole `b` and show the part of it `clip`
     *  names, skipping a pair it has already been given. The dedupe is what
     *  makes the periodic sweep below almost free: a hole that has not moved
     *  costs one rect read and no IPC.
     *
     *  Two rects rather than one because they mean different things to the
     *  Rust side. The hole decides the grid — how many columns and rows the
     *  shell is told it has — and must therefore not change when a menu
     *  opens, or every TUI in the app would re-lay itself out twice per menu
     *  click. The clip decides only which part of that grid the native view
     *  covers. Hand the same rect for both and this is exactly the call it
     *  always was. */
    function moveTo(b: Bounds, clip: Bounds) {
      if (lastHole && lastClip && sameBounds(lastHole, b) && sameBounds(lastClip, clip)) return;
      lastHole = b;
      lastClip = clip;
      invoke("native_term_set_bounds", {
        termId,
        x: b.x,
        y: b.y,
        width: b.w,
        height: b.h,
        clip: { x: clip.x, y: clip.y, w: clip.w, h: clip.h },
        scale: scale(),
      }).catch(() => {});
    }

    async function reconcile() {
      if (cancelled) return;
      const zoom = webviewZoom();
      const holeCss = clientRect();
      const hole = rect(holeCss, zoom);
      // How much of the hole is left over once every open menu, popover and
      // dialog has had its rectangle. Null means an overlay has taken the
      // whole pane, and only then does the surface go away — the pane is a
      // backdrop at that point and there is nothing to read behind the sheet.
      // Anything else is a clip: the terminal keeps running at `hole`'s size
      // and the native view steps off the part the sheet needs.
      const clipCss = isShown() ? clearRect(holeCss, openOverlayRects()) : null;
      // `placementFor` is asked about the CLIP, because the clip is the box the
      // surface will occupy, and a clip too small to paint has to park for the
      // same reason a collapsed hole does. When there is no clip the rect it
      // gets is not read at all: `shown` is false, which is already the whole
      // answer.
      const place = placementFor(clipCss ? rect(clipCss, zoom) : hole, opened, !!clipCss);
      // Not laid out yet — opening a 0×0 surface would spawn a shell sized 1×1
      // and thrash on the first real resize.
      if (place.kind === "wait") return;
      // The hole has stopped being shown — four ways, all of which the page
      // considers settled and none of which reaches a surface that is the
      // webview's sibling rather than its child: an ancestor went
      // `display:none` (the work body does precisely that when the terminal
      // dock is maximized), the pane collapsed to nothing, an ancestor went
      // `visibility:hidden` (how the agent surface swaps its terminal for the
      // readable transcript while leaving the PTY streaming), or an opaque
      // page was mounted over it. Leaving the surface put a live terminal over
      // the dock's own chrome in the first case, over the transcript in the
      // third and over the Tasks board in the fourth.
      //
      // A menu over the pane is NOT one of them any more. That is the whole
      // point of the clip above: a sheet over part of a terminal takes that
      // part of the rectangle and leaves the rest running.
      if (place.kind === "park") {
        // ...but only if nobody else is showing it. One terminal id addresses
        // one surface, and more than one pane can be mounted against it (a
        // hidden tab keeping its PTY alive, the same session in a split or a
        // popout). Each loop dedupes against what it alone last sent, so a
        // hidden pane parking what a shown pane just placed never settles —
        // the surface flickers offscreen and back every sweep tick.
        //
        // A surface nobody owns is parked as well. Nobody is showing it, so it
        // can only be on screen because a placement landed after its pane
        // stepped away — an attach that resolved after the pane had parked —
        // and left alone it paints over the page that replaced the pane for as
        // long as the page is up.
        if (dropSurface(termId, token) || !surfaceHeld(termId)) moveTo(PARKED, PARKED);
        // Someone else owns the bounds now, so what we last sent says nothing
        // about where the surface is; forget it, or we would skip the move
        // that puts it back under us when this pane is shown again.
        else {
          lastHole = null;
          lastClip = null;
        }
        return;
      }
      // What `placementFor` approved is the clip — the box the native view
      // will cover. The hole it is a part of is `hole`, computed above, and
      // that is what sizes the shell.
      const clip = place.bounds;
      // Showing it makes us the pane it follows. Most-recent-wins rather than
      // first-wins: a visible pane must never be starved by a background one.
      takeSurface(termId, token);

      if (!opened) {
        opened = true;
        // Reattach when the Rust side already holds this PTY — a remount after a
        // tab/group switch. `native_term_open` is idempotent (it just
        // repositions an existing surface), so we must NOT re-run the boot
        // command; we only mark the reconnection.
        const reattach = liveNativeTerms.has(termId);
        try {
          // Both commands are idempotent for an id this manager already holds
          // (they reposition the existing surface), which is what makes a
          // remount after a tab switch cheap.
          await invoke(attachSessionId ? "native_term_attach" : "native_term_open", {
            termId,
            ...(attachSessionId
              ? { sessionId: attachSessionId }
              : { cwd: cwd ?? repoRoot ?? null }),
            // The HOLE, never the clip. This call is what sizes the shell, and
            // a terminal must not be born with the columns a menu happened to
            // leave it — the menu closes a second later and the shell would
            // keep them.
            x: hole.x,
            y: hole.y,
            width: hole.w,
            height: hole.h,
            scale: scale(),
          });
          // Register before the cancel check so an unmount mid-open still parks
          // (not closes) the session — the cleanup below keys off this set.
          liveNativeTerms.add(termId);
          if (cancelled) {
            // The pane went away while the attach was in flight, and the
            // attach has just placed the surface at a hole that is gone. The
            // cleanup could not park it (it was not live yet), so do it here —
            // unless a newer pane has already taken it.
            if (!surfaceHeld(termId)) parkNow();
            return;
          }
          // Take the keyboard the moment the pane is live, the way xterm does
          // on mount. Keys only reach the shell through this hole's handlers,
          // so without it a terminal that just appeared — or an agent putting
          // a permission prompt on screen — swallows everything you type
          // while looking perfectly ready for it.
          //
          // Only when nothing else holds it. A pane opening is not a reason to
          // interrupt someone mid-sentence: a terminal that came up in the
          // dock behind an agent tab used to pull the caret out of whatever
          // the user was typing into, and the rest of the sentence went to a
          // shell. Grab an idle keyboard, never a busy one.
          try {
            const active = document.activeElement;
            if (!active || active === document.body) el.focus();
          } catch {
            /* detached mid-open */
          }
          onOpenedRef.current?.(termId, reattach);
          // An attached pane has nothing to boot: the agent was already
          // running before this pane existed.
          if (bootCommand && !reattach && !attachSessionId) {
            const cmd = bootCommand.endsWith("\n") ? bootCommand : `${bootCommand}\n`;
            window.setTimeout(() => {
              invoke("native_term_write", { termId, data: toBytes(cmd) }).catch(() => {});
            }, 250);
          }
        } catch {
          opened = false;
          openFailures += 1;
          if (openFailures >= MAX_OPEN_FAILURES) {
            // wgpu / PTY can't come up on this machine — stop retrying and let
            // the parent swap in xterm so the user still gets a shell.
            onUnavailableRef.current?.();
            return;
          }
          // Force one more attempt next frame instead of waiting for an
          // incidental resize/scroll tick.
          schedule();
          return;
        }
        // `open` placed the view at the whole hole, so that is what the
        // surface has been told.
        lastHole = hole;
        lastClip = hole;
        // ...and if something was already open over the pane when it came up,
        // clip it now rather than at the next sweep tick. A no-op in the
        // ordinary case, where the clip IS the hole and `moveTo` drops it.
        moveTo(hole, clip);
        // Everything above was decided before the await. A page may have been
        // drawn over the pane while the attach was in flight, so decide again
        // now rather than leave the surface where that decision put it.
        schedule();
        return;
      }

      moveTo(hole, clip);
    }

    function schedule() {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        void reconcile();
      });
    }

    /** Re-measure after a gesture that may have OPENED an overlay.
     *
     *  `schedule` is wrong for this on its own, and measurement rather than
     *  reasoning says so: right-clicking a project row put the menu in the
     *  document 9ms later, but the surface only moved at 261ms — the frame
     *  this would have reconciled on had already been claimed, so the 400ms
     *  sweep ended up doing the work and the terminal spent a quarter of a
     *  second painting over the menu. Two things make one frame unreliable
     *  here: React commits the overlay in its own microtask after the handler
     *  returns, and `schedule` coalesces onto any frame already pending, so a
     *  reconcile booked by something else a moment earlier swallows this one.
     *
     *  So an overlay-opening gesture reads twice more, past the coalescing:
     *  once on the next macrotask, by which point the commit and layout have
     *  both happened, and once after the open animation has had time to run,
     *  because a sheet that is still scaling up from `zoom-in-95` reports a
     *  box several percent small and the first read would clip to the wrong
     *  rectangle. `moveTo` drops whichever of the reads finds nothing new, so
     *  the cost of being early is nothing.
     */
    function scheduleOverlayCheck() {
      schedule();
      for (const delay of [0, 140]) {
        const t = window.setTimeout(() => {
          overlayTimers.delete(t);
          void reconcile();
        }, delay);
        overlayTimers.add(t);
      }
    }

    void reconcile();

    const ro = new ResizeObserver(schedule);
    ro.observe(el);
    // Being hidden and being shown again are both attribute edits that change
    // no geometry whatsoever, so `ResizeObserver` is silent for each. Without
    // this the surface would come back a sweep tick late — a visible stutter
    // every time someone flips between the transcript and the terminal, which
    // is the single most-used control on the pane. `visibility` and `display`
    // inherit down from wherever they are set, so the watch has to cover the
    // ancestors, not just the hole.
    const attrs = new MutationObserver(schedule);
    for (let p: HTMLElement | null = el; p; p = p.parentElement) {
      attrs.observe(p, { attributes: true, attributeFilter: ["style", "class", "hidden", "inert"] });
    }
    // Capture-phase so any scrolling ancestor (panes, split views) re-aligns the
    // surface, not just the window.
    window.addEventListener("resize", schedule, true);
    window.addEventListener("scroll", schedule, true);
    // An overlay opening over the hole changes nothing the observers above
    // watch: it is mounted somewhere else in the tree (a portal on <body>, or
    // the tab strip next door), and the hole's own box never moves. Only the
    // sweep would notice, up to 400ms later, which on a menu is the whole
    // interaction — you would click "+" and read the panel through a terminal
    // for a third of a second. Nobody opens a menu without a click or a key,
    // so those are the signal.
    //
    // CAPTURE phase, and that is the whole reason these work. In bubble phase
    // they saw almost nothing: React attaches its listeners at the root
    // container, so a React handler that calls `e.stopPropagation()` ends the
    // native event there and `window` is never reached — and nearly every
    // menu-opening handler in this app does exactly that, the roster's
    // `openProjectMenu` among them, to stop the click also selecting the row
    // it was aimed at. Measured before the change: a right-click put the menu
    // in the document after 9ms, and the surface moved after 272ms, by the
    // 400ms sweep, having never been told. Capture runs before any of that
    // and nothing downstream can cancel it.
    //
    // Which is also why these cannot just book a frame: in capture phase the
    // overlay does not exist yet, so `scheduleOverlayCheck` reads again once
    // React has committed it.
    window.addEventListener("click", scheduleOverlayCheck, true);
    window.addEventListener("keyup", scheduleOverlayCheck, true);
    // And a right-click opens one without ever firing `click`, which is the
    // path for both of the menus the user reported: the agent tab's context
    // menu and the roster's.
    window.addEventListener("contextmenu", scheduleOverlayCheck, true);
    // A toast opens and closes with no gesture at all — a download finishing,
    // a timer running out — so the stack announces it instead.
    window.addEventListener(NATIVE_OVERLAYS_CHANGED, scheduleOverlayCheck);
    // The safety net, and it is not optional. Everything above reports a hole
    // that RESIZES or a window that moves under it; nothing in the platform
    // reports a hole that merely MOVES. For this pane that is the common case
    // rather than the exotic one: the dock is pinned to an explicit height
    // between a work body and a composer that each change height on their own,
    // so a neighbour growing slides the hole down while its own box never
    // changes and no observer fires. The browser hole reached the same
    // conclusion (`BrowserTab`, 400ms) after the same class of bug. A tick
    // costs one rect read, and `moveTo` drops it when nothing moved.
    const sweep = window.setInterval(schedule, SWEEP_MS);
    // A surface cannot paint while the window is hidden, so the sweep above
    // achieves nothing until it is back — but the app may well have relaid out
    // in the meantime. Re-measure on the way in rather than waiting a tick.
    document.addEventListener("visibilitychange", schedule);

    listen<{ termId: string }>("native-term:closed", (evt) => {
      if (evt.payload.termId === termId) {
        // The shell itself exited (e.g. the user typed `exit`) — the session is
        // genuinely gone, so drop it from the live set and tear the surface
        // down. Won't be parked/reattached after this.
        liveNativeTerms.delete(termId);
        invoke("native_term_close", { termId }).catch(() => {});
      }
    }).then((u) => {
      if (cancelled) u();
      else unlistenClosed = u;
    });

    return () => {
      cancelled = true;
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
      attrs.disconnect();
      window.clearInterval(sweep);
      window.removeEventListener("resize", schedule, true);
      window.removeEventListener("scroll", schedule, true);
      window.removeEventListener("click", scheduleOverlayCheck, true);
      window.removeEventListener("keyup", scheduleOverlayCheck, true);
      window.removeEventListener("contextmenu", scheduleOverlayCheck, true);
      window.removeEventListener(NATIVE_OVERLAYS_CHANGED, scheduleOverlayCheck);
      for (const t of overlayTimers) window.clearTimeout(t);
      overlayTimers.clear();
      document.removeEventListener("visibilitychange", schedule);
      unlistenClosed?.();
      // Persist across tab/group switches like xterm: keep the Rust PTY + GPU
      // surface alive and just park it far offscreen so it stops painting over
      // whatever pane replaced it. Reattaches (repositions) on the next mount.
      // A real tab-close routes through releaseNativeTerminalSession() instead.
      // Guarded by ownership for the same reason the park above is: another
      // pane may already be showing this surface (a split, or a remount whose
      // new loop started before this cleanup ran), and parking it then would
      // blank a terminal someone is looking at.
      //
      // Ownership is handed back whether or not the surface is live yet. A
      // pane unmounted mid-attach used to keep it, and a surface held by a
      // pane that no longer exists can never be parked by anyone else.
      const mine = dropSurface(termId, token);
      if (mine && liveNativeTerms.has(termId)) parkNow();
    };
    // Only the things that describe WHICH terminal this is. See the refs above
    // for why the callbacks are deliberately absent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, repoRoot, bootCommand, attachSessionId]);

  const copySelection = () => copyNativeTerminalSelection(termIdRef.current);
  const pasteClipboard = () => pasteIntoNativeTerminal(termIdRef.current);

  function onKeyDown(e: React.KeyboardEvent) {
    const key = e.key.toLowerCase();
    // Copy: ⌘C (macOS) or Ctrl+Shift+C (Linux). Intercept before the VT encoder
    // so Ctrl+Shift+C never leaks a SIGINT to the shell.
    const isCopy =
      (e.metaKey && key === "c" && !e.ctrlKey && !e.altKey) ||
      (e.ctrlKey && e.shiftKey && key === "c" && !e.metaKey);
    if (isCopy) {
      e.preventDefault();
      void copySelection();
      return;
    }
    // Paste: ⌘V (macOS) or Ctrl+Shift+V (Linux).
    //
    // ⌘V used to be left to "the native paste event", which never arrives:
    // the hole is a plain div, and WebKit will not dispatch a paste to an
    // element it cannot edit. The keystroke reached nothing that could service
    // `paste:`, so AppKit rang the bell — the error beep with nothing pasted.
    const isPaste =
      (e.metaKey && key === "v" && !e.ctrlKey && !e.altKey) ||
      (e.ctrlKey && e.shiftKey && key === "v" && !e.metaKey);
    if (isPaste) {
      e.preventDefault();
      void pasteClipboard();
      return;
    }
    const bytes = keyEventToBytes(e.nativeEvent);
    if (bytes == null) return;
    e.preventDefault();
    invoke("native_term_write", {
      termId: termIdRef.current,
      data: toBytes(bytes),
    }).catch(() => {});
  }

  function fracFromEvent(e: React.PointerEvent): { fx: number; fy: number } {
    const el = holeRef.current;
    if (!el) return { fx: 0, fy: 0 };
    const r = el.getBoundingClientRect();
    const fx = r.width > 0 ? (e.clientX - r.left) / r.width : 0;
    const fy = r.height > 0 ? (e.clientY - r.top) / r.height : 0;
    const clamp = (n: number) => Math.min(1, Math.max(0, n));
    return { fx: clamp(fx), fy: clamp(fy) };
  }

  function onPointerDown(e: React.PointerEvent) {
    if (e.button !== 0) return; // left button only
    e.currentTarget.setPointerCapture(e.pointerId);
    selStart.current = fracFromEvent(e);
    selecting.current = false;
    // A fresh click dismisses the previous selection; a drag will start a new one.
    invoke("native_term_select", {
      termId: termIdRef.current,
      phase: "clear",
      fx: 0,
      fy: 0,
    }).catch(() => {});
  }

  function onPointerMove(e: React.PointerEvent) {
    const start = selStart.current;
    if (!start) return;
    const at = fracFromEvent(e);
    if (!selecting.current) {
      selecting.current = true;
      invoke("native_term_select", {
        termId: termIdRef.current,
        phase: "start",
        fx: start.fx,
        fy: start.fy,
      }).catch(() => {});
    }
    invoke("native_term_select", {
      termId: termIdRef.current,
      phase: "move",
      fx: at.fx,
      fy: at.fy,
    }).catch(() => {});
  }

  function onPointerUp(e: React.PointerEvent) {
    if (selStart.current) {
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        /* capture already gone */
      }
    }
    selStart.current = null;
    selecting.current = false;
  }

  // A paste that does arrive as an event — a middle-click on X11, a context
  // menu — takes the same encoder as the shortcut rather than writing the raw
  // text, so a multiline paste behaves the same however it got here.
  function onPaste(e: React.ClipboardEvent) {
    const text = e.clipboardData.getData("text");
    if (!text) return;
    e.preventDefault();
    invoke("native_term_paste", { termId: termIdRef.current, text }).catch(() => {});
  }

  function onWheel(e: React.WheelEvent) {
    // On macOS this does not run: the GPU surface is the view under the
    // pointer and takes the wheel itself, because getting the event this far
    // depends on the webview, the page and WebKit's own gesture handling all
    // staying out of the way. Everywhere else the hole is what hears a wheel,
    // and this is the path.
    //
    // Wheel up (deltaY < 0) scrolls back into scrollback (positive lines);
    // wheel down returns toward the live prompt.
    const lines = wheelToLines(e, wheelAccumRef.current, estimatedTerminalLineHeightPx());
    if (lines === 0) return;
    invoke("native_term_scroll", { termId: termIdRef.current, lines }).catch(() => {});
  }

  function onFocus() {
    invoke("native_term_focus", { termId: termIdRef.current, focused: true }).catch(() => {});
  }

  function onBlur() {
    invoke("native_term_focus", { termId: termIdRef.current, focused: false }).catch(() => {});
  }

  return (
    <div
      ref={holeRef}
      tabIndex={0}
      role="textbox"
      aria-label="Terminal"
      onKeyDown={onKeyDown}
      onPaste={onPaste}
      onWheel={onWheel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onFocus={onFocus}
      onBlur={onBlur}
      data-native-term=""
      style={{
        width: "100%",
        height: "100%",
        outline: "none",
        background: "transparent",
        cursor: "text",
      }}
    />
  );
}
