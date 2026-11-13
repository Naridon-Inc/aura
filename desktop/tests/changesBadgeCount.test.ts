// The Changes tab's badge and the Changes header count the same thing.
//
//   bun test tests/changesBadgeCount.test.ts
//
// They used to come from two places. The badge was the App's `git diff`
// stats for the project alone, so a nested repository's files never reached
// it: the header said "9 files changed" over a list of nine, the tab said
// "Changes 8". Then the header counted only real edits, so a tree whose one
// change was `.aura/team/team.json` (+17 −37, folded under "Generated &
// ignored") read "0 files changed +0 −0" while the badge said 1 — a header
// that says nothing changed above a file with +17 −37 looks broken.
//
// Now there is one list (`useChangeList`) and one count of it
// (`changedFileCount`): every file the list draws, once by path, generated
// ones included, with the +/− of those same files. The header and the badge
// both read it, so the two can't drift. The pure half is tested on a tree with
// every kind of entry; the wiring half is held by source pins, because the
// panel and the App can't be rendered here (no DOM, and App.tsx pulls the
// Tauri bridge through its import graph).

import { describe, expect, test } from "bun:test";

import type { NestedRepo } from "../src/lib/api";
import type { ChangedFile } from "../src/lib/useGitChanges";
import { changesReadout } from "../src/components/rightrail/ChangesPanel";
import { flatChangeGroups } from "../src/components/rightrail/changeGroups";
import { totals } from "../src/components/rightrail/changeNodes";
import {
  changeList,
  changedFileCount,
  listedFiles,
} from "../src/components/rightrail/useChangeList";
import { readSrc, stripComments } from "./support/code";

const ROOT = "/repo";

function file(path: string, index: string, worktree: string, additions = 0, deletions = 0): ChangedFile {
  const status = index === "?" ? "?" : index === "A" ? "A" : "M";
  return { path, status, index, worktree, additions, deletions };
}

const none = { staged: [], unstaged: [], untracked: [] };

const CLOUD: NestedRepo = { rel_path: "cloud", root: `${ROOT}/cloud`, kind: "nested", branch: "main", base: "main" };
const VENDOR: NestedRepo = { rel_path: "vendor/lib", root: `${ROOT}/vendor/lib`, kind: "submodule", branch: null, base: null };

/** A project with every kind of entry the list draws: an edit, a file staged
 *  and then edited again, a new file, a submodule whose recorded commit moved,
 *  a generated file, and the `?? cloud/` folder standing in for a nested
 *  repository whose own files are two more changes. */
function wholeTree() {
  const staged = [file("src/b.ts", "M", " ", 2, 2)];
  const unstaged = [
    file("src/a.ts", " ", "M", 3, 1),
    file("src/b.ts", "M", "M", 2, 2),
    file("vendor/lib", " ", "M", 0, 0),
    file(".aura/team/team.json", " ", "M", 17, 37),
  ];
  const untracked = [file("cloud/", "?", "?"), file("notes.md", "?", "?", 4, 0)];
  const byRoot = new Map([
    [
      CLOUD.root,
      { staged: [], unstaged: [file("api.rs", " ", "M", 5, 0)], untracked: [file("new.rs", "?", "?", 9, 0)] },
    ],
  ]);
  return changeList({ staged, unstaged, untracked }, [CLOUD, VENDOR], byRoot, true);
}

/** Every row the rail's list draws, the folded generated group included. */
function drawnPaths(parts: ReturnType<typeof wholeTree>["parts"]): string[] {
  return flatChangeGroups(parts, { generatedOpen: false, toggleGenerated: () => {} }).flatMap((g) =>
    g.files.map((f) => f.file.path),
  );
}

describe("one count for the list", () => {
  test("counts every file the list draws, nested and generated ones included", () => {
    const { parts } = wholeTree();
    const drawn = drawnPaths(parts);
    expect([...drawn].sort()).toEqual(
      [
        ".aura/team/team.json",
        "cloud/api.rs",
        "cloud/new.rs",
        "notes.md",
        "src/a.ts",
        "src/b.ts",
        "vendor/lib",
      ].sort(),
    );
    // The stand-in folder is not a file the list draws, and not one it counts.
    expect(drawn).not.toContain("cloud/");
    expect(changedFileCount(parts)).toBe(drawn.length);
    expect(changedFileCount(parts)).toBe(7);
  });

  test("the +/− are those same files, each once", () => {
    const { parts } = wholeTree();
    expect(listedFiles(parts).map((f) => f.path).sort()).toEqual([...drawnPaths(parts)].sort());
    // src/b.ts is in both git lists with the same line counts; it adds once.
    expect(totals(listedFiles(parts))).toEqual({ added: 3 + 2 + 4 + 17 + 5 + 9, removed: 1 + 2 + 37 });
  });

  test("a tree whose one change is generated reads 1 file changed, not 0", () => {
    // The user's screen: `.aura/team/team.json` M +17 −37 under
    // "Generated & ignored 1", the header reading "0 files changed +0 −0".
    const { parts } = changeList(
      { ...none, unstaged: [file(".aura/team/team.json", " ", "M", 17, 37)] },
      [],
      new Map(),
      true,
    );
    expect(parts.signalCount).toBe(0);
    expect(drawnPaths(parts)).toEqual([".aura/team/team.json"]);
    const count = changedFileCount(parts);
    expect(count).toBe(1);
    expect(totals(listedFiles(parts))).toEqual({ added: 17, removed: 37 });
    // The header prints its count only when the readout has no note of its
    // own — and with a file listed it doesn't.
    const readout = changesReadout({ loading: false, failed: false, total: count, liveActive: false });
    expect(readout.headerNote).toBeNull();
  });

  test("whenever a file is listed the count is not zero", () => {
    const cases: Parameters<typeof changeList>[0][] = [
      { ...none, untracked: [file("dist/out.js", "?", "?", 1, 0)] },
      { ...none, staged: [file(".aura/intent_log.jsonl", "M", " ", 1, 0)] },
      { ...none, unstaged: [file("src/a.ts", " ", "M", 1, 0)] },
    ];
    for (const own of cases) {
      const { parts } = changeList(own, [], new Map(), true);
      expect(drawnPaths(parts).length).toBeGreaterThan(0);
      expect(changedFileCount(parts)).toBe(drawnPaths(parts).length);
    }
  });

  test("a clean tree counts nothing, and the stand-in alone is not a change", () => {
    const clean = changeList(none, [], new Map(), true);
    expect(changedFileCount(clean.parts)).toBe(0);
    // A nested repository with nothing changed: its `?? cloud/` goes and
    // nothing comes in for it.
    const quiet = changeList({ ...none, untracked: [file("cloud/", "?", "?")] }, [CLOUD], new Map([[CLOUD.root, none]]), true);
    expect(changedFileCount(quiet.parts)).toBe(0);
  });
});

describe("the header and the badge read that count", () => {
  test("the header's number and +/− come from the shared list", async () => {
    const src = stripComments(await readSrc("components/rightrail/ChangesPanel.tsx"));
    expect(src).toContain("useChangeList(repoRoot, { withNested: !staging })");
    expect(src).toContain("const totalChanged = changedFileCount(parts);");
    expect(src).toContain("readout.headerNote ?? filesChanged(totalChanged)");
    expect(src).toContain("const changedFiles = useMemo(() => listedFiles(parts), [parts]);");
    expect(src).toContain("totals(changedFiles)");
    // No second count of its own beside the shared one.
    expect(src).not.toContain("parts.signalCount");
    expect(src).not.toContain("useGitChanges(");
  });

  test("the badge is the shared count of the same list", async () => {
    const hook = stripComments(await readSrc("components/rightrail/useChangeList.ts"));
    const body = hook.slice(hook.indexOf("export function useChangedFileCount"));
    expect(body).toContain("useChangeList(repoRoot, { withNested: true })");
    expect(body).toContain("changedFileCount(parts)");

    const rail = stripComments(await readSrc("components/rightrail/RightRail.tsx"));
    expect(rail).toContain("const changesCount = useChangedFileCount(");
    expect(rail).toContain('label: "Changes", count: changesCount');
    // The rail takes a root, not a number someone else counted.
    expect(rail).not.toContain("changesCount?: number");
    expect(rail).toContain("changesRoot?: string | null");
  });

  test("the App hands the rail the root its Changes view lists", async () => {
    const app = stripComments(await readSrc("App.tsx"));
    expect(app).toContain("changesRoot={project.root}");
    expect(app).not.toContain("changesCount=");
    const view = app.slice(app.indexOf("changesView={"), app.indexOf("changesView={") + 200);
    expect(view).toContain("<GitSidebar");
    expect(view).toContain("repoRoot={project.root}");
  });
});
