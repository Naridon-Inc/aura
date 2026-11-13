// The rail's change lists name files the way a reader scans them, and the
// Review tab's ticks only ever describe the change that is on disk.

import { describe, expect, it } from "bun:test";

import { changeNodes, displayNames, treeStatus } from "../src/components/rightrail/changeNodes";
import { liveMarks, stampOf } from "../src/components/rightrail/reviewedFiles";
import { readSrc } from "./support/code";

describe("a changed file is named by its file name", () => {
  it("drops the folders when the name is unique", () => {
    const names = displayNames(["src/components/CommandMenu.tsx", "src/styles/theme.css"]);
    expect(names.get("src/components/CommandMenu.tsx")).toBe("CommandMenu.tsx");
    expect(names.get("src/styles/theme.css")).toBe("theme.css");
  });

  it("keeps just enough folder to tell two same-named files apart", () => {
    const names = displayNames(["src/a/index.ts", "src/b/index.ts", "README.md"]);
    expect(names.get("src/a/index.ts")).toBe("a/index.ts");
    expect(names.get("src/b/index.ts")).toBe("b/index.ts");
    expect(names.get("README.md")).toBe("README.md");
  });

  it("goes as deep as it has to, and stops at the full path", () => {
    const names = displayNames(["x/lib/index.ts", "y/lib/index.ts", "lib/index.ts"]);
    expect(names.get("x/lib/index.ts")).toBe("x/lib/index.ts");
    expect(names.get("y/lib/index.ts")).toBe("y/lib/index.ts");
    expect(names.get("lib/index.ts")).toBe("lib/index.ts");
  });

  it("maps git's letters onto the tree's three states", () => {
    expect(treeStatus("A")).toBe("added");
    expect(treeStatus("??")).toBe("added");
    expect(treeStatus("D")).toBe("deleted");
    expect(treeStatus("R")).toBe("modified");
    const [node] = changeNodes([{ path: "a/new.ts", status: "M", additions: 3, deletions: 0 }], "untracked");
    expect(node.status).toBe("added");
    expect(node.name).toBe("new.ts");
  });
});

describe("a review mark holds only for the change it was made against", () => {
  const file = { path: "src/app.ts", status: "M", additions: 4, deletions: 1 };

  it("survives while the file is unchanged since the tick", () => {
    const marks = { [file.path]: stampOf(file) };
    expect(liveMarks(marks, [{ path: file.path, stamp: stampOf(file) }])).toEqual(marks);
  });

  it("lapses when the file changes again", () => {
    const marks = { [file.path]: stampOf(file) };
    const edited = stampOf({ ...file, additions: 9 });
    expect(liveMarks(marks, [{ path: file.path, stamp: edited }])).toEqual({});
  });

  it("is dropped once the file is no longer changed", () => {
    const marks = { [file.path]: stampOf(file), "gone.ts": "M:1:1" };
    expect(Object.keys(liveMarks(marks, [{ path: file.path, stamp: stampOf(file) }]))).toEqual([
      file.path,
    ]);
  });
});

describe("the rail offers Review only where there is a review list", () => {
  it("gates the Review button and tab on the view being supplied", async () => {
    const rail = await readSrc("components/rightrail/RightRail.tsx");
    expect(rail).toContain("reviewView");
    expect(rail).toMatch(/reviewValue=\{reviewView != null \? "review" : undefined\}/);
  });
});
