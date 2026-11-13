import { describe, expect, test } from "bun:test";

import type { ChangedFile } from "../../lib/useGitChanges";
import { buildChangeGroups, flatChangeGroups, selectedModeFor, splitChanges } from "./changeGroups";

const file = (path: string): ChangedFile => ({
  path,
  status: "M",
  index: " ",
  worktree: "M",
  additions: 1,
  deletions: 0,
});

const noop = () => {};

describe("splitChanges", () => {
  test("real edits are counted once across states; machine churn is set apart", () => {
    const parts = splitChanges(
      [file("src/a.ts"), file(".aura/intent_log.jsonl")],
      [file("src/a.ts"), file("src/b.ts")],
      [file("notes.md"), file(".DS_Store")],
    );
    expect(parts.sigStaged.map((f) => f.path)).toEqual(["src/a.ts"]);
    expect(parts.sigUnstaged.map((f) => f.path)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(parts.sigUntracked.map((f) => f.path)).toEqual(["notes.md"]);
    expect(parts.signalCount).toBe(3);
    expect(parts.noise.map((n) => [n.file.path, n.mode])).toEqual([
      [".aura/intent_log.jsonl", "staged"],
      [".DS_Store", "untracked"],
    ]);
    expect(parts.noiseCount).toBe(2);
  });
});

describe("buildChangeGroups", () => {
  test("nothing staged: one untitled group of edits and new files", () => {
    const groups = buildChangeGroups(splitChanges([], [file("a.ts")], [file("b.ts")]), {
      stage: noop,
      unstage: noop,
      generatedOpen: false,
      toggleGenerated: noop,
    });
    expect(groups.map((g) => g.key)).toEqual(["working"]);
    expect(groups[0].title).toBeUndefined();
    expect(groups[0].files.map((e) => e.mode)).toEqual(["unstaged", "untracked"]);
  });

  test("staged files get their own group, and bulk actions act on each group's paths", () => {
    const staged: string[][] = [];
    const unstaged: string[][] = [];
    const groups = buildChangeGroups(splitChanges([file("a.ts")], [file("b.ts")], [file("dist/x.js")]), {
      stage: (p) => staged.push(p),
      unstage: (p) => unstaged.push(p),
      generatedOpen: false,
      toggleGenerated: noop,
    });
    expect(groups.map((g) => [g.key, g.title])).toEqual([
      ["staged", "Staged"],
      ["working", "Changes"],
      ["generated", "Generated & ignored"],
    ]);
    groups[0].action?.run();
    groups[1].action?.run();
    expect(unstaged).toEqual([["a.ts"]]);
    expect(staged).toEqual([["b.ts"]]);
    expect(groups[2].collapsed).toBe(true);
    expect(groups[2].action).toBeUndefined();
  });
});

describe("selectedModeFor", () => {
  test("names the state the selected row is drawn in", () => {
    const a = file("a.ts");
    const b = file("b.ts");
    const c = file("c.ts");
    expect(selectedModeFor("a.ts", [a], [], [])).toBe("staged");
    expect(selectedModeFor("a.ts", [a], [a], [])).toBe("unstaged");
    expect(selectedModeFor("c.ts", [], [], [c])).toBe("untracked");
    expect(selectedModeFor("b.ts", [], [b], [])).toBe("unstaged");
    expect(selectedModeFor(null, [], [], [])).toBe("unstaged");
  });
});

describe("flatChangeGroups", () => {
  const opts = { generatedOpen: false, toggleGenerated: noop };

  test("one untitled list: each path once, in path order, with no bulk action", () => {
    const groups = flatChangeGroups(
      splitChanges([file("src/b.ts"), file("README.md")], [file("src/b.ts"), file(".gitignore")], [file("docs/New.md")]),
      opts,
    );
    expect(groups).toHaveLength(1);
    const [list] = groups;
    expect(list.title).toBeUndefined();
    expect(list.action).toBeUndefined();
    expect(list.files.map((e) => [e.file.path, e.mode])).toEqual([
      [".gitignore", "unstaged"],
      ["docs/New.md", "untracked"],
      ["README.md", "staged"],
      // Staged and edited again: one row, on the working copy.
      ["src/b.ts", "unstaged"],
    ]);
  });

  test("machine churn folds into one collapsed group at the end, each path once", () => {
    const toggles: number[] = [];
    const groups = flatChangeGroups(
      splitChanges([file(".aura/intent_log.jsonl")], [file(".aura/intent_log.jsonl"), file("a.ts")], []),
      { generatedOpen: false, toggleGenerated: () => toggles.push(1) },
    );
    expect(groups.map((g) => [g.key, g.title, g.collapsed])).toEqual([
      ["working", undefined, undefined],
      ["generated", "Generated & ignored", true],
    ]);
    expect(groups[1].files.map((e) => e.file.path)).toEqual([".aura/intent_log.jsonl"]);
    groups[1].onToggle?.();
    expect(toggles).toEqual([1]);
  });

  test("a clean tree is one empty list", () => {
    expect(flatChangeGroups(splitChanges([], [], []), opts).map((g) => g.files.length)).toEqual([0]);
  });
});
