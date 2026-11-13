import { describe, expect, test } from "bun:test";

import type { NestedRepo } from "./api";
import type { ChangedFile } from "./useGitChanges";
import {
  isInsideNested,
  nestedCopyProblems,
  nestedRepoOf,
  nestedLossLines,
  sameRepos,
  trackedCount,
  underFolder,
  withNestedChanges,
  withoutNested,
} from "./nestedRepos";

const file = (path: string, over: Partial<ChangedFile> = {}): ChangedFile => ({
  path,
  status: "M",
  index: " ",
  worktree: "M",
  additions: 1,
  deletions: 0,
  ...over,
});

const repo = (rel_path: string, over: Partial<NestedRepo> = {}): NestedRepo => ({
  rel_path,
  root: `/p/${rel_path}`,
  kind: "nested",
  branch: "main",
  base: "main",
  ...over,
});

describe("isInsideNested", () => {
  test("matches the folder itself, with or without its slash, and what is inside it", () => {
    expect(isInsideNested("cloud", ["cloud"])).toBe(true);
    expect(isInsideNested("cloud/", ["cloud"])).toBe(true);
    expect(isInsideNested("cloud/src/a.ts", ["cloud"])).toBe(true);
  });

  test("a sibling sharing the name's start is not inside", () => {
    expect(isInsideNested("cloudy/a.ts", ["cloud"])).toBe(false);
    expect(isInsideNested("src/cloud", ["cloud"])).toBe(false);
  });

  test("no nested repositories means nothing is inside one", () => {
    expect(isInsideNested("cloud/a.ts", [])).toBe(false);
  });
});

describe("withoutNested", () => {
  test("drops the entry standing in for the folder", () => {
    const files = [file("README.md"), file("cloud/", { index: "?", worktree: "?" })];
    expect(withoutNested(files, ["cloud"]).map((f) => f.path)).toEqual(["README.md"]);
  });

  test("hands back the same array when nothing is dropped", () => {
    const files = [file("README.md"), file("src/a.ts")];
    expect(withoutNested(files, ["cloud"])).toBe(files);
    expect(withoutNested(files, [])).toBe(files);
  });
});

describe("underFolder", () => {
  test("puts each path under the repository's folder and keeps the rest", () => {
    const out = underFolder([file("src/a.ts", { additions: 3 })], "cloud");
    expect(out).toEqual([file("cloud/src/a.ts", { additions: 3 })]);
  });
});

describe("trackedCount", () => {
  test("counts a file both staged and unstaged once", () => {
    expect(trackedCount([file("a"), file("b")], [file("a"), file("c")])).toBe(3);
    expect(trackedCount([], [])).toBe(0);
  });
});

describe("sameRepos", () => {
  test("equal lists match, any field change does not", () => {
    const a = [repo("cloud"), repo("web")];
    expect(sameRepos(a, a)).toBe(true);
    expect(sameRepos(a, [repo("cloud"), repo("web")])).toBe(true);
    expect(sameRepos(a, [repo("cloud")])).toBe(false);
    expect(sameRepos(a, [repo("cloud", { branch: "dev" }), repo("web")])).toBe(false);
    expect(sameRepos(a, [repo("cloud", { kind: "submodule" }), repo("web")])).toBe(false);
    expect(sameRepos(a, [repo("cloud", { root: "/q/cloud" }), repo("web")])).toBe(false);
    expect(sameRepos(a, [repo("cloud", { base: "develop" }), repo("web")])).toBe(false);
  });
});

describe("nestedCopyProblems", () => {
  test("lists only the repositories that failed or were left out", () => {
    expect(
      nestedCopyProblems([
        { rel_path: "cloud", state: "created", branch: "ws/a", detail: null },
        { rel_path: "web", state: "attached", branch: "ws/a", detail: null },
        { rel_path: "infra", state: "failed", branch: "ws/a", detail: "fatal: bad ref" },
        { rel_path: "empty", state: "skipped", branch: null, detail: null },
      ]),
    ).toEqual(["infra: fatal: bad ref", "empty: left out"]);
  });

  test("a failure with no detail still says what happened", () => {
    expect(nestedCopyProblems([{ rel_path: "x", state: "failed", branch: null, detail: null }])).toEqual([
      "x: could not be copied",
    ]);
  });

  test("nothing to say when there are no nested repositories", () => {
    expect(nestedCopyProblems(undefined)).toEqual([]);
    expect(nestedCopyProblems([])).toEqual([]);
  });
});

describe("nestedLossLines", () => {
  test("warns that a repository only in this copy goes with it", () => {
    const [line] = nestedLossLines([{ rel_path: "cloud", changed: 0, standalone: true }]);
    expect(line).toContain("cloud/ is a separate repository that only exists in this copy");
    expect(line).toContain("history included");
  });

  test("counts the uncommitted files of a copied repository", () => {
    expect(nestedLossLines([{ rel_path: "cloud", changed: 1, standalone: false }])[0]).toContain("has 1 file with");
    expect(nestedLossLines([{ rel_path: "web", changed: 4, standalone: false }])[0]).toContain("has 4 files with");
  });

  test("nothing to say when nothing would be lost", () => {
    expect(nestedLossLines([])).toEqual([]);
  });
});

describe("withNestedChanges", () => {
  const none = { staged: [], unstaged: [], untracked: [] };

  test("each repository's files join the project's lists, from the project root", () => {
    const own = { staged: [], unstaged: [file("src/a.ts")], untracked: [] };
    const merged = withNestedChanges(
      own,
      [repo("cloud"), repo("tools/cli")],
      new Map([
        ["/p/cloud", { staged: [file("app.ts")], unstaged: [], untracked: [file("new.md", { status: "?" })] }],
        ["/p/tools/cli", { ...none, unstaged: [file("main.rs")] }],
      ]),
    );
    expect(merged.staged.map((f) => f.path)).toEqual(["cloud/app.ts"]);
    expect(merged.unstaged.map((f) => f.path)).toEqual(["src/a.ts", "tools/cli/main.rs"]);
    expect(merged.untracked.map((f) => f.path)).toEqual(["cloud/new.md"]);
  });

  test("a repository not read yet adds nothing, and the project's lists keep their identity", () => {
    const own = { staged: [file("a.ts")], unstaged: [], untracked: [] };
    const merged = withNestedChanges(own, [repo("cloud")], new Map());
    expect(merged.staged).toBe(own.staged);
    expect(merged.unstaged).toBe(own.unstaged);
  });
});

describe("nestedRepoOf", () => {
  const repos = [repo("cloud"), repo("cloud/vendor/lib"), repo("web")];

  test("a path inside a repository names it; the deepest one wins", () => {
    expect(nestedRepoOf("cloud/src/app.ts", repos)?.rel_path).toBe("cloud");
    expect(nestedRepoOf("cloud/vendor/lib/x.c", repos)?.rel_path).toBe("cloud/vendor/lib");
  });

  test("the project's own files and look-alike names belong to none", () => {
    expect(nestedRepoOf("src/main.ts", repos)).toBeUndefined();
    expect(nestedRepoOf("cloudy/notes.md", repos)).toBeUndefined();
  });
});
