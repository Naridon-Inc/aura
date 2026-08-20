import { describe, expect, test } from "bun:test";

import { projectRootFor, rootsForScope, scopeValueOf } from "./projectRoots";

// The registry as it actually looks on a machine with parallel copies running:
// projects carry the `p-<hex>` id the managed worktree store names its folders
// after, and no worktree is ever a row of its own.
const KNOWN = [
  { root: "/Users/x/Documents/Shopify", label: "Shopify", id: "p-806b69db6ce45eb6" },
  { root: "/Users/x/Documents/New Git", label: "New Git", id: "p-2daf03543d69790" },
];

describe("projectRootFor", () => {
  test("a real project is left alone", () => {
    expect(projectRootFor("/Users/x/Documents/Shopify", KNOWN)).toBe(
      "/Users/x/Documents/Shopify",
    );
  });

  test("the managed store's `p-<hash>` folder resolves through the registry", () => {
    // This is the case the user saw: the picker read "marrakesh".
    expect(
      projectRootFor("/Users/x/.aura/worktrees/p-806b69db6ce45eb6/marrakesh", KNOWN),
    ).toBe("/Users/x/Documents/Shopify");
  });

  test("a sibling worktree resolves from the path, registry or not", () => {
    expect(
      projectRootFor("/Users/x/Documents/New Git/.claude/worktrees/trunk-0.19.33", []),
    ).toBe("/Users/x/Documents/New Git");
  });

  test("an unknown project's copy keeps its own root rather than guessing", () => {
    const orphan = "/Users/x/.aura/worktrees/p-ffffffffffffffff/kyoto";
    expect(projectRootFor(orphan, KNOWN)).toBe(orphan);
  });
});

describe("the places read the project, not the copy", () => {
  const WT = "/Users/x/.aura/worktrees/p-806b69db6ce45eb6/marrakesh";

  test("no explicit scope means the open checkout's PROJECT", () => {
    expect(rootsForScope("", WT, KNOWN)).toEqual(["/Users/x/Documents/Shopify"]);
    expect(scopeValueOf("", WT, KNOWN)).toBe("/Users/x/Documents/Shopify");
  });

  test("an explicit scope is already a project and passes through", () => {
    expect(rootsForScope("/Users/x/Documents/New Git", WT, KNOWN)).toEqual([
      "/Users/x/Documents/New Git",
    ]);
  });

  test("the picker's value is always one of the options it offers", () => {
    const value = scopeValueOf("", WT, KNOWN);
    expect(KNOWN.some((k) => k.root === value)).toBe(true);
  });
});
