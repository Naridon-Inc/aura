// Where the keyboard goes when a wizard closes.
//
//   bun test ./tests/focusReturn.test.ts
//
// AURA-1362. Open a session from the list with the keyboard, press Esc, and
// focus was on <body>: the reader was returned to the top of the document and
// had to tab through the whole list again to reach the row they had just been
// reading. The mouse hides this entirely, which is how it survived so long.
//
// The rules that make handing focus back safe rather than merely polite:
// nothing is remembered when nothing had focus; nothing is restored to an
// element that has since left the page; and restoring must not move the
// viewport, because the surface underneath is still scrolled where the reader
// left it.

import { describe, expect, test } from "bun:test";

import { captureFocus, isWorthReturningTo } from "../src/lib/focusReturn";

function control() {
  const calls: Array<{ preventScroll?: boolean } | undefined> = [];
  return {
    isConnected: true,
    focus(options?: { preventScroll?: boolean }) {
      calls.push(options);
    },
    calls,
  };
}

describe("what is worth returning to", () => {
  test("a live control is", () => {
    expect(isWorthReturningTo(control())).toBe(true);
  });

  test("the page body is not", () => {
    // Focus parks on <body> when nothing holds it. Returning there is the same
    // as returning nowhere, and remembering it would overwrite whatever the
    // surface itself sensibly focused.
    const body = control();
    expect(isWorthReturningTo(body, body)).toBe(false);
  });

  test("nothing at all is not", () => {
    expect(isWorthReturningTo(null)).toBe(false);
    expect(isWorthReturningTo(undefined)).toBe(false);
    expect(isWorthReturningTo("a string")).toBe(false);
    expect(isWorthReturningTo({})).toBe(false);
  });
});

describe("handing the keyboard back", () => {
  test("returns focus to the control that opened the surface", () => {
    const row = control();
    const restore = captureFocus(row);
    restore();
    expect(row.calls).toHaveLength(1);
  });

  test("does not scroll the surface underneath", () => {
    const row = control();
    captureFocus(row)();
    expect(row.calls[0]).toEqual({ preventScroll: true });
  });

  test("stays quiet when the control has left the page", () => {
    // The row was filtered away, or its pane closed, while the wizard was up.
    const row = control();
    const restore = captureFocus(row);
    row.isConnected = false;
    restore();
    expect(row.calls).toHaveLength(0);
  });

  test("stays quiet when nothing had focus", () => {
    // A surface opened by a command palette or a cross-surface event has no
    // originating control; it must not throw on the way out.
    expect(() => captureFocus(null)()).not.toThrow();
  });

  test("is safe to run more than once", () => {
    // React can run an effect's teardown in strict mode and again on unmount.
    const row = control();
    const restore = captureFocus(row);
    restore();
    restore();
    expect(row.calls).toHaveLength(2);
    expect(row.calls.every((c) => c?.preventScroll)).toBe(true);
  });
});
