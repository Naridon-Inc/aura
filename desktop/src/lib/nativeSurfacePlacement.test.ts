// The claim under test: a surface that can't be seen gets moved, not left.
//
// The DOM can hide a native terminal's hole without telling anyone and without
// clipping the surface that fills it, so the only thing standing between a
// hidden pane and a live terminal painting over the rest of the app is the
// distinction these cases draw — between a hole that is not ready yet and a
// hole that has been taken away.

import { beforeEach, describe, expect, it } from "bun:test";

import {
  OVERLAY_SELECTOR,
  PARKED,
  SWEEP_MS,
  clearRect,
  dropSurface,
  isCovered,
  isPaintable,
  openOverlayRects,
  placementFor,
  parseZoom,
  resetSurfaceOwners,
  sameBounds,
  takeSurface,
  toWindowPoints,
  webviewZoom,
  type Bounds,
} from "./nativeSurfacePlacement";

const hole = (w: number, h: number, x = 10, y = 20): Bounds => ({ x, y, w, h });

describe("placementFor", () => {
  it("places a surface over a hole that is being shown", () => {
    const b = hole(600, 300);
    expect(placementFor(b, true)).toEqual({ kind: "place", bounds: b });
    expect(placementFor(b, false)).toEqual({ kind: "place", bounds: b });
  });

  it("waits, rather than opening, while a pane is still laying out", () => {
    // A 0×0 hole before first layout. Opening here would size the shell 1×1
    // and make it thrash on the first real resize, so nothing happens yet.
    expect(placementFor(hole(0, 0), false)).toEqual({ kind: "wait" });
  });

  it("parks a surface whose hole has been taken away", () => {
    // This is the bug. `display:none` on an ancestor — which is what maximizing
    // the terminal dock does to the whole work body — leaves the element
    // measuring 0×0. A surface told nothing goes on painting where it was, over
    // whatever the app drew instead.
    expect(placementFor(hole(0, 0), true)).toEqual({ kind: "park" });
  });

  it("parks a pane that collapsed to a hairline rather than to nothing", () => {
    // A flex child squeezed to a sliver is as invisible as a hidden one, and a
    // 1px surface is a 1-column shell. Both sides of the axis count.
    expect(placementFor(hole(1, 300), true)).toEqual({ kind: "park" });
    expect(placementFor(hole(600, 1), true)).toEqual({ kind: "park" });
  });

  it("re-places a parked surface as soon as its hole comes back", () => {
    // The return journey, which is why parking beats closing: the PTY and the
    // GPU surface are still there and only the box has to change.
    const back = hole(600, 300);
    expect(placementFor(back, true)).toEqual({ kind: "place", bounds: back });
  });

  it("parks a hole that is full size and simply not being painted", () => {
    // The one a measurement cannot catch. `visibility:hidden` keeps the box
    // intact — same position, same size, perfectly healthy rect — and only
    // stops it being drawn. This is how the agent surface puts its terminal
    // away while leaving the PTY streaming behind the transcript, so a
    // surface that trusted the rect painted a live terminal on top of the
    // transcript the user had just switched to.
    expect(placementFor(hole(2116, 1009), true, false)).toEqual({ kind: "park" });
  });

  it("does not open a surface behind a pane that is hidden from the start", () => {
    // Hidden and never opened is still "wait": an agent tab that opens on the
    // transcript has a terminal hole measuring full size from the first frame,
    // and booting a GPU surface for it would put one on screen immediately.
    expect(placementFor(hole(2116, 1009), false, false)).toEqual({ kind: "wait" });
  });

  it("brings the surface straight back when the pane is painted again", () => {
    const back = hole(2116, 1009);
    expect(placementFor(back, true, true)).toEqual({ kind: "place", bounds: back });
  });

  it("treats a shown hole the same whether or not the caller says so", () => {
    // The default keeps every existing caller honest: omitting the flag must
    // not quietly mean "hidden".
    const b = hole(600, 300);
    expect(placementFor(b, true)).toEqual(placementFor(b, true, true));
  });
});

describe("isPaintable", () => {
  it("accepts the smallest hole that could hold a terminal", () => {
    expect(isPaintable(hole(2, 2))).toBe(true);
    expect(isPaintable(hole(1, 2))).toBe(false);
    expect(isPaintable(hole(2, 1))).toBe(false);
  });
});

describe("sameBounds", () => {
  it("treats sub-pixel jitter as no movement", () => {
    // A fractional device scale perturbs getBoundingClientRect below anything
    // anyone can see; re-sending it would mean IPC on every sweep tick forever.
    expect(sameBounds(hole(600, 300), { x: 10.001, y: 20, w: 600, h: 300 })).toBe(true);
  });

  it("notices a hole that moved without resizing", () => {
    // The case no observer reports: same size, different place. If this
    // compared equal the safety net would never fire and the surface would
    // stay behind.
    expect(sameBounds(hole(600, 300, 10, 20), hole(600, 300, 10, 160))).toBe(false);
  });

  it("notices a resize that kept the origin", () => {
    expect(sameBounds(hole(600, 300), hole(600, 220))).toBe(false);
  });

  it("separates a real box from the parking spot", () => {
    expect(sameBounds(hole(600, 300), PARKED)).toBe(false);
  });
});

describe("SWEEP_MS", () => {
  it("re-measures fast enough that a misplaced surface is not a visible state", () => {
    // Not a style preference: a surface in the wrong place is wrong on screen
    // until the next tick, so this bounds how long anyone can see it. Half a
    // second is about the limit of what reads as "it was never wrong".
    expect(SWEEP_MS).toBeLessThanOrEqual(500);
    expect(SWEEP_MS).toBeGreaterThanOrEqual(100);
  });
});

describe("surface ownership", () => {
  beforeEach(resetSurfaceOwners);

  const TERM = "agent-abc";

  it("lets the only pane showing a surface park it", () => {
    const solo = {};
    takeSurface(TERM, solo);
    expect(dropSurface(TERM, solo)).toBe(true);
  });

  it("stops a hidden pane parking a surface another pane is showing", () => {
    // The flicker, exactly: an agent tab keeps its terminal mounted-but-hidden
    // so the PTY keeps streaming, while a second pane shows the same session.
    // Both loops sweep; each dedupes only against what it alone last sent. The
    // hidden one must not win, or the surface oscillates offscreen and back
    // two or three times a second for as long as both are mounted.
    const shown = {};
    const hidden = {};
    takeSurface(TERM, shown);
    expect(dropSurface(TERM, hidden)).toBe(false);
    // ...and the showing pane still owns it afterwards.
    expect(dropSurface(TERM, shown)).toBe(true);
  });

  it("hands the surface to the pane that shows it most recently", () => {
    // Most-recent-wins, not first-wins. A stale or background pane holding the
    // surface against a visible one reads as a terminal that is simply gone,
    // which is worse than the flicker this registry exists to stop.
    const first = {};
    const second = {};
    takeSurface(TERM, first);
    takeSurface(TERM, second);
    expect(dropSurface(TERM, first)).toBe(false);
    expect(dropSurface(TERM, second)).toBe(true);
  });

  it("does not park a surface for a pane that never showed it", () => {
    expect(dropSurface(TERM, {})).toBe(false);
  });

  it("keeps surfaces apart by terminal id", () => {
    const dock = {};
    const agent = {};
    takeSurface("dock", dock);
    takeSurface(TERM, agent);
    expect(dropSurface("dock", agent)).toBe(false);
    expect(dropSurface("dock", dock)).toBe(true);
    expect(dropSurface(TERM, agent)).toBe(true);
  });

  it("survives a remount: the new loop owns it, the old cleanup cannot park it", () => {
    // A tab switch remounts the pane. React may start the new effect before
    // the old one's cleanup runs, and the cleanup parks on its way out — so
    // without this the surface would be parked immediately after the pane it
    // belongs to was put back on screen.
    const oldLoop = {};
    const newLoop = {};
    takeSurface(TERM, oldLoop);
    takeSurface(TERM, newLoop);
    expect(dropSurface(TERM, oldLoop)).toBe(false);
  });
});

describe("toWindowPoints", () => {
  it("leaves a measurement alone at 100%", () => {
    // The overwhelmingly common case, and the one that must stay free: no
    // arithmetic, and the same object shape the placement logic already takes.
    const b = hole(600, 300);
    expect(toWindowPoints(b, 1)).toEqual(b);
  });

  it("scales the origin as well as the size", () => {
    // This is the bug. Only multiplying w/h would leave the surface the right
    // SIZE in the wrong PLACE — still overlapping the sidebar on the left and
    // still short of the rail on the right, which looks like the same defect
    // and is why the gutter read as a sizing problem rather than a unit one.
    expect(toWindowPoints({ x: 10, y: 20, w: 600, h: 300 }, 1.5)).toEqual({
      x: 15,
      y: 30,
      w: 900,
      h: 450,
    });
  });

  it("reproduces the measured 130% agent pane", () => {
    // The real numbers off the failing window: a 3440pt-wide window at 130%,
    // where the hole measured 2116x1009 CSS px at (226,70) and the pane the
    // user could see ran from 294 to 3045. Before the conversion the surface
    // was placed at the CSS numbers verbatim, leaving a 704pt dead strip
    // between the terminal's right edge and the file rail.
    const placed = toWindowPoints({ x: 226, y: 70, w: 2116, h: 1009 }, 1.3);
    expect(Math.round(placed.x)).toBe(294);
    expect(Math.round(placed.x + placed.w)).toBe(3045);
    expect(Math.round(placed.w)).toBe(2751);
    expect(Math.round(placed.h)).toBe(1312);
  });

  it("shrinks as well as grows", () => {
    // Zoom goes down to 50%, where the surface has to get SMALLER than its
    // measurement rather than larger.
    expect(toWindowPoints({ x: 100, y: 50, w: 800, h: 400 }, 0.5)).toEqual({
      x: 50,
      y: 25,
      w: 400,
      h: 200,
    });
  });

  it("keeps a parked surface parked", () => {
    // PARKED is a sentinel in window points, not a measurement, so it must not
    // be scaled — and at the 0.5 floor its 1pt box would round toward nothing.
    expect(toWindowPoints(PARKED, 1)).toEqual(PARKED);
  });
});

describe("parseZoom", () => {
  it("reads the level App.tsx publishes", () => {
    expect(parseZoom("1.3")).toBeCloseTo(1.3, 5);
    // getPropertyValue returns a leading-space-padded string for a custom
    // property set the way publishZoomToCss sets it.
    expect(parseZoom(" 1.3")).toBeCloseTo(1.3, 5);
  });

  it("falls back to 1 when the property was never published", () => {
    // An older window, or a surface measured before App.tsx's module-load
    // publish. getPropertyValue answers "" for a property that is not set.
    expect(parseZoom("")).toBe(1);
    expect(parseZoom(null)).toBe(1);
    expect(parseZoom(undefined)).toBe(1);
  });

  it("refuses a nonsense level rather than collapsing the surface", () => {
    // A zero or negative factor would multiply the hole down to nothing and
    // the pane would go black — far worse than ignoring the zoom entirely.
    for (const bad of ["0", "-2", "not-a-number", "NaN"]) {
      expect(parseZoom(bad)).toBe(1);
    }
  });
});

describe("isCovered", () => {
  // A stand-in for the two DOM facts the rule reads: identity, and whether
  // one node is inside another. The suite runs without a document, and a real
  // one would not make the cases any truer.
  type Stub = Element & { parent?: Stub };
  // One object per node, so `===` means what it means in a document, and
  // `contains` walks the same parent chain the DOM would.
  const node = (parent?: Stub): Stub => {
    const self = {
      parent,
      contains(other: unknown) {
        for (let p = other as Stub | undefined; p; p = p.parent) if (p === self) return true;
        return false;
      },
    } as unknown as Stub;
    return self;
  };

  const box: Bounds = { x: 0, y: 0, w: 800, h: 400 };

  it("says a hole with a page drawn over it is covered", () => {
    // The reported bug: opening Tasks mounts an opaque layer over the work
    // body and leaves the hole mounted and visible underneath. Nothing in a
    // style answers this, so the surface went on painting over the board.
    const hole = node();
    const page = node();
    expect(isCovered(hole, box, () => page)).toBe(true);
  });

  it("says a hole in plain sight is not covered", () => {
    const hole = node();
    expect(isCovered(hole, box, () => hole)).toBe(false);
  });

  it("treats a child of the hole as the hole", () => {
    // The hole may well have something inside it — a focus ring, a drag
    // affordance. Hitting one is still hitting the hole.
    const hole = node();
    const inner = node(hole);
    expect(isCovered(hole, box, () => inner)).toBe(false);
  });

  it("treats an ancestor of the hole as the hole", () => {
    // What comes back when the hole itself is `pointer-events: none`: the
    // pane around it. Still nothing in the way.
    const pane = node();
    const hole = node(pane);
    expect(isCovered(hole, box, () => pane)).toBe(false);
  });

  it("does not park for something covering only part of the terminal", () => {
    // This rule stays all-or-nothing: it is asking "has the whole hole been
    // taken away", and it must not blank a terminal because a hover card
    // clipped a corner. An overlay someone OPENED over part of the hole is a
    // different question with a different answer — see `isOverlaid` below.
    const hole = node();
    const menu = node();
    let n = 0;
    expect(isCovered(hole, box, () => (n++ === 0 ? menu : hole))).toBe(false);
  });

  it("does not park on a question that was never answered", () => {
    // `elementFromPoint` answers null outside the viewport. A surface must
    // never be taken away on the strength of that.
    const hole = node();
    expect(isCovered(hole, box, () => null)).toBe(false);
  });

  it("has no opinion about a hole too small to paint", () => {
    // `placementFor` already parks that one for being collapsed; sampling a
    // 0×0 box would just be hit-testing a point on whatever is behind it.
    const hole = node();
    const page = node();
    expect(isCovered(hole, { x: 0, y: 0, w: 0, h: 0 }, () => page)).toBe(false);
  });
});

describe("clearRect", () => {
  // The claim under test, and the one the whole regression turns on: a menu
  // over a terminal takes the part of the rectangle it is on, and the terminal
  // keeps the rest. Parking the surface instead — which is what the boolean
  // this replaced could only lead to — blanked the pane.
  //
  // The hole an agent pane leaves for its terminal, measured in the running
  // app at 100% webview zoom: the whole pane body under a 39px header.
  const hole: Bounds = { x: 280, y: 100, w: 840, h: 771 };
  // The tab strip's "+" launcher, measured in the same frame. It hangs from
  // the strip, so it starts ABOVE the hole and reaches 234px into it.
  const launcher: Bounds = { x: 700, y: 64, w: 360, h: 269.8 };

  /** The area the surface keeps, as a fraction of the hole. */
  const kept = (r: Bounds | null) => (r ? (r.w * r.h) / (hole.w * hole.h) : 0);

  it("hands the whole hole over when nothing is open", () => {
    // Identity, not just equality: the caller compares the clip to the hole to
    // know whether anything has to be clipped at all.
    expect(clearRect(hole, [])).toBe(hole);
  });

  it("keeps the band below a panel that reaches into the hole from above", () => {
    // Symptom 1. Only the top 36px of this panel clears the terminal, so with
    // the surface left in place a reader sees a search strip on the pane's
    // header row and no panel; with the surface taken away the pane goes
    // black. The honest answer is neither: the panel occupies the hole's
    // top-right, and the whole width below it is still a terminal.
    expect(isCovered({} as Element, hole, () => null)).toBe(false);
    const clip = clearRect(hole, [launcher]);
    expect(clip).toEqual({ x: 280, y: 333.8, w: 840, h: 537.2 });
    // The launcher is clear of it, which is the only thing the user asked for.
    expect(clip && clip.y >= launcher.y + launcher.h).toBe(true);
    expect(kept(clip)).toBeGreaterThan(0.69);
  });

  it("keeps the band beside a menu that reaches over the hole's left edge", () => {
    // Symptom 3: right-clicking a project row in the roster. The sheet is
    // anchored in the sidebar and overhangs the pane, so the clear band is the
    // full height of the hole to its right — and it is the bigger of the two
    // candidates, which is why the search is exhaustive rather than "the band
    // below".
    const rosterMenu: Bounds = { x: 190, y: 400, w: 224, h: 300 };
    const clip = clearRect(hole, [rosterMenu]);
    expect(clip).toEqual({ x: 414, y: 100, w: 706, h: 771 });
    expect(kept(clip)).toBeGreaterThan(0.84);
  });

  it("clips for an overlay the five hit-test samples all miss", () => {
    // Why this is rects and not hit-testing: a small menu on a large hole can
    // sit between every sample point and still be a menu nobody can read. The
    // menu lands dead centre, so the four bands around it are all that is
    // left and the biggest one wins.
    const menu: Bounds = { x: 600, y: 360, w: 200, h: 60 };
    const clip = clearRect(hole, [menu]);
    expect(clip).not.toBeNull();
    expect(clip && overlapsBox(clip, menu)).toBe(false);
    // Four bands are candidates and area picks between them: the band below
    // the menu is 840x451, the one above it only 840x260, and the two beside
    // it 320x771 and 320x771. The one below wins, which is also the one a
    // reader wants, because a shell's output grows downward from the prompt.
    expect(clip).toEqual({ x: 280, y: 420, w: 840, h: 451 });
  });

  it("leaves a surface alone for an overlay elsewhere on screen", () => {
    // A menu in the sidebar that does not reach the pane is not this pane's
    // business, and the hole comes back untouched.
    expect(clearRect(hole, [{ x: 0, y: 100, w: 260, h: 400 }])).toBe(hole);
  });

  it("treats an edge that merely touches the hole as clear", () => {
    // A panel ending exactly on the hole's top edge covers none of it, and a
    // terminal must not lose a column for a box it shares a boundary with.
    expect(clearRect(hole, [{ x: 700, y: 36, w: 360, h: 64 }])).toBe(hole);
  });

  it("ignores an overlay too small to paint", () => {
    // A closed menu still mounted at 0×0, which is how several of them wait.
    expect(clearRect(hole, [{ x: 700, y: 300, w: 0, h: 0 }])).toBe(hole);
  });

  it("gives up on a hole too small to paint", () => {
    // `placementFor` already parks that one for being collapsed; there is no
    // rectangle to carve out of nothing.
    expect(clearRect({ x: 0, y: 0, w: 0, h: 0 }, [launcher])).toBeNull();
  });

  it("parks rather than hand back a sliver", () => {
    // A dialog that leaves a 40px rim is a dialog covering the pane. Painting
    // four columns of terminal around it is noise, and asking the native side
    // for it costs a swapchain reconfigure to show nothing.
    const sheet: Bounds = { x: 300, y: 120, w: 800, h: 731 };
    expect(clearRect(hole, [sheet])).toBeNull();
  });

  it("works around two sheets at once", () => {
    // A menu with a submenu, or a launcher with one of its footer flyouts
    // open: two portals, two rectangles, and the clear band has to miss both.
    const second: Bounds = { x: 300, y: 700, w: 300, h: 171 };
    const clip = clearRect(hole, [launcher, second]);
    expect(clip).not.toBeNull();
    expect(clip && overlapsBox(clip, launcher)).toBe(false);
    expect(clip && overlapsBox(clip, second)).toBe(false);
  });

  it("parks rather than search a pane with a dozen sheets on it", () => {
    // Not a case the app can produce — the cap is a guard on a quartic search,
    // not a policy. A pane under that many overlays is a backdrop.
    const many = Array.from({ length: 12 }, (_, i) => ({
      x: 300 + i * 10,
      y: 120 + i * 10,
      w: 100,
      h: 100,
    }));
    expect(clearRect(hole, many)).toBeNull();
  });

  it("asks the same question at any webview zoom", () => {
    // Both boxes are CSS px off the same document, so zoom scales them
    // together and the shape of the answer cannot depend on it. Measured at
    // 130%: the viewport is narrower, the hole is 508 wide instead of 840, and
    // the launcher still reaches 234px into it.
    const zoomedHole: Bounds = { x: 280, y: 100, w: 508, h: 563 };
    const zoomedLauncher: Bounds = { x: 368, y: 64, w: 360, h: 269.8 };
    const clip = clearRect(zoomedHole, [zoomedLauncher]);
    expect(clip).toEqual({ x: 280, y: 333.8, w: 508, h: 329.2 });
  });
});

/** Do two boxes share any area? A local copy so a clear rect is checked
 *  against the overlay it had to miss by something other than the arithmetic
 *  that produced it. */
function overlapsBox(a: Bounds, b: Bounds): boolean {
  const xs = a.x < b.x + b.w && b.x < a.x + a.w;
  const ys = a.y < b.y + b.h && b.y < a.y + a.h;
  return xs && ys;
}

describe("OVERLAY_SELECTOR", () => {
  // There is no DOM in this suite, so this cannot be asserted by querying —
  // but the selector string itself is the contract that broke, and it is worth
  // pinning. The regression was `[role="menu"][data-state="open"]`: every
  // hand-rolled sheet in this app is a plain div with a role and no Radix
  // state attribute, so the state gate silently matched none of them and the
  // terminal painted over the roster's context menu.
  const parts = OVERLAY_SELECTOR.split(",");

  it("matches a menu on its role alone", () => {
    expect(parts).toContain('[role="menu"]');
    expect(parts.some((p) => p.startsWith('[role="menu"][')))
      .toBe(false);
  });

  it("matches a confirmation on its role alone", () => {
    // Medusa's Prompt is Radix AlertDialog underneath, so it carries neither
    // role="dialog" nor a popper wrapper — nothing else in the list sees it.
    expect(parts).toContain('[role="alertdialog"]');
  });

  it("keeps dialog and listbox gated on being open", () => {
    // Both roles can describe something permanently on screen, and clipping a
    // terminal around a panel that is simply part of the layout would shrink
    // the surface for the life of the app.
    expect(parts).toContain('[role="dialog"][data-state="open"]');
    expect(parts).toContain('[role="listbox"][data-state="open"]');
  });

  it("keeps the explicit opt-in for sheets with no role to match", () => {
    // The tab strip's launcher is the one that started this: a popover that is
    // a menu in every way except its markup.
    expect(parts).toContain("[data-over-native-surface]");
    expect(parts).toContain("[data-radix-popper-content-wrapper]");
  });

  it("never matches a tooltip", () => {
    // A tooltip follows the pointer, so honouring one would resize the
    // drawable on every hover.
    expect(OVERLAY_SELECTOR).not.toContain("tooltip");
  });

  // That this is the class the panels actually carry is pinned on the other
  // side, in `components/ui/menuSurface.test.ts`: importing the recipe here
  // would pull React into a suite that deliberately runs without a DOM.
  it("matches the shared flyout surface by class, bare", () => {
    // The roles above are keyed on what a sheet IS, and they caught only the
    // sheets that are menus of commands. Every panel that merely reports
    // something — the CLI version chip the user reported, the topbar pickers,
    // Ports, the cloud pickers, the mention pickers — is built from the one
    // MENU_PANEL recipe and carries its marker, so naming the recipe covers
    // all of them at once and covers the next one for free.
    expect(parts).toContain(".aura-menu-surface");
    // Bare, like role="menu": these panels are mounted only while open, so
    // presence is openness and there is no state attribute to gate on. The
    // two mention pickers prove the point — they are role="listbox" with no
    // `data-state`, so the gated listbox part had never seen them.
    expect(parts.some((p) => p.startsWith(".aura-menu-surface["))).toBe(false);
  });
});

describe("openOverlayRects", () => {
  it("answers empty with no document to read", () => {
    // Same guard as `webviewZoom`: a surface can be reconciled off the main
    // window, before there is a document to query.
    expect(openOverlayRects()).toEqual([]);
  });
});

describe("webviewZoom", () => {
  it("answers 1 with no document to read", () => {
    // The guard that actually runs in this suite — and the one that matters
    // off the main window, where a surface can be reconciled before a
    // document exists to carry the property.
    expect(webviewZoom()).toBe(1);
  });
});
