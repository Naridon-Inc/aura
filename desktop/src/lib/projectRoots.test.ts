import { describe, expect, test } from "bun:test";

import {
  mergeRootReads,
  projectRootFor,
  rootsForScope,
  scopeValueOf,
  unreadProjectsMessage,
  type RootTasks,
} from "./projectRoots";
import type { Task } from "./api";

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

// AURA-263: Tasks showed "No tasks yet" on a board the rail beside it was
// counting 261 tasks in, and neither switching view nor clearing filters
// brought them back. A read that fails and a project with no work were the
// same fact to the board, so one failed read erased everything on screen.

function task(id: string, root: string): Task & { __root: string } {
  return {
    id,
    title: id,
    status: "todo",
    priority: "medium",
    labels: [],
    __root: root,
  } as unknown as Task & { __root: string };
}

function ok(root: string, ids: string[]): RootTasks {
  return { root, tasks: ids.map((id) => task(id, root)), error: null };
}

function broke(root: string): RootTasks {
  return { root, tasks: [], error: "read failed" };
}

describe("mergeRootReads", () => {
  const A = "/Users/x/Documents/New Git";
  const B = "/Users/x/Documents/Shopify";

  test("a clean read replaces what was there", () => {
    const { tasks, failed } = mergeRootReads([task("old", A)], [ok(A, ["a1", "a2"])]);
    expect(tasks.map((t) => t.id)).toEqual(["a1", "a2"]);
    expect(failed).toEqual([]);
  });

  test("a project that genuinely has no work reports none", () => {
    // Not the same as the case below, and the difference is the whole point.
    const { tasks, failed } = mergeRootReads([task("old", A)], [ok(A, [])]);
    expect(tasks).toEqual([]);
    expect(failed).toEqual([]);
  });

  test("a project that could not be read keeps the rows it last showed", () => {
    const { tasks, failed } = mergeRootReads([task("a1", A)], [broke(A)]);
    expect(tasks.map((t) => t.id)).toEqual(["a1"]);
    expect(failed).toEqual([A]);
  });

  test("one project failing does not cost the others their fresh rows", () => {
    const { tasks, failed } = mergeRootReads(
      [task("a1", A), task("b1", B)],
      [broke(A), ok(B, ["b2"])],
    );
    expect(tasks.map((t) => t.id).sort()).toEqual(["a1", "b2"]);
    expect(failed).toEqual([A]);
  });

  test("a project that answered is not topped up from the stale copy", () => {
    // b1 was deleted between reads; keeping it because it used to be there
    // would resurrect deleted work.
    const { tasks } = mergeRootReads(
      [task("b1", B), task("b2", B)],
      [ok(B, ["b2"])],
    );
    expect(tasks.map((t) => t.id)).toEqual(["b2"]);
  });

  test("a stale row is not shown twice when the fresh read also has it", () => {
    const { tasks } = mergeRootReads(
      [task("a1", A), task("b1", B)],
      [broke(A), ok(B, ["a1"])],
    );
    expect(tasks.map((t) => t.id)).toEqual(["a1"]);
  });

  test("when nothing answered at all, the whole board is kept", () => {
    // Including rows whose project tag we never recorded — an untagged row is
    // still work someone can see, and this is the moment we know least.
    const previous = [task("a1", A), { ...task("b1", B), __root: undefined }];
    const { tasks, failed } = mergeRootReads(previous, [broke(A), broke(B)]);
    expect(tasks.map((t) => t.id)).toEqual(["a1"]);
    expect(failed).toEqual([A, B]);
  });

  test("a cold start that fails has nothing to keep, and says so", () => {
    const { tasks, failed } = mergeRootReads([], [broke(A)]);
    expect(tasks).toEqual([]);
    expect(failed).toEqual([A]);
  });
});

describe("unreadProjectsMessage", () => {
  const A = "/Users/x/Documents/New Git";
  const B = "/Users/x/Documents/Shopify";

  test("says nothing when every project answered", () => {
    expect(unreadProjectsMessage([], KNOWN)).toBeNull();
  });

  test("names the project rather than counting it", () => {
    expect(unreadProjectsMessage([A], KNOWN)).toBe(
      "Couldn’t read tasks from New Git. Showing what was last loaded.",
    );
  });

  test("reads as a sentence with several", () => {
    expect(unreadProjectsMessage([A, B], KNOWN)).toBe(
      "Couldn’t read tasks from New Git and Shopify. Showing what was last loaded.",
    );
  });

  test("falls back to the folder name for a project not in the registry", () => {
    expect(unreadProjectsMessage(["/Users/x/src/orphan"], KNOWN)).toContain("orphan");
  });
});
