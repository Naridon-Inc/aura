import { describe, expect, test } from "bun:test";
import type { IntentChangesetFile } from "../src/lib/api";
import { buildChangeTree, changeStatus, folderSummary } from "../src/components/trace/changes/changeTree";

const f = (path: string, extra: Partial<IntentChangesetFile> = {}) =>
  ({ path, ...extra }) as IntentChangesetFile;

describe("buildChangeTree", () => {
  test("a single-child folder chain reads as one row, folders before files", () => {
    const { nodes, fileOrder, folderIds } = buildChangeTree([
      f("README.md", { additions: 1, deletions: 0 }),
      f("a/b/c/x.ts", { additions: 2, deletions: 1 }),
      f("a/b/c/y.ts"),
    ]);
    expect(nodes.map((n) => n.name)).toEqual(["a/b/c", "README.md"]);
    expect(nodes[0].id).toBe("dir:a/b/c");
    expect(nodes[0].children?.map((n) => n.name)).toEqual(["x.ts", "y.ts"]);
    expect(fileOrder).toEqual(["a/b/c/x.ts", "a/b/c/y.ts", "README.md"]);
    expect(folderIds).toEqual(["dir:a/b/c"]);
  });

  test("a file's counts are drawn only when the changeset recorded them", () => {
    const { nodes } = buildChangeTree([f("x.ts", { additions: 3 }), f("y.ts")]);
    expect(nodes[0]).toMatchObject({ added: 3, removed: 0, status: "modified" });
    expect(nodes[1].added).toBeUndefined();
  });

  test("most changed orders whole branches by their summed churn", () => {
    const { fileOrder } = buildChangeTree(
      [
        f("small/a.ts", { additions: 1 }),
        f("big/b.ts", { additions: 50 }),
        f("big/c.ts", { additions: 2 }),
        f("top.ts", { additions: 100 }),
      ],
      "churn",
    );
    expect(fileOrder).toEqual(["big/b.ts", "big/c.ts", "small/a.ts", "top.ts"]);
  });

  test("newest puts unstamped files last", () => {
    const { fileOrder } = buildChangeTree(
      [
        f("a.ts"),
        f("b.ts", { changed_at: "2026-01-01T00:00:00Z" }),
        f("c.ts", { changed_at: "2026-03-01T00:00:00Z" }),
      ],
      "recent",
    );
    expect(fileOrder).toEqual(["c.ts", "b.ts", "a.ts"]);
  });
});

describe("changeStatus", () => {
  test("a rename is a modification that says so", () => {
    expect(changeStatus("R")).toEqual({ status: "modified", word: "renamed" });
    expect(changeStatus("new")).toEqual({ status: "added", word: "added" });
    expect(changeStatus("removed")).toEqual({ status: "deleted", word: "deleted" });
    expect(changeStatus(undefined)).toEqual({ status: "modified", word: "modified" });
  });
});

describe("folderSummary", () => {
  test("sums the files under a folder, not a sibling with the same prefix", () => {
    const files = [
      f("src/a.ts", { additions: 2, deletions: 1 }),
      f("src/b.ts", { additions: 1 }),
      f("srcx/c.ts", { additions: 9 }),
    ];
    expect(folderSummary(files, "src")).toEqual({ count: 2, adds: 3, dels: 1 });
  });
});
