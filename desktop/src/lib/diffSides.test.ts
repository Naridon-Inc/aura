// The reading these pin: the split view's line numbers are NOT the file's line
// numbers, and a modified piece's recorded numbers describe the new tree even
// when it is shown in the "Previous was this" column. Both mistakes point the
// reader at code that has nothing to do with the piece they clicked.

import { describe, expect, test } from "bun:test";

import type { ChangedSymbol } from "./api";
import { materializeSides, materializedSpan, recordedTree, symbolSpan } from "./diffSides";

/** A diff that starts at line 40, so diff-relative and real line numbers can
 *  never be confused for one another. */
const DIFF = [
  "diff --git a/src/retry.ts b/src/retry.ts",
  "index 1111111..2222222 100644",
  "--- a/src/retry.ts",
  "+++ b/src/retry.ts",
  "@@ -40,6 +40,8 @@ import { sleep } from './sleep';",
  " export function retry(times: number) {",
  "-  const wait = 100;",
  "-  return wait;",
  "+  const wait = 100 * Math.pow(2, times);",
  "+  const jitter = Math.random() * 50;",
  "+  return wait + jitter;",
  " }",
  " ",
  " export function noop() {}",
].join("\n");

function sym(over: Partial<ChangedSymbol>): ChangedSymbol {
  return {
    identifier: "retry",
    kind: "function_declaration",
    change: "modified",
    start_line: null,
    end_line: null,
    ...over,
  };
}

describe("materializeSides", () => {
  const sides = materializeSides(DIFF);

  test("puts each line on the side it belongs to", () => {
    expect(sides.original.split("\n")).toEqual([
      "export function retry(times: number) {",
      "  const wait = 100;",
      "  return wait;",
      "}",
      "",
      "export function noop() {}",
    ]);
    expect(sides.modified.split("\n")).toEqual([
      "export function retry(times: number) {",
      "  const wait = 100 * Math.pow(2, times);",
      "  const jitter = Math.random() * 50;",
      "  return wait + jitter;",
      "}",
      "",
      "export function noop() {}",
    ]);
  });

  test("a two-sided change is not one-sided", () => {
    expect(sides.oneSided).toBe(false);
  });

  test("carries the REAL file line behind every line it kept", () => {
    // The hunk starts at 40 on both sides. The left keeps two removals, the
    // right three additions, so the two sides diverge after the first line —
    // which is exactly why a single shared line number cannot work.
    expect(sides.origAt).toEqual([40, 41, 42, 43, 44, 45]);
    expect(sides.modAt).toEqual([40, 41, 42, 43, 44, 45, 46]);
  });

  test("a new file has nothing on the left", () => {
    const added = materializeSides(
      ["new file mode 100644", "--- /dev/null", "+++ b/a.ts", "@@ -0,0 +1,2 @@", "+one", "+two"].join(
        "\n",
      ),
    );
    expect(added.oneSided).toBe(true);
    expect(added.original).toBe("");
    expect(added.modAt).toEqual([1, 2]);
  });

  test("line numbers restart at each hunk header", () => {
    const two = materializeSides(
      ["@@ -1,1 +1,1 @@", " a", "@@ -90,1 +95,1 @@", " b"].join("\n"),
    );
    expect(two.origAt).toEqual([1, 90]);
    expect(two.modAt).toEqual([1, 95]);
  });
});

describe("recordedTree", () => {
  test("a deleted piece was recorded against the old tree, everything else the new one", () => {
    expect(recordedTree("deleted")).toBe("original");
    expect(recordedTree("added")).toBe("modified");
    expect(recordedTree("modified")).toBe("modified");
  });
});

describe("symbolSpan · the recorded numbers are usable", () => {
  const sides = materializeSides(DIFF);

  test("a modified piece on the new side uses them as-is", () => {
    const span = symbolSpan(sides, sym({ start_line: 40, end_line: 44 }), "modified");
    expect(span).toEqual({ side: "modified", startLine: 40, endLine: 44, source: "lines" });
  });

  test("and converts to the buffer's own numbering for the editor", () => {
    const span = symbolSpan(sides, sym({ start_line: 40, end_line: 44 }), "modified")!;
    // Real 40..44 is the first five lines of the materialized right-hand side.
    expect(materializedSpan(sides, span)).toEqual({ startLine: 1, endLine: 5 });
  });

  test("a range the diff only partly kept is narrowed, not dropped", () => {
    // The piece claims to run to line 400; the diff stops at 46.
    const span = symbolSpan(sides, sym({ start_line: 44, end_line: 400 }), "modified");
    expect(span).toEqual({ side: "modified", startLine: 44, endLine: 46, source: "lines" });
  });

  test("a piece the diff never showed has nothing to point at", () => {
    expect(symbolSpan(sides, sym({ start_line: 900, end_line: 950, identifier: "zzz" }), "modified"))
      .toBeNull();
  });

  test("a deleted piece is found by its OLD-tree numbers, on the old side", () => {
    const gone = sym({ identifier: "wait", change: "deleted", start_line: 41, end_line: 42 });
    expect(symbolSpan(sides, gone, "original")).toEqual({
      side: "original",
      startLine: 41,
      endLine: 42,
      source: "lines",
    });
  });
});

describe("symbolSpan · the recorded numbers describe the other tree", () => {
  const sides = materializeSides(DIFF);

  test("a modified piece on the PREVIOUS side searches for the declaration", () => {
    // 40..44 are the piece's NEW-tree lines. On the old side those numbers
    // land on `}` and past it — so the search must take over.
    const span = symbolSpan(sides, sym({ start_line: 40, end_line: 44 }), "original")!;
    expect(span.source).toBe("search");
    expect(span.side).toBe("original");
    // The old `retry` runs from its declaration to its closing brace: 40..43.
    expect(span.startLine).toBe(40);
    expect(span.endLine).toBe(43);
  });

  test("the declaration beats an earlier mention of the same name", () => {
    const uses = materializeSides(
      [
        "@@ -1,6 +1,6 @@",
        " retry(3);",
        " ",
        " export function retry(times) {",
        "-  return 1;",
        "+  return 2;",
        " }",
      ].join("\n"),
    );
    const span = symbolSpan(uses, sym({ identifier: "retry", start_line: null }), "original")!;
    expect(span.startLine).toBe(3);
    expect(span.endLine).toBe(5);
  });

  test("a name that appears nowhere on that side gives up rather than guessing", () => {
    expect(symbolSpan(sides, sym({ identifier: "jitter", change: "added" }), "original")).toBeNull();
  });

  test("a one-line declaration is one line, not the rest of the file", () => {
    const span = symbolSpan(
      sides,
      sym({ identifier: "noop", change: "modified", start_line: null }),
      "original",
    )!;
    expect(span.startLine).toBe(45);
    expect(span.endLine).toBe(45);
  });
});

describe("materializedSpan", () => {
  const sides = materializeSides(DIFF);

  test("the two sides number the same real line differently", () => {
    // Real line 43 is `return wait;` (index 3) on the left and `}` (index 5)
    // on the right — the whole reason a single number cannot serve both.
    const left = materializedSpan(sides, {
      side: "original",
      startLine: 43,
      endLine: 43,
      source: "lines",
    });
    const right = materializedSpan(sides, {
      side: "modified",
      startLine: 43,
      endLine: 43,
      source: "lines",
    });
    expect(left).toEqual({ startLine: 4, endLine: 4 });
    expect(right).toEqual({ startLine: 4, endLine: 4 });
    // …and a line only one side kept exists only there.
    expect(
      materializedSpan(sides, { side: "modified", startLine: 46, endLine: 46, source: "lines" }),
    ).toEqual({ startLine: 7, endLine: 7 });
    expect(
      materializedSpan(sides, { side: "original", startLine: 46, endLine: 46, source: "lines" }),
    ).toBeNull();
  });
});
