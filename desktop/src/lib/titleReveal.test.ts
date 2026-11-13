import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  REVEAL_MS,
  SETTLE_MS,
  forgetReveals,
  noteReveal,
  revealFrame,
  setRevealClock,
} from "./titleReveal";

// A tab or row calls `noteReveal` on every render. These pin when that turns
// into a reveal — once per real rename, never for a re-render, a remount, the
// first sight of a tab, or a reader who asked for less motion — and that the
// frame it draws ends on exactly the new name.

let now = 0;
beforeEach(() => {
  forgetReveals();
  now = 10_000;
  setRevealClock(() => now);
});
afterEach(() => setRevealClock(null));

/** The tab has been on screen long enough that a new name is news. */
const settle = () => {
  now += SETTLE_MS + 1;
};

describe("when a name change reveals", () => {
  test("a placeholder becoming the chat's subject plays one reveal", () => {
    expect(noteReveal("tab:manager:s1", "New chat")).toBeNull();
    settle();
    const first = noteReveal("tab:manager:s1", "Fix the login redirect");
    expect(first).not.toBeNull();
    expect(first?.from).toBe("New chat");
    expect(first?.to).toBe("Fix the login redirect");
    expect(first?.progress).toBe(0);

    // Every render while it plays reads the same reveal back, further along.
    now += REVEAL_MS / 2;
    const mid = noteReveal("tab:manager:s1", "Fix the login redirect");
    expect(mid?.startedAt).toBe(first?.startedAt);
    expect(mid?.progress).toBeCloseTo(0.5);

    // And once it has run its length, it is over — and stays over.
    now += REVEAL_MS;
    expect(noteReveal("tab:manager:s1", "Fix the login redirect")).toBeNull();
    now += 5_000;
    expect(noteReveal("tab:manager:s1", "Fix the login redirect")).toBeNull();
  });

  test("the same name on every render never reveals", () => {
    expect(noteReveal("tab:agent:a1", "Claude Code")).toBeNull();
    for (let i = 0; i < 20; i++) {
      settle();
      expect(noteReveal("tab:agent:a1", "Claude Code")).toBeNull();
    }
  });

  test("the first sight of a tab never reveals, whatever it is called", () => {
    settle();
    expect(noteReveal("tab:manager:restored", "Fix the login redirect")).toBeNull();
  });

  test("a remount mid-reveal picks the same reveal up instead of restarting it", () => {
    noteReveal("tab:agent:a2", "Claude Code");
    settle();
    const started = noteReveal("tab:agent:a2", "fixing the retry backoff");
    now += 200;
    // The strip keys a tab by its label, so the new name mounts a new tab —
    // which calls in with the same key and value.
    const remounted = noteReveal("tab:agent:a2", "fixing the retry backoff");
    expect(remounted?.startedAt).toBe(started?.startedAt);
    expect(remounted?.progress).toBeCloseTo(200 / REVEAL_MS);
  });

  test("a name that lands while the tab is still loading is adopted quietly", () => {
    // A reopened chat opens on the opener's hint and gets its stored title a
    // frame later: that is the tab finishing loading, not a rename.
    expect(noteReveal("tab:manager:s2", "Conversation")).toBeNull();
    now += 30;
    expect(noteReveal("tab:manager:s2", "Fix the login redirect")).toBeNull();
    settle();
    expect(noteReveal("tab:manager:s2", "Fix the login redirect")).toBeNull();
  });

  test("two different tabs with the same name do not read as one renamed", () => {
    noteReveal("tab:manager:x", "New chat");
    settle();
    expect(noteReveal("tab:manager:y", "Ship the billing fix")).toBeNull();
  });

  test("with reduced motion the new name shows at once, and is remembered", () => {
    noteReveal("workspace:/w", "Untitled workspace");
    settle();
    expect(noteReveal("workspace:/w", "Billing webhook retries", { reducedMotion: true })).toBeNull();
    // Turning motion back on later does not replay a rename already shown.
    expect(noteReveal("workspace:/w", "Billing webhook retries")).toBeNull();
  });

  test("asking for less motion mid-reveal ends it on the spot", () => {
    noteReveal("tab:browser:b", "New tab");
    settle();
    expect(noteReveal("tab:browser:b", "Aura docs")).not.toBeNull();
    now += 100;
    expect(noteReveal("tab:browser:b", "Aura docs", { reducedMotion: true })).toBeNull();
    expect(noteReveal("tab:browser:b", "Aura docs")).toBeNull();
  });

  test("a second rename restarts from the name it was showing", () => {
    noteReveal("tab:agent:a3", "Claude Code");
    settle();
    noteReveal("tab:agent:a3", "reading the tests");
    now += REVEAL_MS * 2;
    expect(noteReveal("tab:agent:a3", "reading the tests")).toBeNull();
    const again = noteReveal("tab:agent:a3", "fixing the flaky test");
    expect(again?.from).toBe("reading the tests");
    expect(again?.progress).toBe(0);
  });
});

describe("what a frame of the reveal looks like", () => {
  const text = (cells: ReturnType<typeof revealFrame>) =>
    cells.map((c) => (c.kind === "char" ? c.ch : "▪")).join("");

  test("the last frame is exactly the new name", () => {
    expect(text(revealFrame("New chat", "Fix the login redirect", 1, 7))).toBe(
      "Fix the login redirect",
    );
    expect(text(revealFrame("Untitled workspace", "Billing", 1, 7))).toBe("Billing");
  });

  test("it starts from the old name and turns over left to right", () => {
    const early = text(revealFrame("New chat", "Review PR #93", 0.05, 3));
    expect(early.startsWith("▪")).toBe(true);
    expect(early.slice(-3)).toBe("hat");
    const late = text(revealFrame("New chat", "Review PR #93", 0.9, 3));
    expect(late.startsWith("Review")).toBe(true);
  });

  test("midway it is pixels standing in for letters, with the gaps kept", () => {
    const cells = revealFrame("New chat", "Fix the login redirect", 0.45, 11);
    expect(cells.some((c) => c.kind === "px")).toBe(true);
    for (const c of cells) if (c.kind === "px") expect([1, 2, 3]).toContain(c.level);
    // No letter is ever drawn as a pixel where the new name has a space.
    const next = Array.from("Fix the login redirect");
    cells.forEach((c, i) => {
      if (next[i] === " ") expect(c).toEqual({ kind: "char", ch: " " });
    });
  });

  test("the same reveal draws the same frame — it is a pattern, not a dice roll per render", () => {
    expect(revealFrame("A", "Billing webhook", 0.4, 99)).toEqual(
      revealFrame("A", "Billing webhook", 0.4, 99),
    );
  });

  test("letters outside the basic plane land whole", () => {
    expect(text(revealFrame("New chat", "Fix 🐛 in login", 1, 5))).toBe("Fix 🐛 in login");
  });
});
