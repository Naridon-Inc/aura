// Settings → Repository → Cloud machine, driven in a real window.
//
//   bun test
//
// Three things this pane got wrong, all found by clicking it signed out.
//
// 1. THE ONE INSTRUCTION IT GAVE POINTED NOWHERE. "Use the account menu in
//    the top-right corner to connect." The account menu is at the foot of
//    the left sidebar, not the top right — and this panel's other home is
//    Settings, which covers the whole window, so even the right corner
//    wasn't reachable without leaving the surface the sentence was on.
//    The only control offered was "I've signed in. Check again", for a
//    sign-in the panel never let you start. Every other gate in the app
//    (TeamTab, the workspace composer, the team feed) raises the welcome
//    surface with `aura:open-signin`; this one talked about it instead.
//
// 2. A FAILED BOARD READ SPUN FOREVER. `runners === null` means "haven't
//    managed to read it", and the catch deliberately kept the last known
//    board — but with no board yet there is nothing to keep, so a call
//    that failed every time left "Checking your board…" on screen for as
//    long as the pane was open.
//
// 3. THE EXAMPLE BRIEF COULD NOT BE READ. It rode in the textarea's
//    placeholder. WebKit — which is what this app renders in — draws a
//    textarea placeholder on one line and clips it, so the half that
//    showed what a good brief looks like was cut off mid-word.

import { describe, expect, test } from "bun:test";

import { readSrc } from "./support/code";

const PANE = "components/commons/crew/CloudRunnerPanel.tsx";

describe("the sign-in gate offers the sign-in", () => {
  test("it raises the welcome surface the rest of the app uses", async () => {
    const src = await readSrc(PANE);
    expect(src).toContain('new CustomEvent("aura:open-signin")');
  });

  test("and stops sending people to a menu that isn't there", async () => {
    const src = await readSrc(PANE);
    expect(src).not.toContain("account menu in the top-right");
    expect(src).not.toContain("I&apos;ve signed in. Check again");
  });

  test("signing in elsewhere brings this panel with it", async () => {
    const src = await readSrc(PANE);
    // The welcome broadcasts on success — so the panel updates itself
    // rather than leaving a button as the only way back.
    expect(src).toContain(
      'window.addEventListener("aura:cloud-auth-changed", onAuthChanged)',
    );
    expect(src).toContain(
      'window.removeEventListener("aura:cloud-auth-changed", onAuthChanged)',
    );
  });

  test("asking again by hand survives, for the sign-ins that don't announce", async () => {
    const src = await readSrc(PANE);
    // `aura login` at a terminal fires no DOM event.
    expect(src).toContain("Check again");
  });
});

describe("a board it never read is not a board with nothing on it", () => {
  test("the failure is kept, not just the empty result", async () => {
    const src = await readSrc(PANE);
    expect(src).toContain(
      "const [boardError, setBoardError] = useState<string | null>(null)",
    );
    expect(src).toContain("setBoardError(String(e))");
    // Cleared on a read that worked, so one bad poll doesn't stick.
    expect(src).toContain("setBoardError(null)");
  });

  test("and it says so, with a way to ask again, instead of spinning", async () => {
    const src = await readSrc(PANE);
    const board = src.slice(
      src.indexOf("Your machines"),
      src.indexOf("{showConnect && ("),
    );
    expect(board).toContain("runners === null && boardError ?");
    expect(board).toContain("onClick={() => void refreshRunners()}");
    // The spinner still covers the honest case: no answer yet, no failure.
    expect(board).toContain("Checking your board…");
    // The failure branch is tested before it.
    expect(board.indexOf("runners === null && boardError")).toBeLessThan(
      board.indexOf("Checking your board…"),
    );
  });
});

describe("the example brief is text, because a placeholder can't be", () => {
  test("the placeholder is short enough for one clipped line", async () => {
    const src = await readSrc(PANE);
    expect(src).toContain('placeholder="What should it work on?"');
    expect(src).not.toContain(
      'placeholder="What should it work on? e.g. “Add rate-limit',
    );
  });

  test("and the example renders as real, wrapping copy", async () => {
    const src = await readSrc(PANE);
    expect(src).toContain("{!text && (");
    expect(src).toContain("e.g. “Add rate-limit retries to the billing client");
  });
});
