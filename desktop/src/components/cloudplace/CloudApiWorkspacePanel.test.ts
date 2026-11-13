import { describe, expect, test } from "bun:test";

import type { CloudChangedFile } from "../../lib/cloudWorkspacesApi";
import { workspaceLink } from "../../lib/cloudPlan";
import { changeTree, totalsOf } from "./CloudApiWorkspacePanel";

function file(path: string, status: string | null, additions = 1, deletions = 0): CloudChangedFile {
  return {
    path,
    previous_path: null,
    status,
    additions,
    deletions,
    commit: "abc1234",
    message: "change",
  };
}

describe("changeTree", () => {
  test("puts folders before files and sorts each level by name", () => {
    const tree = changeTree([
      file("src/z.ts", "modified"),
      file("README.md", "modified"),
      file("src/api/a.ts", "added"),
    ]);
    expect(tree.map((n) => n.name)).toEqual(["src", "README.md"]);
    expect(tree[0]!.children!.map((n) => n.name)).toEqual(["api", "z.ts"]);
    expect(tree[0]!.children![0]!.children!.map((n) => n.id)).toEqual(["src/api/a.ts"]);
  });

  test("reads the server's status words and churn as the tree's", () => {
    const [added, removed, renamed] = changeTree([
      file("a.ts", "added", 4, 0),
      file("b.ts", "removed", 0, 9),
      file("c.ts", "renamed"),
    ]);
    expect([added!.status, added!.added, added!.removed]).toEqual(["added", 4, 0]);
    expect([removed!.status, removed!.removed]).toEqual(["deleted", 9]);
    expect([renamed!.status, renamed!.statusLabel]).toEqual(["modified", "renamed"]);
  });

  test("shares one folder between files under it", () => {
    const tree = changeTree([file("src/a.ts", "added"), file("src/b.ts", "added")]);
    expect(tree).toHaveLength(1);
    expect(tree[0]!.children).toHaveLength(2);
  });
});

describe("workspaceLink", () => {
  test("links a public-cloud workspace to its console page", () => {
    expect(workspaceLink("https://auravcs.com", "w 1")).toBe(
      "https://app.auravcs.com/workspaces/w%201",
    );
    expect(workspaceLink("https://api.auravcs.com/", "w1")).toBe(
      "https://app.auravcs.com/workspaces/w1",
    );
  });

  test("offers no link where there is no console to open it on", () => {
    expect(workspaceLink(null, "w1")).toBeNull();
    expect(workspaceLink("http://localhost:3001", "w1")).toBeNull();
  });
});

describe("totalsOf", () => {
  test("adds up the lines every file reports", () => {
    expect(totalsOf([file("a.ts", "added", 3, 0), file("b.ts", "modified", 2, 5)])).toEqual({
      added: 5,
      removed: 5,
    });
  });

  test("says nothing when any file leaves its counts out", () => {
    const unknown = { ...file("b.ts", "modified"), additions: null };
    expect(totalsOf([file("a.ts", "added"), unknown])).toBeNull();
  });
});
