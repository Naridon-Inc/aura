// The rail's announcement lives at the FOOT, over the projects.
//
// It used to render above the nav, which meant shipping a release pushed the
// user's project list down the page — the app rearranging the one index that
// is true everywhere in order to make room for our own news. Pinned at the
// bottom it costs the list nothing: the list keeps the full column and the
// body reserves the card's measured height, so no row ever rests under it.
//
// Scanned rather than rendered — what's being asserted is the structure: which
// layer is pinned, what reserves the room, and what the slot does NOT paint.

import { describe, expect, it } from "bun:test";

import { readSrc } from "./support/code";

const sidebar = await readSrc("components/AdeSidebar.tsx");
const announce = await readSrc("components/SidebarAnnouncement.tsx");
const whatsNew = await readSrc("components/WhatsNewCard.tsx");
const css = await readSrc("styles.css");

describe("the sidebar announcement slot", () => {
  it("pins the card inside the same stack as the scrolling list", () => {
    // Both layers in one positioned parent — that's what puts the card OVER
    // the projects instead of after them.
    expect(sidebar).toContain('className="ade-side-stack"');
    const stack = sidebar.slice(sidebar.indexOf('"ade-side-stack"'));
    const body = stack.indexOf("ade-side-body");
    const notice = stack.indexOf("ade-side-notice");
    expect(body).toBeGreaterThan(-1);
    expect(notice).toBeGreaterThan(body);
  });

  it("is the only place the what's-new card renders", () => {
    // A second copy above the nav would put the projects back where they were.
    const uses = sidebar.match(/<WhatsNewCard/g) ?? [];
    expect(uses.length).toBe(1);
  });

  it("reserves the card's measured height, not a guessed one", () => {
    // The card's height depends on how far the headline wraps; a constant is
    // either a gap under an absent card or a row stuck behind a present one.
    expect(sidebar).toContain("--ade-notice-h");
    expect(sidebar).toContain("ResizeObserver");
    expect(sidebar).toContain("offsetHeight");
    expect(css).toContain("padding: 5px 4px calc(3px + var(--ade-notice-h, 0px))");
  });

  it("clears the reservation when there is no announcement", () => {
    expect(sidebar).toContain('removeProperty("--ade-notice-h")');
  });

  it("draws no fade above the card", () => {
    // This slot used to wear a 32px dissolve into `--color-bg-1`, and this
    // test used to demand it. `f2ed6f02` took it out on purpose: under
    // vibrancy the rail is not bg-1 — it's a frosted color-mix over the
    // desktop — so the gradient painted a slab that was both darker and
    // opaque, and a fade above a card with nothing below it reads as light
    // arriving from one direction. Nothing rests under the card anyway,
    // because the body reserves its height, so the dissolve was buying a
    // transient scroll case at the price of a permanent smudge.
    //
    // Asserted rather than deleted: a rule removed for a reason that isn't
    // written down anywhere is a rule the next person re-adds.
    const slot = css.slice(
      css.indexOf(".ade-side-notice"),
      css.indexOf(".ade-side-foot"),
    );
    expect(slot).not.toContain("linear-gradient");
    expect(slot).not.toContain("::before");
  });

  it("lets clicks through the slot to the rows behind it", () => {
    const slot = css.slice(css.indexOf(".ade-side-notice"), css.indexOf(".ade-announce {"));
    expect(slot).toContain("pointer-events: none");
    expect(slot).toContain(".ade-side-notice > * {\n  pointer-events: auto;\n}");
  });
});

describe("the announcement card itself", () => {
  it("carries a badge, a title, a line and one action", () => {
    for (const cls of [
      "ade-announce-badge",
      "ade-announce-title",
      "ade-announce-body",
      "ade-announce-cta",
    ]) {
      expect(announce).toContain(cls);
      expect(css).toContain(`.${cls}`);
    }
  });

  it("can always be dismissed", () => {
    expect(announce).toContain('aria-label="Dismiss"');
  });

  it("paints its marker with the accent token, never a raw hex", () => {
    const card = css.slice(css.indexOf(".ade-announce {"));
    const block = card.slice(0, card.indexOf(".ade-announce-x:hover"));
    expect(block).toContain("var(--color-accent)");
    expect(block).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it("is what the what's-new notice wears. One card look in this corner", () => {
    expect(whatsNew).toContain("<SidebarAnnouncement");
    // …and it no longer hand-rolls its own box.
    expect(whatsNew).not.toContain("rounded-lg border");
  });
});
