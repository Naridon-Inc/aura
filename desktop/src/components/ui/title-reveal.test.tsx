import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { RevealMark, TitleReveal } from "./title-reveal";
import { SETTLE_MS, forgetReveals, noteReveal, setRevealClock } from "../../lib/titleReveal";

// The component draws what lib/titleReveal decides. These pin the markup: the
// plain name when nothing plays (so a row that is never renamed carries
// nothing extra), and during a reveal the real name kept readable underneath a
// decorative frame.

let now = 0;
beforeEach(() => {
  forgetReveals();
  now = 50_000;
  setRevealClock(() => now);
});
afterEach(() => setRevealClock(null));

describe("the name reveal's markup", () => {
  test("is the bare name when nothing is playing", () => {
    expect(renderToStaticMarkup(<TitleReveal revealKey="tab:manager:a" text="New chat" />)).toBe(
      "New chat",
    );
    expect(renderToStaticMarkup(<TitleReveal text="Untitled workspace" />)).toBe("Untitled workspace");
  });

  test("without a key a new name never reveals", () => {
    renderToStaticMarkup(<TitleReveal text="New chat" />);
    now += SETTLE_MS + 1;
    expect(renderToStaticMarkup(<TitleReveal text="Fix the login redirect" />)).toBe(
      "Fix the login redirect",
    );
  });

  test("mid-reveal keeps the real name for readers and draws pixels over it", () => {
    renderToStaticMarkup(<TitleReveal revealKey="tab:manager:b" text="New chat" />);
    now += SETTLE_MS + 1;
    noteReveal("title:tab:manager:b", "Review PR #93");
    now += 200;
    const html = renderToStaticMarkup(<TitleReveal revealKey="tab:manager:b" text="Review PR #93" />);
    expect(html).toContain('<span class="ui-title-reveal-final">Review PR #93</span>');
    expect(html).toContain('class="ui-title-reveal-frame" aria-hidden="true"');
    expect(html).toMatch(/<i data-level="[123]"><\/i>/);
  });

  test("a mark builds in only when which mark it is changes", () => {
    const glyph = <svg data-mark="" />;
    expect(renderToStaticMarkup(<RevealMark revealKey="tab:manager:c" markKey="pending">{glyph}</RevealMark>)).toBe(
      '<svg data-mark=""></svg>',
    );
    now += SETTLE_MS + 1;
    expect(renderToStaticMarkup(<RevealMark revealKey="tab:manager:c" markKey="pending">{glyph}</RevealMark>)).toBe(
      '<svg data-mark=""></svg>',
    );
    const html = renderToStaticMarkup(
      <RevealMark revealKey="tab:manager:c" markKey="review">
        {glyph}
      </RevealMark>,
    );
    expect(html).toContain('class="ui-reveal-mark" data-revealing=""');
    expect(html).toContain('<svg data-mark=""></svg>');
  });
});
