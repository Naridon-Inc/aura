import { describe, expect, it } from "bun:test";

import { hasHunks } from "./useWhitespaceHiddenDiff";

describe("whitespace-hidden patch", () => {
  it("has hunks only when git printed one", () => {
    expect(hasHunks("")).toBe(false);
    expect(hasHunks("diff --git a/f b/f\nindex 1..2 100644\n")).toBe(false);
    expect(hasHunks("--- a/f\n+++ b/f\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n")).toBe(true);
  });
});
