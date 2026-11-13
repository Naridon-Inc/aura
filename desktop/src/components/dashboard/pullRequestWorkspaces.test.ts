import { describe, expect, test } from "bun:test";

import { prLocalBranch, prWorkspaces } from "./pullRequestWorkspaces";

const pr = (number: number, head_ref: string, is_cross_repository = false) => ({
  number,
  head_ref,
  is_cross_repository,
});

describe("prWorkspaces", () => {
  const worktrees = [
    { path: "/r", branch: "main" },
    { path: "/r-wt/api", branch: "refs/heads/feat/stack-api" },
    { path: "/r-wt/fork", branch: "pr-12-main" },
  ];

  test("a pull request's workspace is the checkout on its branch", () => {
    const m = prWorkspaces([pr(103, "feat/stack-api"), pr(104, "feat/stack-ui")], worktrees);
    expect(m.get(103)).toBe("/r-wt/api");
    expect(m.has(104)).toBe(false);
  });

  test("a fork's pull request is looked for on the branch it is fetched into, not its head name", () => {
    // The fork's head is called `main`; the repository's own main checkout is
    // not that pull request's workspace.
    const m = prWorkspaces([pr(12, "main", true), pr(13, "main", true)], worktrees);
    expect(m.get(12)).toBe("/r-wt/fork");
    expect(m.has(13)).toBe(false);
    expect(prLocalBranch(pr(12, "main", true))).toBe("pr-12-main");
  });
});
