import { describe, expect, test } from "bun:test";
import { diffText, foldContext, parseUnifiedDiff } from "../src/lib/diff";

describe("diffText", () => {
  test("keeps shared lines as context and numbers each side from 1", () => {
    const lines = diffText("a\nb\nc\n", "a\nB\nc");
    expect(lines).toEqual([
      { type: "context", content: "a", oldLine: 1, newLine: 1 },
      { type: "removed", content: "b", oldLine: 2 },
      { type: "added", content: "B", newLine: 2 },
      { type: "context", content: "c", oldLine: 3, newLine: 3 },
    ]);
  });

  test("a piece that no longer exists comes back as all added", () => {
    const lines = diffText("", "fn x() {\n}\n");
    expect(lines.map((l) => l.type)).toEqual(["added", "added"]);
  });

  test("identical text has nothing removed or added", () => {
    expect(diffText("x\ny", "x\ny").every((l) => l.type === "context")).toBe(true);
  });
});

describe("foldContext", () => {
  const ctx = (n: number) => ({ type: "context" as const, content: `c${n}`, oldLine: n, newLine: n });
  test("folds a long unchanged run between changes, keeping three each side", () => {
    const lines = [
      { type: "removed" as const, content: "x", oldLine: 1 },
      ...Array.from({ length: 10 }, (_, i) => ctx(i + 2)),
      { type: "added" as const, content: "y", newLine: 12 },
    ];
    const folded = foldContext(lines);
    expect(folded.map((l) => l.content)).toEqual(["x", "c2", "c3", "c4", "4 unchanged lines", "c9", "c10", "c11", "y"]);
  });
  test("leaves a short run alone and folds unchanged lines at either end", () => {
    const lines = [ctx(1), ctx(2), ctx(3), ctx(4), ctx(5), { type: "added" as const, content: "y" }];
    expect(foldContext(lines).map((l) => l.content)).toEqual(["2 unchanged lines", "c3", "c4", "c5", "y"]);
  });
});

describe("parseUnifiedDiff", () => {
  test("numbers rows from each hunk header and drops the file headers", () => {
    const raw = [
      "diff --git a/x.ts b/x.ts",
      "index 1..2 100644",
      "--- a/x.ts",
      "+++ b/x.ts",
      "@@ -10,3 +10,3 @@ fn",
      " keep",
      "-old",
      "+new",
      " tail",
      "",
    ].join("\n");
    expect(parseUnifiedDiff(raw)).toEqual([
      { type: "hunk", content: "@@ -10,3 +10,3 @@ fn" },
      { type: "context", content: "keep", oldLine: 10, newLine: 10 },
      { type: "removed", content: "old", oldLine: 11 },
      { type: "added", content: "new", newLine: 11 },
      { type: "context", content: "tail", oldLine: 12, newLine: 12 },
    ]);
  });

  test("git's file notes and the no-newline marker are not drawn as code", () => {
    const raw = [
      "diff --git a/n.ts b/n.ts",
      "new file mode 100644",
      "index 0000000..1111111",
      "--- /dev/null",
      "+++ b/n.ts",
      "@@ -0,0 +1,2 @@",
      "+one",
      "+two",
      "\\ No newline at end of file",
    ].join("\n");
    expect(parseUnifiedDiff(raw)).toEqual([
      { type: "hunk", content: "@@ -0,0 +1,2 @@" },
      { type: "added", content: "one", newLine: 1 },
      { type: "added", content: "two", newLine: 2 },
    ]);
  });

  test("a diff without hunk headers is drawn unnumbered", () => {
    expect(parseUnifiedDiff("+a\n-b")).toEqual([
      { type: "added", content: "a", newLine: undefined },
      { type: "removed", content: "b", oldLine: undefined },
    ]);
  });
});
