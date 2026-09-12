// Run with: bun test src/components/board/rowActivation.test.ts
//
// AURA-270: only the title of a list row opened the task. The chips, the
// assignee stack and the space between them — most of the row — swallowed the
// click, so the surface looked like it had no detail view at all.

import { describe, expect, test } from "bun:test";

import { rowClickOpens } from "./rowActivation";

/** A stand-in for a clicked element: `matches` lists the selectors that would
 *  find an ancestor from here. bun's runner has no DOM. */
function target(...matches: string[]) {
  return {
    closest(sel: string) {
      const wanted = sel.split(",");
      return matches.some((m) => wanted.includes(m)) ? { tag: matches[0] } : null;
    },
  };
}

describe("rowClickOpens", () => {
  test("plain text on the row opens it", () => {
    expect(rowClickOpens(target())).toBe(true);
  });

  test("the empty space between chips opens it", () => {
    // This is most of a wide row, and it used to do nothing at all.
    expect(rowClickOpens(target())).toBe(true);
  });

  test("the status tag keeps its own click", () => {
    // It sets the status. Opening the task on top of that would be two things
    // from one click.
    expect(rowClickOpens(target("button"))).toBe(false);
  });

  test("a link on the row keeps its own click", () => {
    expect(rowClickOpens(target("a"))).toBe(false);
  });

  test("a menu item keeps its own click", () => {
    expect(rowClickOpens(target('[role="menuitem"]'))).toBe(false);
  });

  test("a checkbox keeps its own click", () => {
    expect(rowClickOpens(target('[role="checkbox"]'))).toBe(false);
  });

  test("something with no closest() at all still opens the row", () => {
    // Defensive: a synthetic event in a test, or a text node. Failing open
    // matches what a reader expects from clicking a row.
    expect(rowClickOpens(null)).toBe(true);
    expect(rowClickOpens({})).toBe(true);
  });
});
