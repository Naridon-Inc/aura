// What these pin: a suggestion's patch keeps shared lines as unchanged rows,
// puts removals ahead of additions, and counts both sides in its header.

import { describe, expect, it } from "bun:test";

import { suggestionPatch } from "./suggestionPatch";

describe("suggestion patch", () => {
  it("shows a replaced line as removed then added", () => {
    expect(suggestionPatch("a\nb\nc", "a\nB\nc")).toBe("@@ -1,3 +1,3 @@\n a\n-b\n+B\n c");
  });

  it("counts an added line on the new side only", () => {
    expect(suggestionPatch("x", "x\ny")).toBe("@@ -1,1 +1,2 @@\n x\n+y");
  });

  it("handles a full rewrite", () => {
    expect(suggestionPatch("p\nq", "r")).toBe("@@ -1,2 +1,1 @@\n-p\n-q\n+r");
  });
});
