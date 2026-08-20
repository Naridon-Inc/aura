// What the keyboard map claims, checked against what the app binds.
//
// This is aura-shell's first test, and it exists because of a specific failure:
// `lib/shortcuts.ts` called itself "the single source of truth for every
// shortcut Aura ships", and every key it listed was real — but it listed 22 of
// the 37 the app binds. The claim only ever ran one way, and the direction it
// didn't run is the one a cheat-sheet is for. A comment can't catch that. This
// can.
//
// It lives in `tests/` rather than beside the source because `tsconfig.json`
// includes only `src`, and the repo carries no Bun types — a `bun:test` import
// under `src` would fail `bun run typecheck`, which is also `bun run build`.
//
//   bun test
//
// Reads real source rather than mocking, so it fails when the app changes and
// the map doesn't. Anything scanning source strips comments first: several of
// these files now carry comments naming the exact thing they stopped doing, and
// a scan that doesn't strip them finds the ghost and reports it as the thing.

import { describe, expect, test } from "bun:test";

import { SHORTCUT_GROUPS, comboKeys } from "../src/lib/shortcuts";
import { stripComments } from "./support/code";

const SRC = `${import.meta.dir}/../src`;


describe("comboKeys", () => {
  test("splits a combo into the caps that get drawn", () => {
    expect(comboKeys("⌘⇧F")).toEqual(["⌘", "⇧", "F"]);
    expect(comboKeys("⌘,")).toEqual(["⌘", ","]);
    expect(comboKeys("⌘/")).toEqual(["⌘", "/"]);
    expect(comboKeys("⌘⌥↓")).toEqual(["⌘", "⌥", "↓"]);
    expect(comboKeys("?")).toEqual(["?"]);
  });

  test("a run of letters is one cap, not one box per letter", () => {
    // The three code-point splits this replaced would each have drawn
    // ⌘ ⇧ E n t e r — seven boxes for a three-key combo.
    expect(comboKeys("⌘⇧Enter")).toEqual(["⌘", "⇧", "Enter"]);
    expect(comboKeys("Enter")).toEqual(["Enter"]);
    expect(comboKeys("Esc")).toEqual(["Esc"]);
  });

  test("+ separates and never prints", () => {
    // Which is what lets a combo name something that isn't a key.
    expect(comboKeys("⇧+click")).toEqual(["⇧", "click"]);
  });

  test("every combo in the map draws at least one cap, and no blanks", () => {
    for (const group of SHORTCUT_GROUPS) {
      for (const s of group.items) {
        const caps = comboKeys(s.keys);
        expect(caps.length).toBeGreaterThan(0);
        expect(caps.every((c) => c.trim().length > 0)).toBe(true);
        expect(caps.length).toBeLessThanOrEqual([...s.keys].length);
      }
    }
  });
});

describe("the map", () => {
  test("every group has bindings", () => {
    for (const g of SHORTCUT_GROUPS) expect(g.items.length).toBeGreaterThan(0);
  });

  test("no combo is bound twice inside one group", () => {
    // Across groups is fine and now expected — Enter opens a task on a focused
    // card and builds a plan on a plan card. Twice on ONE surface is two
    // answers to one key, which is the bug this pass is about.
    const dupes: string[] = [];
    for (const g of SHORTCUT_GROUPS) {
      const seen = new Set<string>();
      for (const s of g.items) {
        if (seen.has(s.keys)) dupes.push(`${g.title}: ${s.keys}`);
        seen.add(s.keys);
      }
    }
    expect(dupes).toEqual([]);
  });

  test("a group whose keys aren't global says where they apply", () => {
    // A scoped key printed with no scope is worse than an absent one: you try
    // it on the wrong screen and conclude the app is broken.
    const global = new Set([
      "Find your way around",
      "Chat & agents",
      "Panels & tabs",
      "Files & history",
    ]);
    const silent = SHORTCUT_GROUPS.filter(
      (g) => !global.has(g.title) && !g.note,
    ).map((g) => g.title);
    expect(silent).toEqual([]);
  });

  test("labels are plain language, not key names", () => {
    // The audience is non-engineers: "Reopen closed tab", not "restore buffer".
    for (const g of SHORTCUT_GROUPS) {
      for (const s of g.items) expect(s.label).toMatch(/\s/);
    }
  });
});

describe("the task-card group is backed by handlers", () => {
  // The assertion useTaskShortcuts.ts's comment points at. It replaces
  // "the list sits next to the handler" as the thing keeping the two in step —
  // proximity made drift easy to notice and did nothing to prevent it.

  // How a listed combo maps onto a keydown. `⇧+click` is a mouse binding the
  // board handles on the card, so it is named here rather than quietly skipped.
  const AS_KEY: Record<string, string> = {
    Enter: "Enter",
    Esc: "Escape",
    "?": "?",
    a: "a",
    p: "p",
    s: "s",
    l: "l",
    c: "c",
    d: "d",
  };
  const MOUSE_ONLY = new Set(["⇧+click"]);

  const group = SHORTCUT_GROUPS.find((g) => g.title === "On a task card");

  async function boundKeys(): Promise<Set<string>> {
    const body = stripComments(
      await Bun.file(`${SRC}/components/tasks/useTaskShortcuts.ts`).text(),
    );
    const bound = new Set<string>();
    for (const m of body.matchAll(/e\.key === "([^"]+)"/g)) bound.add(m[1]!);
    for (const m of body.matchAll(/case "([a-z])":/g)) bound.add(m[1]!);
    return bound;
  }

  test("the group exists", () => {
    expect(group).toBeDefined();
  });

  test("every listed key has a handler", async () => {
    const bound = await boundKeys();
    const unhandled = (group?.items ?? [])
      .filter((i) => !MOUSE_ONLY.has(i.keys))
      .filter((i) => !AS_KEY[i.keys] || !bound.has(AS_KEY[i.keys]!))
      .map((i) => i.keys);
    expect(unhandled).toEqual([]);
  });

  test("every handled key is listed", async () => {
    // The converse, which is how the map went stale in the first place.
    const bound = await boundKeys();
    const listed = new Set(
      (group?.items ?? [])
        .map((i) => AS_KEY[i.keys])
        .filter((k): k is string => !!k),
    );
    expect([...bound].filter((k) => !listed.has(k))).toEqual([]);
  });

  test("the hook no longer carries a list of its own", async () => {
    const body = await Bun.file(
      `${SRC}/components/tasks/useTaskShortcuts.ts`,
    ).text();
    expect(stripComments(body)).not.toContain("TASK_SHORTCUTS");
  });
});

describe("one key cap", () => {
  // Four files draw their own, each documented at the site:
  //   ui/kbd.tsx           — is the cap
  //   QuestionCard.tsx     — inside a filled primary CTA; inverts on the fill
  //   ManagerChatView.tsx  — the plan card's Build key, same reason
  //   Composer.tsx         — menu accelerators: right-aligned plain grey text,
  //                          the macOS convention. A cap there reads as a button.
  const SANCTIONED = new Set([
    "components/ui/kbd.tsx",
    "components/manager/chat/QuestionCard.tsx",
    "components/manager/ManagerChatView.tsx",
    "components/team/presentation/Composer.tsx",
  ]);

  async function sourceFiles(): Promise<string[]> {
    const out: string[] = [];
    for await (const rel of new Bun.Glob("**/*.{ts,tsx}").scan({ cwd: SRC })) {
      out.push(rel);
    }
    return out;
  }

  test("nothing hand-rolls a <kbd> outside the documented four", async () => {
    const rogue: string[] = [];
    for (const rel of await sourceFiles()) {
      if (SANCTIONED.has(rel)) continue;
      const src = stripComments(await Bun.file(`${SRC}/${rel}`).text());
      if (/<kbd[\s>]/.test(src)) rogue.push(rel);
    }
    expect(rogue).toEqual([]);
  });

  test("nobody imports Medusa's key cap", async () => {
    // It paints from Medusa's own zinc tag ramp, not our palette, so a themed
    // app was drawing one unthemed control.
    const medusa: string[] = [];
    for (const rel of await sourceFiles()) {
      const src = stripComments(await Bun.file(`${SRC}/${rel}`).text());
      if (/from ["']@medusajs\/ui["']/.test(src) && /\bKbd\b/.test(src)) {
        medusa.push(rel);
      }
    }
    expect(medusa).toEqual([]);
  });

  test("the cap paints from the theme tokens", async () => {
    const kbd = await Bun.file(`${SRC}/components/ui/kbd.tsx`).text();
    expect(kbd).toContain("bg-kbd-bg");
    expect(kbd).toContain("text-kbd-fg");
  });

  test("every theme pack declares both tokens", async () => {
    // Miss one and the cap goes transparent on whichever pack forgot — which
    // is survivable precisely because nothing rendered them until now.
    const css = await Bun.file(`${SRC}/styles.css`).text();
    const bg = [...css.matchAll(/--color-kbd-bg\s*:/g)].length;
    const fg = [...css.matchAll(/--color-kbd-fg\s*:/g)].length;
    expect(bg).toBeGreaterThanOrEqual(5);
    expect(fg).toBe(bg);
  });
});

describe("one cheat-sheet", () => {
  test("the tasks board no longer draws a second one", async () => {
    const board = stripComments(
      await Bun.file(`${SRC}/components/TasksBoard.tsx`).text(),
    );
    expect(board).not.toContain("ShortcutsModal");
    expect(board).toContain("<ShortcutsDialog");
  });

  test("both surfaces render the groups, so both print the scopes", async () => {
    for (const rel of [
      "components/dialogs/ShortcutsDialog.tsx",
      "components/dialogs/SettingsDialog.tsx",
    ]) {
      const src = stripComments(await Bun.file(`${SRC}/${rel}`).text());
      expect(src).toContain("SHORTCUT_GROUPS");
      expect(src).toContain("group.note");
    }
  });
});
