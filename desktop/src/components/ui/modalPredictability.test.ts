// Run with: bun test src/components/ui/modalPredictability.test.ts
//
// AURA-1377: every modal in this app closes on Escape, except the two that
// deliberately do not — and until this test, three of them disagreed without
// anything on screen saying which kind you were looking at.
//
// Two of the three had an Escape handler that could never run: a React
// `onKeyDown` on the backdrop `<div>`. A backdrop is not focusable and
// nothing inside these dialogs takes focus when they open, so the keydown
// never reaches that element — the handler reads correct and does nothing.
// The third (Chat doctor) listened for nothing at all and could only be
// closed with the ✕ or a click away.
//
// The second half is the other way a modal stops being operable: a centred
// card with no height cap grows with its content, and since the panel is
// overflow-hidden its own buttons end up below the bottom of the window with
// nothing to scroll. The shared ask sheet — 38 call sites — was one of them,
// and its body is whatever the caller had to say.
//
// A source scan rather than a render: both failures are a class name or the
// element a handler sits on, and they only show at a real keyboard in a real
// window. Same shape as `popoverHeight.test.ts`, for the same reason.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "..");

/** Reaching Escape from the document, which is the only place it arrives. */
const REAL_LISTENERS = [
  "useDismiss(", // the app's shared answer: outside mousedown + Escape
  'addEventListener("keydown"', // a hand-rolled window/document listener
  "FullscreenOverlay", // delegates to the overlay, which owns one
];

/** A surface may opt out by saying so, in one word a scan can find. */
const OPT_OUT = "no-escape-dismissal:";

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

const modals = walk(SRC)
  .map((path) => ({ path, text: readFileSync(path, "utf8") }))
  .filter((f) => f.text.includes('aria-modal="true"'));

describe("every modal dismisses the same way", () => {
  test("there are modals to check (the scan itself still works)", () => {
    expect(modals.length).toBeGreaterThan(8);
  });

  test("each one reaches Escape from the document, or says why it doesn't", () => {
    const offenders = modals
      .filter((f) => !REAL_LISTENERS.some((m) => f.text.includes(m)))
      .filter((f) => !f.text.includes(OPT_OUT))
      .map((f) => f.path.slice(SRC.length + 1));

    expect(offenders).toEqual([]);
  });

  test("nobody hangs Escape off a backdrop that can never have focus", () => {
    // The exact shape of the bug: `onKeyDown` on an element in a file that
    // has no document-level listener to fall back on.
    const offenders = modals
      .filter((f) => /onKeyDown=\{\(e\) =>[\s\S]{0,200}?["']Escape["']/.test(f.text))
      .filter((f) => !REAL_LISTENERS.some((m) => f.text.includes(m)))
      .map((f) => f.path.slice(SRC.length + 1));

    expect(offenders).toEqual([]);
  });

  test("the opt-out is a stated reason, not a bare marker", () => {
    for (const f of modals.filter((m) => m.text.includes(OPT_OUT))) {
      const after = f.text.slice(f.text.indexOf(OPT_OUT) + OPT_OUT.length);
      const said = after.split("\n").slice(0, 3).join(" ").trim();
      expect(said.length).toBeGreaterThan(20);
    }
  });
});

describe("no modal hides its own buttons", () => {
  const withFooter = modals.filter(
    (f) => f.text.includes("MODAL_FOOTER") || f.text.includes("<footer"),
  );

  /** A shell fills the window and lays itself out: header, a body that takes
   *  the leftover height, footer. Its buttons cannot be pushed off, because
   *  the body is what gives way — and the scrolling belongs to whatever the
   *  caller renders inside it, not to the shell. A centred card is the other
   *  kind: its height follows its content, so the cap and the scroller have
   *  to be its own. Two shapes, two rules. */
  const isShell = (text: string) => /className="fixed inset-0|absolute inset-2/.test(text);
  const shells = withFooter.filter((f) => isShell(f.text));
  const cards = withFooter.filter((f) => !isShell(f.text));

  test("there are footered modals of both shapes to check", () => {
    expect(cards.length).toBeGreaterThan(3);
    expect(shells.length).toBeGreaterThan(0);
  });

  test("a footered card caps its height", () => {
    // Uncapped, the card grows past the window and takes Cancel and the
    // primary button with it — at 900×600, the smallest window Aura
    // supports, that is roughly twenty lines of body text.
    const offenders = cards
      .filter((f) => !/max-h-\[|h-full/.test(f.text))
      .map((f) => f.path.slice(SRC.length + 1));

    expect(offenders).toEqual([]);
  });

  test("and scrolls something inside that cap", () => {
    // A cap with no scroller is worse than none: the content is clipped and
    // simply unreachable.
    const offenders = cards
      .filter((f) => !/overflow-y-auto|overflow-auto/.test(f.text))
      .map((f) => f.path.slice(SRC.length + 1));

    expect(offenders).toEqual([]);
  });

  test("a footered shell lets its body give way, not its footer", () => {
    // `flex-1 min-h-0` on the body is the whole guarantee: without min-h-0 a
    // flex child refuses to shrink below its content and pushes the footer
    // out of the panel, which is the same bug wearing a different layout.
    const offenders = shells
      .filter((f) => !/flex-1 min-h-0|min-h-0 flex-1/.test(f.text))
      .map((f) => f.path.slice(SRC.length + 1));

    expect(offenders).toEqual([]);
  });
});
