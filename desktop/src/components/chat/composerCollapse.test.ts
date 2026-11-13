// Run with: bun test src/components/chat/composerCollapse.test.ts
//
// The composer survives the flip to the terminal, and folds to a strip while
// it has nothing to show.
//
// Two things are pinned here, and the split is deliberate. The POLICY is a
// pure function, so it is called rather than scanned — five booleans in, one
// out, and every row of the table below is a real state the pane can be in.
// The WIRING is a source scan, because the parts it joins up are in four
// files and the bug this guards against is one of them quietly dropping its
// end: a collapse with nobody setting the attribute, an attribute with no
// stylesheet behind it, or a strip floating over a terminal that never
// reserved room for it.
//
// Why it exists at all: this pane opens on the terminal (the default view),
// and until now that view had no composer. The rich one — model picker, mode,
// @file mentions, up-arrow recall — was a click away on a tab you had to
// leave the TUI to reach. Now one composer sits at the foot of the
// pane whatever tab is showing, and collapses to a strip when you are
// reading rather than writing. That is what this builds.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { Composer } from "../ui/composer";
import { MINIMIZED_SELECTOR } from "./composerOverlay";

import {
  COMPOSER_MINIMIZE_DELAY_MS,
  STRIP_CONTROL_SELECTOR,
  isComposerMinimized,
  pressTakesField,
  type ComposerCollapseInputs,
} from "./composerCollapse";

const SRC = join(import.meta.dir, "..", "..");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");

const chatView = read("components/agent/chatView.css");
const surface = read("components/agent/AgentSurface.tsx");
const transcript = read("components/agent/normalized/NormalizedTranscript.tsx");
const agentComposer = read("components/agent/chat/AgentChatComposer.tsx");
const overlay = read("components/chat/composerOverlay.ts");

/** Declaration block of the single rule whose selector list is `selector`. */
function rule(css: string, selector: string): string {
  const norm = (s: string) => s.trim().replace(/\s*\n\s*/g, " ").replace(/\s+/g, " ");
  const want = norm(selector);
  const out: string[] = [];
  for (const m of css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (norm(m[1]) === want) out.push(m[2]);
  }
  expect(out.length, `exactly one rule for ${selector}`).toBe(1);
  return out[0];
}

/** A composer over a terminal with nothing in it — the one state that folds. */
const idleOverContent: ComposerCollapseInputs = {
  overlaying: true,
  empty: true,
  focused: false,
  blocked: false,
  engaged: false,
};

describe("when the composer is a strip", () => {
  test("empty, over a content surface, untouched", () => {
    expect(isComposerMinimized(idleOverContent)).toBe(true);
  });

  test("never on the conversation itself, whatever the draft says", () => {
    // The rule is `isViewingContentTab && canMinimize`, and the
    // first half is not decoration. On the conversation the composer is the
    // subject rather than an overlay on something being read, so there is
    // nothing to hand back by folding — it would just be a composer that
    // shrinks when you stop typing.
    expect(isComposerMinimized({ ...idleOverContent, overlaying: false })).toBe(false);
    expect(
      isComposerMinimized({ ...idleOverContent, overlaying: false, empty: false }),
    ).toBe(false);
  });

  test("a draft holds it open", () => {
    // Folding on a half-written prompt hides work. The strip keeps the caret
    // and the text, but the text is exactly what you cannot see in 20px.
    expect(isComposerMinimized({ ...idleOverContent, empty: false })).toBe(false);
  });

  test("focus holds it open, and losing focus alone does not fold it", () => {
    expect(isComposerMinimized({ ...idleOverContent, focused: true })).toBe(false);
    // The important half: this is NOT a blur rule. Clicking the transcript to
    // read what you are answering takes focus out of the composer, and a
    // composer that folded on that would move under the cursor during the one
    // gesture that must not move it. What folds it is the draft emptying and
    // the forgiveness window below running out.
    expect(isComposerMinimized({ ...idleOverContent, focused: false, engaged: true })).toBe(false);
  });

  test("a question waiting on the user holds it open", () => {
    // This is folded in with the draft under one name
    // (`canMinimize`), for the same reason: the composer is the only place
    // the answer can be typed, so it cannot be the thing that hides.
    expect(isComposerMinimized({ ...idleOverContent, blocked: true })).toBe(false);
  });

  test("the forgiveness window is half a second", () => {
    // Sending empties the draft. Collapsing on that frame folds the box under
    // the cursor of someone about to type a second line.
    expect(COMPOSER_MINIMIZE_DELAY_MS).toBe(500);
  });
});

// The bug this guards: over the terminal, pressing the strip opened the box
// and it folded again half a second later. The press opened it, the box grew
// upward under the pointer before the browser ran the press's default focus,
// and the point that had been over the field was now over the footer row.
// The footer cannot take focus, so focus went to the transcript section, the
// composer read that as focus leaving, and the forgiveness window folded it.
describe("a press on the strip", () => {
  test("puts focus in the field itself", () => {
    expect(pressTakesField({ minimized: true, button: 0, onControl: false })).toBe(true);
  });

  test("leaves an open box to the browser, so a click still places the caret", () => {
    expect(pressTakesField({ minimized: false, button: 0, onControl: false })).toBe(false);
  });

  test("leaves the strip's controls and other buttons alone", () => {
    // The model icon and send are pinned to the bottom edge, so they are
    // still under the pointer after the box grows and their own click lands.
    expect(pressTakesField({ minimized: true, button: 0, onControl: true })).toBe(false);
    expect(pressTakesField({ minimized: true, button: 2, onControl: false })).toBe(false);
    for (const control of ["button", '[role="button"]', '[role="combobox"]', "input"]) {
      expect(STRIP_CONTROL_SELECTOR).toContain(control);
    }
    // The field is the one thing a strip press hands focus to itself, so it
    // cannot also be read as a control.
    expect(STRIP_CONTROL_SELECTOR).not.toContain("textarea");
  });

  test("cancels the browser's own focus move for the same press", () => {
    const collapse = read("components/chat/composerCollapse.ts");
    // Focus is given during pointerdown, before React's commit can move the
    // field, and the mousedown that follows is stopped from taking it away.
    expect(collapse).toMatch(/el\.focus\(\{ preventScroll: true \}\);\s*focusTaken\.current = document\.activeElement === el;/);
    expect(collapse).toMatch(
      /onMouseDownCapture = useCallback\(\(event[\s\S]*?\) => \{\s*if \(!focusTaken\.current\) return;\s*focusTaken\.current = false;\s*event\.preventDefault\(\);/,
    );
    expect(collapse).toMatch(/\(\) => \(\{ onPointerDownCapture, onMouseDownCapture, onFocusCapture, onBlurCapture \}\)/);
    // The footer really is pinned to the bottom edge, which is why the point
    // under a strip press ends up on it once the box has grown.
    const css = read("components/ui/interface.css");
    expect(rule(css, '.ui-composer[data-composer-minimized="true"] .ui-composer-footer')).toMatch(
      /bottom: 8px;/,
    );
  });
});

describe("the strip over a terminal", () => {
  test("the conversation goes invisible, it is not taken away", () => {
    // display:none reports scrollTop 0, so every flip back to the chat would
    // land at the top of a long session. visibility keeps the box and keeps
    // the place.
    const hidden = rule(chatView, ".chat-workspace[data-chat-overlay] > *:not(.chat-dock)");
    expect(hidden).toMatch(/visibility:\s*hidden/);
    expect(hidden).not.toMatch(/display:\s*none/);
    // And the layer is no longer conditionally mounted or inert'd away.
    expect(surface).toMatch(/overlay=\{view !== "chat"\}/);
    expect(surface).not.toMatch(/inert=\{view !== "chat"\}/);
  });

  test("the dock becomes a bottom band and takes the clicks the pane does not", () => {
    const section = rule(chatView, ".chat-workspace[data-chat-overlay]");
    expect(section).toMatch(/pointer-events:\s*none/);
    expect(section).toMatch(/background:\s*transparent/);
    const dock = rule(chatView, ".chat-workspace[data-chat-overlay] .chat-dock");
    expect(dock).toMatch(/position:\s*absolute/);
    expect(dock).toMatch(/bottom:\s*0/);
    expect(dock).toMatch(/pointer-events:\s*auto/);
    expect(dock).toMatch(/visibility:\s*visible/);
  });

  test("the card takes an opaque ground over content", () => {
    // The shared box's fill is part-transparent in the light theme. Against
    // scrolling terminal output there is nothing to read it against, and the
    // draft would be typed over somebody else's text.
    expect(rule(chatView, ".chat-workspace[data-chat-overlay] .chat-composer")).toMatch(
      /background:\s*var\(--ui-sidebar\)/,
    );
  });

  test("the terminal reserves the strip instead of being clipped for it", () => {
    // A clip would cost a swapchain reconfigure and nativeSurfacePlacement's
    // 8px overlay margin, permanently, for something that never moves. Real
    // padding makes the native surface smaller and the strip sits in free
    // page.
    expect(surface).toMatch(/data-composer-underlay=""/);
    expect(surface).toMatch(/var\(--composer-overlay-height, 0px\)/);
  });
});

describe("the height the pane reserves", () => {
  test("the band reports it, not the card", () => {
    // What a pane has to clear is everything drawn over it, the dock's own
    // padding included.
    expect(transcript).toMatch(/className="chat-dock" ref=\{dockRef\}/);
    expect(transcript).toMatch(/useComposerOverlayHeight\(dockRef, \{ active: overlay \}\)/);
  });

  test("only a COLLAPSED band publishes, so typing cannot resize the terminal", () => {
    // The strip's height is measured rather than constant because ours is
    // built out of tokens and a dock's padding. But a measured number moves
    // as the composer grows, and republishing it would SIGWINCH the PTY on
    // the line where a draft wraps.
    expect(overlay).toMatch(/if \(!minimized\) return;/);
    expect(overlay).toMatch(/querySelector\(MINIMIZED_SELECTOR\)/);
  });

  test("an OPEN box is not read as folded", () => {
    // The box writes `data-composer-minimized` on every render — "false"
    // while it is open — so a bare presence selector held every open box to
    // be a strip, republished its growing height, and resized the terminal
    // each time a draft wrapped. The selector has to name the value.
    const attr = (minimized: boolean) => {
      const html = renderToStaticMarkup(
        createElement(Composer, { value: "", onChange: () => {}, onSend: () => {}, minimized }),
      );
      const m = html.match(/data-composer-minimized="([^"]*)"/);
      expect(m, "the box carries the marker").not.toBeNull();
      return m![1];
    };
    const sel = MINIMIZED_SELECTOR.match(/^\[([\w-]+)="([^"]*)"\]$/);
    expect(sel, "the selector names a value, not mere presence").not.toBeNull();
    const [, name, value] = sel!;
    expect(name).toBe("data-composer-minimized");
    expect(attr(false)).not.toBe(value);
    expect(attr(true)).toBe(value);
  });

  test("an EXPANDED band asks to be drawn across the native surface", () => {
    // The one case a clip is right: an open composer genuinely is over the
    // terminal, and no z-index reaches a native GPU surface.
    expect(overlay).toMatch(/OVER_NATIVE_ATTR = "data-over-native-surface"/);
    expect(overlay).toMatch(/if \(minimized\) band\.removeAttribute\(OVER_NATIVE_ATTR\);/);
    expect(overlay).toMatch(/else band\.setAttribute\(OVER_NATIVE_ATTR, ""\);/);
  });
});

describe("what the composer wires up", () => {
  test("the agent composer reads the policy and dresses the frame with it", () => {
    expect(agentComposer).toMatch(
      /useComposerCollapse\(\{\s*overlaying: overlay,\s*empty: !canSend,\s*blocked: docked,\s*field: textareaRef,\s*\}\)/,
    );
    expect(agentComposer).toMatch(/textareaRef=\{textareaRef\}/);
    // The shared box draws the strip, and is told whether this fold is one
    // to ease into or one to land on.
    expect(agentComposer).toMatch(/<Composer[\s\S]*minimized=\{collapse\.minimized\}/);
    expect(agentComposer).toMatch(/animateResize=\{collapse\.animate\}/);
    expect(agentComposer).toMatch(/\{\.\.\.collapse\.handlers\}/);
  });

  test("Escape folds an empty strip back, and never a draft", () => {
    expect(agentComposer).toMatch(/e\.key === "Escape" && overlay && !canSend/);
  });

  test("a change of surface sets the state rather than animating to it", () => {
    // Flipping to the terminal is a different view, not a composer gesture:
    // the reset happens during the render that sees the new surface, and it
    // turns the easing off, so the box lands on the new state at once.
    const collapse = read("components/chat/composerCollapse.ts");
    expect(collapse).toMatch(
      /if \(surface !== overlaying\) \{\s*setSurface\(overlaying\);\s*setEngaged\(false\);\s*setAnimate\(false\);/,
    );
    expect(collapse).not.toMatch(/requestAnimationFrame/);
    // A fold or unfold the user caused eases: a click or focus opens it, and
    // the forgiveness window running out folds it.
    expect(collapse).toMatch(
      /onPointerDownCapture = useCallback\(\s*\(event: StripPress\) => \{\s*focusTaken\.current = false;\s*setAnimate\(true\);/,
    );
    expect(collapse).toMatch(/setTimeout\(\(\) => \{\s*setAnimate\(true\);\s*setEngaged\(false\);/);
    // The box marks a fold it must not ease, and the stylesheet drops every
    // transition under that mark.
    const box = read("components/ui/composer.tsx");
    expect(box).toContain("data-composer-resize-instant={animateResize ? undefined : true}");
    expect(box).toContain("animateResize = false,");
    const css = read("components/ui/interface.css");
    expect(css).toMatch(/\.ui-composer\[data-composer-resize-instant\] textarea,[^{]*\{\s*transition: none;/);
  });

  test("folded, the box is one line with the model icon and send pinned in", () => {
    const css = read("components/ui/interface.css");
    const folded = (sel: string) =>
      css.match(new RegExp(`${sel.replace(/[[\]().*"=]/g, "\\$&")} \\{([^}]*)\\}`))?.[1] ?? "";
    expect(folded('.ui-composer[data-composer-minimized="true"] textarea')).toMatch(
      /margin: 8px 0;\s*padding: 4px 144px 4px 48px;\s*min-height: 28px;/,
    );
    expect(folded('.ui-composer[data-composer-minimized="true"] .ui-composer-footer')).toMatch(
      /left: 7px;\s*right: 8px;\s*bottom: 8px;/,
    );
    expect(css).toMatch(
      /\.ui-composer\[data-composer-minimized="true"\] \.ui-composer-tools,[^{]*\{\s*opacity: 0;\s*translate: 0 4px;\s*pointer-events: none;/,
    );
    // The model control closes up to its agent icon.
    const patterns = read("components/ui/patterns.css");
    expect(patterns).toMatch(
      /\.ui-composer\[data-composer-minimized="true"\] \.ui-model-compact-icon \{\s*display: inline-flex;/,
    );
    // The host's tools and ＋ sit in the group that fades; the "to focus"
    // pill comes after it, next to the buttons that stay.
    const box = read("components/ui/composer.tsx");
    expect(box.indexOf('className="ui-composer-tools"')).toBeLessThan(box.indexOf("{minimized && focusHint}"));
    expect(box).toContain("const floor = minimized ? 28 : 88;");
  });
});
