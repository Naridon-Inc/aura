import { describe, expect, test } from "bun:test";
import { fuzzyMatch, searchShortcuts, shortcutRows } from "./shortcutSearch";
import { SHORTCUT_GROUPS } from "./shortcuts";

const rows = shortcutRows([
  { title: "Panels & tabs", items: [{ label: "Close tab", keys: "⌘W" }, { label: "Toggle terminal", keys: "⌘J" }] },
  { title: "Chat & agents", items: [{ label: "New chat", keys: "⌘N" }, { label: "Fork this chat", keys: "⌘⌥Enter" }] },
]);

describe("matching what was typed", () => {
  test("a whole word scores best at the start of a word", () => {
    expect(fuzzyMatch("tab", "Close tab")).toEqual({ score: 1, indices: [6, 7, 8] });
    expect(fuzzyMatch("ab", "Close tab")?.score).toBe(0.9);
  });

  test("letters in order match, and initials count as a good match", () => {
    expect(fuzzyMatch("nc", "New chat")).toEqual({ score: 0.8, indices: [0, 4] });
    expect(fuzzyMatch("cn", "New chat")).toBeNull();
  });

  test("every word has to turn up", () => {
    expect(fuzzyMatch("new chat", "New chat")?.indices).toEqual([0, 1, 2, 4, 5, 6, 7]);
    expect(fuzzyMatch("new tab", "New chat")).toBeNull();
    expect(fuzzyMatch("   ", "New chat")).toBeNull();
  });
});

describe("searching the sheet", () => {
  test("rows come best first and carry the matched letters of their name", () => {
    const hits = searchShortcuts(rows, "chat");
    expect(hits.map((h) => h.row.title)).toEqual(["New chat", "Fork this chat"]);
    expect(hits[0].titleMatch).toEqual([4, 5, 6, 7]);
  });

  test("a group's name finds its rows without highlighting them", () => {
    const hits = searchShortcuts(rows, "panels");
    expect(hits.map((h) => h.row.title)).toEqual(["Close tab", "Toggle terminal"]);
    expect(hits.every((h) => h.titleMatch === undefined)).toBe(true);
  });

  test("at an equal fit, a row named by the query beats one found through its group", () => {
    const hits = searchShortcuts(rows, "tab");
    expect(hits[0].row.title).toBe("Close tab");
    expect(hits[1].titleMatch).toBeUndefined();
  });

  test("letters strewn across a long name are too loose to show", () => {
    // c…e across "Close": 2 letters over 5
    expect(searchShortcuts(rows, "ce")).toHaveLength(0);
    expect(searchShortcuts(rows, "zzz")).toHaveLength(0);
  });

  test("the real map: every row has a unique id and a key", () => {
    const all = shortcutRows();
    expect(all.length).toBe(SHORTCUT_GROUPS.reduce((n, g) => n + g.items.length, 0));
    expect(new Set(all.map((r) => r.id)).size).toBe(all.length);
    expect(searchShortcuts(all, "save")[0].row.keys).toBe("⌘S");
  });
});
