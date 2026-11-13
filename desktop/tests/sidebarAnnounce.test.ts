// The what's-new notice lives at the FOOT of the sidebar, with the other
// app-level notices, and wears the same shared notice they do.
//
// It used to render above the nav, which meant shipping a release pushed the
// user's project list down the page — the app rearranging the one index that
// is true everywhere in order to make room for our own news. Then it wore a
// card look of its own beside the update and tracking notices, so the corner
// carried two unrelated styles saying things at once.
//
// Scanned rather than rendered — what's being asserted is the structure.

import { describe, expect, it } from "bun:test";

import { readSrc } from "./support/code";

const sidebar = await readSrc("components/nav/AppSidebar.tsx");
const whatsNew = await readSrc("components/WhatsNewCard.tsx");
const css = await readSrc("styles.css");

describe("the what's-new notice", () => {
  it("renders once, in the sidebar's notice area, after the shared slot", () => {
    const uses = sidebar.match(/<WhatsNewCard/g) ?? [];
    expect(uses.length).toBe(1);
    const notice = sidebar.slice(sidebar.indexOf("notice={"));
    const slot = notice.indexOf("ref={setNoticeSlot}");
    const card = notice.indexOf("<WhatsNewCard");
    expect(slot).toBeGreaterThan(-1);
    expect(card).toBeGreaterThan(slot);
    expect(notice.slice(0, card)).toContain("<ShellNoticeStack>");
  });

  it("wears the shared notice, not a card of its own", () => {
    expect(whatsNew).toContain("<ShellNotice");
    expect(whatsNew).not.toContain("className=");
    expect(css).not.toContain(".ade-announce");
  });

  it("can always be dismissed, and offers at most one action", () => {
    expect(whatsNew).toContain("onDismiss={onDismiss}");
    expect(whatsNew).toContain('dismissLabel="Dismiss what\'s new"');
    expect(whatsNew).not.toContain("secondary=");
  });

  it("dismisses itself before it acts", () => {
    const click = whatsNew.slice(whatsNew.indexOf("onClick: () => {"));
    expect(click.indexOf("onDismiss()")).toBeLessThan(click.indexOf("onCta(cta.kind)"));
  });
});
