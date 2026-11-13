// What these pin: viewed files leave their groups for a last "Viewed" group,
// in order and keeping their mode; with none viewed the groups are untouched.

import { describe, expect, it } from "bun:test";

import type { ChangedFile } from "../../lib/useGitChanges";
import type { ChangeGroup } from "./ChangesTree";
import { VIEWED_GROUP_KEY, withViewedGroup } from "./viewedGroup";

const file = (path: string): ChangedFile =>
  ({ path, status: "M", index: " ", worktree: "M", additions: 1, deletions: 0 }) as ChangedFile;

const groups: ChangeGroup[] = [
  { key: "staged", title: "Staged", files: [{ file: file("a"), mode: "staged" }] },
  {
    key: "changes",
    title: "Changes",
    files: [
      { file: file("b"), mode: "unstaged" },
      { file: file("c"), mode: "unstaged" },
    ],
  },
];

describe("viewed group", () => {
  it("moves viewed files into a last group", () => {
    const out = withViewedGroup(groups, (f) => f.path !== "b");
    expect(out.map((g) => g.key)).toEqual(["staged", "changes", VIEWED_GROUP_KEY]);
    expect(out[0].files).toHaveLength(0);
    expect(out[1].files.map((e) => e.file.path)).toEqual(["b"]);
    expect(out[2].title).toBe("Viewed");
    expect(out[2].files.map((e) => [e.file.path, e.mode])).toEqual([
      ["a", "staged"],
      ["c", "unstaged"],
    ]);
  });

  it("leaves the groups alone when nothing is viewed", () => {
    expect(withViewedGroup(groups, () => false)).toBe(groups);
  });

  it("drops an emptied group that had no caption", () => {
    const one: ChangeGroup[] = [{ key: "all", files: [{ file: file("a"), mode: "unstaged" }] }];
    const out = withViewedGroup(one, () => true);
    expect(out.map((g) => g.key)).toEqual([VIEWED_GROUP_KEY]);
  });
});
