import { describe, expect, test } from "bun:test";

import type { DirEntry } from "../../lib/api";
import { boxChanges, boxWorkAt, dirNodes, withChildren } from "./boxWork";
import { changeTree } from "./CloudApiWorkspacePanel";
import { standing } from "./CloudBoxWorkPanel";

const entry = (id: string, repo_path: string | null, project_root: string | null, name = "aura-runner") => ({
  id,
  name,
  repo_path,
  project_root,
});

const place = (remote_root: string, machine = "aura-runner") => ({ machine, remote_root });

describe("boxWorkAt", () => {
  const book = [
    entry("other", "/home/ubuntu/naridon", "/laptop/naridon"),
    entry("ours", "/home/ubuntu/aura", null),
    entry("bare", null, "/laptop/x"),
    entry("elsewhere", "/home/ubuntu/aura", "/laptop/aura", "another-box"),
  ];

  test("reads through the entry for the project the worktree came from", () => {
    const t = boxWorkAt(book, place("/home/ubuntu/aura-fix-login-ab12cd"));
    expect(t).toEqual({
      kind: "ok",
      at: {
        machineId: "ours",
        repoRoot: "/home/ubuntu/aura-fix-login-ab12cd",
        remoteRoot: "/home/ubuntu/aura-fix-login-ab12cd",
      },
    });
  });

  test("a project whose name only starts the same is not the one", () => {
    const t = boxWorkAt(book, place("/home/ubuntu/auraplus"));
    expect(t.kind === "ok" && t.at.machineId).not.toBe("ours");
  });

  test("only entries for the named machine count", () => {
    const t = boxWorkAt(book, place("/home/ubuntu/aura-x", "another-box"));
    expect(t.kind === "ok" && t.at.machineId).toBe("elsewhere");
  });

  test("a machine this laptop has no entry for is not read from anywhere else", () => {
    expect(boxWorkAt(book, place("/home/ubuntu/aura-x", "nobody"))).toEqual({
      kind: "not-connected",
      machine: "nobody",
    });
    expect(boxWorkAt([], place("/home/ubuntu/aura-x")).kind).toBe("not-connected");
  });

  test("a folder that isn't a full path on the machine isn't opened", () => {
    expect(boxWorkAt(book, place("aura-x")).kind).toBe("no-folder");
    expect(boxWorkAt(book, place("/home/ubuntu/../etc")).kind).toBe("no-folder");
    expect(boxWorkAt(book, place("")).kind).toBe("no-folder");
  });

  test("a trailing slash names the same folder", () => {
    const t = boxWorkAt(book, place("/home/ubuntu/aura-x/"));
    expect(t.kind === "ok" && t.at.repoRoot).toBe("/home/ubuntu/aura-x");
  });
});

describe("the files tree", () => {
  const dir = (path: string, is_dir: boolean, git_status: string | null = null): DirEntry => ({
    name: path.split("/").pop()!,
    path,
    is_dir,
    git_status,
  });

  test("a folder is drawn unread until it is opened", () => {
    const nodes = dirNodes([dir("/r/src", true), dir("/r/a.ts", false, "M"), dir("/r/b.ts", false, "?")]);
    expect(nodes[0]).toEqual({ id: "/r/src", name: "src", children: [] });
    expect(nodes[1]).toMatchObject({ id: "/r/a.ts", status: "modified", statusLabel: "Changed" });
    expect(nodes[2]).toMatchObject({ status: "added", statusLabel: "New" });
    expect(nodes[1]!.children).toBeUndefined();
  });

  test("opening a folder puts its listing in, however deep", () => {
    let tree = dirNodes([dir("/r/src", true), dir("/r/x.ts", false)]);
    tree = withChildren(tree, "/r/src", dirNodes([dir("/r/src/lib", true)]));
    tree = withChildren(tree, "/r/src/lib", dirNodes([dir("/r/src/lib/y.ts", false)]));
    expect(tree[0]!.children![0]!.children!.map((n) => n.id)).toEqual(["/r/src/lib/y.ts"]);
    expect(tree[1]).toEqual({ id: "/r/x.ts", name: "x.ts" });
  });
});

describe("the changes tree", () => {
  test("every file the branch changed, with git's word for what isn't committed", () => {
    const files = boxChanges(
      [
        { path: "src/new.ts", additions: 12, deletions: 0 },
        { path: "src/old.ts", additions: 0, deletions: 4 },
        { path: "README.md", additions: 3, deletions: 1 },
        { path: "src/committed.ts", additions: 2, deletions: 2 },
        { path: "src/new.ts", additions: 12, deletions: 0 },
      ],
      [
        { path: "src/new.ts", index: "?", worktree: "?" },
        { path: "src/old.ts", index: "", worktree: "D" },
        { path: "README.md", index: "M", worktree: "" },
      ],
    );
    expect(files.map((f) => [f.path, f.status])).toEqual([
      ["src/new.ts", "added"],
      ["src/old.ts", "removed"],
      ["README.md", "modified"],
      ["src/committed.ts", null],
    ]);
    const tree = changeTree(files);
    const src = tree.find((n) => n.name === "src")!;
    expect(src.children!.find((n) => n.name === "committed.ts")!.status).toBeUndefined();
    expect(src.children!.find((n) => n.name === "old.ts")!.status).toBe("deleted");
  });

  test("a conflicted file says so", () => {
    const [f] = boxChanges([{ path: "a", additions: 1, deletions: 1 }], [{ path: "a", index: "U", worktree: "U" }]);
    expect(changeTree([f!])[0]!.status).toBe("conflict");
  });
});

describe("standing", () => {
  test("names where the branch stands in a few words", () => {
    expect(standing(null)).toBeNull();
    expect(standing({ ahead: 0, behind: 0, has_upstream: false, branch: "b" })).toBe("Not pushed");
    expect(standing({ ahead: 0, behind: 0, has_upstream: true, branch: "b" })).toBe("Up to date");
    expect(standing({ ahead: 2, behind: 1, has_upstream: true, branch: "b" })).toBe("2 ahead · 1 behind");
  });
});
