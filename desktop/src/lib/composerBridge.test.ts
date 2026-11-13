import { expect, test } from "bun:test";

import { insertIntoComposer, registerComposerInserter, withLeading, withTrailing } from "./composerBridge";

test("a mention handed to the composer goes in front of what is typed, once", () => {
  expect(withLeading("can you look?", "@maya ")).toBe("@maya can you look?");
  expect(withLeading("  can you look?", "@maya")).toBe("@maya can you look?");
  expect(withLeading("", "@maya ")).toBe("@maya ");
  expect(withLeading("@maya can you look?", "@maya ")).toBe("@maya can you look?");
  expect(withLeading("@mayabelle hi", "@maya ")).toBe("@maya @mayabelle hi");
});

test("anything else follows what is typed, after a blank line", () => {
  expect(withTrailing("fix this", "Priya said: try the green one")).toBe(
    "fix this\n\nPriya said: try the green one",
  );
  expect(withTrailing("  ", "Priya said: hi")).toBe("Priya said: hi");
});

test("the composer is told where the text goes", () => {
  const got: [string, string | undefined][] = [];
  const off = registerComposerInserter((text, at) => got.push([text, at]));
  expect(insertIntoComposer("@maya ", "start")).toBe(true);
  expect(insertIntoComposer("quote")).toBe(true);
  off();
  expect(insertIntoComposer("lost")).toBe(false);
  expect(got).toEqual([
    ["@maya ", "start"],
    ["quote", "end"],
  ]);
});
