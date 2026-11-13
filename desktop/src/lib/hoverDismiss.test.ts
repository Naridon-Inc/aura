// Run with: bun test src/lib/hoverDismiss.test.ts
//
// An open hover card closes when its row goes away — hidden, covered by
// another page, scrolled off, or the window leaves — not only when the
// pointer moves.

import { describe, expect, test } from "bun:test";
import { rowShowing, watchHoverDismiss, type HoverRow, type HoverView } from "./hoverDismiss";

type Rect = { left: number; top: number; width: number; height: number };

function row(rect: Rect, opts: { connected?: boolean } = {}): HoverRow & { child: Element } {
  const child = { id: "row-child" } as unknown as Element;
  const self = {
    isConnected: opts.connected ?? true,
    child,
    getBoundingClientRect: () => ({ ...rect, right: rect.left + rect.width, bottom: rect.top + rect.height }) as DOMRect,
    contains: (n: Node | null) => n === (self as unknown as Node) || n === (child as unknown as Node),
  };
  return self as unknown as HoverRow & { child: Element };
}

function view(hit: Element | null): HoverView {
  return { width: 1200, height: 800, elementFromPoint: () => hit };
}

const ROW: Rect = { left: 10, top: 100, width: 240, height: 32 };

describe("rowShowing", () => {
  test("a laid-out row in the window with nothing over it is showing", () => {
    const r = row(ROW);
    expect(rowShowing(r, view(r.child))).toBe(true);
  });

  test("a row that unmounted, or never mounted, is not", () => {
    const r = row(ROW, { connected: false });
    expect(rowShowing(r, view(r.child))).toBe(false);
    expect(rowShowing(null, view(null))).toBe(false);
  });

  test("a hidden row has no size and is not showing", () => {
    const r = row({ left: 0, top: 0, width: 0, height: 0 });
    expect(rowShowing(r, view(r.child))).toBe(false);
  });

  test("a row scrolled out of the window is not showing", () => {
    const above = row({ ...ROW, top: -200 });
    const below = row({ ...ROW, top: 900 });
    expect(rowShowing(above, view(above.child))).toBe(false);
    expect(rowShowing(below, view(below.child))).toBe(false);
  });

  test("a row another page is drawn over is not showing", () => {
    const r = row(ROW);
    const otherPage = { id: "page" } as unknown as Element;
    expect(rowShowing(r, view(otherPage))).toBe(false);
  });
});

class FakeDoc extends EventTarget {
  visibilityState = "visible";
}

function harness(showing = { value: true }) {
  const win = new EventTarget();
  const doc = new FakeDoc();
  const beats: (() => void)[] = [];
  let beatCancelled = false;
  let closes = 0;
  const card = { id: "card" };
  const stop = watchHoverDismiss({
    close: () => {
      closes += 1;
    },
    isShowing: () => showing.value,
    inCard: (t) => t === (card as unknown as EventTarget),
    win,
    doc,
    every: (check) => {
      beats.push(check);
      return () => {
        beatCancelled = true;
      };
    },
  });
  return {
    win,
    doc,
    card,
    stop,
    beat: () => beats.forEach((b) => b()),
    closes: () => closes,
    beatCancelled: () => beatCancelled,
  };
}

function scrollFrom(target: object): Event {
  const e = new Event("scroll");
  Object.defineProperty(e, "target", { value: target });
  return e;
}

describe("watchHoverDismiss", () => {
  test("a scroll anywhere outside the card closes it", () => {
    const h = harness();
    h.win.dispatchEvent(scrollFrom({ id: "sidebar-list" }));
    expect(h.closes()).toBe(1);
  });

  test("the card's own scroll leaves it open", () => {
    const h = harness();
    h.win.dispatchEvent(scrollFrom(h.card));
    expect(h.closes()).toBe(0);
  });

  test("the window losing focus closes it", () => {
    const h = harness();
    h.win.dispatchEvent(new Event("blur"));
    expect(h.closes()).toBe(1);
  });

  test("a route change closes it", () => {
    for (const kind of ["popstate", "hashchange"]) {
      const h = harness();
      h.win.dispatchEvent(new Event(kind));
      expect(h.closes()).toBe(1);
    }
  });

  test("the window going hidden closes it; becoming visible does not", () => {
    const h = harness();
    h.doc.dispatchEvent(new Event("visibilitychange"));
    expect(h.closes()).toBe(0);
    h.doc.visibilityState = "hidden";
    h.doc.dispatchEvent(new Event("visibilitychange"));
    expect(h.closes()).toBe(1);
  });

  test("the beat closes it once the row is gone — a page change with the pointer still", () => {
    const showing = { value: true };
    const h = harness(showing);
    h.beat();
    expect(h.closes()).toBe(0);
    showing.value = false;
    h.beat();
    expect(h.closes()).toBe(1);
    expect(h.beatCancelled()).toBe(true);
  });

  test("it closes once, however many reasons arrive", () => {
    const showing = { value: false };
    const h = harness(showing);
    h.beat();
    h.win.dispatchEvent(new Event("blur"));
    h.win.dispatchEvent(scrollFrom({}));
    expect(h.closes()).toBe(1);
  });

  test("after cleanup (the card closed, the row unmounted) nothing closes it again", () => {
    const showing = { value: true };
    const h = harness(showing);
    h.stop();
    expect(h.beatCancelled()).toBe(true);
    showing.value = false;
    h.beat();
    h.win.dispatchEvent(new Event("blur"));
    h.win.dispatchEvent(scrollFrom({}));
    h.doc.visibilityState = "hidden";
    h.doc.dispatchEvent(new Event("visibilitychange"));
    expect(h.closes()).toBe(0);
  });
});
