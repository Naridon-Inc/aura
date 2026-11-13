// The All files tab's rows, from what the disk and git report.
//
//   bun test tests/projectFileRows.test.ts
//
// The tab draws folders as they are read, marks each file from git with a
// sentence a non-engineer can read, and turns a filter into a tree of the
// folders holding the best matches. These are the pure mappings behind it.

import { describe, expect, test } from "bun:test";

import type { DirEntry } from "../src/lib/api";
import type { ChangedFile } from "../src/lib/useGitChanges";
import {
  NEW_ENTRY_ID,
  SEARCH_LIMIT,
  canMoveInto,
  changeMap,
  fileNode,
  filterNodes,
  folderIds,
  hitTree,
  listingNodes,
  parentOf,
  rankHits,
  relativeTo,
  visibleIds,
  withNestedChanges,
  withNewEntry,
} from "../src/components/rightrail/files/fileNodes";

const ROOT = "/repo";

function changed(path: string, status: string, additions = 0, deletions = 0): ChangedFile {
  return { path, status, index: status, worktree: status, additions, deletions };
}

function entry(path: string, isDir: boolean, gitStatus: string | null = null): DirEntry {
  return { name: path.slice(path.lastIndexOf("/") + 1), path, is_dir: isDir, git_status: gitStatus };
}

describe("paths", () => {
  test("parent and project-relative path", () => {
    expect(parentOf("/repo/src/a.ts")).toBe("/repo/src");
    expect(parentOf("/repo")).toBeNull();
    expect(relativeTo("/repo/", "/repo/src/a.ts")).toBe("src/a.ts");
    expect(relativeTo("/repo", "/elsewhere/a.ts")).toBe("/elsewhere/a.ts");
  });
});

describe("canMoveInto", () => {
  test("a file or folder moves into another folder", () => {
    expect(canMoveInto(["/repo/src/a.ts"], "/repo/docs")).toBe(true);
    expect(canMoveInto(["/repo/src/lib"], "/repo/docs")).toBe(true);
  });

  test("a folder never moves into itself or a folder inside it", () => {
    expect(canMoveInto(["/repo/src"], "/repo/src")).toBe(false);
    expect(canMoveInto(["/repo/src"], "/repo/src/lib")).toBe(false);
  });

  test("a folder that already holds the entry is no move", () => {
    expect(canMoveInto(["/repo/src/a.ts"], "/repo/src")).toBe(false);
  });

  test("a folder whose name only starts the same is not inside it", () => {
    expect(canMoveInto(["/repo/src"], "/repo/src-old")).toBe(true);
  });

  test("a selection moves when any one of its entries can", () => {
    expect(canMoveInto(["/repo/src/a.ts", "/repo/docs/b.md"], "/repo/src")).toBe(true);
    expect(canMoveInto(["/repo/src/a.ts", "/repo/src/b.ts"], "/repo/src")).toBe(false);
    expect(canMoveInto([], "/repo/src")).toBe(false);
  });
});

describe("changeMap", () => {
  test("only working-tree changes and new files can be discarded", () => {
    const map = changeMap({
      staged: [changed("staged.ts", "M", 2, 1)],
      unstaged: [changed("edited.ts", "M", 4, 0)],
      untracked: [changed("new.ts", "?", 9, 0)],
    });
    expect(map.get("staged.ts")?.discardable).toBe(false);
    expect(map.get("edited.ts")?.discardable).toBe(true);
    expect(map.get("new.ts")).toMatchObject({ status: "?", discardable: true, untracked: true });
  });

  test("a file both staged and edited keeps its first letter and can be discarded", () => {
    const map = changeMap({
      staged: [changed("both.ts", "A", 1, 0)],
      unstaged: [changed("both.ts", "M", 3, 2)],
      untracked: [],
    });
    expect(map.get("both.ts")).toMatchObject({ status: "A", added: 3, removed: 2, discardable: true });
  });
});

describe("withNestedChanges", () => {
  test("a nested repository's changes land under its folder, and its stand-in entry goes", () => {
    const own = changeMap({ staged: [], unstaged: [changed("README.md", "M", 1, 0)], untracked: [changed("cloud/", "?")] });
    const map = withNestedChanges(own, [
      { rel: "cloud", git: { staged: [changed("api.rs", "A", 5, 0)], unstaged: [], untracked: [changed("notes.md", "?", 2, 0)] } },
    ]);
    expect(map.get("README.md")?.status).toBe("M");
    expect(map.has("cloud/")).toBe(false);
    expect(map.get("cloud/api.rs")).toMatchObject({ status: "A", added: 5, discardable: false });
    expect(map.get("cloud/notes.md")).toMatchObject({ status: "?", untracked: true });
  });

  test("no nested repositories hands back the project's own map", () => {
    const own = changeMap({ staged: [], unstaged: [changed("a.ts", "M")], untracked: [] });
    expect(withNestedChanges(own, [])).toBe(own);
  });

  test("a nested file shows in the tree with its own mark", () => {
    const changes = withNestedChanges(new Map(), [
      { rel: "cloud", git: { staged: [], unstaged: [changed("api.rs", "M", 2, 1)], untracked: [] } },
    ]);
    const nodes = listingNodes(
      ROOT,
      new Map([
        [ROOT, [entry(`${ROOT}/cloud`, true)]],
        [`${ROOT}/cloud`, [entry(`${ROOT}/cloud/api.rs`, false)]],
      ]),
      changes,
    );
    expect(nodes[0].children?.[0]).toMatchObject({ status: "modified", added: 2, removed: 1 });
  });
});

describe("fileNode", () => {
  test("every mark carries a sentence, not just a letter", () => {
    for (const letter of ["M", "A", "?", "D", "R", "U"]) {
      const node = fileNode("/repo/f", "f", letter);
      expect(node.status).toBeDefined();
      expect(node.statusLabel?.split(" ").length ?? 0).toBeGreaterThan(0);
      expect(node.statusLabel).not.toBe(letter);
    }
  });

  test("a conflict from the listing wins over the change store", () => {
    const change = { status: "M", added: 1, removed: 1, discardable: true, untracked: false };
    expect(fileNode("/repo/f", "f", "U", change).status).toBe("conflict");
  });

  test("an untracked file is drawn as new; counts only when lines moved", () => {
    expect(fileNode("/repo/f", "f", "?").status).toBe("added");
    const quiet = fileNode("/repo/f", "f", null, { status: "M", added: 0, removed: 0, discardable: true, untracked: false });
    expect(quiet.added).toBeUndefined();
    const busy = fileNode("/repo/f", "f", null, { status: "M", added: 5, removed: 2, discardable: true, untracked: false });
    expect([busy.added, busy.removed]).toEqual([5, 2]);
  });

  test("a clean file has no mark", () => {
    const node = fileNode("/repo/f", "f", null);
    expect(node.status).toBeUndefined();
    expect(node.statusLabel).toBeUndefined();
  });
});

describe("listingNodes", () => {
  test("a folder not read yet has no children until it is opened", () => {
    const listings = new Map<string, DirEntry[]>([
      [ROOT, [entry("/repo/src", true), entry("/repo/docs", true), entry("/repo/a.ts", false, "M")]],
      ["/repo/src", [entry("/repo/src/b.ts", false)]],
    ]);
    const changes = changeMap({ staged: [], unstaged: [changed("a.ts", "M", 3, 1)], untracked: [] });
    const nodes = listingNodes(ROOT, listings, changes);
    expect(nodes.map((n) => n.name)).toEqual(["src", "docs", "a.ts"]);
    expect(nodes[0].children?.map((n) => n.id)).toEqual(["/repo/src/b.ts"]);
    expect(nodes[1].children).toEqual([]);
    expect(nodes[2]).toMatchObject({ status: "modified", added: 3, removed: 1 });
  });
});

describe("rankHits", () => {
  const index = ["src/deep/app.tsx", "app.ts", "src/apple.ts", "src/myapp.ts", "app/readme.md", "lib/other.ts"];

  test("exact name, then prefix (shorter name first), then contains, then a folder match", () => {
    expect(rankHits(index, "app.ts").hits[0]).toBe("app.ts");
    const { hits, total } = rankHits(index, "app");
    expect(total).toBe(5);
    expect(hits).toEqual(["app.ts", "src/deep/app.tsx", "src/apple.ts", "src/myapp.ts", "app/readme.md"]);
  });

  test("past the limit the total still counts every match", () => {
    const many = Array.from({ length: SEARCH_LIMIT + 25 }, (_, i) => `f${i}.ts`);
    const { hits, total } = rankHits(many, "f");
    expect(hits.length).toBe(SEARCH_LIMIT);
    expect(total).toBe(SEARCH_LIMIT + 25);
  });
});

describe("hitTree", () => {
  test("matches sit inside their folders, in ranking order", () => {
    const tree = hitTree("/repo/", ["src/b.ts", "a.ts", "src/deep/c.ts"], new Map());
    expect(tree.map((n) => n.id)).toEqual(["/repo/src", "/repo/a.ts"]);
    expect(tree[0].children?.map((n) => n.id)).toEqual(["/repo/src/b.ts", "/repo/src/deep"]);
    expect(folderIds(tree)).toEqual(["/repo/src", "/repo/src/deep"]);
  });
});

describe("filterNodes and visibleIds", () => {
  const tree = [
    { id: "/repo/src", name: "src", children: [{ id: "/repo/src/main.ts", name: "main.ts" }, { id: "/repo/src/x.ts", name: "x.ts" }] },
    { id: "/repo/README.md", name: "README.md" },
  ];

  test("a match keeps the folders above it", () => {
    const kept = filterNodes(tree, "main");
    expect(kept.map((n) => n.id)).toEqual(["/repo/src"]);
    expect(kept[0].children?.map((n) => n.id)).toEqual(["/repo/src/main.ts"]);
  });

  test("closed folders hide their rows", () => {
    expect(visibleIds(tree, new Set())).toEqual(["/repo/src", "/repo/README.md"]);
    expect(visibleIds(tree, new Set(["/repo/src"]))).toEqual([
      "/repo/src",
      "/repo/src/main.ts",
      "/repo/src/x.ts",
      "/repo/README.md",
    ]);
  });
});

describe("withNewEntry", () => {
  const tree = [{ id: "/repo/src", name: "src", children: [{ id: "/repo/src/a.ts", name: "a.ts" }] }];

  test("the naming row goes first inside its folder", () => {
    const next = withNewEntry(tree, "/repo/src", false);
    expect(next[0].children?.[0]).toEqual({ id: NEW_ENTRY_ID, name: "" });
    expect(tree[0].children.length).toBe(1);
  });

  test("a new folder row is a folder; an unseen parent puts it at the top", () => {
    const next = withNewEntry(tree, "/repo/elsewhere", true);
    expect(next[0]).toEqual({ id: NEW_ENTRY_ID, name: "", children: [] });
  });
});
