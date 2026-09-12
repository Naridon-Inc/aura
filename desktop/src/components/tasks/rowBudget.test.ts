// Run with: bun test src/components/tasks/rowBudget.test.ts
//
// AURA-263 / AURA-269: the Tasks list rendered every row it had. On a real
// board that meant a five-to-seven second blocked render, during which the
// chrome said List while the Board was still on screen, a menu looked like it
// needed a second click, and an empty state sat over work that existed.

import { describe, expect, test } from "bun:test";

import {
  budgetGroups,
  FIRST_PAINT_CARDS,
  FIRST_PAINT_ROWS,
  REVEAL_STEP_CARDS,
  rowCap,
} from "./rowBudget";

function group(key: string, n: number) {
  return { key, tasks: Array.from({ length: n }, (_, i) => `${key}-${i}`) };
}

describe("rowCap", () => {
  test("the first paint is a screenful and a bit, not a whole board", () => {
    expect(rowCap(0)).toBe(FIRST_PAINT_ROWS);
    expect(rowCap(0)).toBeLessThan(200);
  });

  test("each reveal adds more than the last paint drew, so scrolling settles", () => {
    expect(rowCap(1)).toBeGreaterThan(rowCap(0));
    expect(rowCap(6)).toBeGreaterThan(1_149); // the board this was found on
  });

  test("a lane of cards starts smaller than a list of rows", () => {
    // Four lanes pay the first paint together, and a card is several times the
    // DOM of a row.
    expect(FIRST_PAINT_CARDS).toBeLessThan(FIRST_PAINT_ROWS);
    expect(rowCap(0, FIRST_PAINT_CARDS, REVEAL_STEP_CARDS)).toBe(FIRST_PAINT_CARDS);
    expect(rowCap(2, FIRST_PAINT_CARDS, REVEAL_STEP_CARDS)).toBe(
      FIRST_PAINT_CARDS + 2 * REVEAL_STEP_CARDS,
    );
  });

  test("a negative reveal count cannot shrink the list", () => {
    expect(rowCap(-3)).toBe(FIRST_PAINT_ROWS);
  });
});

describe("budgetGroups", () => {
  test("a list that fits is drawn whole", () => {
    const { groups, hidden } = budgetGroups([group("a", 3), group("b", 2)], 120);
    expect(groups.map((g) => g.tasks.length)).toEqual([3, 2]);
    expect(hidden).toBe(0);
  });

  test("a long list is cut in order, and says how much it held back", () => {
    const { groups, hidden } = budgetGroups([group("a", 100), group("b", 100)], 120);
    expect(groups.map((g) => g.tasks.length)).toEqual([100, 20]);
    expect(hidden).toBe(80);
  });

  test("a group's header keeps its true count even when its rows are cut", () => {
    // A heading reading "20" over a group of 100 would be a worse bug than the
    // slow render this exists to fix.
    const { groups } = budgetGroups([group("a", 100)], 40);
    expect(groups[0]!.tasks.length).toBe(40);
    expect(groups[0]!.total).toBe(100);
  });

  test("a group entirely past the cap is dropped, not drawn as a bare heading", () => {
    const { groups, hidden } = budgetGroups(
      [group("a", 10), group("b", 10), group("c", 10)],
      10,
    );
    expect(groups.map((g) => g.key)).toEqual(["a"]);
    expect(hidden).toBe(20);
  });

  test("an already-empty group passes through, because it says what the pipeline is", () => {
    // The list keeps empty Backlog / In progress headings on purpose; the
    // budget must not be what removes them.
    const { groups } = budgetGroups([group("a", 0), group("b", 5)], 120);
    expect(groups.map((g) => g.key)).toEqual(["a", "b"]);
  });

  test("the drawn rows are the first ones, in the order they were given", () => {
    const { groups } = budgetGroups([group("a", 5)], 2);
    expect(groups[0]!.tasks).toEqual(["a-0", "a-1"]);
  });

  test("a cap of zero draws no rows and hides all of them", () => {
    const { groups, hidden } = budgetGroups([group("a", 7)], 0);
    expect(groups).toEqual([]);
    expect(hidden).toBe(7);
  });

  test("a collapsed group costs nothing and still reports its real size", () => {
    // Collapsing a 900-row Backlog must not spend the whole budget on rows
    // nobody can see — and its heading must still say 900.
    const collapsed = { key: "backlog", tasks: [] as string[], total: 900 };
    const { groups, hidden } = budgetGroups([collapsed, group("b", 10)], 120);
    expect(groups[0]!.total).toBe(900);
    expect(groups[1]!.tasks.length).toBe(10);
    expect(hidden).toBe(0);
  });

  test("nothing to draw is not an error", () => {
    expect(budgetGroups([], 120)).toEqual({ groups: [], hidden: 0 });
  });

  test("the original groups are not mutated", () => {
    const gs = [group("a", 5)];
    budgetGroups(gs, 2);
    expect(gs[0]!.tasks.length).toBe(5);
  });
});
