import { describe, expect, test } from "bun:test";

import { createWebglBudget, type WebglHolder } from "./webglBudget";

type Fake = WebglHolder & { name: string; gl: boolean; made: number };

function fake(name: string, canMake = true): Fake {
  const h: Fake = {
    name,
    gl: false,
    made: 0,
    attachGl() {
      if (!canMake) return false;
      h.gl = true;
      h.made += 1;
      return true;
    },
    dropGl() {
      h.gl = false;
    },
  };
  return h;
}

describe("webgl budget", () => {
  test("never holds more contexts than the cap, evicting the one shown longest ago", () => {
    const budget = createWebglBudget<Fake>(3);
    const all = ["a", "b", "c", "d", "e"].map((n) => fake(n));
    for (const h of all) budget.acquire(h);
    expect(budget.holders().map((h) => h.name)).toEqual(["c", "d", "e"]);
    expect(all.filter((h) => h.gl).map((h) => h.name)).toEqual(["c", "d", "e"]);
  });

  test("showing a holder again refreshes it without rebuilding its context", () => {
    const budget = createWebglBudget<Fake>(2);
    const [a, b, c] = ["a", "b", "c"].map((n) => fake(n));
    budget.acquire(a);
    budget.acquire(b);
    budget.acquire(a);
    budget.acquire(c);
    expect(a.made).toBe(1);
    expect(a.gl).toBe(true);
    expect(b.gl).toBe(false);
  });

  test("a terminal that comes back after eviction gets a context again", () => {
    const budget = createWebglBudget<Fake>(1);
    const [a, b] = ["a", "b"].map((n) => fake(n));
    budget.acquire(a);
    budget.acquire(b);
    budget.acquire(a);
    expect(a.gl).toBe(true);
    expect(a.made).toBe(2);
    expect(b.gl).toBe(false);
  });

  test("release disposes, lost only forgets", () => {
    const budget = createWebglBudget<Fake>(4);
    const [a, b] = ["a", "b"].map((n) => fake(n));
    budget.acquire(a);
    budget.acquire(b);
    budget.release(a);
    expect(a.gl).toBe(false);
    b.gl = false; // the webview took it
    budget.lost(b);
    expect(budget.holders()).toEqual([]);
  });

  test("a webview that cannot make a context holds nothing", () => {
    const budget = createWebglBudget<Fake>(2);
    const a = fake("a", false);
    budget.acquire(a);
    expect(budget.holders()).toEqual([]);
  });
});
